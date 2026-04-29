import { z } from 'zod'
import {
  buildActivityUrl,
  buildDealAllFailActivity,
  buildDealUrl,
  buildPastaSummaryNote,
} from './pipedrive-formatter.js'
import type { PipedriveActivityRow, PipedriveActivityStore } from './pipedrive-activity-store.js'
import type { PipedriveClient } from './pipedrive-client.js'
import type { PipedrivePublisher } from './pipedrive-publisher.js'
import type {
  PipedriveDealAllFailIntent,
  PipedrivePastaSummaryIntent,
} from './types.js'
import type { HttpMethod, PluginContext, RouteHandler } from '../types.js'

/**
 * Plugin-scoped Pipedrive operator API.
 *
 * Mounted under `/api/v1/plugins/adb-precheck/pipedrive/*` via
 * `PluginContext.registerRoute`. The plugin loader prefixes each path with
 * `/api/v1/plugins/<plugin-name>` and applies the standard X-API-Key /
 * Bearer JWT auth gate, so we only register the relative path here.
 *
 * When the integration is disabled (no PIPEDRIVE_API_TOKEN), `client`,
 * `store`, and `publisher` are all null and the routes return 503 — except
 * /health, which returns a "disabled" payload so the UI can render an
 * informative empty state rather than a 503.
 */
export interface PipedrivePluginApiDeps {
  /** Null when integration is disabled. */
  store: PipedriveActivityStore | null
  client: PipedriveClient | null
  publisher: PipedrivePublisher | null
  companyDomain: string | null
  cacheTtlDays?: number
  baseUrl?: string
}

// `phone_fail` is included in the LIST filter enum so operators can still
// query historical rows in `pipedrive_activities`; it is rejected by the
// preview and manual-trigger schemas because we no longer emit it.
const scenarioEnum = z.enum(['phone_fail', 'deal_all_fail', 'pasta_summary'])
const activeScenarioEnum = z.enum(['deal_all_fail', 'pasta_summary'])
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

const pastaDealRowSchema = z.object({
  deal_id: z.number().int().positive(),
  phones: z
    .array(
      z.object({
        column: z.string().min(1).max(64),
        phone_normalized: z.string().min(1).max(32),
        outcome: z.enum(['valid', 'invalid', 'error']),
        strategy: z.string().min(1).max(32),
      }),
    )
    .max(50),
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
  /**
   * Optional per-deal phone breakdown for the v2 visual layout. When omitted
   * the formatter renders aggregate metrics only — useful for legacy callers
   * that don't have phone-level data on hand.
   */
  deals: z.array(pastaDealRowSchema).max(500).optional(),
})

// preview / manual-trigger accept ONLY the active scenarios. Sending a
// body with `scenario:'phone_fail'` returns 400 — Zod's discriminated
// union rejects unknown literal values, which is exactly what we want.
const previewBodySchema = z.discriminatedUnion('scenario', [
  dealAllFailBodySchema,
  pastaSummaryBodySchema,
])

const manualTriggerBodySchema = z.discriminatedUnion('scenario', [
  dealAllFailBodySchema.extend({ triggered_by: z.string().min(1).max(120).optional() }),
  pastaSummaryBodySchema.extend({ triggered_by: z.string().min(1).max(120).optional() }),
])

void activeScenarioEnum  // exported through the schemas above; reference kept for clarity.

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
  _cacheTtlDays?: number,
): {
  endpoint: '/activities' | '/notes'
  subject: string | null
  type: string | null
  markdownBody: string
  dealUrl: string | null
} {
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
    deals: body.deals ?? [],
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

// Loose Fastify-shaped reply/request types — the plugin loader injects the
// real Fastify objects, but we don't depend on Fastify here.
type ReplyLike = {
  status: (n: number) => { send: (b: unknown) => unknown }
  send: (b: unknown) => unknown
}

function unavailable(reply: ReplyLike) {
  return reply.status(503).send({
    error: 'pipedrive_disabled',
    detail: 'PIPEDRIVE_API_TOKEN is not set on this instance',
  })
}

/**
 * Build the route table for the plugin-scoped Pipedrive API.
 *
 * Returned as a list of `[method, path, handler]` tuples so the caller can
 * wire each one through `PluginContext.registerRoute()`. Paths are relative
 * to `/api/v1/plugins/adb-precheck` — the loader adds the prefix.
 */
export function buildPipedriveRoutes(
  deps: PipedrivePluginApiDeps,
): Array<[HttpMethod, string, RouteHandler]> {
  const routes: Array<[HttpMethod, string, RouteHandler]> = []

  // ── Health ────────────────────────────────────────────────────────────
  routes.push(['GET', '/pipedrive/health', async (_req: unknown, reply: unknown) => {
    const r = reply as ReplyLike
    if (!deps.client) {
      return r.send({
        tokenValid: false,
        enabled: false,
        domain: deps.companyDomain,
        baseUrl: deps.baseUrl ?? null,
      })
    }
    const w = await deps.client.whoami()
    return r.send({
      tokenValid: w.ok,
      enabled: true,
      ownerName: w.name ?? null,
      ownerEmail: w.email ?? null,
      company: w.company_name ?? null,
      companyDomainRemote: w.company_domain ?? null,
      domain: deps.companyDomain,
      baseUrl: deps.baseUrl ?? null,
      error: w.ok ? null : w.error,
    })
  }])

  // ── List activities ───────────────────────────────────────────────────
  routes.push(['GET', '/pipedrive/activities', async (request: unknown, reply: unknown) => {
    const r = reply as ReplyLike
    if (!deps.store) return unavailable(r)
    const parsed = listQuerySchema.safeParse((request as { query: unknown }).query)
    if (!parsed.success) {
      return r.status(400).send({ error: 'invalid_query', details: parsed.error.format() })
    }
    const { items, total } = deps.store.list(parsed.data)
    return r.send({
      items: items.map((row) => rowWithUrls(row, deps.companyDomain)),
      total,
    })
  }])

  // ── Get single activity ───────────────────────────────────────────────
  routes.push(['GET', '/pipedrive/activities/:id', async (request: unknown, reply: unknown) => {
    const r = reply as ReplyLike
    if (!deps.store) return unavailable(r)
    const { id } = (request as { params: { id: string } }).params
    const row = deps.store.getById(id)
    if (!row) return r.status(404).send({ error: 'not_found' })
    return r.send(rowWithUrls(row, deps.companyDomain))
  }])

  // ── Retry failed activity (re-enqueue) ────────────────────────────────
  routes.push(['POST', '/pipedrive/activities/:id/retry', async (request: unknown, reply: unknown) => {
    const r = reply as ReplyLike
    if (!deps.store || !deps.publisher) return unavailable(r)
    const { id } = (request as { params: { id: string } }).params
    const row = deps.store.getById(id)
    if (!row) return r.status(404).send({ error: 'not_found' })
    const headers = (request as { headers: Record<string, string | undefined> }).headers
    const triggered_by = headers['x-triggered-by'] ?? 'operator'
    const retrySuffix = `retry-${Date.now()}`
    let newRowId: string | null = null

    if (row.scenario === 'phone_fail') {
      // phone_fail was retired on 2026-04-29. Re-emitting one would
      // re-pollute Pipedrive with the very kind of activity the operator
      // explicitly asked us to stop creating. Refuse the retry.
      return r.status(410).send({
        error: 'scenario_removed',
        detail: 'phone_fail Activities are no longer emitted; retry blocked.',
      })
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
    return r.status(202).send({ retried: true, originalId: id, newAttemptId: newRowId })
  }])

  // ── Render preview without sending ────────────────────────────────────
  routes.push(['POST', '/pipedrive/preview', async (request: unknown, reply: unknown) => {
    const r = reply as ReplyLike
    const parsed = previewBodySchema.safeParse((request as { body: unknown }).body)
    if (!parsed.success) {
      return r.status(400).send({ error: 'invalid_body', details: parsed.error.format() })
    }
    const out = buildPreviewPayload(parsed.data, deps.companyDomain, deps.cacheTtlDays)
    return r.send(out)
  }])

  // ── Manual trigger (operator-driven, persists with manual=1) ─────────
  routes.push(['POST', '/pipedrive/manual-trigger', async (request: unknown, reply: unknown) => {
    const r = reply as ReplyLike
    if (!deps.publisher) return unavailable(r)
    const parsed = manualTriggerBodySchema.safeParse((request as { body: unknown }).body)
    if (!parsed.success) {
      return r.status(400).send({ error: 'invalid_body', details: parsed.error.format() })
    }
    const headers = (request as { headers: Record<string, string | undefined> }).headers
    const triggered_by =
      parsed.data.triggered_by ?? headers['x-triggered-by'] ?? 'operator'
    const jobIdSuffix = `manual-${Date.now()}`
    let newRowId: string | null = null
    if (parsed.data.scenario === 'deal_all_fail') {
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
          deals: parsed.data.deals ?? [],
        },
        { manual: true, triggered_by },
      )
    }
    return r.status(201).send({ triggered: true, activityId: newRowId, triggered_by })
  }])

  // ── Stats ─────────────────────────────────────────────────────────────
  routes.push(['GET', '/pipedrive/stats', async (request: unknown, reply: unknown) => {
    const r = reply as ReplyLike
    if (!deps.store) return unavailable(r)
    const parsed = statsQuerySchema.safeParse((request as { query: unknown }).query)
    if (!parsed.success) {
      return r.status(400).send({ error: 'invalid_query', details: parsed.error.format() })
    }
    const period = parsed.data.period ?? 'all'
    const stats = deps.store.stats(period)
    return r.send(stats)
  }])

  return routes
}

/** Wire all Pipedrive routes via the plugin context. */
export function registerPipedrivePluginRoutes(
  ctx: PluginContext,
  deps: PipedrivePluginApiDeps,
): void {
  for (const [method, path, handler] of buildPipedriveRoutes(deps)) {
    ctx.registerRoute(method, path, handler)
  }
}

export {
  listQuerySchema as _pluginListQuerySchema,
  previewBodySchema as _pluginPreviewBodySchema,
  manualTriggerBodySchema as _pluginManualTriggerBodySchema,
}
