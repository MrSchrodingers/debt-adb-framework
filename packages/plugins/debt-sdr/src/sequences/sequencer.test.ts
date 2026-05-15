import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { Sequencer, type SequencerDeps } from './sequencer.js'
import { initSdrSchema } from '../db/migrations.js'
import { IdentityGate } from '../identity-gate/identity-gate.js'
import { ThrottleGate } from '../throttle/throttle-gate.js'
import './oralsin-cold-v1.js'
import type { SdrTenantConfig } from '../config/tenant-config.js'

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

const NOW = Date.UTC(2026, 4, 14, 15, 0) // 12:00 -03:00, inside hours
let db: Database.Database

function seedLead(): string {
  const id = 'lead-1'
  db.prepare(
    `INSERT INTO sdr_lead_queue (id, tenant, pipedrive_deal_id, contact_phone, contact_name, pulled_at, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pulled', ?, ?)`,
  ).run(id, TENANT.name, 100, '554399999991', 'João', new Date(NOW).toISOString(), new Date(NOW).toISOString(), new Date(NOW).toISOString())
  // Also seed a minimal messages table so ThrottleGate's daily_max / min_interval queries don't error.
  db.prepare(
    `CREATE TABLE IF NOT EXISTS messages (
       id TEXT PRIMARY KEY,
       to_number TEXT NOT NULL,
       body TEXT NOT NULL,
       idempotency_key TEXT NOT NULL UNIQUE,
       sender_number TEXT,
       status TEXT NOT NULL,
       sent_at TEXT,
       updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     )`,
  ).run()
  return id
}

function makeDeps(): SequencerDeps & {
  enqueueStep: ReturnType<typeof vi.fn>
  hasOutgoingHistory: ReturnType<typeof vi.fn>
} {
  const identityGate = new IdentityGate(db, {
    enqueueHandshake: vi.fn(() => 'hs-msg-1'),
    blacklist: vi.fn(),
    raiseOperatorAlert: vi.fn(),
  })
  const throttleGate = new ThrottleGate(db, { now: () => NOW })
  return {
    enqueueStep: vi.fn(() => 'msg-' + Math.random().toString(36).slice(2, 7)),
    pickSender: () => '554399000001',
    identityGate,
    throttleGate,
    hasOutgoingHistory: vi.fn(() => false),
    now: () => NOW,
  } as unknown as SequencerDeps & {
    enqueueStep: ReturnType<typeof vi.fn>
    hasOutgoingHistory: ReturnType<typeof vi.fn>
  }
}

beforeEach(() => {
  db = new Database(':memory:')
  initSdrSchema(db)
})

afterEach(() => db.close())

describe('Sequencer.tick — first run on a new lead', () => {
  it('kicks off identity gate when gate enabled and no history', async () => {
    seedLead()
    const deps = makeDeps()
    const seq = new Sequencer(db, deps)
    const r = await seq.tick(TENANT)
    expect(r.examined).toBe(1)
    expect(r.advanced).toBe(1)
    const state = seq.fetchState('lead-1')
    expect(state).not.toBeNull()
    expect(state!.status).toBe('pending_identity')
    const lead = db.prepare("SELECT state FROM sdr_lead_queue WHERE id='lead-1'").get() as { state: string }
    expect(lead.state).toBe('gating')
  })

  it('skips identity gate when has_history; immediately schedules step 0', async () => {
    seedLead()
    const deps = makeDeps()
    deps.hasOutgoingHistory.mockReturnValue(true)
    const seq = new Sequencer(db, deps)
    const r = await seq.tick(TENANT)
    expect(r.advanced).toBe(1)
    expect(seq.fetchState('lead-1')!.status).toBe('active')
  })

  it('respects identity_gate.enabled=false (skip entirely)', async () => {
    seedLead()
    const deps = makeDeps()
    const seq = new Sequencer(db, deps)
    const r = await seq.tick({ ...TENANT, identity_gate: { ...TENANT.identity_gate, enabled: false } })
    expect(r.advanced).toBe(1)
    expect(seq.fetchState('lead-1')!.status).toBe('active')
  })
})

describe('Sequencer.tick — second-tick transitions', () => {
  it('moves from pending_identity → active when gate verified', async () => {
    seedLead()
    const deps = makeDeps()
    const seq = new Sequencer(db, deps)
    await seq.tick(TENANT) // create pending_identity
    // Mock the gate row as verified.
    db.prepare(
      `UPDATE sdr_contact_identity SET state = 'verified' WHERE contact_phone = '554399999991'`,
    ).run()
    db.prepare(
      `UPDATE sdr_sequence_state SET next_action_at = ? WHERE lead_id = 'lead-1'`,
    ).run(new Date(NOW - 1000).toISOString())

    const r2 = await seq.tick(TENANT)
    expect(r2.advanced).toBeGreaterThanOrEqual(1)
    expect(seq.fetchState('lead-1')!.status).toBe('active')
  })

  it('terminates sequence when gate marks opted_out', async () => {
    seedLead()
    const deps = makeDeps()
    const seq = new Sequencer(db, deps)
    await seq.tick(TENANT)
    db.prepare(
      `UPDATE sdr_contact_identity SET state = 'opted_out' WHERE contact_phone = '554399999991'`,
    ).run()
    db.prepare(
      `UPDATE sdr_sequence_state SET next_action_at = ? WHERE lead_id = 'lead-1'`,
    ).run(new Date(NOW - 1000).toISOString())

    await seq.tick(TENANT)
    expect(seq.fetchState('lead-1')!.status).toBe('opted_out')
    const lead = db.prepare("SELECT state FROM sdr_lead_queue WHERE id='lead-1'").get() as { state: string }
    expect(lead.state).toBe('aborted')
  })
})

describe('Sequencer.tick — step enqueue + advance', () => {
  it('enqueues step 0 when active and due, advances to step 1', async () => {
    seedLead()
    const deps = makeDeps()
    deps.hasOutgoingHistory.mockReturnValue(true) // skip identity
    const seq = new Sequencer(db, deps)
    await seq.tick(TENANT) // creates active state, schedules step 0 immediately
    await seq.tick(TENANT) // should enqueue

    expect(deps.enqueueStep).toHaveBeenCalled()
    const state = seq.fetchState('lead-1')!
    expect(state.current_step).toBe(1)
    expect(state.last_message_id).toBeTruthy()
  })

  it('honors throttle gate — blocks send when outside hours', async () => {
    seedLead()
    const deps = makeDeps()
    deps.hasOutgoingHistory.mockReturnValue(true)
    // Force ThrottleGate to "outside_hours" by setting hours to a slot in the future.
    const closedTenant = {
      ...TENANT,
      throttle: { ...TENANT.throttle, operating_hours: { start: '09:00', end: '09:01' } },
    }
    const seq = new Sequencer(db, deps)
    await seq.tick(closedTenant)
    await seq.tick(closedTenant)
    expect(deps.enqueueStep).not.toHaveBeenCalled()
  })

  it('marks lead completed and sequence no_response after the terminal step', async () => {
    seedLead()
    const deps = makeDeps()
    deps.hasOutgoingHistory.mockReturnValue(true)
    const seq = new Sequencer(db, deps)
    // Run 4 ticks: 1 to create active state, 3 to advance through steps.
    for (let i = 0; i < 4; i++) {
      await seq.tick(TENANT)
      const s = seq.fetchState('lead-1')
      if (s) {
        // Re-arm next_action_at so we don't depend on day_offset elapsing.
        db.prepare(
          `UPDATE sdr_sequence_state SET next_action_at = ? WHERE lead_id = 'lead-1'`,
        ).run(new Date(NOW - 1000).toISOString())
      }
    }
    const final = seq.fetchState('lead-1')!
    expect(final.status).toBe('no_response')
    const lead = db.prepare("SELECT state FROM sdr_lead_queue WHERE id='lead-1'").get() as { state: string }
    expect(lead.state).toBe('completed')
  })
})

describe('Sequencer — processing lock', () => {
  it('reaps stale locks (older than 5 min)', async () => {
    seedLead()
    const deps = makeDeps()
    const seq = new Sequencer(db, deps)
    await seq.tick(TENANT) // creates state row

    // Insert a stale lock.
    const stale = new Date(NOW - 10 * 60 * 1000).toISOString()
    db.prepare(
      `UPDATE sdr_sequence_state SET processing_lock = 'stale', processing_lock_at = ?, next_action_at = ? WHERE lead_id = 'lead-1'`,
    ).run(stale, new Date(NOW - 1000).toISOString())

    deps.hasOutgoingHistory.mockReturnValue(true)
    const r = await seq.tick(TENANT)
    expect(r.examined).toBeGreaterThanOrEqual(1)
  })
})

describe('Sequencer.terminateSequence (external entry)', () => {
  it('marks sequence qualified and lead completed', async () => {
    seedLead()
    const deps = makeDeps()
    const seq = new Sequencer(db, deps)
    await seq.tick(TENANT)
    seq.terminateSequence('lead-1', 'qualified', 'interested_classifier')
    const state = seq.fetchState('lead-1')!
    expect(state.status).toBe('qualified')
    expect(state.stop_reason).toBe('interested_classifier')
    const lead = db.prepare("SELECT state FROM sdr_lead_queue WHERE id='lead-1'").get() as { state: string }
    expect(lead.state).toBe('completed')
  })
})
