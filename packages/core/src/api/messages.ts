import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { MessageQueue, MessageStatus } from '../queue/index.js'
import type { DispatchEmitter } from '../events/index.js'

const VALID_STATUSES: readonly MessageStatus[] = ['queued', 'locked', 'sending', 'sent', 'failed', 'permanently_failed', 'waiting_device']

const ALLOWED_MEDIA_TYPES = [
  'image/jpeg', 'image/png', 'image/webp', 'application/pdf',
] as const

const enqueueSchema = z.object({
  to: z.string().regex(/^\d{10,15}$/, 'Phone must be 10-15 digits'),
  body: z.string().min(1).max(4096),
  idempotencyKey: z.string().min(1),
  priority: z.number().int().min(1).max(10).optional(),
  senderNumber: z.string().regex(/^\d{10,15}$/).optional(),
  contactName: z.string().min(1).max(100).optional(),
  mediaUrl: z.string().url().optional(),
  mediaType: z.enum(ALLOWED_MEDIA_TYPES).optional(),
  mediaCaption: z.string().max(4096).optional(),
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
      // Pre-register contact name if provided
      if (parsed.data.contactName) {
        queue.saveContact(parsed.data.to, parsed.data.contactName)
      }
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
    const query = request.query as {
      status?: string
      limit?: string
      offset?: string
      pluginName?: string
      phone?: string
      senderNumber?: string
      dateFrom?: string
      dateTo?: string
    }

    if (query.status && !VALID_STATUSES.includes(query.status as MessageStatus)) {
      return reply.status(400).send({ error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` })
    }

    // If any pagination/filter param is present, use paginated method
    const hasPagination = query.limit || query.offset || query.pluginName || query.phone || query.senderNumber || query.dateFrom || query.dateTo
    if (hasPagination) {
      return queue.listPaginated({
        limit: query.limit ? Number(query.limit) : undefined,
        offset: query.offset ? Number(query.offset) : undefined,
        status: query.status,
        pluginName: query.pluginName,
        phone: query.phone,
        senderNumber: query.senderNumber,
        dateFrom: query.dateFrom,
        dateTo: query.dateTo,
      })
    }

    // Legacy: return flat array for backward compatibility
    return queue.list(query.status as MessageStatus | undefined)
  })
}
