import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  buildActivityUrl,
  buildDealAllFailActivity,
  buildDealUrl,
  buildPastaSummaryNote,
  buildPhoneFailActivity,
  type PipedriveActivityRow,
  type PipedriveActivityStore,
  type PipedriveScenario,
  type PipedriveStatus,
} from '../plugins/adb-precheck/index.js'
import type { PipedriveClient } from '../plugins/adb-precheck/pipedrive-client.js'
import type { PipedrivePublisher } from '../plugins/adb-precheck/pipedrive-publisher.js'
import type {
  PipedriveDealAllFailIntent,
  PipedrivePastaSummaryIntent,
  PipedrivePhoneFailIntent,
} from '../plugins/adb-precheck/types.js'

/**
 * Operator-facing API for the Pipedrive integration.
 *
 * All routes mount under /api/v1/pipedrive and are protected by the global
 * X-API-Key / Bearer auth gate (see api-auth.ts). When the integration is
 * disabled (no PIPEDRIVE_API_TOKEN in env), the routes return 503 so the UI
 * can render an explanatory empty state.
 */
export interface PipedriveApiDeps {
  /** Null when integration is disabled. */
  store: PipedriveActivityStore | null
  client: PipedriveClient | null
  publisher: PipedrivePublisher | null
  companyDomain: string | null
  cacheTtlDays?: number
  baseUrl?: string
}

const scenarioEnum = z.enum(['phone_fail', 'deal_all_fail', 'pasta_summary'])
const statusEnum = z.enum(['success', 'failed', 'retrying'])

const listQuerySchema = z.object({
  scenario: scenarioEnum.optional(),
  status: statusEnum.optional(),
  deal_id: z.coerce.number().int().positive().optional(),
  pasta: z.string().min(1).max(255).optional(),
  since: z.string().min(1).max(64).optional(),
  until: z.string().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
})

const phoneFailBodySchema = z.object({
  scenario: z.literal('phone_fail'),
  deal_id: z.number().int().positive(),
  pasta: z.string().min(1),
  phone: z.string().min(8),
  column: z.string().min(1),
  strategy: z.string().min(1),
  confidence: z.number().nullable().optional(),
  job_id: z.string().min(1).optional(),
  cache_ttl_days: z.number().int().positive().optional(),
})

const dealAllFailBodySchema = z.object({
  scenario: z.literal('deal_all_fail'),
  deal_id: z.number().int().positive(),
  pasta: z.string().min(1),
  motivo: z.string().min(1).default('todos_telefones_invalidos'),
  job_id: z.string().min(1).optional(),
  phones: z
    .array(
      z.object({
        column: z.string().min(1),
        phone: z.string().min(8),
        outcome: z.enum(['valid', 'invalid', 'error']),
        strategy: z.string().min(1),
        confidence: z.number().nullable().optional(),
      }),
    )
    .min(1)
    .max(20),
})

const pastaSummaryBodySchema = z.object({
  scenario: z.literal('pasta_summary'),
  pasta: z.string().min(1),
  first_deal_id: z.number().int().positive(),
  job_id: z.string().min(1).optional(),
  total_deals: z.number().int().min(0).default(0),
  ok_deals: z.number().int().min(0).default(0),
  archived_deals: z.number().int().min(0).default(0),
  total_phones_checked: z.number().int().min(0).default(0),
  ok_phones: z.number().int().min(0).default(0),
  strategy_counts: z
    .object({
      adb: z.number().int().min(0).default(0),
      waha: z.number().int().min(0).default(0),
      cache: z.number().int().min(0).default(0),
    })
    .default({ adb: 0, waha: 0, cache: 0 }),
})

const previewBodySchema = z.discriminatedUnion('scenario', [
  phoneFailBodySchema,
  dealAllFailBodySchema,
  pastaSummaryBodySchema,
])

const manualTriggerBodySchema = z.discriminatedUnion('scenario', [
  phoneFailBodySchema.extend({ triggered_by: z.string().min(1).max(120).optional() }),
  dealAllFailBodySchema.extend({ triggered_by: z.string().min(1).max(120).optional() }),
  pastaSummaryBodySchema.extend({ triggered_by: z.string().min(1).max(120).optional() }),
])

const periodEnum = z.enum(['today', '7d', '30d', 'all'])
const statsQuerySchema = z.object({ period: periodEnum.optional() })

function rowWithUrls(
  row: PipedriveActivityRow,
  companyDomain: string | null,
): PipedriveActivityRow & { dealUrl: string | null; activityUrl: string | null } {
  return {
    ...row,
    dealUrl: buildDealUrl(row.deal_id, companyDomain),
    activityUrl: buildActivityUrl(row.deal_id, row.pipedrive_response_id, companyDomain),
  }
}

function buildPreviewPayload(
  body: z.infer<typeof previewBodySchema>,
  companyDomain: string | null,
  cacheTtlDays?: number,
): {
  endpoint: '/activities' | '/notes'
  subject: string | null
  type: string | null
  markdownBody: string
  dealUrl: string | null
} {
  if (body.scenario === 'phone_fail') {
    const intent: PipedrivePhoneFailIntent = {
      scenario: 'phone_fail',
      deal_id: body.deal_id,
      pasta: body.pasta,
      phone: body.phone,
      column: body.column,
      strategy: body.strategy,
      confidence: body.confidence ?? null,
      job_id: body.job_id ?? 'manual-preview',
      occurred_at: new Date().toISOString(),
      cache_ttl_days: body.cache_ttl_days ?? cacheTtlDays,
    }
    const a = buildPhoneFailActivity(intent, companyDomain)
    return {
      endpoint: '/activities',
      subject: a.payload.subject,
      type: a.payload.type,
      markdownBody: a.payload.note,
      dealUrl: buildDealUrl(body.deal_id, companyDomain),
    }
  }
  if (body.scenario === 'deal_all_fail') {
    const intent: PipedriveDealAllFailIntent = {
      scenario: 'deal_all_fail',
      deal_id: body.deal_id,
      pasta: body.pasta,
      motivo: body.motivo,
      phones: body.phones.map((p) => ({
        column: p.column,
        phone: p.phone,
        outcome: p.outcome,
        strategy: p.strategy,
        confidence: p.confidence ?? null,
      })),
      job_id: body.job_id ?? 'manual-preview',
      occurred_at: new Date().toISOString(),
    }
    const a = buildDealAllFailActivity(intent, companyDomain)
    return {
      endpoint: '/activities',
      subject: a.payload.subject,
      type: a.payload.type,
      markdownBody: a.payload.note,
      dealUrl: buildDealUrl(body.deal_id, companyDomain),
    }
  }
  // pasta_summary
  const intent: PipedrivePastaSummaryIntent = {
    scenario: 'pasta_summary',
    pasta: body.pasta,
    first_deal_id: body.first_deal_id,
    job_id: body.job_id ?? 'manual-preview',
    job_started: null,
    job_ended: null,
    total_deals: body.total_deals,
    ok_deals: body.ok_deals,
    archived_deals: body.archived_deals,
    total_phones_checked: body.total_phones_checked,
    ok_phones: body.ok_phones,
    strategy_counts: body.strategy_counts,
  }
  const n = buildPastaSummaryNote(intent, companyDomain)
  return {
    endpoint: '/notes',
    subject: null,
    type: null,
    markdownBody: n.payload.content,
    dealUrl: buildDealUrl(body.first_deal_id, companyDomain),
  }
}

function unavailable(reply: { status: (n: number) => { send: (b: unknown) => unknown } }) {
  return reply.status(503).send({
    error: 'pipedrive_disabled',
    detail: 'PIPEDRIVE_API_TOKEN is not set on this instance',
  })
}

export function registerPipedriveRoutes(server: FastifyInstance, deps: PipedriveApiDeps): void {
  // ── Health ─────────────────────────────────────────────────────────────
  server.get('/api/v1/pipedrive/health', async (_req, reply) => {
    if (!deps.client) {
      return reply.send({
        tokenValid: false,
        enabled: false,
        domain: deps.companyDomain,
        baseUrl: deps.baseUrl ?? null,
      })
    }
    const r = await deps.client.whoami()
    return reply.send({
      tokenValid: r.ok,
      enabled: true,
      ownerName: r.name ?? null,
      ownerEmail: r.email ?? null,
      company: r.company_name ?? null,
      companyDomainRemote: r.company_domain ?? null,
      domain: deps.companyDomain,
      baseUrl: deps.baseUrl ?? null,
      error: r.ok ? null : r.error,
    })
  })

  // ── List activities ────────────────────────────────────────────────────
  server.get('/api/v1/pipedrive/activities', async (request, reply) => {
    if (!deps.store) return unavailable(reply)
    const parsed = listQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_query', details: parsed.error.format() })
    }
    const { items, total } = deps.store.list(parsed.data)
    return reply.send({
      items: items.map((r) => rowWithUrls(r, deps.companyDomain)),
      total,
    })
  })

  // ── Get single activity ────────────────────────────────────────────────
  server.get('/api/v1/pipedrive/activities/:id', async (request, reply) => {
    if (!deps.store) return unavailable(reply)
    const { id } = request.params as { id: string }
    const row = deps.store.getById(id)
    if (!row) return reply.status(404).send({ error: 'not_found' })
    return reply.send(rowWithUrls(row, deps.companyDomain))
  })

  // ── Retry a failed activity (re-enqueue) ───────────────────────────────
  server.post('/api/v1/pipedrive/activities/:id/retry', async (request, reply) => {
    if (!deps.store || !deps.publisher) return unavailable(reply)
    const { id } = request.params as { id: string }
    const row = deps.store.getById(id)
    if (!row) return reply.status(404).send({ error: 'not_found' })
    // Rebuild the original intent from the persisted payload so dedup/format
    // are deterministic. We bypass dedup memory by appending a fresh job_id
    // suffix on retries — the dedup key is intent-specific (scenario + deal +
    // phone + job_id), and the publisher's seenDedupKeys is in-memory only,
    // so a different suffix produces a new intent record.
    const retrySuffix = `retry-${Date.now()}`
    let newRowId: string | null = null
    const triggered_by = (request.headers['x-triggered-by'] as string | undefined) ?? 'operator'

    if (row.scenario === 'phone_fail') {
      const original = JSON.parse(row.pipedrive_payload_json) as { deal_id: number; note: string }
      newRowId = deps.publisher.enqueuePhoneFail(
        {
          scenario: 'phone_fail',
          deal_id: original.deal_id,
          pasta: row.pasta ?? '',
          phone: row.phone_normalized ?? '',
          column: 'unknown',
          strategy: 'manual_retry',
          confidence: null,
          job_id: `${row.job_id ?? 'manual'}-${retrySuffix}`,
          occurred_at: new Date().toISOString(),
          cache_ttl_days: deps.cacheTtlDays,
        },
        { manual: true, triggered_by },
      )
    } else if (row.scenario === 'deal_all_fail') {
      newRowId = deps.publisher.enqueueDealAllFail(
        {
          scenario: 'deal_all_fail',
          deal_id: row.deal_id,
          pasta: row.pasta ?? '',
          motivo: 'manual_retry',
          phones: [],
          job_id: `${row.job_id ?? 'manual'}-${retrySuffix}`,
          occurred_at: new Date().toISOString(),
        },
        { manual: true, triggered_by },
      )
    } else {
      newRowId = deps.publisher.enqueuePastaSummary(
        {
          scenario: 'pasta_summary',
          pasta: row.pasta ?? '',
          first_deal_id: row.deal_id,
          job_id: `${row.job_id ?? 'manual'}-${retrySuffix}`,
          job_started: null,
          job_ended: null,
          total_deals: 0,
          ok_deals: 0,
          archived_deals: 0,
          total_phones_checked: 0,
          ok_phones: 0,
          strategy_counts: { adb: 0, waha: 0, cache: 0 },
        },
        { manual: true, triggered_by },
      )
    }
    return reply.status(202).send({ retried: true, originalId: id, newAttemptId: newRowId })
  })

  // ── Render preview without sending ─────────────────────────────────────
  server.post('/api/v1/pipedrive/preview', async (request, reply) => {
    const parsed = previewBodySchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_body', details: parsed.error.format() })
    }
    const out = buildPreviewPayload(parsed.data, deps.companyDomain, deps.cacheTtlDays)
    return reply.send(out)
  })

  // ── Manual trigger (operator-driven, persists with manual=1) ──────────
  server.post('/api/v1/pipedrive/manual-trigger', async (request, reply) => {
    if (!deps.publisher) return unavailable(reply)
    const parsed = manualTriggerBodySchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_body', details: parsed.error.format() })
    }
    const triggered_by =
      parsed.data.triggered_by ?? (request.headers['x-triggered-by'] as string | undefined) ?? 'operator'
    const jobIdSuffix = `manual-${Date.now()}`
    let newRowId: string | null = null
    if (parsed.data.scenario === 'phone_fail') {
      newRowId = deps.publisher.enqueuePhoneFail(
        {
          scenario: 'phone_fail',
          deal_id: parsed.data.deal_id,
          pasta: parsed.data.pasta,
          phone: parsed.data.phone,
          column: parsed.data.column,
          strategy: parsed.data.strategy,
          confidence: parsed.data.confidence ?? null,
          job_id: parsed.data.job_id ?? jobIdSuffix,
          occurred_at: new Date().toISOString(),
          cache_ttl_days: parsed.data.cache_ttl_days ?? deps.cacheTtlDays,
        },
        { manual: true, triggered_by },
      )
    } else if (parsed.data.scenario === 'deal_all_fail') {
      newRowId = deps.publisher.enqueueDealAllFail(
        {
          scenario: 'deal_all_fail',
          deal_id: parsed.data.deal_id,
          pasta: parsed.data.pasta,
          motivo: parsed.data.motivo,
          phones: parsed.data.phones.map((p) => ({
            column: p.column,
            phone: p.phone,
            outcome: p.outcome,
            strategy: p.strategy,
            confidence: p.confidence ?? null,
          })),
          job_id: parsed.data.job_id ?? jobIdSuffix,
          occurred_at: new Date().toISOString(),
        },
        { manual: true, triggered_by },
      )
    } else {
      newRowId = deps.publisher.enqueuePastaSummary(
        {
          scenario: 'pasta_summary',
          pasta: parsed.data.pasta,
          first_deal_id: parsed.data.first_deal_id,
          job_id: parsed.data.job_id ?? jobIdSuffix,
          job_started: null,
          job_ended: null,
          total_deals: parsed.data.total_deals,
          ok_deals: parsed.data.ok_deals,
          archived_deals: parsed.data.archived_deals,
          total_phones_checked: parsed.data.total_phones_checked,
          ok_phones: parsed.data.ok_phones,
          strategy_counts: parsed.data.strategy_counts,
        },
        { manual: true, triggered_by },
      )
    }
    return reply.status(201).send({ triggered: true, activityId: newRowId, triggered_by })
  })

  // ── Stats ──────────────────────────────────────────────────────────────
  server.get('/api/v1/pipedrive/stats', async (request, reply) => {
    if (!deps.store) return unavailable(reply)
    const parsed = statsQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_query', details: parsed.error.format() })
    }
    const period = parsed.data.period ?? 'all'
    const stats = deps.store.stats(period)
    return reply.send(stats)
  })
}

export {
  listQuerySchema as _listQuerySchema,
  previewBodySchema as _previewBodySchema,
  manualTriggerBodySchema as _manualTriggerBodySchema,
}
export type {
  PipedriveScenario as _PipedriveScenarioApi,
  PipedriveStatus as _PipedriveStatusApi,
}
