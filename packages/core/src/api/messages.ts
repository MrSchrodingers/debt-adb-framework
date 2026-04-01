import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { MessageQueue, MessageStatus } from '../queue/index.js'
import type { DispatchEmitter } from '../events/index.js'

const VALID_STATUSES = ['queued', 'locked', 'sending', 'sent', 'failed'] as const

const enqueueSchema = z.object({
  to: z.string().regex(/^\d{10,15}$/, 'Phone must be 10-15 digits'),
  body: z.string().min(1).max(4096),
  idempotencyKey: z.string().min(1),
  priority: z.number().int().min(1).max(10).optional(),
  senderNumber: z.string().regex(/^\d{10,15}$/).optional(),
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

  server.get('/api/v1/messages', async (request, reply) => {
    const { status } = request.query as { status?: string }
    if (status && !VALID_STATUSES.includes(status as MessageStatus)) {
      return reply.status(400).send({ error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` })
    }
    return queue.list(status as MessageStatus | undefined)
  })
}
