import type Database from 'better-sqlite3'
import { z } from 'zod'
import type { PluginContext } from '@dispatch/core'
import type { Sequencer } from '../sequences/sequencer.js'
import type { OperatorAlerts } from '../operator-alerts.js'

/**
 * Operator (mutating) routes for the debt-sdr plugin (Task 39).
 *
 * Side-effect contract:
 *   - /sequence/:lead_id/abort  → Sequencer.terminateSequence(lead, 'aborted', ...)
 *   - /sequence/:lead_id/resume → re-activate an aborted/no_response sequence
 *   - /alerts/:id/resolve       → OperatorAlerts.resolve(id, resolution)
 *   - /leads/:id/force-recheck  → drop sequence_state row + reset lead to 'pulled'
 *
 * Resume rejects finalized states (qualified/disqualified/opted_out/wrong_number)
 * so an operator cannot un-finalize a deal that already wrote back to Pipedrive.
 */

export interface OperatorRoutesDeps {
  db: Database.Database
  alerts: OperatorAlerts
  sequencer: Sequencer
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

const abortBody = z.object({ reason: z.string().min(1).max(500) })
const resolveBody = z.object({ resolution: z.string().min(1).max(2000) })
const leadIdParam = z.object({ lead_id: z.string().min(1) })
const idParam = z.object({ id: z.string().min(1) })

const RESUMABLE_STATES = new Set(['aborted', 'no_response'])

export async function handleAbortSequence(
  deps: OperatorRoutesDeps,
  req: RouteRequest,
  reply: RouteReply,
): Promise<unknown> {
  const params = leadIdParam.safeParse(req.params ?? {})
  if (!params.success) return reply.status(400).send({ error: 'Validation failed', details: params.error.issues })
  const body = abortBody.safeParse(req.body ?? {})
  if (!body.success) return reply.status(400).send({ error: 'Validation failed', details: body.error.issues })

  const exists = deps.db.prepare('SELECT 1 FROM sdr_lead_queue WHERE id = ?').get(params.data.lead_id)
  if (!exists) return reply.status(404).send({ error: 'Lead not found' })

  deps.sequencer.terminateSequence(params.data.lead_id, 'aborted', `operator:${body.data.reason}`)
  return reply.status(200).send({ ok: true })
}

export async function handleResumeSequence(
  deps: OperatorRoutesDeps,
  req: RouteRequest,
  reply: RouteReply,
): Promise<unknown> {
  const params = leadIdParam.safeParse(req.params ?? {})
  if (!params.success) return reply.status(400).send({ error: 'Validation failed', details: params.error.issues })

  const state = deps.db
    .prepare('SELECT status FROM sdr_sequence_state WHERE lead_id = ?')
    .get(params.data.lead_id) as { status: string } | undefined
  if (!state) return reply.status(404).send({ error: 'Sequence state not found' })

  if (!RESUMABLE_STATES.has(state.status)) {
    return reply
      .status(409)
      .send({ error: 'Sequence cannot be resumed', current_status: state.status, resumable_from: [...RESUMABLE_STATES] })
  }

  const nowIso = new Date().toISOString()
  deps.db
    .prepare(
      `UPDATE sdr_sequence_state
          SET status = 'active',
              stop_reason = NULL,
              next_action_at = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE lead_id = ?`,
    )
    .run(nowIso, params.data.lead_id)
  deps.db
    .prepare(
      `UPDATE sdr_lead_queue
          SET state = 'sequencing',
              stop_reason = NULL,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`,
    )
    .run(params.data.lead_id)
  return reply.status(200).send({ ok: true })
}

export async function handleResolveAlert(
  deps: OperatorRoutesDeps,
  req: RouteRequest,
  reply: RouteReply,
): Promise<unknown> {
  const params = idParam.safeParse(req.params ?? {})
  if (!params.success) return reply.status(400).send({ error: 'Validation failed', details: params.error.issues })
  const body = resolveBody.safeParse(req.body ?? {})
  if (!body.success) return reply.status(400).send({ error: 'Validation failed', details: body.error.issues })

  const ok = deps.alerts.resolve(params.data.id, body.data.resolution)
  if (!ok) return reply.status(404).send({ error: 'Alert not found or already resolved' })
  return reply.status(200).send({ ok: true })
}

export async function handleForceRecheck(
  deps: OperatorRoutesDeps,
  req: RouteRequest,
  reply: RouteReply,
): Promise<unknown> {
  const params = idParam.safeParse(req.params ?? {})
  if (!params.success) return reply.status(400).send({ error: 'Validation failed', details: params.error.issues })

  const exists = deps.db.prepare('SELECT 1 FROM sdr_lead_queue WHERE id = ?').get(params.data.id)
  if (!exists) return reply.status(404).send({ error: 'Lead not found' })

  // Re-pull semantics for MVP: clear sequence_state + reset lead row to
  // 'pulled' so the next sequencer tick treats it as a brand-new lead.
  // The lead's pipedrive_context_json stays as-is — the next full
  // tenant pull cron will refresh it if Pipedrive data changed.
  deps.db.prepare('DELETE FROM sdr_sequence_state WHERE lead_id = ?').run(params.data.id)
  deps.db
    .prepare(
      `UPDATE sdr_lead_queue
          SET state = 'pulled',
              stop_reason = NULL,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`,
    )
    .run(params.data.id)
  return reply.status(200).send({ ok: true })
}

export function registerOperatorRoutes(ctx: PluginContext, deps: OperatorRoutesDeps): void {
  ctx.registerRoute('PATCH', '/sequence/:lead_id/abort', (req, rep) => handleAbortSequence(deps, req, rep))
  ctx.registerRoute('PATCH', '/sequence/:lead_id/resume', (req, rep) => handleResumeSequence(deps, req, rep))
  ctx.registerRoute('PATCH', '/alerts/:id/resolve', (req, rep) => handleResolveAlert(deps, req, rep))
  ctx.registerRoute('POST', '/leads/:id/force-recheck', (req, rep) => handleForceRecheck(deps, req, rep))
}
