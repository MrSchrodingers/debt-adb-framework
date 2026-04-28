import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import type { MessageQueue } from '../queue/index.js'
import type { AuditLogger } from '../config/audit-logger.js'

const BULK_RETRY_MAX = 500

const bulkRetrySchema = z.object({
  message_ids: z
    .array(z.string().min(1))
    .min(1, 'At least one message_id required')
    .max(BULK_RETRY_MAX, `Cannot retry more than ${BULK_RETRY_MAX} messages at once`),
})

interface RetryFailure {
  id: string
  reason: string
}

interface BulkRetryResponse {
  retried: number
  failed: RetryFailure[]
  skipped: string[]
}

export function registerAdminMessageRoutes(
  server: FastifyInstance,
  queue: MessageQueue,
  auditLogger?: AuditLogger,
): void {
  server.post('/api/v1/admin/messages/bulk-retry', async (request, reply) => {
    const parsed = bulkRetrySchema.safeParse(request.body)
    if (!parsed.success) {
      const msg = parsed.error.issues.map(i => i.message).join('; ')
      return reply.status(400).send({ error: msg })
    }

    const { message_ids } = parsed.data
    let retried = 0
    const failed: RetryFailure[] = []
    const skipped: string[] = []

    for (const id of message_ids) {
      const message = queue.getById(id)
      if (!message) {
        failed.push({ id, reason: 'Message not found' })
        continue
      }

      // Skip already-sent messages (allowSent=false)
      if (message.status === 'sent') {
        skipped.push(id)
        continue
      }

      // Skip messages already queued (idempotent)
      if (message.status === 'queued') {
        skipped.push(id)
        continue
      }

      try {
        queue.replay(id, false)
        retried++
      } catch (err) {
        failed.push({
          id,
          reason: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // Audit log the bulk retry action
    auditLogger?.log({
      actor: 'admin',
      action: 'bulk_retry',
      resourceType: 'messages',
      afterState: { requested: message_ids.length, retried, failed: failed.length, skipped: skipped.length },
    })

    const response: BulkRetryResponse = { retried, failed, skipped }
    return response
  })
}
