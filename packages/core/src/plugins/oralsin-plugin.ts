import type Database from 'better-sqlite3'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import type { DispatchPlugin, PluginContext, PluginEnqueueParams } from './types.js'
import type { DispatchEventName } from '../events/index.js'
import type { GeoViewDefinition } from '../geo/types.js'

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
  manifest: import('./manifest.js').PluginManifest = {
    name: 'oralsin',
    version: '1.0.0',
    sdkVersion: '^1.0.0',
    description: 'Oralsin debt collection adapter — batch enqueue + HMAC callbacks for notification billing flows',
    author: 'DEBT',
  }
  events: DispatchEventName[] = ['message:sent', 'message:failed']
  webhookUrl: string

  private ctx: PluginContext | null = null

  /**
   * Optional DB handle for geo view aggregations. When provided, the plugin
   * registers a `oralsin.sends` GeoView that queries `messages` filtered by
   * plugin_name='oralsin'. Plugin remains functional without it (no geo tab).
   */
  constructor(webhookUrl: string, private db?: Database.Database) {
    this.webhookUrl = webhookUrl
  }

  async init(ctx: PluginContext): Promise<void> {
    this.ctx = ctx
    ctx.registerRoute('POST', '/enqueue', this.handleEnqueue.bind(this))
    ctx.registerRoute('POST', '/contacts/pre-register', this.handlePreRegister.bind(this))
    ctx.registerRoute('GET', '/status', this.handleStatus.bind(this))
    ctx.registerRoute('GET', '/queue', this.handleQueue.bind(this))
    if (this.db) {
      ctx.registerGeoView(buildOralsinSendsView(this.db))
    }
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

        // Task 5.4: pre-enqueue ban check — reject before sender resolution
        if (this.ctx.isBlacklisted(item.patient.phone)) {
          rejected.push({
            index: i,
            idempotency_key: item.idempotency_key,
            reason: `Phone ${item.patient.phone} is banned`,
          })
          continue
        }

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
        const allBanned = rejected.length > 0 && rejected.every(r => r.reason.includes('is banned'))
        return reply.status(422).send({
          error: allBanned
            ? 'No messages could be enqueued — all recipient phones are banned'
            : 'No messages could be enqueued — all sender resolutions failed',
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

// ── Geo View (Geolocalização tab) ──

/**
 * Build the Oralsin "sends" geo view. Aggregates messages by DDD of the
 * destination number, filtered by plugin_name='oralsin' and configurable
 * status. Pure SQL — no plugin state needed.
 */
export function buildOralsinSendsView(db: Database.Database): GeoViewDefinition {
  return {
    id: 'oralsin.sends',
    label: 'Envios',
    description: 'Heatmap de envios da fila por DDD do destinatário',
    group: 'oralsin',
    palette: 'sequential',
    filters: [
      { type: 'window', id: 'window', defaultValue: '7d', options: ['24h', '7d', '30d'] },
      { type: 'select', id: 'status', label: 'Status', defaultValue: 'sent',
        options: [
          { value: 'sent', label: 'Enviadas' },
          { value: 'failed', label: 'Falhadas' },
          { value: 'permanently_failed', label: 'Permanentes' },
          { value: 'queued', label: 'Em fila' },
          { value: 'sending', label: 'Enviando' },
        ] },
    ],
    aggregate: async (params) => {
      const since = windowToIso(params.window)
      const rows = db.prepare(`
        SELECT substr(to_number, 3, 2) AS ddd, COUNT(*) AS count
        FROM messages
        WHERE plugin_name = 'oralsin'
          AND status = ?
          AND created_at >= ?
        GROUP BY ddd
      `).all(params.filters.status, since) as Array<{ ddd: string; count: number }>
      const buckets: Record<string, number> = {}
      for (const r of rows) if (r.ddd) buckets[r.ddd] = r.count
      return {
        buckets,
        total: rows.reduce((s, r) => s + r.count, 0),
        generatedAt: new Date().toISOString(),
      }
    },
    drill: async (ddd, params) => {
      const since = windowToIso(params.window)
      const pageSize = params.pageSize ?? 50
      const offset = ((params.page ?? 1) - 1) * pageSize
      const rows = db.prepare(`
        SELECT id, to_number AS phone, status, created_at, sender_number
        FROM messages
        WHERE plugin_name = 'oralsin'
          AND status = ?
          AND created_at >= ?
          AND substr(to_number, 3, 2) = ?
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `).all(params.filters.status, since, ddd, pageSize, offset)
      const total = (db.prepare(`
        SELECT COUNT(*) AS c FROM messages
        WHERE plugin_name = 'oralsin' AND status = ? AND created_at >= ?
          AND substr(to_number, 3, 2) = ?
      `).get(params.filters.status, since, ddd) as { c: number }).c
      return {
        columns: [
          { key: 'id', label: 'ID', type: 'string' },
          { key: 'phone', label: 'Telefone', type: 'phone' },
          { key: 'status', label: 'Status', type: 'string' },
          { key: 'created_at', label: 'Data', type: 'date' },
          { key: 'sender_number', label: 'Sender', type: 'phone' },
        ],
        rows: rows as Array<Record<string, unknown>>,
        total, page: params.page ?? 1, pageSize,
      }
    },
  }
}

function windowToIso(window: '24h' | '7d' | '30d' | 'all'): string {
  if (window === 'all') return '1970-01-01T00:00:00.000Z'
  const ms = window === '24h' ? 24 * 60 * 60 * 1000
           : window === '7d'  ? 7  * 24 * 60 * 60 * 1000
           :                    30 * 24 * 60 * 60 * 1000
  return new Date(Date.now() - ms).toISOString()
}
