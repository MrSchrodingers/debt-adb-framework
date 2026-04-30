/**
 * Read-only quality dashboard API. Mutations remain on /senders pause/resume.
 */

import type { FastifyInstance } from 'fastify'
import type Database from 'better-sqlite3'
import { z } from 'zod'
import type { QualityHistory } from '../research/quality-history.js'
import type { ChipRegistry } from '../fleet/chip-registry.js'
import type { ComposeDeps } from '../research/quality-composer.js'
import { composeQualityInputs, fleetMedianReadRatio } from '../research/quality-composer.js'
import { computeQualityScore, QUALITY_WEIGHTS } from '../research/quality-score.js'

export interface QualityApiDeps {
  db: Database.Database
  history: QualityHistory
  chips: ChipRegistry
  composerFactory: (senderPhone: string) => ComposeDeps
}

const trendQuerySchema = z.object({
  days: z.coerce.number().int().positive().max(90).optional(),
})

const cohortQuerySchema = z.object({
  sinceMonths: z.coerce.number().int().positive().max(24).optional(),
})

export function registerQualityRoutes(server: FastifyInstance, deps: QualityApiDeps): void {
  server.get('/api/v1/quality/summary', async (_request, reply) => {
    const rows = deps.history.latestPerSender()
    return reply.send({
      rows: rows.map((r) => ({
        senderPhone: r.senderPhone,
        total: r.total,
        components: r.components,
        computedAt: r.computedAt,
      })),
      total: rows.length,
      weights: QUALITY_WEIGHTS,
    })
  })

  server.get('/api/v1/quality/trend/:phone', async (request, reply) => {
    const { phone } = request.params as { phone: string }
    const parsed = trendQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_query', details: parsed.error.format() })
    }
    const days = parsed.data.days ?? 30
    const sinceIso = new Date(Date.now() - days * 86_400_000).toISOString()
    const samples = deps.history.series(phone, sinceIso)
    return reply.send({
      senderPhone: phone,
      days,
      samples: samples.map((s) => ({
        ts: s.computedAt,
        total: s.total,
      })),
    })
  })

  server.get('/api/v1/quality/components/:phone', async (request, reply) => {
    const { phone } = request.params as { phone: string }

    const liveDeps = deps.composerFactory(phone)
    const inputs = composeQualityInputs(liveDeps)
    const result = computeQualityScore(inputs)

    const latestSample = deps.history.latest(phone)
    return reply.send({
      senderPhone: phone,
      live: {
        total: result.total,
        components: result.components,
        warmupTier: inputs.warmupTier,
        warmupTierMax: inputs.warmupTierMax,
        volumeToday: inputs.volumeToday,
        volumeDailyCap: inputs.volumeDailyCap,
        accountAgeDays: inputs.accountAgeDays,
        daysSinceLastBan: inputs.daysSinceLastBan,
      },
      lastPersisted: latestSample
        ? { total: latestSample.total, components: latestSample.components, computedAt: latestSample.computedAt }
        : null,
      weights: QUALITY_WEIGHTS,
    })
  })

  server.get('/api/v1/quality/cohort', async (request, reply) => {
    const parsed = cohortQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_query', details: parsed.error.format() })
    }
    const sinceMonths = parsed.data.sinceMonths ?? 12
    const since = new Date()
    since.setMonth(since.getMonth() - sinceMonths)
    const sinceIso = since.toISOString().slice(0, 10)

    type Row = {
      cohort_month: string
      carrier: string
      ddd: string
      total: number
      banned: number
    }
    const rows = deps.db
      .prepare(`
        SELECT
          substr(acquisition_date, 1, 7)                       AS cohort_month,
          carrier                                               AS carrier,
          substr(REPLACE(REPLACE(REPLACE(phone_number, '+', ''), ' ', ''), '-', ''), 3, 2) AS ddd,
          COUNT(*)                                              AS total,
          SUM(CASE WHEN status = 'banned' THEN 1 ELSE 0 END)    AS banned
        FROM chips
        WHERE acquisition_date >= ?
        GROUP BY cohort_month, carrier, ddd
        ORDER BY cohort_month DESC, total DESC
      `)
      .all(sinceIso) as Row[]
    return reply.send({
      sinceMonths,
      rows: rows.map((r) => ({
        cohortMonth: r.cohort_month,
        carrier: r.carrier,
        ddd: r.ddd,
        total: r.total,
        banned: r.banned,
        banRate: r.total > 0 ? r.banned / r.total : 0,
      })),
    })
  })

  server.get('/api/v1/quality/fleet-median', async (_request, reply) => {
    const median = fleetMedianReadRatio(deps.db, Date.now(), 24)
    return reply.send({ readRatioMedianLast24h: median })
  })
}
