import type Database from 'better-sqlite3'
import { nanoid } from 'nanoid'
import type { DispatchEmitter } from '../events/index.js'
import type { WahaApiClient, WahaSessionInfo, WahaWebhookConfig } from './types.js'

export interface ManagedSession {
  sessionName: string
  phoneNumber: string
  status: WahaSessionInfo['status']
  deviceSerial: string
  profileId: number
}

export interface SessionManagerConfig {
  healthCheckIntervalMs?: number
  dispatchWebhookUrl?: string
  hmacSecret?: string
}

const MAX_RESTART_ATTEMPTS = 5
const BACKOFF_BASE_MS = 5_000 // 5s, 10s, 20s, 40s, 80s

export class SessionManager {
  private healthInterval: ReturnType<typeof setInterval> | null = null
  private restartAttempts = new Map<string, { count: number; nextRetryAt: number }>()

  constructor(
    private readonly db: Database.Database,
    private readonly emitter: DispatchEmitter,
    private readonly wahaClient: WahaApiClient,
    private readonly config: SessionManagerConfig = {},
  ) {}

  initialize(): void {
    // SessionManager doesn't own any tables — it reads whatsapp_accounts (Phase 2)
    // and calls WAHA API for session state.
  }

  async discoverManagedSessions(): Promise<ManagedSession[]> {
    // Get phone numbers managed by Dispatch (from whatsapp_accounts table)
    const accounts = this.db.prepare(`
      SELECT device_serial, profile_id, phone_number
      FROM whatsapp_accounts
      WHERE phone_number IS NOT NULL AND status = 'active'
    `).all() as { device_serial: string; profile_id: number; phone_number: string }[]

    const phoneNumbers = new Map(
      accounts.map((a) => [a.phone_number, a]),
    )

    // List all WAHA sessions
    const sessions = await this.wahaClient.listSessions()

    const managed: ManagedSession[] = []
    for (const session of sessions) {
      if (!session.me) continue

      // Extract phone number from WAHA id format "554396835104@c.us"
      const phoneNumber = session.me.id.replace('@c.us', '')
      const account = phoneNumbers.get(phoneNumber)
      if (!account) continue

      managed.push({
        sessionName: session.name,
        phoneNumber,
        status: session.status,
        deviceSerial: account.device_serial,
        profileId: account.profile_id,
      })
    }

    return managed
  }

  async checkHealth(): Promise<void> {
    const managed = await this.discoverManagedSessions()

    for (const session of managed) {
      if (session.status === 'FAILED') {
        const tracker = this.restartAttempts.get(session.sessionName)
        const now = Date.now()

        // Skip if in backoff window
        if (tracker && now < tracker.nextRetryAt) continue

        // Skip if max attempts exhausted
        if (tracker && tracker.count >= MAX_RESTART_ATTEMPTS) {
          // Only alert once when hitting max
          if (tracker.count === MAX_RESTART_ATTEMPTS) {
            this.emitter.emit('alert:new', {
              id: nanoid(),
              deviceSerial: session.deviceSerial,
              severity: 'critical',
              type: 'waha_session_down',
              message: `WAHA session '${session.sessionName}' for ${session.phoneNumber} failed ${MAX_RESTART_ATTEMPTS} restart attempts`,
            })
            tracker.count++ // prevent re-alerting
          }
          continue
        }

        const attempt = (tracker?.count ?? 0) + 1
        const backoffMs = BACKOFF_BASE_MS * Math.pow(2, attempt - 1) // 5s, 10s, 20s, 40s, 80s

        this.emitter.emit('alert:new', {
          id: nanoid(),
          deviceSerial: session.deviceSerial,
          severity: 'high',
          type: 'waha_session_down',
          message: `WAHA session '${session.sessionName}' for ${session.phoneNumber} is FAILED (attempt ${attempt}/${MAX_RESTART_ATTEMPTS})`,
        })

        this.restartAttempts.set(session.sessionName, {
          count: attempt,
          nextRetryAt: now + backoffMs,
        })

        try {
          await this.wahaClient.restartSession(session.sessionName)
        } catch {
          // Restart failed — backoff will prevent immediate retry
        }
      } else if (session.status === 'WORKING') {
        // Session recovered — clear backoff tracker
        this.restartAttempts.delete(session.sessionName)
      }
    }
  }

  async addWebhook(sessionName: string): Promise<void> {
    if (!this.config.dispatchWebhookUrl) {
      throw new Error('dispatchWebhookUrl not configured')
    }

    const session = await this.wahaClient.getSession(sessionName)
    const existingWebhooks = session.config.webhooks ?? []

    // Check if Dispatch webhook already exists (idempotent)
    const alreadyExists = existingWebhooks.some(
      (w) => w.url === this.config.dispatchWebhookUrl,
    )

    let webhooks: WahaWebhookConfig[]
    if (alreadyExists) {
      // Update existing Dispatch webhook config, keep others
      webhooks = existingWebhooks.map((w) =>
        w.url === this.config.dispatchWebhookUrl
          ? this.buildDispatchWebhook()
          : w,
      )
    } else {
      // Add new Dispatch webhook alongside existing ones
      webhooks = [...existingWebhooks, this.buildDispatchWebhook()]
    }

    await this.wahaClient.updateSessionWebhooks(sessionName, webhooks)
  }

  async restartSession(sessionName: string): Promise<void> {
    await this.wahaClient.restartSession(sessionName)
  }

  startHealthPolling(intervalMs?: number): void {
    const interval = intervalMs ?? this.config.healthCheckIntervalMs ?? 60_000
    this.healthInterval = setInterval(() => {
      this.checkHealth().catch(() => {
        // Health check errors are non-fatal
      })
    }, interval)
  }

  stop(): void {
    if (this.healthInterval) {
      clearInterval(this.healthInterval)
      this.healthInterval = null
    }
  }

  private buildDispatchWebhook(): WahaWebhookConfig {
    const webhook: WahaWebhookConfig = {
      url: this.config.dispatchWebhookUrl!,
      events: ['message.any', 'session.status', 'message.ack'],
      retries: { policy: 'exponential', delaySeconds: 2, attempts: 10 },
    }
    if (this.config.hmacSecret) {
      webhook.hmac = { key: this.config.hmacSecret }
    }
    return webhook
  }
}
