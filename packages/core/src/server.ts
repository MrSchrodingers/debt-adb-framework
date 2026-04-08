import Fastify from 'fastify'
import cors from '@fastify/cors'
import Database from 'better-sqlite3'
import { Server as SocketIOServer } from 'socket.io'
import { MessageQueue } from './queue/index.js'
import { AdbBridge } from './adb/index.js'
import { SendEngine, selectDevice, SenderMapping, ReceiptTracker, AccountMutex, WahaFallback } from './engine/index.js'
import { DispatchEmitter } from './events/index.js'
import { buildCorsOrigins, registerApiAuth, registerMessageRoutes, registerDeviceRoutes, registerMonitorRoutes, registerWahaRoutes, registerSessionRoutes, registerMetricsRoutes, registerAuditRoutes, registerBulkActionRoutes, registerSenderMappingRoutes, registerPluginOralsinRoutes, registerScreenshotRoutes } from './api/index.js'
import { DeviceManager, HealthCollector, WaAccountMapper, AlertSystem } from './monitor/index.js'
import { SessionManager, WebhookHandler, MessageHistory } from './waha/index.js'
import { createWahaHttpClient } from './waha/waha-http-client.js'
import { createChatwootHttpClient, ManagedSessions, InboxAutomation } from './chatwoot/index.js'
import { PluginRegistry, PluginEventBus, CallbackDelivery, PluginLoader } from './plugins/index.js'
import { buildLoggerConfig } from './config/logger.js'
import { GracefulShutdown } from './config/graceful-shutdown.js'
import { RateLimitGuard } from './config/rate-limits.js'
import { OralsinPlugin } from './plugins/oralsin-plugin.js'
import type { DispatchEventName } from './events/index.js'
import type { DispatchPlugin } from './plugins/types.js'

export interface DispatchCore {
  server: ReturnType<typeof Fastify>
  io: SocketIOServer
  queue: MessageQueue
  adb: AdbBridge
  engine: SendEngine
  emitter: DispatchEmitter
  shutdown: GracefulShutdown
}

export async function createServer(port = Number(process.env.PORT) || 7890): Promise<DispatchCore> {
  const loggerConfig = buildLoggerConfig(process.env.NODE_ENV, process.env.LOG_FILE)
  const server = Fastify({
    logger: loggerConfig,
  })
  const corsOrigins = buildCorsOrigins(process.env.DISPATCH_ALLOWED_ORIGINS)
  await server.register(cors, { origin: corsOrigins })

  // API Auth — must be registered before routes
  registerApiAuth(server, process.env.DISPATCH_API_KEY)

  const db = new Database(process.env.DB_PATH || 'dispatch.db')
  db.pragma('journal_mode = WAL')

  const queue = new MessageQueue(db)
  queue.initialize()

  const adb = new AdbBridge()
  const emitter = new DispatchEmitter()
  const engine = new SendEngine(adb, queue, emitter)

  const rateLimitGuard = RateLimitGuard.fromEnv(process.env as Record<string, string | undefined>)

  // Initialize monitor modules
  const deviceManager = new DeviceManager(db, emitter, adb)
  deviceManager.initialize()
  const healthCollector = new HealthCollector(db, adb)
  healthCollector.initialize()
  const waMapper = new WaAccountMapper(db, adb)
  waMapper.initialize()
  const alertSystem = new AlertSystem(db, emitter)
  alertSystem.initialize()

  // Initialize WAHA modules (Phase 4)
  const messageHistory = new MessageHistory(db)
  messageHistory.initialize()

  const wahaApiUrl = process.env.WAHA_API_URL
  const wahaApiKey = process.env.WAHA_API_KEY
  // WebhookHandler works without WAHA client (receives webhooks regardless)
  const webhookHandler = new WebhookHandler(emitter, messageHistory, {
    hmacSecret: process.env.WAHA_WEBHOOK_HMAC_SECRET,
    queue,
  })

  let sessionManager: SessionManager | null = null
  let inboxAutomation: InboxAutomation | null = null

  // Initialize managed sessions table (always available, even without WAHA/Chatwoot)
  const managedSessions = new ManagedSessions(db)
  managedSessions.initialize()

  if (wahaApiUrl && wahaApiKey) {
    const wahaClient = createWahaHttpClient(wahaApiUrl, wahaApiKey)

    sessionManager = new SessionManager(db, emitter, wahaClient, {
      dispatchWebhookUrl: process.env.DISPATCH_WEBHOOK_URL,
      hmacSecret: process.env.WAHA_WEBHOOK_HMAC_SECRET,
    })
    sessionManager.initialize()

    // Initialize Chatwoot integration (Phase 5)
    const chatwootApiUrl = process.env.CHATWOOT_API_URL
    const chatwootApiToken = process.env.CHATWOOT_API_TOKEN
    const chatwootAccountId = Number(process.env.CHATWOOT_ACCOUNT_ID) || 1

    if (chatwootApiUrl && chatwootApiToken) {
      const chatwootClient = createChatwootHttpClient({
        apiUrl: chatwootApiUrl,
        accountId: chatwootAccountId,
        apiToken: chatwootApiToken,
      })
      inboxAutomation = new InboxAutomation(chatwootClient, wahaClient, managedSessions)
    }
  }

  const serverStartTime = Date.now()

  server.get('/api/v1/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
  }))

  // DP-6: Comprehensive health endpoint for external monitoring
  server.get('/healthz', async () => {
    const devices = deviceManager.getDevices()
    const onlineDevices = devices.filter((d) => d.status === 'online')
    const queueStats = queue.getQueueStats()
    const plugins = pluginRegistry.listPlugins()
    const pluginStatus: Record<string, string> = {}
    for (const p of plugins) {
      pluginStatus[p.name] = p.status
    }

    return {
      status: 'healthy',
      uptime_seconds: Math.floor((Date.now() - serverStartTime) / 1000),
      devices: { online: onlineDevices.length, total: devices.length },
      queue: {
        pending: queueStats.pending,
        processing: queueStats.processing,
        failed_last_hour: queueStats.failedLastHour,
      },
      plugins: pluginStatus,
      failed_callbacks: callbackDelivery.listFailedCallbacks().length,
      pid: process.pid,
    }
  })
  registerMessageRoutes(server, queue, emitter)
  registerDeviceRoutes(server, adb)
  registerMonitorRoutes(server, { adb, engine, deviceManager, healthCollector, waMapper, alertSystem })

  // WAHA routes always registered (webhook receiver works without WAHA client)
  // sessionManager may be null if WAHA_API_URL not configured
  // WAHA routes registered after senderMapping init (see below)

  // Session management routes (Phase 5)
  registerSessionRoutes(server, { inboxAutomation, managedSessions })

  // Metrics routes (Phase 6)
  registerMetricsRoutes(server, db)
  registerAuditRoutes(server, db)
  registerBulkActionRoutes(server, adb)

  // Plugin monitoring routes
  registerPluginOralsinRoutes(server, db)
  registerScreenshotRoutes(server, queue)

  // Manual phone number mapping moved to api/devices.ts

  // Reset permanently_failed → queued (manual recovery for lost messages)
  server.post('/api/v1/messages/:id/retry', async (request, reply) => {
    const { id } = request.params as { id: string }
    const message = queue.getById(id)
    if (!message) return reply.status(404).send({ error: 'Message not found' })
    if (message.status !== 'permanently_failed' && message.status !== 'failed') {
      return reply.status(409).send({ error: `Cannot retry message in status: ${message.status}` })
    }
    const updated = queue.requeueForRetry(id)
    emitter.emit('message:queued', { id: updated.id, to: updated.to, priority: updated.priority })
    return { id: updated.id, status: updated.status, attempts: updated.attempts }
  })

  let workerRunning = false

  server.post('/api/v1/messages/:id/send', async (request, reply) => {
    const { id } = request.params as { id: string }
    const message = queue.getById(id)

    if (!message) {
      return reply.status(404).send({ error: 'Message not found' })
    }
    if (message.status !== 'queued' && message.status !== 'failed') {
      return reply.status(409).send({ error: `Cannot send message in status: ${message.status}` })
    }
    if (workerRunning) {
      return reply.status(409).send({ error: 'Worker is currently sending. Try again shortly.' })
    }

    const devices = await adb.discover()
    const online = devices.find(d => d.type === 'device')
    if (!online) {
      return reply.status(503).send({ error: 'No device available' })
    }

    // Re-queue failed messages, then lock via dequeue to prevent auto-worker collision
    if (message.status === 'failed') {
      queue.updateStatus(id, 'queued')
    }
    const locked = queue.dequeue(online.serial)
    if (!locked || locked.id !== id) {
      return reply.status(409).send({ error: 'Message was claimed by another process' })
    }

    try {
      const result = await engine.send(locked, online.serial)
      return { status: 'sent', durationMs: result.durationMs }
    } catch (err) {
      return reply.status(500).send({
        error: 'Send failed',
        detail: err instanceof Error ? err.message : String(err),
      })
    }
  })

  // ── Receipt Tracker (DP-2) ──
  const receiptTracker = new ReceiptTracker(db, queue, emitter)
  receiptTracker.initialize()

  // ── Sender Mapping (DP-1) ──
  const senderMapping = new SenderMapping(db)
  senderMapping.initialize()
  registerSenderMappingRoutes(server, senderMapping)

  // WAHA routes (after senderMapping init — pair endpoint needs it)
  registerWahaRoutes(server, { webhookHandler, sessionManager, messageHistory, adb, senderMapping })

  // ── WAHA Fallback + Account Mutex (DP-3) ──
  const accountMutex = new AccountMutex()
  const wahaFallback = new WahaFallback(senderMapping, queue, fetch, process.env.WAHA_API_KEY)

  // ── Plugin System (Phase 7) ──
  const pluginRegistry = new PluginRegistry(db)
  pluginRegistry.initialize()
  const pluginEventBus = new PluginEventBus(pluginRegistry, emitter)
  const callbackDelivery = new CallbackDelivery(db, pluginRegistry, fetch)
  const pinoLogger = { child: (bindings: Record<string, unknown>) => ({ info: server.log.info.bind(server.log), warn: server.log.warn.bind(server.log), error: server.log.error.bind(server.log), debug: server.log.debug.bind(server.log) }) }
  const pluginLoader = new PluginLoader(pluginRegistry, pluginEventBus, queue, db, pinoLogger, senderMapping)

  // Load plugins from config
  const pluginNames = (process.env.DISPATCH_PLUGINS || '').split(',').map(s => s.trim()).filter(Boolean)
  const pluginMap: Record<string, () => DispatchPlugin> = {
    oralsin: () => new OralsinPlugin(process.env.PLUGIN_ORALSIN_WEBHOOK_URL || 'http://localhost:8000/api/webhooks/dispatch/'),
  }

  for (const name of pluginNames) {
    const factory = pluginMap[name]
    if (!factory) {
      server.log.warn({ plugin: name }, 'Plugin not found in registry, skipping')
      continue
    }
    const plugin = factory()
    const apiKey = process.env[`PLUGIN_${name.toUpperCase()}_API_KEY`] || ''
    const hmacSecret = process.env[`PLUGIN_${name.toUpperCase()}_HMAC_SECRET`] || ''
    await pluginLoader.loadPlugin(plugin, apiKey, hmacSecret)
    server.log.info({ plugin: name }, 'Plugin loaded')
  }

  // Register plugin routes on Fastify (generic — works for any plugin)
  for (const route of pluginLoader.getRegisteredRoutes()) {
    const record = pluginRegistry.getPlugin(route.pluginName)
    if (!record || record.status !== 'active') continue
    const apiKey = process.env[`PLUGIN_${route.pluginName.toUpperCase()}_API_KEY`] || ''
    const fullPath = `/api/v1/plugins/${route.pluginName}${route.path}`
    const method = route.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete'

    server[method](fullPath, async (req, reply) => {
      if (apiKey && method === 'post') {
        const providedKey = (req.headers as Record<string, string>)['x-api-key']
        if (providedKey !== apiKey) {
          return reply.status(401).send({ error: 'Invalid API key' })
        }
      }
      return route.handler(req, reply)
    })
  }

  // Per-message metadata set by worker loop, consumed by callback listeners
  const sendMetadata = new Map<string, { profileId: number; userSwitched: boolean; ts: number }>()

  // Plugin callback listeners — only when plugins are configured
  if (pluginNames.length > 0) {
    // Helper to extract sender session/pair from senders_config JSON
    const parseSenderInfo = (msg: { senderNumber: string | null; sendersConfig: string | null }) => {
      let senderSession = ''
      let pairUsed = ''
      if (msg.sendersConfig && msg.senderNumber) {
        try {
          const senders = JSON.parse(msg.sendersConfig) as Array<{ phone: string; session: string; pair: string }>
          const match = senders.find((s) => s.phone === msg.senderNumber)
          if (match) {
            senderSession = match.session
            pairUsed = match.pair
          }
        } catch { /* malformed JSON — ignore */ }
      }
      return { senderSession, pairUsed }
    }

    emitter.on('message:sent', (data) => {
      const msg = queue.getById(data.id)
      if (msg?.pluginName) {
        const { senderSession, pairUsed } = parseSenderInfo(msg)
        const meta = sendMetadata.get(data.id)
        sendMetadata.delete(data.id)

        void callbackDelivery.sendResultCallback(msg.pluginName, msg.id, {
          idempotency_key: msg.idempotencyKey,
          correlation_id: msg.correlationId ?? undefined,
          status: 'sent',
          sent_at: data.sentAt,
          delivery: {
            message_id: msg.wahaMessageId,
            provider: msg.fallbackUsed ? 'waha' : 'adb',
            sender_phone: msg.senderNumber ?? '',
            sender_session: senderSession,
            pair_used: pairUsed,
            used_fallback: msg.fallbackUsed === 1,
            elapsed_ms: data.durationMs,
            device_serial: data.deviceSerial,
            profile_id: meta?.profileId ?? 0,
            char_count: msg.body.length,
            contact_registered: data.contactRegistered,
            screenshot_url: msg.screenshotPath ? `/api/v1/messages/${msg.id}/screenshot` : null,
            dialogs_dismissed: data.dialogsDismissed,
            user_switched: meta?.userSwitched ?? false,
          },
          error: null,
          fallback_reason: msg.fallbackUsed ? { original_error: 'adb_failed', original_session: senderSession, quarantined: false } : undefined,
          context: msg.context ? JSON.parse(msg.context) : undefined,
        })
      }
    })

    emitter.on('message:failed', (data) => {
      sendMetadata.delete(data.id)
      const msg = queue.getById(data.id)
      if (msg?.pluginName) {
        void callbackDelivery.sendResultCallback(msg.pluginName, msg.id, {
          idempotency_key: msg.idempotencyKey,
          correlation_id: msg.correlationId ?? undefined,
          status: 'failed',
          sent_at: null,
          delivery: null,
          error: {
            code: 'send_failed',
            message: data.error,
            retryable: msg.attempts < msg.maxRetries,
          },
          context: msg.context ? JSON.parse(msg.context) : undefined,
        })
      }
    })

    // DP-4: ACK callbacks (delivery receipts)
    emitter.on('message:delivered', (data) => {
      const msg = queue.getById(data.id)
      if (msg?.pluginName) {
        void callbackDelivery.sendAckCallback(msg.pluginName, msg.id, {
          idempotency_key: msg.idempotencyKey,
          message_id: data.id,
          event: 'ack_update',
          ack: {
            level: 2,
            level_name: 'device',
            delivered_at: data.deliveredAt,
            read_at: null,
          },
        })
      }
    })

    emitter.on('message:read', (data) => {
      const msg = queue.getById(data.id)
      if (msg?.pluginName) {
        void callbackDelivery.sendAckCallback(msg.pluginName, msg.id, {
          idempotency_key: msg.idempotencyKey,
          message_id: data.id,
          event: 'ack_update',
          ack: {
            level: 3,
            level_name: 'read',
            delivered_at: data.readAt, // Use readAt as best available
            read_at: data.readAt,
          },
        })
      }
    })

    // DP-4: Response callback (patient reply captured by WAHA)
    emitter.on('waha:message_received', (data) => {
      // Find the most recent outgoing message to this patient
      const history = messageHistory.query({
        fromNumber: data.toNumber, // sender that sent to the patient
        toNumber: data.fromNumber, // patient's number
        direction: 'outgoing',
        limit: 1,
      })
      if (history.length === 0 || !history[0].messageId) return

      const dispatchMsgId = history[0].messageId
      const msg = queue.getById(dispatchMsgId)
      if (!msg?.pluginName) return

      const incomingHistory = messageHistory.query({
        fromNumber: data.fromNumber,
        limit: 1,
      })
      const replyText = incomingHistory.length > 0 ? (incomingHistory[0].text ?? '') : ''

      void callbackDelivery.sendResponseCallback(msg.pluginName, msg.id, {
        idempotency_key: msg.idempotencyKey,
        message_id: msg.id,
        event: 'patient_response',
        response: {
          body: replyText,
          received_at: new Date().toISOString(),
          from_number: data.fromNumber,
          has_media: false,
        },
      })
    })
  }

  // ── DP-2: Receipt Tracking — wire WAHA events to ReceiptTracker ──
  emitter.on('waha:message_sent', (data) => {
    // When webhook handler dedup-matches an outgoing message, correlate for receipts
    if (data.deduplicated && data.wahaMessageId) {
      receiptTracker.correlateOutgoing({
        wahaMessageId: data.wahaMessageId,
        toNumber: data.toNumber,
        senderNumber: data.fromNumber,
        timestamp: new Date().toISOString(),
      })
    }
  })

  emitter.on('waha:message_ack', (data) => {
    const timestamp = data.deliveredAt ?? data.readAt ?? new Date().toISOString()
    receiptTracker.handleAck(data.wahaMessageId, data.ackLevel, timestamp)
  })

  // Admin routes for plugin management
  server.get('/api/v1/admin/plugins', async (_req, reply) => {
    return reply.send(pluginRegistry.listPlugins())
  })

  server.get('/api/v1/admin/plugins/:name', async (req, reply) => {
    const { name } = req.params as { name: string }
    const plugin = pluginRegistry.getPlugin(name)
    if (!plugin) return reply.status(404).send({ error: 'Plugin not found' })
    return reply.send(plugin)
  })

  server.patch('/api/v1/admin/plugins/:name', async (req, reply) => {
    const { name } = req.params as { name: string }
    const body = req.body as { enabled?: boolean; webhookUrl?: string; events?: string[] }
    if (body.enabled === false) pluginRegistry.disablePlugin(name)
    if (body.enabled === true) pluginRegistry.enablePlugin(name)
    if (body.webhookUrl || body.events) pluginRegistry.updatePlugin(name, body)
    return reply.send(pluginRegistry.getPlugin(name))
  })

  server.delete('/api/v1/admin/plugins/:name', async (req, reply) => {
    const { name } = req.params as { name: string }
    pluginRegistry.deletePlugin(name)
    return reply.status(204).send()
  })

  server.post('/api/v1/admin/plugins/:name/rotate-key', async (req, reply) => {
    const { name } = req.params as { name: string }
    const newKey = pluginRegistry.rotateApiKey(name)
    return reply.send({ api_key: newKey })
  })

  // Auto-configure new devices on connect: disable screen lock + keep awake
  emitter.on('device:connected', (data) => {
    const { serial } = data
    server.log.info({ serial }, 'New device connected — applying keep-awake settings')
    const commands = [
      'settings put system screen_off_timeout 2147483647',
      'svc power stayon usb',
      'locksettings set-disabled true',
      'input keyevent KEYCODE_WAKEUP',
    ]
    for (const cmd of commands) {
      adb.shell(serial, cmd).catch((err) => {
        server.log.warn({ serial, cmd, err: (err as Error).message }, 'Keep-awake command failed')
      })
    }
  })

  // Device discovery polling (5s) — managed by DeviceManager
  deviceManager.startPolling(5_000)

  // In-memory health map for selectDevice (populated by health interval)
  const latestHealthMap = new Map<string, import('./monitor/types.js').HealthSnapshot>()

  // Health collection polling (30s) — per-device error isolation
  const healthInterval = setInterval(async () => {
    for (const device of deviceManager.getDevices()) {
      if (device.status !== 'online') continue
      try {
        const snapshot = await healthCollector.collect(device.serial)
        latestHealthMap.set(device.serial, snapshot)
        alertSystem.evaluate(snapshot)
        emitter.emit('device:health', {
          serial: device.serial,
          batteryPercent: snapshot.batteryPercent,
          temperatureCelsius: snapshot.temperatureCelsius,
          ramAvailableMb: snapshot.ramAvailableMb,
          storageFreeBytes: snapshot.storageFreeBytes,
        })
      } catch (err) {
        server.log.error({ err, serial: device.serial }, 'Health collection failed for device')
      }
    }
  }, 30_000)

  // WA account mapping — run on device connect + every 5 minutes
  const mapAllAccounts = async () => {
    for (const device of deviceManager.getDevices()) {
      if (device.status !== 'online') continue
      try {
        await waMapper.mapAccounts(device.serial)
      } catch (err) {
        server.log.error({ err, serial: device.serial }, 'WA account mapping failed for device')
      }
    }
  }
  emitter.on('device:connected', () => {
    setTimeout(() => { void mapAllAccounts() }, 3000) // 3s after connect for device to stabilize
  })
  const accountInterval = setInterval(async () => {
    await mapAllAccounts()
  }, 300_000)

  // Health data cleanup (hourly, removes > 7 days)
  const healthCleanupInterval = setInterval(() => {
    healthCollector.cleanup()
    receiptTracker.cleanup() // DP-2: remove correlations older than 48h
  }, 3_600_000)

  const cleanupInterval = setInterval(() => {
    const cleaned = queue.cleanStaleLocks()
    if (cleaned > 0) {
      server.log.info({ cleaned }, 'Cleaned stale locks')
    }
  }, 30_000)

  // DP-5: Helper to process a single message (ADB + WAHA fallback)
  const processMessage = async (message: import('./queue/types.js').Message, deviceSerial: string, isFirstInBatch = true) => {
    let sendSuccess = false
    let usedFallback = false

    try {
      await engine.send(message, deviceSerial, isFirstInBatch)
      sendSuccess = true
    } catch (adbErr) {
      server.log.warn({ messageId: message.id, err: adbErr }, 'Worker: ADB send failed, attempting WAHA fallback')

      // Reset status to 'sending' to suppress premature 'failed' callback
      try { queue.updateStatus(message.id, 'sending') } catch { /* ignore */ }

      try {
        const fallbackResult = await wahaFallback.send(message)
        server.log.info({ messageId: message.id, wahaMessageId: fallbackResult.wahaMessageId }, 'Worker: WAHA fallback succeeded')
        queue.updateStatus(message.id, 'sent')
        emitter.emit('message:sent', { id: message.id, sentAt: new Date().toISOString(), durationMs: 0, deviceSerial, contactRegistered: false, dialogsDismissed: 0 })
        sendSuccess = true
        usedFallback = true
      } catch (wahaErr) {
        server.log.error({ messageId: message.id, err: wahaErr }, 'Worker: WAHA fallback also failed')
        queue.updateStatus(message.id, 'permanently_failed')
        emitter.emit('message:failed', {
          id: message.id,
          error: `ADB and WAHA fallback both failed: ${wahaErr instanceof Error ? wahaErr.message : String(wahaErr)}`,
        })
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
  }

  // DP-5: Worker loop uses sender-grouped dequeue
  const cappedSendersCooldown = new Map<string, number>() // senderNumber → timestamp when capped
  let currentForegroundUser = 0

  const switchToUser = async (deviceSerial: string, profileId: number): Promise<boolean> => {
    if (profileId === currentForegroundUser) return true
    if (!Number.isInteger(profileId) || profileId < 0) return false

    await adb.shell(deviceSerial, `am switch-user ${profileId}`)

    // Poll am get-current-user until it returns the expected profileId (max 10s)
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 1000))
      const output = await adb.shell(deviceSerial, 'am get-current-user')
      const currentUser = parseInt(output.trim(), 10)
      if (currentUser === profileId) {
        currentForegroundUser = profileId
        // Wait 2s for UI stabilization after switch
        await new Promise(r => setTimeout(r, 2000))
        return true
      }
    }

    server.log.error({ profileId, deviceSerial }, 'Worker: user switch timed out after 10s')
    return false
  }

  const workerInterval = setInterval(async () => {
    if (workerRunning) return
    workerRunning = true

    let releaseMutex: (() => void) | null = null

    try {
      const online = selectDevice(deviceManager.getDevices(), latestHealthMap, db)
        ?? deviceManager.getDevices().find(d => d.status === 'online')
      if (!online) return

      // DP-5: Dequeue batch grouped by sender (minimizes user switches)
      const batch = queue.dequeueBySender(online.serial)
      if (batch.length === 0) return

      const senderNumber = batch[0].senderNumber
      if (senderNumber) {
        releaseMutex = await accountMutex.acquire(senderNumber)
      }

      // Rate limit: check daily cap for this sender
      if (senderNumber) {
        // Cooldown: if we already logged the cap within the last 60s, requeue silently
        const lastCapped = cappedSendersCooldown.get(senderNumber)
        if (lastCapped !== undefined && Date.now() - lastCapped < 60_000) {
          for (const msg of batch) {
            try { queue.updateStatus(msg.id, 'queued') } catch { /* ignore */ }
          }
          return
        }
        // Cooldown expired or first check — evaluate cap
        if (lastCapped !== undefined) cappedSendersCooldown.delete(senderNumber)

        const dailyCount = queue.getSenderDailyCount(senderNumber)
        if (!rateLimitGuard.canSend(dailyCount)) {
          server.log.warn({ senderNumber, dailyCount, max: rateLimitGuard.maxPerSenderPerDay }, 'Worker: sender daily limit reached, skipping batch')
          cappedSendersCooldown.set(senderNumber, Date.now())
          for (const msg of batch) {
            try { queue.updateStatus(msg.id, 'queued') } catch { /* ignore */ }
          }
          return
        }
      }

      // Resolve profileId and switch user ONCE for the entire batch
      const senderProfile = senderNumber ? senderMapping.getByPhone(senderNumber) : null
      const profileId = senderProfile?.profile_id ?? 0
      const userSwitched = profileId !== currentForegroundUser

      if (userSwitched) {
        const switched = await switchToUser(online.serial, profileId)
        if (!switched) {
          server.log.error({ profileId, batchSize: batch.length }, 'Worker: skipping batch — user switch failed')
          // Requeue the batch
          for (const msg of batch) {
            try { queue.requeueForRetry(msg.id) } catch { /* ignore */ }
          }
          return
        }
      }

      server.log.info({ batchSize: batch.length, senderNumber, profileId, userSwitched, device: online.serial }, 'Worker: processing sender batch')

      for (let i = 0; i < batch.length; i++) {
        const message = batch[i]
        sendMetadata.set(message.id, { profileId, userSwitched, ts: Date.now() })
        await processMessage(message, online.serial, i === 0)

        // Rate-limit-aware delay between messages (skip after last message)
        if (i < batch.length - 1) {
          const nextMsg = batch[i + 1]
          const isFirstContact = senderNumber
            ? queue.isFirstContactWith(nextMsg.to, senderNumber)
            : false
          const delayMs = rateLimitGuard.getInterMessageDelay(isFirstContact)
          server.log.info({ delayMs, isFirstContact, remaining: batch.length - i - 1 }, 'Worker: rate-limited delay')
          await new Promise(r => setTimeout(r, delayMs))
        }
      }
    } catch (err) {
      server.log.error({ err }, 'Worker: batch processing failed')
    } finally {
      if (releaseMutex) releaseMutex()
      workerRunning = false
    }
  }, 5_000)

  // WAHA session health polling (60s) and history cleanup (hourly)
  if (sessionManager) {
    sessionManager.startHealthPolling(60_000)
  }
  const retentionDays = Number(process.env.MESSAGE_HISTORY_RETENTION_DAYS) || 90
  const historyCleanupInterval = setInterval(() => {
    messageHistory.cleanup(retentionDays)
  }, 3_600_000)

  // Periodic sendMetadata cleanup (60s) — remove stale entries older than 5 minutes
  const metadataCleanupInterval = setInterval(() => {
    const cutoff = Date.now() - 300_000
    for (const [id, meta] of sendMetadata) {
      if (meta.ts < cutoff) sendMetadata.delete(id)
    }
  }, 60_000)

  // Periodic callback retry worker (60s) — retries failed callbacks, max 20 per cycle
  let callbackRetryRunning = false
  const callbackRetryInterval = setInterval(async () => {
    if (callbackRetryRunning) return
    callbackRetryRunning = true
    try {
    const failed = callbackDelivery.listFailedCallbacks()
    let retried = 0
    for (const cb of failed) {
      if (retried >= 20) break // Max 20 retries per cycle to prevent storm
      if (cb.attempts < 10) {
        try {
          await callbackDelivery.retryFailedCallback(cb.id)
          retried++
        } catch (err) {
          server.log.warn({ callbackId: cb.id, err }, 'Callback retry failed')
          retried++
        }
      }
    }
    } finally {
      callbackRetryRunning = false
    }
  }, 60_000)

  // ── Graceful Shutdown (must register hook BEFORE listen) ──
  const shutdown = new GracefulShutdown(server.log)

  server.addHook('onClose', async () => {
    await shutdown.execute()
  })

  await server.listen({ port, host: '0.0.0.0' })

  const io = new SocketIOServer(server.server, { cors: { origin: corsOrigins } })

  const events: DispatchEventName[] = [
    'message:queued', 'message:sending', 'message:sent', 'message:failed',
    'message:delivered', 'message:read',
    'device:connected', 'device:disconnected', 'device:health', 'alert:new',
    'waha:message_received', 'waha:message_sent', 'waha:session_status', 'waha:message_ack',
  ]
  for (const event of events) {
    emitter.on(event, (data) => io.emit(event, data))
  }

  // Register shutdown handlers (after listen, handlers don't use addHook)
  shutdown.addHandler('plugins', async () => {
    await pluginLoader.destroyAll()
    pluginEventBus.destroy()
  })

  shutdown.addHandler('intervals', async () => {
    deviceManager.stop()
    sessionManager?.stop()
    clearInterval(healthInterval)
    clearInterval(accountInterval)
    clearInterval(healthCleanupInterval)
    clearInterval(historyCleanupInterval)
    clearInterval(cleanupInterval)
    clearInterval(workerInterval)
    clearInterval(callbackRetryInterval)
    clearInterval(metadataCleanupInterval)
  })

  shutdown.addHandler('stale-locks', async () => {
    const cleaned = queue.cleanStaleLocks()
    if (cleaned > 0) {
      server.log.info({ cleaned }, 'Cleaned stale locks during shutdown')
    }
  })

  shutdown.addHandler('socket.io', async () => {
    io.close()
  })

  shutdown.addHandler('database', async () => {
    db.close()
  })

  return { server, io, queue, adb, engine, emitter, shutdown }
}
