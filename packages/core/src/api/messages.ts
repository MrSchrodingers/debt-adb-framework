import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { MessageQueue, MessageStatus } from '../queue/index.js'
import type { DispatchEmitter } from '../events/index.js'

const enqueueSchema = z.object({
  to: z.string().min(1),
  body: z.string().min(1),
  idempotencyKey: z.string().min(1),
  priority: z.number().int().min(1).max(10).optional(),
  senderNumber: z.string().optional(),
})

export function registerMessageRoutes(
  server: FastifyInstance,
  queue: MessageQueue,
  emitter: DispatchEmitter,
): void {
  server.post('/api/v1/messages', async (request, reply) => {
    const parsed = enqueueSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parsed.error.issues })
    }

    try {
      const message = queue.enqueue(parsed.data)
      emitter.emit('message:queued', { id: message.id, to: message.to, priority: message.priority })
      return reply.status(201).send(message)
    } catch (err) {
      if (err instanceof Error && err.message.includes('UNIQUE constraint failed')) {
        return reply.status(409).send({ error: 'Duplicate idempotency key' })
      }
      throw err
    }
  })

  server.get('/api/v1/messages/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const message = queue.getById(id)
    if (!message) {
      return reply.status(404).send({ error: 'Message not found' })
    }
    return message
  })

  server.get('/api/v1/messages', async (request) => {
    const { status } = request.query as { status?: string }
    return queue.list(status as MessageStatus | undefined)
  })
}
