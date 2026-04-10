import { z } from 'zod'
import type { DispatchPlugin, PluginContext, PluginEnqueueParams } from './types.js'
import type { DispatchEventName } from '../events/index.js'

// ── Zod Schemas for request validation ──

const senderSchema = z.object({
  phone: z.string().min(10),
  session: z.string().min(1),
  pair: z.string().min(1),
  role: z.enum(['primary', 'backup', 'overflow', 'reserve']),
})

const enqueueItemSchema = z.object({
  idempotency_key: z.string().min(1),
  correlation_id: z.string().optional(),
  patient: z.object({
    phone: z.string().min(10),
    name: z.string().min(1),
    patient_id: z.string().optional(),
  }),
  message: z.object({
    text: z.string().min(1),
    template_id: z.string().optional(),
  }),
  senders: z.array(senderSchema).min(1),
  context: z.record(z.unknown()).optional(),
  send_options: z
    .object({
      max_retries: z.number().int().min(1).max(10).optional(),
      priority: z.enum(['normal', 'high']).optional(),
    })
    .optional(),
})

const enqueueRequestSchema = z.union([
  enqueueItemSchema,
  z.array(enqueueItemSchema).min(1),
])

// ── Plugin Implementation ──

export class OralsinPlugin implements DispatchPlugin {
  name = 'oralsin' as const
  version = '1.0.0'
  events: DispatchEventName[] = ['message:sent', 'message:failed']
  webhookUrl: string

  private ctx: PluginContext | null = null

  constructor(webhookUrl: string) {
    this.webhookUrl = webhookUrl
  }

  async init(ctx: PluginContext): Promise<void> {
    this.ctx = ctx
    ctx.registerRoute('POST', '/enqueue', this.handleEnqueue.bind(this))
    ctx.registerRoute('GET', '/status', this.handleStatus.bind(this))
    ctx.registerRoute('GET', '/queue', this.handleQueue.bind(this))
    ctx.logger.info('Oralsin plugin initialized')
  }

  async destroy(): Promise<void> {
    this.ctx?.logger.info('Oralsin plugin destroyed')
    this.ctx = null
  }

  // ── Route Handlers ──

  private async handleEnqueue(request: { body: unknown; headers: Record<string, string> }, reply: { status: (code: number) => { send: (data: unknown) => unknown } }): Promise<unknown> {
    if (!this.ctx) {
      return reply.status(503).send({ error: 'Plugin not initialized' })
    }

    const parsed = enqueueRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parsed.error.issues })
    }

    const items = Array.isArray(parsed.data) ? parsed.data : [parsed.data]

    try {
      const params: PluginEnqueueParams[] = []
      const rejected: Array<{ index: number; idempotency_key: string; reason: string }> = []

      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        // Resolve sender via mapping — walk senders[] in order
        const resolved = this.ctx.resolveSenderChain(item.senders)

        if (!resolved) {
          rejected.push({
            index: i,
            idempotency_key: item.idempotency_key,
            reason: `No sender mapping for: ${item.senders.map((s: { phone: string }) => s.phone).join(', ')}`,
          })
          continue // Skip this item, process the rest
        }

        params.push({
          idempotencyKey: item.idempotency_key,
          correlationId: item.correlation_id,
          patient: {
            phone: item.patient.phone,
            name: item.patient.name,
            patientId: item.patient.patient_id,
          },
          message: {
            text: item.message.text,
            templateId: item.message.template_id,
          },
          senders: item.senders,
          context: item.context,
          sendOptions: item.send_options
            ? {
                maxRetries: item.send_options.max_retries,
                priority: item.send_options.priority,
              }
            : undefined,
          resolvedSenderPhone: resolved.mapping.phone_number,
        })
      }

      if (params.length === 0) {
        return reply.status(422).send({
          error: 'No messages could be enqueued — all sender resolutions failed',
          rejected,
        })
      }

      const messages = this.ctx.enqueue(params)

      return reply.status(201).send({
        enqueued: messages.length,
        rejected: rejected.length,
        messages: messages.map((m) => ({
          id: m.id,
          idempotency_key: m.idempotencyKey,
          status: m.status,
        })),
        ...(rejected.length > 0 ? { rejected_details: rejected } : {}),
      })
    } catch (err) {
      if (err instanceof Error && err.message.includes('UNIQUE constraint failed')) {
        return reply.status(409).send({ error: 'Duplicate idempotency key' })
      }
      throw err
    }
  }

  private async handleStatus(_request: unknown, reply: { status: (code: number) => { send: (data: unknown) => unknown } }): Promise<unknown> {
    return reply.status(200).send({
      plugin: this.name,
      version: this.version,
      status: 'active',
      events: this.events,
    })
  }

  private async handleQueue(_request: unknown, reply: { status: (code: number) => { send: (data: unknown) => unknown } }): Promise<unknown> {
    if (!this.ctx) {
      return reply.status(503).send({ error: 'Plugin not initialized' })
    }

    const stats = this.ctx.getQueueStats()

    return reply.status(200).send({
      pending: stats.pending,
      processing: stats.processing,
      failed_last_hour: stats.failedLastHour,
      oldest_pending_age_seconds: stats.oldestPendingAgeSeconds,
    })
  }
}
