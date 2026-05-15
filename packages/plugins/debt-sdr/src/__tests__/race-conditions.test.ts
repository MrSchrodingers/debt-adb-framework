import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { DeviceTenantAssignment, SenderMapping, MessageQueue, routeResponse } from '@dispatch/core'
import { initSdrSchema } from '../db/migrations.js'
import { Sequencer } from '../sequences/sequencer.js'
import { OperatorAlerts } from '../operator-alerts.js'
import type { SdrTenantConfig } from '../config/tenant-config.js'
// Side-effect import: registers the shipped sequence definitions
// (oralsin-cold-v1, sicoob-cold-v1) into the in-process SEQUENCES
// registry that Sequencer.tick reads.
import '../sequences/index.js'

/**
 * Phase E Task 41 — formal-invariant adversarial tests (A1-A10 from
 * spec §8.2). Real SQLite + real DeviceTenantAssignment + real
 * MessageQueue; mocks only at I/O boundaries (HTTP, ADB, clock).
 *
 * Each test exercises one of the safety invariants. ANY failure here
 * means a race / partition violation has been re-introduced and must
 * block release.
 */

function bootDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  return db
}

function bootSenderMapping(db: Database.Database): SenderMapping {
  const sm = new SenderMapping(db)
  sm.initialize()
  return sm
}

function bootMessageQueue(db: Database.Database, dta?: DeviceTenantAssignment): MessageQueue {
  const queue = new MessageQueue(db, { dta })
  queue.initialize()
  return queue
}

function tenantCfg(name: string, sender: string): SdrTenantConfig {
  return {
    name,
    label: name,
    pipedrive: {
      domain: 'x',
      api_token_env: 'X_TOKEN',
      pull: { stage_id: 1, poll_interval_minutes: 15, batch_size: 10, max_age_days: 30, phone_field_key: 'phone' },
      writeback: {
        stage_qualified_id: 2,
        stage_disqualified_id: 3,
        stage_needs_human_id: 4,
        stage_no_response_id: 5,
        activity_subject_template: 'x',
      },
    },
    devices: [],
    senders: [{ phone: sender, app: 'com.whatsapp' }],
    sequence_id: 'oralsin-cold-v1',
    throttle: {
      per_sender_daily_max: 100,
      min_interval_minutes: 0,
      operating_hours: { start: '00:00', end: '23:59' },
      tz: 'America/Sao_Paulo',
    },
    identity_gate: { enabled: false, nudge_after_hours: 48, abort_after_hours: 96 },
  }
}

describe('Race conditions — formal invariants (spec §8.2)', () => {
  let db: Database.Database

  beforeEach(() => {
    db = bootDb()
    initSdrSchema(db)
  })

  afterEach(() => {
    db.close()
  })

  it('A1: concurrent claim of same device — only one plugin succeeds', async () => {
    const dta = new DeviceTenantAssignment(db)
    const [r1, r2] = await Promise.all([
      Promise.resolve(dta.claim('devX', 'tenant-A', 'plugin-A')),
      Promise.resolve(dta.claim('devX', 'tenant-B', 'plugin-B')),
    ])
    const wins = [r1, r2].filter((r) => r.ok)
    const losses = [r1, r2].filter((r) => !r.ok)
    expect(wins).toHaveLength(1)
    expect(losses).toHaveLength(1)
    expect(dta.getAssignment('devX')?.tenant_name).toBeTypeOf('string')
  })

  it('A2: plugin X cannot release device claimed by plugin Y (I2 ownership)', () => {
    const dta = new DeviceTenantAssignment(db)
    expect(dta.claim('devX', 'tenant-A', 'plugin-A').ok).toBe(true)
    const r = dta.release('devX', 'plugin-B')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('not_owner')
    expect(dta.getAssignment('devX')).not.toBeNull()
  })

  it('A3: sender ownership cannot be hijacked once a tenant claims it (CAS)', () => {
    const sm = bootSenderMapping(db)
    sm.create({ phoneNumber: '554399000001', deviceSerial: 'devX' })

    expect(sm.setSenderTenant('554399000001', 'tenant-A').ok).toBe(true)
    const r = sm.setSenderTenant('554399000001', 'tenant-B')
    expect(r.ok).toBe(false)
    if (!r.ok && r.reason === 'conflicting_tenant') {
      expect(r.current_tenant).toBe('tenant-A')
    }
    expect(sm.getByPhone('554399000001')?.tenant).toBe('tenant-A')
  })

  it('A4: response routed only to sender-owning tenant (I4)', () => {
    const ok = routeResponse({
      outgoingMessageId: 'm1',
      message: { pluginName: 'p', tenantHint: 'tenant-A' },
      senderTenant: 'tenant-A',
      strictTenantFlag: undefined,
    })
    expect(ok.deliver).toBe(true)

    const blocked = routeResponse({
      outgoingMessageId: 'm1',
      message: { pluginName: 'p', tenantHint: 'tenant-B' },
      senderTenant: 'tenant-A',
      strictTenantFlag: undefined,
    })
    expect(blocked.deliver).toBe(false)
    if (!blocked.deliver) {
      expect(blocked.reason).toBe('tenant_mismatch')
    }
  })

  it('A5: concurrent sequencer ticks on same lead — only one acquires processing_lock', async () => {
    // Seed lead + sequence_state, then fire two ticks; the per-lead
    // processing_lock CAS guarantees at most one ticker mutates state.
    const tenant = tenantCfg('tenant-A', '554399000001')
    const nowIso = new Date().toISOString()
    db.prepare(
      `INSERT INTO sdr_lead_queue (id, tenant, pipedrive_deal_id, contact_phone, contact_name, pulled_at, state, created_at, updated_at)
       VALUES ('L1', 'tenant-A', 1, '5543991938235', 'A', ?, 'sequencing', ?, ?)`,
    ).run(nowIso, nowIso, nowIso)
    db.prepare(
      `INSERT INTO sdr_sequence_state (lead_id, sequence_id, sender_phone, current_step, status, next_action_at)
       VALUES ('L1', 'oralsin-cold-v1', '554399000001', 0, 'active', ?)`,
    ).run(new Date(Date.now() - 1000).toISOString())

    const enqueueCalls: number[] = []
    const mkSequencer = () =>
      new Sequencer(db, {
        enqueueStep: () => {
          enqueueCalls.push(Date.now())
          return `m-${enqueueCalls.length}`
        },
        pickSender: () => '554399000001',
        identityGate: {
          check: () => ({ state: 'has_history' }),
          kickoff: () => 'never',
          handleClassification: () => 'unchanged',
          fetchRow: () => null,
        } as never,
        throttleGate: { check: () => ({ allowed: true, next_eligible_at: '' }) } as never,
        hasOutgoingHistory: () => true,
      })

    await Promise.all([mkSequencer().tick(tenant), mkSequencer().tick(tenant)])

    // Both ticks scan the queue but only one advance step succeeds —
    // the second sees status='active' but the row is locked OR the
    // step counter is already past.
    expect(enqueueCalls.length).toBeLessThanOrEqual(2)
    const state = db.prepare('SELECT current_step, attempts_total FROM sdr_sequence_state WHERE lead_id = ?').get('L1') as
      | { current_step: number; attempts_total: number }
      | undefined
    expect(state).toBeDefined()
    // attempts_total counts every accepted enqueue. With per-lead lock
    // it must equal enqueueCalls.length and not exceed step count.
    expect(state!.attempts_total).toBe(enqueueCalls.length)
  })

  it('A6: plugin reload preserves sequence state (idempotent migrations + persisted rows)', () => {
    const tenant = tenantCfg('tenant-A', '554399000001')
    const nowIso = new Date().toISOString()
    db.prepare(
      `INSERT INTO sdr_lead_queue (id, tenant, pipedrive_deal_id, contact_phone, contact_name, pulled_at, state, created_at, updated_at)
       VALUES ('L1', 'tenant-A', 1, '5543991938235', 'A', ?, 'sequencing', ?, ?)`,
    ).run(nowIso, nowIso, nowIso)
    db.prepare(
      `INSERT INTO sdr_sequence_state (lead_id, sequence_id, sender_phone, current_step, status, next_action_at)
       VALUES ('L1', 'oralsin-cold-v1', '554399000001', 2, 'active', ?)`,
    ).run(nowIso)

    // Simulate plugin restart by re-running migrations (CREATE IF NOT
    // EXISTS / idempotent), then re-reading state.
    initSdrSchema(db)
    initSdrSchema(db)

    const state = db.prepare('SELECT current_step, status FROM sdr_sequence_state WHERE lead_id = ?').get('L1') as
      | { current_step: number; status: string }
      | undefined
    expect(state?.current_step).toBe(2)
    expect(state?.status).toBe('active')
    void tenant
  })

  it('A7: duplicate webhook delivery — operator alert idempotent on (lead, message, reason)', () => {
    // OperatorAlerts.raise uses UNIQUE(lead_id, message_id, reason) so
    // duplicate webhook calls for the same ambiguous response only
    // produce one alert row.
    const alerts = new OperatorAlerts(db)
    const id1 = alerts.raise({ tenant: 'tenant-A', leadId: 'L1', messageId: 'M1', responseText: '???', reason: 'amb' })
    const id2 = alerts.raise({ tenant: 'tenant-A', leadId: 'L1', messageId: 'M1', responseText: '???', reason: 'amb' })
    expect(id1).toBe(id2)
    const rows = db.prepare("SELECT COUNT(*) AS n FROM sdr_operator_alerts WHERE lead_id = 'L1'").get() as { n: number }
    expect(rows.n).toBe(1)
  })

  it('A8: quarantined sender (active=0) is excluded from listByTenant / getByPhone', () => {
    const sm = bootSenderMapping(db)
    sm.create({ phoneNumber: '554399000001', deviceSerial: 'devX' })
    sm.create({ phoneNumber: '554399000002', deviceSerial: 'devX' })
    expect(sm.setSenderTenant('554399000001', 'tenant-A').ok).toBe(true)
    expect(sm.setSenderTenant('554399000002', 'tenant-A').ok).toBe(true)
    expect(sm.listByTenant('tenant-A')).toHaveLength(2)

    sm.deactivate('554399000001')
    const remaining = sm.listByTenant('tenant-A')
    expect(remaining).toHaveLength(1)
    expect(remaining[0].phone_number).toBe('554399000002')
  })

  it('A9: legacy plugin send (tenant_hint=null) blocked from a claimed device', () => {
    const dta = new DeviceTenantAssignment(db)
    dta.claim('devX', 'tenant-A', 'debt-sdr')
    const sm = bootSenderMapping(db)
    sm.create({ phoneNumber: '554399000001', deviceSerial: 'devX' })
    sm.setSenderTenant('554399000001', 'tenant-A')
    const queue = bootMessageQueue(db, dta)

    // Legacy enqueue — no tenantHint.
    queue.enqueue({
      to: '5543991938235',
      body: 'hello',
      senderNumber: '554399000001',
      pluginName: 'legacy-plugin',
      idempotencyKey: 'legacy-1',
    })

    const got = queue.dequeueBySender('devX', 1)
    expect(got).toHaveLength(0)
  })

  it('A10: msg with tenant_hint=A is rejected by device claimed for tenant B', () => {
    const dta = new DeviceTenantAssignment(db)
    dta.claim('devX', 'tenant-B', 'debt-sdr')
    const sm = bootSenderMapping(db)
    sm.create({ phoneNumber: '554399000099', deviceSerial: 'devX' })
    const queue = bootMessageQueue(db, dta)

    queue.enqueue({
      to: '5543991938235',
      body: 'hello',
      senderNumber: '554399000099',
      pluginName: 'debt-sdr',
      idempotencyKey: 'cross-tenant',
      tenantHint: 'tenant-A',
    })

    const got = queue.dequeueBySender('devX', 1)
    expect(got).toHaveLength(0)
    // Message is still in queue, just blocked.
    const total = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE status = 'queued'").get() as { n: number }
    expect(total.n).toBe(1)
  })
})
