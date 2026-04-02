import Fastify from 'fastify'
import cors from '@fastify/cors'
import Database from 'better-sqlite3'
import { Server as SocketIOServer } from 'socket.io'
import { MessageQueue } from './queue/index.js'
import { AdbBridge } from './adb/index.js'
import { SendEngine } from './engine/index.js'
import { DispatchEmitter } from './events/index.js'
import { registerMessageRoutes, registerDeviceRoutes, registerMonitorRoutes, registerWahaRoutes, registerSessionRoutes } from './api/index.js'
import { DeviceManager, HealthCollector, WaAccountMapper, AlertSystem } from './monitor/index.js'
import { SessionManager, WebhookHandler, MessageHistory } from './waha/index.js'
import { createWahaHttpClient } from './waha/waha-http-client.js'
import { createChatwootHttpClient, ManagedSessions, InboxAutomation } from './chatwoot/index.js'
import type { DispatchEventName } from './events/index.js'

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

  server.addHook('onClose', () => {
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
    'waha:message_received', 'waha:message_sent', 'waha:session_status',
  ]
  for (const event of events) {
    emitter.on(event, (data) => io.emit(event, data))
  }

  return { server, io, queue, adb, engine, emitter }
}
