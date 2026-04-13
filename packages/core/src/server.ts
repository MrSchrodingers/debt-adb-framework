import { readdir, unlink, stat } from 'node:fs/promises'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import Database from 'better-sqlite3'
import { Server as SocketIOServer } from 'socket.io'
import { MessageQueue } from './queue/index.js'
import { AdbBridge } from './adb/index.js'
import { SendEngine, SendStrategy, SenderMapping, ReceiptTracker, AccountMutex, WahaFallback, SenderHealth, WorkerOrchestrator, EventRecorder, SendWindow, SenderWarmup, DeviceCircuitBreaker, ContactCache, OptOutDetector, MediaSender } from './engine/index.js'
import { DispatchEmitter } from './events/index.js'
import { buildCorsOrigins, registerApiAuth, registerMessageRoutes, registerDeviceRoutes, registerMonitorRoutes, registerWahaRoutes, registerSessionRoutes, registerMetricsRoutes, registerAuditRoutes, registerBulkActionRoutes, registerSenderMappingRoutes, registerPluginOralsinRoutes, registerScreenshotRoutes, registerTraceRoutes, registerSenderRoutes, registerBlacklistRoutes } from './api/index.js'
import { DeviceManager, HealthCollector, WaAccountMapper, AlertSystem } from './monitor/index.js'
import { SessionManager, WebhookHandler, MessageHistory } from './waha/index.js'
import { createWahaHttpClient } from './waha/waha-http-client.js'
import { createChatwootHttpClient, ManagedSessions, InboxAutomation } from './chatwoot/index.js'
import { PluginRegistry, PluginEventBus, CallbackDelivery, PluginLoader } from './plugins/index.js'
import { buildLoggerConfig } from './config/logger.js'
import { GracefulShutdown } from './config/graceful-shutdown.js'
import { RateLimitGuard } from './config/rate-limits.js'
import { parseConfig } from './config/config-schema.js'
import { AuditLogger } from './config/audit-logger.js'
import { ScreenshotPolicy } from './config/screenshot-policy.js'
import { metricsRegistry, messagesSentTotal, messagesFailedTotal, messagesQueuedTotal, sendDurationSeconds, interMessageDelaySeconds, queueDepth, devicesOnline, senderDailyCount, quarantineEventsTotal, senderQuarantined } from './config/metrics.js'
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
  // Validate all env vars upfront — crash fast on misconfiguration
  const config = parseConfig(process.env as Record<string, string | undefined>)
  void config // TODO: incrementally migrate process.env reads to use config

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
  db.pragma('busy_timeout = 5000')
  db.pragma('wal_autocheckpoint = 400')

  const queue = new MessageQueue(db)
  queue.initialize()

  const auditLogger = new AuditLogger(db)

  const adb = new AdbBridge()
  const emitter = new DispatchEmitter()
  const strategy = SendStrategy.fromEnv(process.env as Record<string, string | undefined>)
  const eventRecorder = new EventRecorder(db)
  const screenshotPolicy = ScreenshotPolicy.fromEnv(process.env as Record<string, string | undefined>)
  const contactCache = new ContactCache()
  const optOutDetector = new OptOutDetector()
  const mediaSender = new MediaSender(adb)
  const engine = new SendEngine(adb, queue, emitter, strategy, eventRecorder, screenshotPolicy, contactCache, mediaSender)

  // ── Prometheus metrics collection ──
  emitter.on('message:sent', (data) => {
    messagesSentTotal.inc({
      sender: data.senderNumber ?? 'unknown',
      method: data.strategyMethod ?? 'unknown',
      app_package: data.appPackage ?? 'unknown',
    })
    sendDurationSeconds.observe(
      { method: data.strategyMethod ?? 'unknown' },
      data.durationMs / 1000,
    )
    if (data.interMessageDelayMs !== undefined && data.interMessageDelayMs > 0) {
      interMessageDelaySeconds.observe(
        { is_first_contact: data.isFirstContact ? 'true' : 'false' },
        data.interMessageDelayMs / 1000,
      )
    }
  })

  emitter.on('message:failed', (data) => {
    messagesFailedTotal.inc({
      sender: data.senderNumber ?? 'unknown',
      error_type: data.attempts !== undefined && data.attempts > 3 ? 'exhausted' : 'transient',
    })
  })

  emitter.on('message:queued', () => {
    messagesQueuedTotal.inc({ plugin: 'direct' })
  })

  emitter.on('sender:quarantined', (data) => {
    quarantineEventsTotal.inc({ sender: data.sender })
    senderQuarantined.set({ sender: data.sender }, 1)
  })

  emitter.on('sender:released', (data) => {
    senderQuarantined.set({ sender: data.sender }, 0)
  })

  const senderWarmup = new SenderWarmup(db)
  const rateLimitGuard = RateLimitGuard.fromEnv(process.env as Record<string, string | undefined>)
  const senderHealth = new SenderHealth(db, {
    quarantineAfterFailures: Number(process.env.QUARANTINE_AFTER_FAILURES) || 3,
    quarantineDurationMs: Number(process.env.QUARANTINE_DURATION_MS) || 3_600_000,
  }, emitter)

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
  // Prometheus metrics endpoint (unauthenticated — standard for /metrics)
  server.get('/metrics', async (_request, reply) => {
    const metrics = await metricsRegistry.metrics()
    reply.header('content-type', metricsRegistry.contentType)
    return reply.send(metrics)
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
  registerAuditRoutes(server, db, auditLogger)
  registerBulkActionRoutes(server, adb)

  // Plugin monitoring routes
  registerPluginOralsinRoutes(server, db)
  registerScreenshotRoutes(server, queue)
  registerTraceRoutes(server, eventRecorder)
  registerBlacklistRoutes(server, db)

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

  server.post('/api/v1/messages/:id/send', async (request, reply) => {
    const { id } = request.params as { id: string }
    const message = queue.getById(id)

    if (!message) {
      return reply.status(404).send({ error: 'Message not found' })
    }
    if (message.status !== 'queued' && message.status !== 'failed') {
      return reply.status(409).send({ error: `Cannot send message in status: ${message.status}` })
    }
    if (orchestrator.isRunning) {
      return reply.status(409).send({ error: 'Worker is currently sending. Try again shortly.' })
    }

    const devices = await adb.discover()
    const online = devices.find(d => d.type === 'device')
    if (!online) {
      return reply.status(503).send({ error: 'No device available' })
    }

    // Re-queue failed messages, then lock via dequeue to prevent auto-worker collision
    if (message.status === 'failed') {
      queue.updateStatus(id, 'failed', 'queued')
    }
    const locked = queue.dequeue(online.serial)
    if (!locked || locked.id !== id) {
      return reply.status(409).send({ error: 'Message was claimed by another process' })
    }

    try {
      const result = await engine.send(locked, online.serial)
      return { status: 'sent', durationMs: result.durationMs }
    } catch (err) {
      // Set failed status since there's no orchestrator WAHA fallback for manual sends
      try { queue.updateStatus(id, 'sending', 'failed') } catch { /* ignore CAS mismatch */ }
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
  registerSenderMappingRoutes(server, senderMapping, auditLogger)
  registerSenderRoutes(server, { senderWarmup, senderMapping, senderHealth, queue })

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
  const pluginLoader = new PluginLoader(pluginRegistry, pluginEventBus, queue, db, pinoLogger, senderMapping, engine)

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
        const meta = orchestrator.getSendMetadata(data.id)

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
      orchestrator.getSendMetadata(data.id) // cleanup metadata (return value unused)
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

  // ── Opt-out detection on WAHA incoming messages ──
  emitter.on('waha:message_received', (data) => {
    const history = messageHistory.query({ fromNumber: data.fromNumber, limit: 1 })
    if (history.length === 0) return

    const text = history[0].text
    const result = optOutDetector.detect(text)
    if (result.matched) {
      db.prepare(
        'INSERT OR IGNORE INTO blacklist (phone_number, reason, detected_message, detected_pattern, source_session) VALUES (?, ?, ?, ?, ?)',
      ).run(data.fromNumber, 'auto_detected', text, result.pattern, data.sessionName)

      emitter.emit('contact:opted_out', {
        phone: data.fromNumber,
        pattern: result.pattern,
        sourceSession: data.sessionName,
        messageText: text ?? '',
      })

      server.log.info({ phone: data.fromNumber, pattern: result.pattern }, 'Opt-out detected — phone blacklisted')
    }
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
    const beforeState = pluginRegistry.getPlugin(name)
    if (body.enabled === false) pluginRegistry.disablePlugin(name)
    if (body.enabled === true) pluginRegistry.enablePlugin(name)
    if (body.webhookUrl || body.events) pluginRegistry.updatePlugin(name, body)
    const afterState = pluginRegistry.getPlugin(name)
    auditLogger.log({
      action: 'update',
      resourceType: 'plugin',
      resourceId: name,
      beforeState: beforeState ? { status: beforeState.status, webhookUrl: beforeState.webhookUrl, events: beforeState.events } : null,
      afterState: afterState ? { status: afterState.status, webhookUrl: afterState.webhookUrl, events: afterState.events } : null,
    })
    return reply.send(afterState)
  })

  server.delete('/api/v1/admin/plugins/:name', async (req, reply) => {
    const { name } = req.params as { name: string }
    const beforeState = pluginRegistry.getPlugin(name)
    pluginRegistry.deletePlugin(name)
    auditLogger.log({
      action: 'delete',
      resourceType: 'plugin',
      resourceId: name,
      beforeState: beforeState ? { status: beforeState.status, webhookUrl: beforeState.webhookUrl, events: beforeState.events } : null,
    })
    return reply.status(204).send()
  })

  server.post('/api/v1/admin/plugins/:name/rotate-key', async (req, reply) => {
    const { name } = req.params as { name: string }
    const newKey = pluginRegistry.rotateApiKey(name)
    auditLogger.log({
      action: 'rotate_key',
      resourceType: 'plugin',
      resourceId: name,
      // Intentionally not logging the key value for security
    })
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
      // Disable autocorrect/autocomplete — prevents keyboard from altering message text
      'settings put secure spell_checker_enabled 0',
      'settings put system text_auto_replace 0',
      'settings put system text_auto_caps 0',
      'settings put system text_auto_punctuate 0',
    ]
    for (const cmd of commands) {
      adb.shell(serial, cmd).catch((err) => {
        server.log.warn({ serial, cmd, err: (err as Error).message }, 'Keep-awake command failed')
      })
    }

    // Disable Play Store to prevent WA auto-updates that could break automation
    adb.shell(serial, 'pm disable-user --user 0 com.android.vending').catch((err) => {
      server.log.warn({ serial, err: (err as Error).message }, 'Failed to disable Play Store')
    })

    // Warm contact cache from DB — eliminates cold-start cache misses
    const contacts = queue.getAllContactPhones()
    contactCache.warmUp(serial, contacts)
    server.log.info({ serial, contacts: contacts.length }, 'Contact cache warmed')
  })

  // Device discovery polling (5s) — managed by DeviceManager
  deviceManager.startPolling(5_000)

  // In-memory health map for WorkerOrchestrator (populated by health interval)
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

  // Screenshot retention cleanup (hourly) — deletes files older than retentionDays
  const screenshotCleanupInterval = setInterval(async () => {
    const retentionMs = screenshotPolicy.retentionDays * 24 * 60 * 60 * 1000
    const cutoff = Date.now() - retentionMs
    try {
      const files = await readdir('reports/sends')
      for (const file of files) {
        const filePath = `reports/sends/${file}`
        try {
          const fileStat = await stat(filePath)
          if (fileStat.mtimeMs < cutoff) {
            await unlink(filePath)
          }
        } catch { /* file may have been deleted between readdir and stat */ }
      }
    } catch { /* directory may not exist yet */ }
  }, 3_600_000)

  // Prometheus gauge refresh (30s) — queue depth + device count + sender daily counts
  const metricsInterval = setInterval(() => {
    const stats = queue.getQueueStats()
    queueDepth.set(stats.pending + stats.processing)
    devicesOnline.set(deviceManager.getDevices().filter(d => d.status === 'online').length)
    // Per-sender daily count gauges
    for (const mapping of senderMapping.listAll()) {
      const count = queue.getSenderDailyCount(mapping.phone_number)
      senderDailyCount.set({ sender: mapping.phone_number }, count)
    }
  }, 30_000)

  const cleanupInterval = setInterval(() => {
    const cleaned = queue.cleanStaleLocks()
    if (cleaned > 0) {
      server.log.info({ cleaned }, 'Cleaned stale locks')
    }
  }, 30_000)

  // DP-5: Worker orchestrator — extracted from inline closures
  const sendWindow = new SendWindow({
    start: Number(process.env.SEND_WINDOW_START) || 7,
    end: Number(process.env.SEND_WINDOW_END) || 21,
    days: process.env.SEND_WINDOW_DAYS || '1,2,3,4,5',
    utcOffsetHours: Number(process.env.SEND_WINDOW_OFFSET_HOURS) || -3,
  })

  const circuitBreaker = new DeviceCircuitBreaker()

  const orchestrator = new WorkerOrchestrator({
    db, queue, engine, adb, emitter, senderMapping, senderHealth,
    rateLimitGuard, receiptTracker, accountMutex, wahaFallback,
    messageHistory, deviceManager,
    latestHealthMap,
    logger: server.log,
    sendWindow,
    senderWarmup,
    circuitBreaker,
  })
  const workerInterval = setInterval(() => orchestrator.tick(), 5_000)
  const metadataCleanupInterval = setInterval(() => orchestrator.cleanupMetadata(), 60_000)

  // WAHA session health polling (60s) and history cleanup (hourly)
  if (sessionManager) {
    sessionManager.startHealthPolling(60_000)
  }
  const retentionDays = Number(process.env.MESSAGE_HISTORY_RETENTION_DAYS) || 90
  const historyCleanupInterval = setInterval(() => {
    messageHistory.cleanup(retentionDays)
  }, 3_600_000)

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
    'contact:opted_out',
    'sender:quarantined', 'sender:released',
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
    clearInterval(metricsInterval)
    clearInterval(screenshotCleanupInterval)
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
