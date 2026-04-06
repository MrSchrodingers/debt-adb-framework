import Fastify from 'fastify'
import cors from '@fastify/cors'
import Database from 'better-sqlite3'
import { Server as SocketIOServer } from 'socket.io'
import { MessageQueue } from './queue/index.js'
import { AdbBridge } from './adb/index.js'
import { SendEngine } from './engine/index.js'
import { DispatchEmitter } from './events/index.js'
import { registerMessageRoutes, registerDeviceRoutes, registerMonitorRoutes, registerWahaRoutes, registerSessionRoutes, registerMetricsRoutes } from './api/index.js'
import { DeviceManager, HealthCollector, WaAccountMapper, AlertSystem } from './monitor/index.js'
import { SessionManager, WebhookHandler, MessageHistory } from './waha/index.js'
import { createWahaHttpClient } from './waha/waha-http-client.js'
import { createChatwootHttpClient, ManagedSessions, InboxAutomation } from './chatwoot/index.js'
import { PluginRegistry, PluginEventBus, CallbackDelivery, PluginLoader } from './plugins/index.js'
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
}

export async function createServer(port = Number(process.env.PORT) || 7890): Promise<DispatchCore> {
  const server = Fastify({
    logger: {
      transport: {
        target: 'pino-pretty',
        options: { colorize: true },
      },
    },
  })
  await server.register(cors)

  const db = new Database(process.env.DB_PATH || 'dispatch.db')
  db.pragma('journal_mode = WAL')

  const queue = new MessageQueue(db)
  queue.initialize()

  const adb = new AdbBridge()
  const emitter = new DispatchEmitter()
  const engine = new SendEngine(adb, queue, emitter)

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

  server.get('/api/v1/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
  }))
  registerMessageRoutes(server, queue, emitter)
  registerDeviceRoutes(server, adb)
  registerMonitorRoutes(server, { adb, engine, deviceManager, healthCollector, waMapper, alertSystem })

  // WAHA routes always registered (webhook receiver works without WAHA client)
  // sessionManager may be null if WAHA_API_URL not configured
  registerWahaRoutes(server, { webhookHandler, sessionManager, messageHistory })

  // Session management routes (Phase 5)
  registerSessionRoutes(server, { inboxAutomation, managedSessions })

  // Metrics routes (Phase 6)
  registerMetricsRoutes(server, db)

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

  // ── Plugin System (Phase 7) ──
  const pluginRegistry = new PluginRegistry(db)
  pluginRegistry.initialize()
  const pluginEventBus = new PluginEventBus(pluginRegistry, emitter)
  const callbackDelivery = new CallbackDelivery(db, pluginRegistry, fetch)
  const pinoLogger = { child: (bindings: Record<string, unknown>) => ({ info: server.log.info.bind(server.log), warn: server.log.warn.bind(server.log), error: server.log.error.bind(server.log), debug: server.log.debug.bind(server.log) }) }
  const pluginLoader = new PluginLoader(pluginRegistry, pluginEventBus, queue, db, pinoLogger)

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
    emitter.on('message:sent', (data) => {
      const msg = queue.getById(data.id)
      if (msg?.pluginName) {
        void callbackDelivery.sendResultCallback(msg.pluginName, msg.id, {
          idempotency_key: msg.idempotencyKey,
          correlation_id: msg.correlationId ?? undefined,
          status: 'sent',
          sent_at: data.sentAt,
          delivery: {
            message_id: msg.wahaMessageId,
            provider: 'adb',
            sender_phone: msg.senderNumber ?? '',
            sender_session: '',
            pair_used: '',
            used_fallback: false,
            elapsed_ms: data.durationMs,
          },
          error: null,
          context: msg.context ? JSON.parse(msg.context) : undefined,
        })
      }
    })

    emitter.on('message:failed', (data) => {
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
  }

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

  // Device discovery polling (5s) — managed by DeviceManager
  deviceManager.startPolling(5_000)

  // Health collection polling (30s) — per-device error isolation
  const healthInterval = setInterval(async () => {
    for (const device of deviceManager.getDevices()) {
      if (device.status !== 'online') continue
      try {
        const snapshot = await healthCollector.collect(device.serial)
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

  // WA account mapping (every 5 minutes) — per-device error isolation
  const accountInterval = setInterval(async () => {
    for (const device of deviceManager.getDevices()) {
      if (device.status !== 'online') continue
      try {
        await waMapper.mapAccounts(device.serial)
      } catch (err) {
        server.log.error({ err, serial: device.serial }, 'WA account mapping failed for device')
      }
    }
  }, 300_000)

  // Health data cleanup (hourly, removes > 7 days)
  const healthCleanupInterval = setInterval(() => {
    healthCollector.cleanup()
  }, 3_600_000)

  const cleanupInterval = setInterval(() => {
    const cleaned = queue.cleanStaleLocks()
    if (cleaned > 0) {
      server.log.info({ cleaned }, 'Cleaned stale locks')
    }
  }, 30_000)

  const workerInterval = setInterval(async () => {
    if (workerRunning) return
    workerRunning = true

    try {
      const online = deviceManager.getDevices().find(d => d.status === 'online')
      if (!online) return

      const message = queue.dequeue(online.serial)
      if (!message) return

      server.log.info({ messageId: message.id, device: online.serial }, 'Worker: sending message')
      await engine.send(message, online.serial)

      // Correlation fix: record ADB send in message_history for WAHA dedup
      messageHistory.insert({
        messageId: message.id,
        direction: 'outgoing',
        fromNumber: message.senderNumber,
        toNumber: message.to,
        text: message.body,
        deviceSerial: online.serial,
        capturedVia: 'adb_send',
      })
    } catch (err) {
      server.log.error({ err }, 'Worker: send failed')
    } finally {
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

  server.addHook('onClose', async () => {
    await pluginLoader.destroyAll()
    pluginEventBus.destroy()
    deviceManager.stop()
    sessionManager?.stop()
    clearInterval(healthInterval)
    clearInterval(accountInterval)
    clearInterval(healthCleanupInterval)
    clearInterval(historyCleanupInterval)
    clearInterval(cleanupInterval)
    clearInterval(workerInterval)
    db.close()
  })

  await server.listen({ port, host: '0.0.0.0' })

  const io = new SocketIOServer(server.server, { cors: { origin: '*' } })

  const events: DispatchEventName[] = [
    'message:queued', 'message:sending', 'message:sent', 'message:failed',
    'device:connected', 'device:disconnected', 'device:health', 'alert:new',
    'waha:message_received', 'waha:message_sent', 'waha:session_status', 'waha:message_ack',
  ]
  for (const event of events) {
    emitter.on(event, (data) => io.emit(event, data))
  }

  return { server, io, queue, adb, engine, emitter }
}
