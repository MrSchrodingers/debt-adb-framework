import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { ResponseHandler } from './response-handler.js'
import { PendingWritebacks } from './pending-writebacks.js'
import { ResponseClassifier } from '../classifier/classifier.js'
import { StubLlmClient, type LlmClient } from '../classifier/llm-client.js'
import { ClassifierLog } from '../classifier/classifier-log.js'
import { IdentityGate } from '../identity-gate/identity-gate.js'
import { Sequencer } from '../sequences/sequencer.js'
import { OperatorAlerts } from '../operator-alerts.js'
import { ThrottleGate } from '../throttle/throttle-gate.js'
import { initSdrSchema } from '../db/migrations.js'
import '../sequences/oralsin-cold-v1.js'
import type { SdrTenantConfig } from '../config/tenant-config.js'
import type { TenantPipedriveClient } from '../pipedrive/tenant-pipedrive-client.js'

const TENANT: SdrTenantConfig = {
  name: 'oralsin-sdr',
  label: 'Oralsin',
  pipedrive: {
    domain: 'oralsin-xyz',
    api_token_env: 'PIPEDRIVE_TOKEN_ORALSIN_SDR',
    pull: { stage_id: 5, poll_interval_minutes: 15, batch_size: 50, max_age_days: 30, phone_field_key: 'phone' },
    writeback: {
      stage_qualified_id: 6,
      stage_disqualified_id: 7,
      stage_needs_human_id: 8,
      stage_no_response_id: 9,
      activity_subject_template: 'SDR: {{outcome}}',
    },
  },
  devices: ['devA'],
  senders: [{ phone: '554399000001', app: 'com.whatsapp' }],
  sequence_id: 'oralsin-cold-v1',
  throttle: {
    per_sender_daily_max: 40,
    min_interval_minutes: 0,
    operating_hours: { start: '00:00', end: '23:59' },
    tz: 'America/Sao_Paulo',
  },
  identity_gate: { enabled: true, nudge_after_hours: 48, abort_after_hours: 96 },
}

const PAYLOAD = {
  leadId: 'lead-1',
  outboundMessageId: 'msg-out-1',
  responseText: 'Sim, sou eu',
  senderPhone: '554399000001',
  contactPhone: '554399999991',
  dealId: 100,
}

function seedLead(db: Database.Database): void {
  db.prepare(
    `INSERT INTO sdr_lead_queue (id, tenant, pipedrive_deal_id, contact_phone, contact_name, pulled_at, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pulled', ?, ?)`,
  ).run('lead-1', TENANT.name, 100, '554399999991', 'João', 'now', 'now', 'now')
  db.prepare(
    `INSERT INTO sdr_sequence_state (lead_id, sequence_id, sender_phone, current_step, status, next_action_at)
     VALUES ('lead-1', 'oralsin-cold-v1', '554399000001', 0, 'active', 'now')`,
  ).run()
}

function makeStack(db: Database.Database, llm: LlmClient = new StubLlmClient(), pipedriveClient?: TenantPipedriveClient) {
  const classifier = new ResponseClassifier(llm)
  const classifierLog = new ClassifierLog(db)
  const identityGate = new IdentityGate(db, {
    enqueueHandshake: vi.fn(() => 'hs-1'),
    blacklist: vi.fn(),
    raiseOperatorAlert: vi.fn(),
  })
  const throttleGate = new ThrottleGate(db, { now: () => Date.now() })
  const sequencer = new Sequencer(db, {
    enqueueStep: vi.fn(() => 'step-msg'),
    pickSender: () => '554399000001',
    identityGate,
    throttleGate,
    hasOutgoingHistory: () => true,
    now: () => Date.now(),
  })
  const pipedriveCall = vi.fn(async () => ({}))
  const pipedriveActivity = vi.fn(async () => ({ id: 1 }))
  const client = pipedriveClient ?? ({
    updateDealStage: pipedriveCall,
    createActivity: pipedriveActivity,
  } as unknown as TenantPipedriveClient)
  const operatorAlerts = new OperatorAlerts(db)
  const pendingWritebacks = new PendingWritebacks(db)
  const handler = new ResponseHandler(db, {
    classifier,
    classifierLog,
    identityGate,
    sequencer,
    pipedrive: () => client,
    operatorAlerts,
    pendingWritebacks,
  })
  return { handler, classifier, classifierLog, identityGate, sequencer, operatorAlerts, pendingWritebacks, pipedriveCall, pipedriveActivity, client }
}

describe('ResponseHandler — identity-gate phase', () => {
  let db: Database.Database
  beforeEach(() => { db = new Database(':memory:'); initSdrSchema(db); seedLead(db) })
  afterEach(() => db.close())

  it('regex identity_confirm sets state=verified and skips writeback', async () => {
    // Seed pending identity row to force identity_gate phase.
    db.prepare(
      `INSERT INTO sdr_contact_identity (tenant, sender_phone, contact_phone, state, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', 'now', 'now')`,
    ).run(TENANT.name, PAYLOAD.senderPhone, PAYLOAD.contactPhone)

    const stack = makeStack(db)
    const r = await stack.handler.handle(TENANT, PAYLOAD)
    expect(r.state).toBe('verified')
    expect(r.classification.category).toBe('identity_confirm')
    expect(stack.pipedriveCall).not.toHaveBeenCalled()
  })

  it('regex opted_out in identity phase calls writeback', async () => {
    db.prepare(
      `INSERT INTO sdr_contact_identity (tenant, sender_phone, contact_phone, state, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', 'now', 'now')`,
    ).run(TENANT.name, PAYLOAD.senderPhone, PAYLOAD.contactPhone)
    const stack = makeStack(db)
    const r = await stack.handler.handle(TENANT, { ...PAYLOAD, responseText: 'pare de mandar' })
    expect(r.state).toBe('opted_out')
    expect(stack.pipedriveCall).toHaveBeenCalledWith(100, TENANT.pipedrive.writeback.stage_disqualified_id)
  })
})

describe('ResponseHandler — response-handling phase', () => {
  let db: Database.Database
  beforeEach(() => { db = new Database(':memory:'); initSdrSchema(db); seedLead(db) })
  afterEach(() => db.close())

  it('interested → qualified writeback + sequence terminate', async () => {
    const stack = makeStack(db)
    const r = await stack.handler.handle(TENANT, { ...PAYLOAD, responseText: 'aceito' })
    expect(r.state).toBe('qualified')
    expect(stack.pipedriveCall).toHaveBeenCalledWith(100, 6)
    expect(stack.pipedriveActivity).toHaveBeenCalled()
    expect(stack.sequencer.fetchState('lead-1')!.status).toBe('qualified')
  })

  it('not_interested → disqualified writeback', async () => {
    const stack = makeStack(db)
    const r = await stack.handler.handle(TENANT, { ...PAYLOAD, responseText: 'não tenho interesse' })
    expect(r.state).toBe('disqualified')
    expect(stack.pipedriveCall).toHaveBeenCalledWith(100, 7)
  })

  it('question → needs_human writeback, sequence stays active', async () => {
    const stack = makeStack(db)
    const r = await stack.handler.handle(TENANT, { ...PAYLOAD, responseText: 'como funciona?' })
    expect(r.state).toBe('needs_human')
    expect(stack.pipedriveCall).toHaveBeenCalledWith(100, 8)
    expect(stack.sequencer.fetchState('lead-1')!.status).toBe('active')
  })

  it('opted_out → blacklist + writeback', async () => {
    const stack = makeStack(db)
    const r = await stack.handler.handle(TENANT, { ...PAYLOAD, responseText: 'pare de me mandar' })
    expect(r.state).toBe('opted_out')
    expect(stack.pipedriveCall).toHaveBeenCalledWith(100, 7)
  })

  it('ambiguous (regex miss + stub LLM) → operator alert, no writeback', async () => {
    const stack = makeStack(db)
    const r = await stack.handler.handle(TENANT, { ...PAYLOAD, responseText: 'sei la' })
    expect(r.state).toBe('ambiguous')
    expect(stack.pipedriveCall).not.toHaveBeenCalled()
    expect(stack.operatorAlerts.countUnresolved()).toBe(1)
  })

  it('Pipedrive failure enqueues to pending_writebacks', async () => {
    const failingClient = {
      updateDealStage: vi.fn(async () => { throw new Error('pipedrive 503') }),
      createActivity: vi.fn(async () => ({ id: 1 })),
    } as unknown as TenantPipedriveClient
    const stack = makeStack(db, new StubLlmClient(), failingClient)
    const r = await stack.handler.handle(TENANT, { ...PAYLOAD, responseText: 'aceito' })
    expect(r.state).toBe('qualified')
    expect(stack.pendingWritebacks.duePending()).toHaveLength(1)
    expect(stack.pendingWritebacks.duePending()[0].action).toBe('update_stage')
  })

  it('persists every classification to classifier_log', async () => {
    const stack = makeStack(db)
    await stack.handler.handle(TENANT, { ...PAYLOAD, responseText: 'aceito' })
    const rows = db.prepare("SELECT * FROM sdr_classifier_log WHERE lead_id = 'lead-1'").all()
    expect(rows).toHaveLength(1)
  })
})
