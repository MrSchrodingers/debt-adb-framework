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
  // Fastify
  const server = Fastify({
    logger: {
      transport: {
        target: 'pino-pretty',
        options: { colorize: true },
      },
    },
  })
  await server.register(cors)

  // SQLite
  const db = new Database(process.env.DB_PATH || 'dispatch.db')
  db.pragma('journal_mode = WAL')

  // Core modules
  const queue = new MessageQueue(db)
  queue.initialize()

  const adb = new AdbBridge()
  const emitter = new DispatchEmitter()
  const engine = new SendEngine(adb, queue, emitter)

  // Routes
  server.get('/api/v1/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
  }))
  registerMessageRoutes(server, queue, emitter)
  registerDeviceRoutes(server, adb)

  // Stale lock cleanup — every 30s
  const cleanupInterval = setInterval(() => {
    const cleaned = queue.cleanStaleLocks()
    if (cleaned > 0) {
      server.log.info({ cleaned }, 'Cleaned stale locks')
    }
  }, 30_000)

  // Cleanup hook — must be registered BEFORE listen()
  server.addHook('onClose', () => {
    clearInterval(cleanupInterval)
    db.close()
  })

  // Start HTTP
  await server.listen({ port, host: '0.0.0.0' })

  // Socket.IO — attach to Fastify's underlying HTTP server
  const io = new SocketIOServer(server.server, { cors: { origin: '*' } })

  // Forward all DispatchEmitter events to Socket.IO
  const events: DispatchEventName[] = [
    'message:queued', 'message:sending', 'message:sent', 'message:failed',
    'device:connected', 'device:disconnected',
  ]
  for (const event of events) {
    emitter.on(event, (data) => {
      io.emit(event, data)
    })
  }

  return { server, io, queue, adb, engine, emitter }
}
