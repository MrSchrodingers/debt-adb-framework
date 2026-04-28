import type { FastifyInstance } from 'fastify'
import type Database from 'better-sqlite3'
import { z } from 'zod'
import { calibrateAckRate, type AckEvent } from '../research/ack-rate-calibrator.js'
import type { AckRateThresholds } from '../research/ack-rate-thresholds.js'
import type { AckPersistFailures } from '../waha/ack-persist-failures.js'

export interface AckRateApiDeps {
  db: Database.Database
  thresholds: AckRateThresholds
  persistFailures: AckPersistFailures
}

interface SummarySenderRow {
  senderPhone: string
  totalSent: number
  totalDelivered: number
  totalRead: number
  deliveryRatio: number
  readRatio: number
  recommendedThreshold: number
  sampleWindows: number
  confidence: number
  warnings: string[]
  appliedThreshold: number | null
  appliedAt: string | null
  appliedBy: string | null
}

export interface SummaryResponse {
  perSender: SummarySenderRow[]
  globalWarnings: string[]
  dataSufficiency: 'SUFFICIENT' | 'SPARSE' | 'INSUFFICIENT'
}

export interface SparklineResponse {
  data: Array<{ ts: string; deliveryRatio: number; readRatio: number; sentTotal: number }>
}

export interface PersistFailuresResponse {
  count: number
  recent: Array<{ wahaMessageId: string; ackLevel: number; error: string; ts: string }>
}

const summaryQuerySchema = z.object({
  windowMs: z.coerce.number().int().positive().optional(),
  hours: z.coerce.number().int().positive().max(24 * 30).optional(),
  percentile: z.coerce.number().gt(0).lt(1).optional(),
  minWindows: z.coerce.number().int().positive().optional(),
})

const sparklineQuerySchema = z.object({
  days: z.coerce.number().int().positive().max(60).optional(),
})

const persistFailuresQuerySchema = z.object({
  hours: z.coerce.number().int().positive().max(24 * 30).optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
})

const applyBodySchema = z.object({
  senderPhone: z.string().min(3),
  threshold: z.number().min(0).max(1),
  windowMs: z.number().int().positive(),
  appliedBy: z.string().min(1).optional(),
})

interface AckEventRow {
  waha_message_id: string
  ack_level: number
  observed_at: string
  sender_phone: string | null
}

function loadEvents(db: Database.Database, sinceMs: number, untilMs: number): AckEvent[] {
  const sinceIso = msToSqliteDatetime(sinceMs)
  const untilIso = msToSqliteDatetime(untilMs)
  // LEFT JOIN message_history on waha_message_id to backfill sender_phone when
  // the denormalized column is NULL (race: ack arrives before message_history).
  const rows = db
    .prepare(`
      SELECT
        h.waha_message_id AS waha_message_id,
        h.ack_level AS ack_level,
        h.observed_at AS observed_at,
        COALESCE(h.sender_phone, m.from_number) AS sender_phone
      FROM message_ack_history h
      LEFT JOIN message_history m ON m.waha_message_id = h.waha_message_id
      WHERE h.observed_at >= ? AND h.observed_at <= ?
      ORDER BY h.observed_at ASC
    `)
    .all(sinceIso, untilIso) as AckEventRow[]
  return rows.map((r) => ({
    wahaMessageId: r.waha_message_id,
    ackLevel: r.ack_level,
    observedAt: sqliteDatetimeToMs(r.observed_at),
    senderPhone: r.sender_phone,
  }))
}

export function buildSummary(
  db: Database.Database,
  thresholds: AckRateThresholds,
  opts: { windowMs: number; hours: number; percentile: number; minWindows: number; now?: number },
): SummaryResponse {
  const now = opts.now ?? Date.now()
  const sinceMs = now - opts.hours * 3_600_000
  const events = loadEvents(db, sinceMs, now)

  const calibration = calibrateAckRate({
    events,
    windowMs: opts.windowMs,
    minSampleSize: opts.minWindows,
    percentile: opts.percentile,
  })

  const applied = new Map(thresholds.listActive().map((r) => [r.senderPhone, r] as const))

  const perSender: SummarySenderRow[] = []
  let sufficientSenders = 0
  for (const [senderPhone, stats] of calibration.perSender.entries()) {
    if (stats.sampleWindows >= opts.minWindows) sufficientSenders++
    const cur = applied.get(senderPhone) ?? null
    perSender.push({
      senderPhone,
      totalSent: stats.totalSent,
      totalDelivered: stats.totalDelivered,
      totalRead: stats.totalRead,
      deliveryRatio: stats.deliveryRatio,
      readRatio: stats.readRatio,
      recommendedThreshold: stats.recommendedThreshold,
      sampleWindows: stats.sampleWindows,
      confidence: stats.confidence,
      warnings: stats.warnings,
      appliedThreshold: cur?.threshold ?? null,
      appliedAt: cur?.appliedAt ?? null,
      appliedBy: cur?.appliedBy ?? null,
    })
  }
  perSender.sort((a, b) => b.totalSent - a.totalSent)

  let dataSufficiency: SummaryResponse['dataSufficiency']
  if (events.length === 0 || perSender.length === 0) {
    dataSufficiency = 'INSUFFICIENT'
  } else if (sufficientSenders >= 1) {
    dataSufficiency = 'SUFFICIENT'
  } else {
    const halfThreshold = Math.max(1, Math.floor(opts.minWindows / 2))
    const hasPartial = perSender.some((p) => p.sampleWindows >= halfThreshold)
    dataSufficiency = hasPartial ? 'SPARSE' : 'INSUFFICIENT'
  }

  return {
    perSender,
    globalWarnings: calibration.globalWarnings,
    dataSufficiency,
  }
}

export function buildSparkline(
  db: Database.Database,
  senderPhone: string,
  days: number,
  now: number = Date.now(),
): SparklineResponse {
  const sinceMs = now - days * 86_400_000
  const events = loadEvents(db, sinceMs, now)
  const senderEvents = events.filter((e) => e.senderPhone === senderPhone)

  // Per-hour buckets — bucket index = floor(observedAt / 3600000)
  const HOUR_MS = 3_600_000
  interface Bucket { sent: number; delivered: number; read: number }
  const buckets = new Map<number, Bucket>()
  // Per-message state inside a bucket, so multiple ack levels of the same
  // message collapse to a single sent/delivered/read tuple inside its bucket.
  const messageKey = new Map<string, number>()
  const messageState = new Map<string, Bucket>()
  for (const e of events.length === 0 ? [] : senderEvents) {
    const bucket = Math.floor(e.observedAt / HOUR_MS)
    const key = e.wahaMessageId
    if (!messageKey.has(key)) messageKey.set(key, bucket)
    const state = messageState.get(key) ?? { sent: 0, delivered: 0, read: 0 }
    if (e.ackLevel >= 1) state.sent = 1
    if (e.ackLevel >= 2) state.delivered = 1
    if (e.ackLevel >= 3) state.read = 1
    messageState.set(key, state)
  }
  for (const [msgId, bucket] of messageKey.entries()) {
    const state = messageState.get(msgId)!
    if (state.sent === 0) continue
    const b = buckets.get(bucket) ?? { sent: 0, delivered: 0, read: 0 }
    b.sent += state.sent
    b.delivered += state.delivered
    b.read += state.read
    buckets.set(bucket, b)
  }

  const data = [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([bucket, b]) => ({
      ts: new Date(bucket * HOUR_MS).toISOString(),
      deliveryRatio: b.sent > 0 ? b.delivered / b.sent : 0,
      readRatio: b.sent > 0 ? b.read / b.sent : 0,
      sentTotal: b.sent,
    }))

  return { data }
}

export function registerAckRateRoutes(
  server: FastifyInstance,
  deps: AckRateApiDeps,
): void {
  server.get('/api/v1/ack-rate/summary', async (request, reply) => {
    const parsed = summaryQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_query', details: parsed.error.format() })
    }
    const { windowMs = 3_600_000, hours = 24, percentile = 0.05, minWindows = 24 } = parsed.data
    const summary = buildSummary(deps.db, deps.thresholds, {
      windowMs, hours, percentile, minWindows,
    })
    return reply.send(summary)
  })

  server.get('/api/v1/ack-rate/sparkline/:senderPhone', async (request, reply) => {
    const { senderPhone } = request.params as { senderPhone: string }
    const parsed = sparklineQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_query', details: parsed.error.format() })
    }
    const { days = 7 } = parsed.data
    const result = buildSparkline(deps.db, senderPhone, days)
    return reply.send(result)
  })

  server.get('/api/v1/ack-rate/persist-failures', async (request, reply) => {
    const parsed = persistFailuresQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_query', details: parsed.error.format() })
    }
    const { hours = 24, limit = 50 } = parsed.data
    const sinceMs = Date.now() - hours * 3_600_000
    return reply.send({
      count: deps.persistFailures.countSince(sinceMs),
      recent: deps.persistFailures.recentSince(sinceMs, limit),
    } satisfies PersistFailuresResponse)
  })

  server.post('/api/v1/ack-rate/apply', async (request, reply) => {
    const parsed = applyBodySchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_body', details: parsed.error.format() })
    }
    const id = deps.thresholds.apply({
      senderPhone: parsed.data.senderPhone,
      threshold: parsed.data.threshold,
      windowMs: parsed.data.windowMs,
      appliedBy: parsed.data.appliedBy,
    })
    const active = deps.thresholds.getActive(parsed.data.senderPhone)
    return reply.status(201).send({ id, active })
  })

  server.get('/api/v1/ack-rate/applied', async (_request, reply) => {
    return reply.send({ rows: deps.thresholds.listActive() })
  })
}

function msToSqliteDatetime(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
}

function sqliteDatetimeToMs(s: string): number {
  return new Date(s.replace(' ', 'T') + 'Z').getTime()
}
