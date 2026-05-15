import type Database from 'better-sqlite3'
import { z } from 'zod'
import type { PluginContext } from '@dispatch/core'
import type { OperatorAlerts } from '../operator-alerts.js'
import type { ClassifierLog } from '../classifier/classifier-log.js'

/**
 * Admin (read-only) routes for the debt-sdr plugin (Task 39).
 *
 * All routes mount under `/api/v1/plugins/debt-sdr/` (the loader handles
 * the prefix). Each handler is exported individually so unit tests can
 * call it without the full Fastify lifecycle.
 *
 * Authentication is enforced upstream by the plugin loader (API key +
 * HMAC) — these handlers trust the request reached them.
 */

export interface AdminRoutesDeps {
  db: Database.Database
  alerts: OperatorAlerts
  classifierLog: ClassifierLog
  /** Tenant names from the loaded config; used by /health and /stats. */
  tenantNames: readonly string[]
  /** LLM provider name surfaced via /health. */
  llmProviderName: string
  /** Live snapshot — DISPATCH_SDR_CRONS_ENABLED at the time of the call. */
  cronsEnabled: () => boolean
  /** True when Pipedrive API token env var is set for the tenant. */
  pipedriveTokenPresent: (tenant: string) => boolean
}

export interface RouteRequest {
  params?: Record<string, string | undefined>
  query?: Record<string, string | undefined>
  body?: unknown
}

export interface RouteReply {
  status(code: number): RouteReply
  send(data: unknown): RouteReply
}

const LEADS_LIMIT_MAX = 200
const ALERTS_LIMIT_MAX = 500
const LOG_LIMIT_MAX = 500

const listLeadsQuery = z.object({
  tenant: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(LEADS_LIMIT_MAX).default(50),
  cursor: z.string().min(1).optional(),
})

const listAlertsQuery = z.object({
  tenant: z.string().min(1).optional(),
  unresolved: z.enum(['true', 'false']).default('true'),
  limit: z.coerce.number().int().min(1).max(ALERTS_LIMIT_MAX).default(100),
})

const classifierLogQuery = z.object({
  lead_id: z.string().min(1).optional(),
  since: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(LOG_LIMIT_MAX).default(100),
})

const leadIdParam = z.object({ id: z.string().min(1) })
const leadIdSnake = z.object({ lead_id: z.string().min(1) })

export async function handleListLeads(deps: AdminRoutesDeps, req: RouteRequest, reply: RouteReply): Promise<unknown> {
  const parsed = listLeadsQuery.safeParse(req.query ?? {})
  if (!parsed.success) {
    return reply.status(400).send({ error: 'Validation failed', details: parsed.error.issues })
  }
  const { tenant, state, limit, cursor } = parsed.data

  const where: string[] = []
  const params: unknown[] = []
  if (tenant) {
    where.push('tenant = ?')
    params.push(tenant)
  }
  if (state) {
    where.push('state = ?')
    params.push(state)
  }
  if (cursor) {
    where.push('id > ?')
    params.push(cursor)
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
  // Fetch limit+1 so we can derive next_cursor without a second query.
  const rows = deps.db
    .prepare(`SELECT * FROM sdr_lead_queue ${whereSql} ORDER BY id ASC LIMIT ?`)
    .all(...params, limit + 1) as Array<Record<string, unknown> & { id: string }>

  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const next_cursor = hasMore ? page[page.length - 1]!.id : null

  return reply.status(200).send({ leads: page, next_cursor })
}

export async function handleGetLead(deps: AdminRoutesDeps, req: RouteRequest, reply: RouteReply): Promise<unknown> {
  const parsed = leadIdParam.safeParse(req.params ?? {})
  if (!parsed.success) {
    return reply.status(400).send({ error: 'Validation failed', details: parsed.error.issues })
  }
  const lead = deps.db.prepare('SELECT * FROM sdr_lead_queue WHERE id = ?').get(parsed.data.id) as unknown
  if (!lead) {
    return reply.status(404).send({ error: 'Lead not found' })
  }
  const state = deps.db.prepare('SELECT * FROM sdr_sequence_state WHERE lead_id = ?').get(parsed.data.id) ?? null
  return reply.status(200).send({ lead, sequence_state: state })
}

export async function handleGetSequenceState(
  deps: AdminRoutesDeps,
  req: RouteRequest,
  reply: RouteReply,
): Promise<unknown> {
  const parsed = leadIdSnake.safeParse(req.params ?? {})
  if (!parsed.success) {
    return reply.status(400).send({ error: 'Validation failed', details: parsed.error.issues })
  }
  const state = deps.db.prepare('SELECT * FROM sdr_sequence_state WHERE lead_id = ?').get(parsed.data.lead_id) ?? null
  return reply.status(200).send({ state })
}

export async function handleListAlerts(deps: AdminRoutesDeps, req: RouteRequest, reply: RouteReply): Promise<unknown> {
  const parsed = listAlertsQuery.safeParse(req.query ?? {})
  if (!parsed.success) {
    return reply.status(400).send({ error: 'Validation failed', details: parsed.error.issues })
  }
  const { tenant, unresolved, limit } = parsed.data
  const where: string[] = []
  const params: unknown[] = []
  if (unresolved === 'true') {
    where.push('resolved_at IS NULL')
  }
  if (tenant) {
    where.push('tenant = ?')
    params.push(tenant)
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
  const rows = deps.db
    .prepare(`SELECT * FROM sdr_operator_alerts ${whereSql} ORDER BY raised_at ASC LIMIT ?`)
    .all(...params, limit)
  return reply.status(200).send({ alerts: rows })
}

export async function handleClassifierLog(
  deps: AdminRoutesDeps,
  req: RouteRequest,
  reply: RouteReply,
): Promise<unknown> {
  const parsed = classifierLogQuery.safeParse(req.query ?? {})
  if (!parsed.success) {
    return reply.status(400).send({ error: 'Validation failed', details: parsed.error.issues })
  }
  const { lead_id, since, limit } = parsed.data
  const where: string[] = []
  const params: unknown[] = []
  if (lead_id) {
    where.push('lead_id = ?')
    params.push(lead_id)
  }
  if (since) {
    where.push('classified_at >= ?')
    params.push(since)
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
  const rows = deps.db
    .prepare(`SELECT * FROM sdr_classifier_log ${whereSql} ORDER BY classified_at DESC LIMIT ?`)
    .all(...params, limit)
  return reply.status(200).send({ entries: rows })
}

export async function handleHealth(deps: AdminRoutesDeps, _req: RouteRequest, reply: RouteReply): Promise<unknown> {
  const tenants = deps.tenantNames.map((name) => ({
    name,
    pipedrive_token_present: deps.pipedriveTokenPresent(name),
  }))
  return reply.status(200).send({
    crons_enabled: deps.cronsEnabled(),
    llm_provider: deps.llmProviderName,
    tenants,
  })
}

export async function handleStats(deps: AdminRoutesDeps, _req: RouteRequest, reply: RouteReply): Promise<unknown> {
  const tenantAggregates = deps.tenantNames.map((name) => {
    const leadsByState = aggregate(deps.db, 'sdr_lead_queue', 'state', name)
    const sequencesByStatus = aggregateSequenceStatus(deps.db, name)
    const alertsUnresolved = (deps.db
      .prepare(`SELECT COUNT(*) AS n FROM sdr_operator_alerts WHERE tenant = ? AND resolved_at IS NULL`)
      .get(name) as { n: number }).n
    return {
      name,
      leads_by_state: leadsByState,
      sequences_by_status: sequencesByStatus,
      alerts_unresolved: alertsUnresolved,
    }
  })
  return reply.status(200).send({ tenants: tenantAggregates })
}

function aggregate(db: Database.Database, table: string, column: string, tenant: string): Record<string, number> {
  const rows = db
    .prepare(`SELECT ${column} AS k, COUNT(*) AS n FROM ${table} WHERE tenant = ? GROUP BY ${column}`)
    .all(tenant) as Array<{ k: string; n: number }>
  const out: Record<string, number> = {}
  for (const r of rows) out[r.k] = r.n
  return out
}

function aggregateSequenceStatus(db: Database.Database, tenant: string): Record<string, number> {
  const rows = db
    .prepare(
      `SELECT s.status AS k, COUNT(*) AS n
         FROM sdr_sequence_state s
         JOIN sdr_lead_queue l ON l.id = s.lead_id
        WHERE l.tenant = ?
        GROUP BY s.status`,
    )
    .all(tenant) as Array<{ k: string; n: number }>
  const out: Record<string, number> = {}
  for (const r of rows) out[r.k] = r.n
  return out
}

export function registerAdminRoutes(ctx: PluginContext, deps: AdminRoutesDeps): void {
  ctx.registerRoute('GET', '/leads', (req, rep) => handleListLeads(deps, req, rep))
  ctx.registerRoute('GET', '/leads/:id', (req, rep) => handleGetLead(deps, req, rep))
  ctx.registerRoute('GET', '/sequences/:lead_id', (req, rep) => handleGetSequenceState(deps, req, rep))
  ctx.registerRoute('GET', '/alerts', (req, rep) => handleListAlerts(deps, req, rep))
  ctx.registerRoute('GET', '/classifier/log', (req, rep) => handleClassifierLog(deps, req, rep))
  ctx.registerRoute('GET', '/health', (req, rep) => handleHealth(deps, req, rep))
  ctx.registerRoute('GET', '/stats', (req, rep) => handleStats(deps, req, rep))
}
