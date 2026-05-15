import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { initSdrSchema } from '../db/migrations.js'
import { OperatorAlerts } from '../operator-alerts.js'
import { ClassifierLog } from '../classifier/classifier-log.js'
import {
  handleListLeads,
  handleGetLead,
  handleGetSequenceState,
  handleListAlerts,
  handleClassifierLog,
  handleHealth,
  handleStats,
  type AdminRoutesDeps,
} from './admin-routes.js'

interface MockReply {
  _status: number
  _body: unknown
  status(code: number): MockReply
  send(data: unknown): MockReply
}

function makeReply(): MockReply {
  const r = {
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
  return r
}

function makeDeps(db: Database.Database): AdminRoutesDeps {
  return {
    db,
    alerts: new OperatorAlerts(db),
    classifierLog: new ClassifierLog(db),
    tenantNames: ['oralsin-sdr', 'sicoob-sdr'],
    llmProviderName: 'stub',
    cronsEnabled: () => false,
    pipedriveTokenPresent: (t) => t === 'oralsin-sdr',
  }
}

function insertLead(db: Database.Database, id: string, tenant: string, state = 'pulled', dealId = 1): void {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO sdr_lead_queue (id, tenant, pipedrive_deal_id, contact_phone, contact_name, pulled_at, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, tenant, dealId, '5543991938235', 'Test', now, state, now, now)
}

function insertSeqState(db: Database.Database, leadId: string, status: string): void {
  const nowIso = new Date(Date.now() + 60_000).toISOString()
  db.prepare(
    `INSERT INTO sdr_sequence_state (lead_id, sequence_id, sender_phone, current_step, status, next_action_at)
     VALUES (?, 'oralsin-cold-v1', '554399000001', 0, ?, ?)`,
  ).run(leadId, status, nowIso)
}

describe('admin-routes', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    initSdrSchema(db)
  })

  afterEach(() => {
    db.close()
  })

  it('GET /leads returns paginated leads filtered by tenant + state', async () => {
    insertLead(db, 'L1', 'oralsin-sdr', 'pulled', 100)
    insertLead(db, 'L2', 'oralsin-sdr', 'sequencing', 101)
    insertLead(db, 'L3', 'sicoob-sdr', 'pulled', 102)

    const reply = makeReply()
    await handleListLeads(makeDeps(db), { query: { tenant: 'oralsin-sdr', state: 'pulled' } }, reply)

    expect(reply._status).toBe(200)
    const body = reply._body as { leads: Array<{ id: string }>; next_cursor: string | null }
    expect(body.leads).toHaveLength(1)
    expect(body.leads[0].id).toBe('L1')
    expect(body.next_cursor).toBeNull()
  })

  it('GET /leads paginates with cursor (limit=1 → next_cursor advances)', async () => {
    insertLead(db, 'L1', 'oralsin-sdr', 'pulled', 100)
    insertLead(db, 'L2', 'oralsin-sdr', 'pulled', 101)

    const reply = makeReply()
    await handleListLeads(makeDeps(db), { query: { tenant: 'oralsin-sdr', limit: '1' } }, reply)

    const body = reply._body as { leads: Array<{ id: string }>; next_cursor: string | null }
    expect(body.leads).toHaveLength(1)
    expect(body.next_cursor).toBe(body.leads[0].id)
  })

  it('GET /leads rejects invalid query (limit too high)', async () => {
    const reply = makeReply()
    await handleListLeads(makeDeps(db), { query: { limit: '99999' } }, reply)
    expect(reply._status).toBe(400)
  })

  it('GET /leads/:id returns lead + sequence_state, 404 when missing', async () => {
    insertLead(db, 'L1', 'oralsin-sdr')
    insertSeqState(db, 'L1', 'pending_identity')

    const okReply = makeReply()
    await handleGetLead(makeDeps(db), { params: { id: 'L1' } }, okReply)
    expect(okReply._status).toBe(200)
    const body = okReply._body as { lead: { id: string }; sequence_state: { status: string } | null }
    expect(body.lead.id).toBe('L1')
    expect(body.sequence_state?.status).toBe('pending_identity')

    const missing = makeReply()
    await handleGetLead(makeDeps(db), { params: { id: 'nope' } }, missing)
    expect(missing._status).toBe(404)
  })

  it('GET /sequences/:lead_id returns state when present, null when absent', async () => {
    insertLead(db, 'L1', 'oralsin-sdr')
    insertSeqState(db, 'L1', 'active')

    const present = makeReply()
    await handleGetSequenceState(makeDeps(db), { params: { lead_id: 'L1' } }, present)
    expect(present._status).toBe(200)
    expect((present._body as { state: { status: string } | null }).state?.status).toBe('active')

    const absent = makeReply()
    await handleGetSequenceState(makeDeps(db), { params: { lead_id: 'unknown' } }, absent)
    expect(absent._status).toBe(200)
    expect((absent._body as { state: unknown }).state).toBeNull()
  })

  it('GET /alerts returns unresolved alerts by default and filters by tenant', async () => {
    const alerts = new OperatorAlerts(db)
    alerts.raise({ tenant: 'oralsin-sdr', leadId: 'L1', messageId: 'M1', responseText: '?', reason: 'r1' })
    const sicoobId = alerts.raise({ tenant: 'sicoob-sdr', leadId: 'L2', messageId: 'M2', responseText: '?', reason: 'r2' })
    alerts.resolve(sicoobId, 'done')

    const all = makeReply()
    await handleListAlerts(makeDeps(db), { query: {} }, all)
    const body = all._body as { alerts: Array<{ tenant: string }> }
    expect(body.alerts).toHaveLength(1)
    expect(body.alerts[0].tenant).toBe('oralsin-sdr')

    const tenant = makeReply()
    await handleListAlerts(makeDeps(db), { query: { tenant: 'sicoob-sdr', unresolved: 'false' } }, tenant)
    const tbody = tenant._body as { alerts: Array<{ tenant: string }> }
    expect(tbody.alerts).toHaveLength(1)
    expect(tbody.alerts[0].tenant).toBe('sicoob-sdr')
  })

  it('GET /classifier/log returns entries filtered by lead_id and since', async () => {
    const log = new ClassifierLog(db)
    log.record({
      lead_id: 'L1',
      message_id: 'M1',
      response_text: 'sim',
      classification: { category: 'identity_yes', confidence: 0.9, source: 'regex', latency_ms: 5 },
    })
    log.record({
      lead_id: 'L2',
      message_id: 'M2',
      response_text: 'pare',
      classification: { category: 'opted_out', confidence: 0.95, source: 'regex', latency_ms: 4 },
    })

    const reply = makeReply()
    await handleClassifierLog(makeDeps(db), { query: { lead_id: 'L1' } }, reply)
    expect(reply._status).toBe(200)
    const body = reply._body as { entries: Array<{ lead_id: string }> }
    expect(body.entries).toHaveLength(1)
    expect(body.entries[0].lead_id).toBe('L1')
  })

  it('GET /health returns per-tenant token presence + crons + llm provider', async () => {
    const reply = makeReply()
    await handleHealth(makeDeps(db), { query: {} }, reply)
    expect(reply._status).toBe(200)
    const body = reply._body as {
      crons_enabled: boolean
      llm_provider: string
      tenants: Array<{ name: string; pipedrive_token_present: boolean }>
    }
    expect(body.crons_enabled).toBe(false)
    expect(body.llm_provider).toBe('stub')
    expect(body.tenants).toEqual([
      { name: 'oralsin-sdr', pipedrive_token_present: true },
      { name: 'sicoob-sdr', pipedrive_token_present: false },
    ])
  })

  it('GET /stats returns per-tenant aggregates (leads by state, sequences by status, alerts unresolved)', async () => {
    insertLead(db, 'L1', 'oralsin-sdr', 'pulled', 100)
    insertLead(db, 'L2', 'oralsin-sdr', 'sequencing', 101)
    insertLead(db, 'L3', 'sicoob-sdr', 'completed', 102)
    insertSeqState(db, 'L1', 'pending_identity')
    insertSeqState(db, 'L2', 'active')
    new OperatorAlerts(db).raise({
      tenant: 'oralsin-sdr',
      leadId: 'L1',
      messageId: 'M1',
      responseText: '?',
      reason: 'amb',
    })

    const reply = makeReply()
    await handleStats(makeDeps(db), { query: {} }, reply)
    expect(reply._status).toBe(200)
    const body = reply._body as {
      tenants: Array<{
        name: string
        leads_by_state: Record<string, number>
        sequences_by_status: Record<string, number>
        alerts_unresolved: number
      }>
    }
    const oralsin = body.tenants.find((t) => t.name === 'oralsin-sdr')!
    expect(oralsin.leads_by_state.pulled).toBe(1)
    expect(oralsin.leads_by_state.sequencing).toBe(1)
    expect(oralsin.sequences_by_status.pending_identity).toBe(1)
    expect(oralsin.sequences_by_status.active).toBe(1)
    expect(oralsin.alerts_unresolved).toBe(1)
    const sicoob = body.tenants.find((t) => t.name === 'sicoob-sdr')!
    expect(sicoob.leads_by_state.completed).toBe(1)
    expect(sicoob.alerts_unresolved).toBe(0)
  })
})
