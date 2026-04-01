import Fastify from 'fastify'
import cors from '@fastify/cors'
import Database from 'better-sqlite3'
import { Server as SocketIOServer } from 'socket.io'
import { MessageQueue } from './queue/index.js'
import { AdbBridge } from './adb/index.js'
import { SendEngine } from './engine/index.js'
import { DispatchEmitter } from './events/index.js'
import { registerMessageRoutes, registerDeviceRoutes } from './api/index.js'
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

  server.get('/api/v1/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
  }))
  registerMessageRoutes(server, queue, emitter)
  registerDeviceRoutes(server, adb)

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
      const devices = await adb.discover()
      const online = devices.find(d => d.type === 'device')
      if (!online) return

      const message = queue.dequeue(online.serial)
      if (!message) return

      server.log.info({ messageId: message.id, device: online.serial }, 'Worker: sending message')
      await engine.send(message, online.serial)
    } catch (err) {
      server.log.error({ err }, 'Worker: send failed')
    } finally {
      workerRunning = false
    }
  }, 5_000)

  server.addHook('onClose', () => {
    clearInterval(cleanupInterval)
    clearInterval(workerInterval)
    db.close()
  })

  await server.listen({ port, host: '0.0.0.0' })

  const io = new SocketIOServer(server.server, { cors: { origin: '*' } })

  const events: DispatchEventName[] = [
    'message:queued', 'message:sending', 'message:sent', 'message:failed',
    'device:connected', 'device:disconnected',
  ]
  for (const event of events) {
    emitter.on(event, (data) => io.emit(event, data))
  }

  return { server, io, queue, adb, engine, emitter }
}
