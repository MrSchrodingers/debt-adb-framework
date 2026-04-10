import type Database from 'better-sqlite3'
import type { MessageQueue } from '../queue/index.js'
import type { SendEngine } from './send-engine.js'
import type { AdbBridge } from '../adb/index.js'
import type { DispatchEmitter } from '../events/index.js'
import type { SenderMapping } from './sender-mapping.js'
import type { SenderHealth } from './sender-health.js'
import type { RateLimitGuard } from '../config/rate-limits.js'
import type { ReceiptTracker } from './receipt-tracker.js'
import type { AccountMutex } from './account-mutex.js'
import type { WahaFallback } from './waha-fallback.js'
import type { MessageHistory } from '../waha/index.js'
import type { DeviceManager } from '../monitor/index.js'
import type { HealthSnapshot } from '../monitor/types.js'
import type { Message } from '../queue/types.js'
import type { SendWindow } from './send-window.js'
import type { SenderWarmup } from './sender-warmup.js'
import type { DeviceCircuitBreaker } from './device-circuit-breaker.js'

export interface WorkerOrchestratorDeps {
  db: Database.Database
  queue: MessageQueue
  engine: SendEngine
  adb: AdbBridge
  emitter: DispatchEmitter
  senderMapping: SenderMapping
  senderHealth: SenderHealth
  rateLimitGuard: RateLimitGuard
  receiptTracker: ReceiptTracker
  accountMutex: AccountMutex
  wahaFallback: WahaFallback
  messageHistory: MessageHistory
  deviceManager: DeviceManager
  latestHealthMap: Map<string, HealthSnapshot>
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void }
  sendWindow?: SendWindow
  senderWarmup?: SenderWarmup
  circuitBreaker?: DeviceCircuitBreaker
}

export class WorkerOrchestrator {
  private devicesRunning = new Set<string>()
  private deviceForegroundUser = new Map<string, number>()
  private cappedSendersCooldown = new Map<string, number>()
  private lastWindowLogAt: number | null = null
  private sendMetadata = new Map<string, {
    profileId: number; userSwitched: boolean; ts: number;
    appPackage: string; senderNumber: string | null; isFirstContact: boolean;
  }>()

  constructor(private readonly deps: WorkerOrchestratorDeps) {}

  get isRunning(): boolean {
    return this.devicesRunning.size > 0
  }

  async processMessage(message: Message, deviceSerial: string, isFirstInBatch = true, appPackage = 'com.whatsapp'): Promise<boolean> {
    const { queue, engine, emitter, wahaFallback, messageHistory, receiptTracker, logger } = this.deps
    let sendSuccess = false
    let usedFallback = false

    try {
      await engine.send(message, deviceSerial, isFirstInBatch, appPackage)
      sendSuccess = true
    } catch (adbErr) {
      logger.warn({ messageId: message.id, err: adbErr }, 'Worker: ADB send failed, attempting WAHA fallback')

      // Reset status to 'sending' to suppress premature 'failed' callback
      try { queue.updateStatus(message.id, 'sending') } catch { /* ignore */ }

      try {
        const fallbackResult = await wahaFallback.send(message)
        logger.info({ messageId: message.id, wahaMessageId: fallbackResult.wahaMessageId }, 'Worker: WAHA fallback succeeded')
        queue.updateStatus(message.id, 'sent')
        emitter.emit('message:sent', { id: message.id, sentAt: new Date().toISOString(), durationMs: 0, deviceSerial, contactRegistered: false, dialogsDismissed: 0 })
        sendSuccess = true
        usedFallback = true
      } catch (wahaErr) {
        logger.error({ messageId: message.id, err: wahaErr }, 'Worker: WAHA fallback also failed')
        if (message.attempts + 1 < message.maxRetries) {
          const requeued = queue.requeueForRetry(message.id)
          logger.warn({ messageId: message.id, attempts: requeued.attempts, maxRetries: message.maxRetries }, 'Worker: message requeued for retry')
        } else {
          queue.updateStatus(message.id, 'permanently_failed')
          emitter.emit('message:failed', {
            id: message.id,
            error: `ADB and WAHA fallback both failed after ${message.maxRetries} attempts: ${wahaErr instanceof Error ? wahaErr.message : String(wahaErr)}`,
            attempts: message.attempts + 1,
            senderNumber: message.senderNumber ?? undefined,
          })
        }
      }
    }

    if (sendSuccess) {
      messageHistory.insert({
        messageId: message.id,
        direction: 'outgoing',
        fromNumber: message.senderNumber,
        toNumber: message.to,
        text: message.body,
        deviceSerial,
        capturedVia: usedFallback ? 'waha_webhook' : 'adb_send',
      })

      if (message.senderNumber) {
        receiptTracker.registerSent({
          messageId: message.id,
          toNumber: message.to,
          senderNumber: message.senderNumber,
          sentAt: new Date().toISOString(),
        })
      }
    }

    return sendSuccess
  }

  async switchToUser(deviceSerial: string, profileId: number): Promise<boolean> {
    const currentUser = this.deviceForegroundUser.get(deviceSerial) ?? 0
    if (profileId === currentUser) return true
    if (!Number.isInteger(profileId) || profileId < 0) return false

    await this.deps.adb.shell(deviceSerial, `am switch-user ${profileId}`)

    // Poll am get-current-user until it returns the expected profileId (max 10s)
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 1000))
      const output = await this.deps.adb.shell(deviceSerial, 'am get-current-user')
      const polledUser = parseInt(output.trim(), 10)
      if (polledUser === profileId) {
        this.deviceForegroundUser.set(deviceSerial, profileId)
        // Disable autocorrect for this user profile (prevents keyboard altering messages)
        await this.deps.adb.shell(deviceSerial, 'settings put secure spell_checker_enabled 0').catch(() => {})
        await this.deps.adb.shell(deviceSerial, 'settings put system text_auto_replace 0').catch(() => {})
        // Wait 2s for UI stabilization after switch
        await new Promise(r => setTimeout(r, 2000))
        return true
      }
    }

    this.deps.logger.error({ profileId, deviceSerial }, 'Worker: user switch timed out after 10s')
    return false
  }

  async tick(): Promise<void> {
    // Send window gate — skip if outside business hours
    if (this.deps.sendWindow && !this.deps.sendWindow.isOpen()) {
      const now = Date.now()
      if (!this.lastWindowLogAt || now - this.lastWindowLogAt >= 60_000) {
        this.deps.logger.info(
          { msUntilOpen: this.deps.sendWindow.msUntilOpen() },
          'Worker: send window closed, messages stay queued',
        )
        this.lastWindowLogAt = now
      }
      return
    }

    const { deviceManager } = this.deps
    const devices = deviceManager.getDevices().filter(d => d.status === 'online')
    if (devices.length === 0) return

    // Process each online device in parallel (each device runs sequentially within)
    const promises = devices.map(device => this.tickDevice(device.serial))
    await Promise.allSettled(promises)
  }

  private async tickDevice(deviceSerial: string): Promise<void> {
    // Per-device lock — skip if already processing on this device
    if (this.devicesRunning.has(deviceSerial)) return
    this.devicesRunning.add(deviceSerial)

    // Circuit breaker: skip if device circuit is open
    if (this.deps.circuitBreaker && !this.deps.circuitBreaker.canExecute(deviceSerial)) {
      this.deps.logger.warn({ device: deviceSerial, state: this.deps.circuitBreaker.getState(deviceSerial) },
        'Worker: device circuit breaker open, skipping tick')
      this.devicesRunning.delete(deviceSerial)
      return
    }

    const { queue, senderMapping, senderHealth, rateLimitGuard, accountMutex, logger } = this.deps
    let releaseMutex: (() => void) | null = null

    try {
      // DP-5: Dequeue batch grouped by sender (minimizes user switches)
      const batch = queue.dequeueBySender(deviceSerial)
      if (batch.length === 0) return

      const senderNumber = batch[0].senderNumber
      if (senderNumber) {
        releaseMutex = await accountMutex.acquire(senderNumber)
      }

      // Rate limit: check daily cap for this sender (warmup-aware)
      if (senderNumber) {
        // Ensure sender is activated for warmup tracking
        if (this.deps.senderWarmup) {
          this.deps.senderWarmup.activateSender(senderNumber)
        }

        // Cooldown: if we already logged the cap within the last 60s, requeue silently
        const lastCapped = this.cappedSendersCooldown.get(senderNumber)
        if (lastCapped !== undefined && Date.now() - lastCapped < 60_000) {
          for (const msg of batch) {
            try { queue.updateStatus(msg.id, 'queued') } catch { /* ignore */ }
          }
          return
        }
        // Cooldown expired or first check — evaluate cap
        if (lastCapped !== undefined) this.cappedSendersCooldown.delete(senderNumber)

        // Use warmup-adjusted cap if available, otherwise fall back to RateLimitGuard
        const dailyCount = queue.getSenderDailyCount(senderNumber)
        const effectiveCap = this.deps.senderWarmup
          ? this.deps.senderWarmup.getEffectiveDailyCap(senderNumber)
          : rateLimitGuard.maxPerSenderPerDay

        if (dailyCount >= effectiveCap) {
          logger.warn({ senderNumber, dailyCount, max: effectiveCap }, 'Worker: sender daily limit reached, skipping batch')
          this.cappedSendersCooldown.set(senderNumber, Date.now())
          for (const msg of batch) {
            try { queue.updateStatus(msg.id, 'queued') } catch { /* ignore */ }
          }
          return
        }
      }

      // Quarantine check: skip senders with consecutive failures
      if (senderNumber && senderHealth.isQuarantined(senderNumber)) {
        logger.warn({ senderNumber }, 'Worker: sender quarantined, skipping batch')
        for (const msg of batch) {
          try { queue.updateStatus(msg.id, 'queued') } catch { /* ignore */ }
        }
        return // finally block releases mutex
      }

      // Pause check: skip paused senders
      if (senderNumber && senderMapping.isPaused(senderNumber)) {
        logger.info({ senderNumber }, 'Worker: sender paused, skipping batch')
        for (const msg of batch) {
          try { queue.updateStatus(msg.id, 'queued') } catch { /* ignore */ }
        }
        return
      }

      // Resolve profileId and switch user ONCE for the entire batch
      const senderProfile = senderNumber ? senderMapping.getByPhone(senderNumber) : null
      const profileId = senderProfile?.profile_id ?? 0
      const appPackage = senderProfile?.app_package ?? 'com.whatsapp'
      const currentFgUser = this.deviceForegroundUser.get(deviceSerial) ?? 0
      const userSwitched = profileId !== currentFgUser

      if (userSwitched) {
        const switched = await this.switchToUser(deviceSerial, profileId)
        if (!switched) {
          logger.error({ profileId, batchSize: batch.length }, 'Worker: skipping batch — user switch failed')
          // Requeue the batch
          for (const msg of batch) {
            try { queue.requeueForRetry(msg.id) } catch { /* ignore */ }
          }
          return
        }
      }

      logger.info({ batchSize: batch.length, senderNumber, profileId, userSwitched, device: deviceSerial }, 'Worker: processing sender batch')

      for (let i = 0; i < batch.length; i++) {
        const message = batch[i]
        const isFirstContact = senderNumber
          ? queue.isFirstContactWith(message.to, senderNumber)
          : false
        this.sendMetadata.set(message.id, {
          profileId, userSwitched, ts: Date.now(),
          appPackage, senderNumber: senderNumber ?? null, isFirstContact,
        })
        const success = await this.processMessage(message, deviceSerial, i === 0, appPackage)
        if (senderNumber) {
          if (success) {
            senderHealth.recordSuccess(senderNumber)
          } else {
            senderHealth.recordFailure(senderNumber)
          }
        }

        // Rate-limit-aware delay between messages (skip after last message)
        if (i < batch.length - 1) {
          const nextMsg = batch[i + 1]
          const isFirstContact = senderNumber
            ? queue.isFirstContactWith(nextMsg.to, senderNumber)
            : false

          let delayMs: number
          if (senderNumber && this.deps.senderWarmup) {
            const delays = this.deps.senderWarmup.getEffectiveDelays(senderNumber)
            const base = isFirstContact ? delays.firstContactDelayMs : delays.recurringContactDelayMs
            delayMs = base + Math.round(base * 0.3 * (Math.random() * 2 - 1)) // +/-30% jitter
            delayMs = Math.max(5000, delayMs)
          } else {
            delayMs = rateLimitGuard.getInterMessageDelay(isFirstContact)
          }

          logger.info({ delayMs, isFirstContact, remaining: batch.length - i - 1 }, 'Worker: rate-limited delay')
          await new Promise(r => setTimeout(r, delayMs))
        }
      }

      // Circuit breaker: record success after batch completes without throwing
      if (this.deps.circuitBreaker) {
        this.deps.circuitBreaker.recordSuccess(deviceSerial)
      }
    } catch (err) {
      logger.error({ err, device: deviceSerial }, 'Worker: batch processing failed')

      // Circuit breaker: record failure on unhandled batch error
      if (this.deps.circuitBreaker) {
        this.deps.circuitBreaker.recordFailure(deviceSerial)
      }
    } finally {
      if (releaseMutex) releaseMutex()
      this.devicesRunning.delete(deviceSerial)
    }
  }

  cleanupMetadata(): void {
    const cutoff = Date.now() - 300_000
    for (const [id, meta] of this.sendMetadata) {
      if (meta.ts < cutoff) this.sendMetadata.delete(id)
    }
  }

  getSendMetadata(id: string): {
    profileId: number; userSwitched: boolean; ts: number;
    appPackage: string; senderNumber: string | null; isFirstContact: boolean;
  } | undefined {
    const meta = this.sendMetadata.get(id)
    if (meta) this.sendMetadata.delete(id)
    return meta
  }
}
