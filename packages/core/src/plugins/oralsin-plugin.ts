import { nanoid } from 'nanoid'
import { z } from 'zod'
import type { DispatchPlugin, PluginContext, PluginEnqueueParams } from './types.js'
import type { DispatchEventName } from '../events/index.js'

// ── Zod Schemas for request validation ──

const phoneSchema = z.string().regex(/^\+?\d{10,15}$/, 'Must be 10-15 digits, optional + prefix')

const senderSchema = z.object({
  phone: phoneSchema,
  session: z.string().min(1),
  pair: z.string().min(1),
  role: z.enum(['primary', 'backup', 'overflow', 'reserve']),
})

const preRegisterItemSchema = z.object({
  patient_phone: z.string().min(10).max(15),
  patient_name: z.string().min(1),
  sender_phone: z.string().min(10),
  sender_session: z.string().optional(),
})

const preRegisterRequestSchema = z.array(preRegisterItemSchema).min(1).max(500)

const enqueueItemSchema = z.object({
  idempotency_key: z.string().min(1),
  correlation_id: z.string().optional(),
  patient: z.object({
    phone: phoneSchema,
    name: z.string().min(1),
    patient_id: z.string().optional(),
  }),
  message: z.object({
    text: z.string().min(1).max(4096),
    template_id: z.string().optional(),
  }),
  senders: z.array(senderSchema).min(1),
  context: z.record(z.unknown()).optional().superRefine((val, ctx) => {
    if (val && JSON.stringify(val).length > 65536) {
      ctx.addIssue({ code: 'custom', message: 'context exceeds 64KB' })
    }
  }),
  send_options: z
    .object({
      max_retries: z.number().int().min(1).max(10).optional(),
      priority: z.enum(['normal', 'high']).optional(),
    })
    .optional(),
})

const enqueueRequestSchema = z.union([
  enqueueItemSchema,
  z.array(enqueueItemSchema).min(1).max(500),
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
    ctx.registerRoute('POST', '/contacts/pre-register', this.handlePreRegister.bind(this))
    ctx.registerRoute('GET', '/status', this.handleStatus.bind(this))
    ctx.registerRoute('GET', '/queue', this.handleQueue.bind(this))
    ctx.logger.info('Oralsin plugin initialized')
  }

  async destroy(): Promise<void> {
    this.ctx?.logger.info('Oralsin plugin destroyed')
    this.ctx = null
  }

  // ── Route Handlers ──

  private async handleEnqueue(
    request: { body: unknown; headers: Record<string, string> },
    reply: {
      status: (code: number) => { send: (data: unknown) => unknown; header?: (k: string, v: string) => unknown }
      header?: (k: string, v: string) => typeof reply
      code?: (code: number) => typeof reply
      send?: (data: unknown) => unknown
    },
  ): Promise<unknown> {
    if (!this.ctx) {
      return reply.status(503).send({ error: 'Plugin not initialized' })
    }

    const parsed = enqueueRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parsed.error.issues })
    }

    // ── Backpressure (Task 4.4) ──
    // Reject incoming batches when the queue is overloaded so upstream callers can back off.
    // The retry-after window matches Oralsin's default Retry-After honouring (30s).
    const queueDepthLimit = parseInt(process.env.DISPATCH_QUEUE_DEPTH_LIMIT ?? '1000', 10)
    const pendingNow = this.ctx.getQueueStats().pending
    if (pendingNow > queueDepthLimit) {
      const replyAny = reply as { code?: (n: number) => unknown; status: (n: number) => { header?: (k: string, v: string) => { send: (d: unknown) => unknown }; send: (d: unknown) => unknown } }
      const errBody = {
        error: 'Queue overloaded',
        pending: pendingNow,
        limit: queueDepthLimit,
        retry_after_seconds: 30,
      }
      // Fastify-style: reply.code(429).header(...).send(...). Fall back to status() for the local mock signature.
      if (typeof replyAny.code === 'function') {
        const r = replyAny.code(429) as { header: (k: string, v: string) => { send: (d: unknown) => unknown } }
        return r.header('Retry-After', '30').send(errBody)
      }
      const r = replyAny.status(429)
      if (typeof r.header === 'function') {
        return r.header('Retry-After', '30').send(errBody)
      }
      return r.send(errBody)
    }

    const items = Array.isArray(parsed.data) ? parsed.data : [parsed.data]

    try {
      const params: PluginEnqueueParams[] = []
      const rejected: Array<{ index: number; idempotency_key: string; reason: string }> = []
      const deduped: Array<{ index: number; idempotency_key: string; message_id: string; status: 'duplicate' }> = []

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

        // ── Idempotency cache check (Task 4.3) ──
        // Pre-generate an ID so the cache and the queue use the same value.
        const msgId = nanoid()
        if (this.ctx.idempotencyCache) {
          const { hit, messageId: cachedId } = this.ctx.idempotencyCache.checkAndReserve(
            item.idempotency_key,
            msgId,
          )
          if (hit) {
            deduped.push({
              index: i,
              idempotency_key: item.idempotency_key,
              message_id: cachedId,
              status: 'duplicate',
            })
            continue
          }
        }

        params.push({
          id: msgId,
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

      if (params.length === 0 && deduped.length === 0) {
        return reply.status(422).send({
          error: 'No messages could be enqueued — all sender resolutions failed',
          rejected,
        })
      }

      const messages = params.length > 0 ? this.ctx.enqueue(params) : []

      return reply.status(201).send({
        enqueued: messages.length,
        deduped: deduped.length,
        rejected: rejected.length,
        messages: messages.map((m) => ({
          id: m.id,
          idempotency_key: m.idempotencyKey,
          status: m.status,
        })),
        ...(deduped.length > 0 ? { deduped_details: deduped } : {}),
        ...(rejected.length > 0 ? { rejected_details: rejected } : {}),
      })
    } catch (err) {
      if (err instanceof Error && err.message.includes('UNIQUE constraint failed')) {
        return reply.status(409).send({ error: 'Duplicate idempotency key' })
      }
      throw err
    }
  }

  private async handlePreRegister(request: { body: unknown; headers: Record<string, string> }, reply: { status: (code: number) => { send: (data: unknown) => unknown } }): Promise<unknown> {
    if (!this.ctx) {
      return reply.status(503).send({ error: 'Plugin not initialized' })
    }

    const parsed = preRegisterRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parsed.error.issues })
    }

    const results: Array<{ phone: string; status: string; reason?: string }> = []
    let registered = 0
    let skipped = 0
    let errors = 0

    for (const item of parsed.data) {
      const result = await this.ctx.registerContact(
        item.sender_phone,
        item.patient_phone,
        item.patient_name,
      )

      if (result.status === 'registered') {
        registered++
        results.push({ phone: item.patient_phone, status: 'registered' })
      } else if (result.status === 'exists') {
        skipped++
        results.push({ phone: item.patient_phone, status: 'skipped', reason: 'already_exists' })
      } else {
        errors++
        results.push({ phone: item.patient_phone, status: 'error', reason: result.error })
      }
    }

    this.ctx.logger.info(`Pre-register batch: ${registered} registered, ${skipped} skipped, ${errors} errors`)

    return reply.status(200).send({ registered, skipped, errors, details: results })
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
