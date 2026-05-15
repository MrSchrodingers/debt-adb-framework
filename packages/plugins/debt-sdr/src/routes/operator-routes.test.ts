import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { initSdrSchema } from '../db/migrations.js'
import { OperatorAlerts } from '../operator-alerts.js'
import { Sequencer } from '../sequences/sequencer.js'
import {
  handleAbortSequence,
  handleResumeSequence,
  handleResolveAlert,
  handleForceRecheck,
  type OperatorRoutesDeps,
} from './operator-routes.js'

interface MockReply {
  _status: number
  _body: unknown
  status(code: number): MockReply
  send(data: unknown): MockReply
}

function makeReply(): MockReply {
  return {
    _status: 200,
    _body: undefined as unknown,
    status(code: number) {
      this._status = code
      return this
    },
    send(data: unknown) {
      this._body = data
      return this
    },
  }
}

function insertLead(db: Database.Database, id: string, tenant: string, state = 'sequencing'): void {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO sdr_lead_queue (id, tenant, pipedrive_deal_id, contact_phone, contact_name, pulled_at, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, tenant, 100, '5543991938235', 'Test', now, state, now, now)
}

function insertSeqState(db: Database.Database, leadId: string, status: string): void {
  const nowIso = new Date(Date.now() + 60_000).toISOString()
  db.prepare(
    `INSERT INTO sdr_sequence_state (lead_id, sequence_id, sender_phone, current_step, status, next_action_at)
     VALUES (?, 'oralsin-cold-v1', '554399000001', 0, ?, ?)`,
  ).run(leadId, status, nowIso)
}

function makeDeps(db: Database.Database): OperatorRoutesDeps {
  return {
    db,
    alerts: new OperatorAlerts(db),
    sequencer: new Sequencer(db, {
      enqueueStep: () => 'never-called',
      pickSender: () => '',
      identityGate: {
        check: () => ({ state: 'verified' }),
        kickoff: () => 'never',
        handleClassification: () => 'unchanged',
        fetchRow: () => null,
      } as never,
      throttleGate: { check: () => ({ allowed: true, next_eligible_at: '' }) } as never,
      hasOutgoingHistory: () => false,
    }),
  }
}

describe('operator-routes', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    initSdrSchema(db)
  })

  afterEach(() => {
    db.close()
  })

  it('PATCH /sequence/:lead_id/abort terminates the sequence and marks lead aborted', async () => {
    insertLead(db, 'L1', 'oralsin-sdr', 'sequencing')
    insertSeqState(db, 'L1', 'active')

    const reply = makeReply()
    await handleAbortSequence(
      makeDeps(db),
      { params: { lead_id: 'L1' }, body: { reason: 'manual_operator_intervention' } },
      reply,
    )
    expect(reply._status).toBe(200)
    expect((reply._body as { ok: boolean }).ok).toBe(true)

    const state = db.prepare('SELECT status, stop_reason FROM sdr_sequence_state WHERE lead_id = ?').get('L1') as {
      status: string
      stop_reason: string
    }
    expect(state.status).toBe('aborted')
    expect(state.stop_reason).toBe('operator:manual_operator_intervention')
    const lead = db.prepare('SELECT state FROM sdr_lead_queue WHERE id = ?').get('L1') as { state: string }
    expect(lead.state).toBe('aborted')
  })

  it('PATCH /sequence/:lead_id/abort returns 404 for unknown lead', async () => {
    const reply = makeReply()
    await handleAbortSequence(
      makeDeps(db),
      { params: { lead_id: 'nope' }, body: { reason: 'x' } },
      reply,
    )
    expect(reply._status).toBe(404)
  })

  it('PATCH /sequence/:lead_id/resume re-activates an aborted sequence and re-queues the lead', async () => {
    insertLead(db, 'L1', 'oralsin-sdr', 'aborted')
    insertSeqState(db, 'L1', 'aborted')

    const reply = makeReply()
    await handleResumeSequence(makeDeps(db), { params: { lead_id: 'L1' }, body: {} }, reply)
    expect(reply._status).toBe(200)

    const state = db.prepare('SELECT status FROM sdr_sequence_state WHERE lead_id = ?').get('L1') as { status: string }
    expect(state.status).toBe('active')
    const lead = db.prepare('SELECT state FROM sdr_lead_queue WHERE id = ?').get('L1') as { state: string }
    expect(lead.state).toBe('sequencing')
  })

  it('PATCH /sequence/:lead_id/resume rejects when sequence is in a terminal-finalized state (qualified)', async () => {
    insertLead(db, 'L1', 'oralsin-sdr', 'completed')
    insertSeqState(db, 'L1', 'qualified')

    const reply = makeReply()
    await handleResumeSequence(makeDeps(db), { params: { lead_id: 'L1' }, body: {} }, reply)
    expect(reply._status).toBe(409)
  })

  it('PATCH /alerts/:id/resolve marks alert resolved, 404 for unknown or already-resolved', async () => {
    const deps = makeDeps(db)
    const alertId = deps.alerts.raise({
      tenant: 'oralsin-sdr',
      leadId: 'L1',
      messageId: 'M1',
      responseText: '?',
      reason: 'r1',
    })

    const ok = makeReply()
    await handleResolveAlert(deps, { params: { id: alertId }, body: { resolution: 'reviewed' } }, ok)
    expect(ok._status).toBe(200)

    const dup = makeReply()
    await handleResolveAlert(deps, { params: { id: alertId }, body: { resolution: 'reviewed' } }, dup)
    expect(dup._status).toBe(404)

    const missing = makeReply()
    await handleResolveAlert(deps, { params: { id: 'nope' }, body: { resolution: 'x' } }, missing)
    expect(missing._status).toBe(404)
  })

  it('POST /leads/:id/force-recheck clears sequence state and resets lead to pulled', async () => {
    insertLead(db, 'L1', 'oralsin-sdr', 'completed')
    insertSeqState(db, 'L1', 'qualified')

    const reply = makeReply()
    await handleForceRecheck(makeDeps(db), { params: { id: 'L1' }, body: {} }, reply)
    expect(reply._status).toBe(200)

    const state = db.prepare('SELECT lead_id FROM sdr_sequence_state WHERE lead_id = ?').get('L1')
    expect(state).toBeUndefined()
    const lead = db.prepare('SELECT state FROM sdr_lead_queue WHERE id = ?').get('L1') as { state: string }
    expect(lead.state).toBe('pulled')
  })

  it('POST /leads/:id/force-recheck returns 404 for unknown lead', async () => {
    const reply = makeReply()
    await handleForceRecheck(makeDeps(db), { params: { id: 'nope' }, body: {} }, reply)
    expect(reply._status).toBe(404)
  })
})
