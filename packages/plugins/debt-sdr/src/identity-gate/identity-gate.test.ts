import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { IdentityGate, type IdentityGateDeps } from './identity-gate.js'
import { initSdrSchema } from '../db/migrations.js'
import type { Classification } from '../classifier/classifier.js'

function makeDeps(): IdentityGateDeps & {
  enqueueHandshake: ReturnType<typeof vi.fn>
  blacklist: ReturnType<typeof vi.fn>
  raiseOperatorAlert: ReturnType<typeof vi.fn>
} {
  return {
    enqueueHandshake: vi.fn(() => `msg-${Math.random().toString(36).slice(2, 9)}`),
    blacklist: vi.fn(),
    raiseOperatorAlert: vi.fn(),
  } as unknown as IdentityGateDeps & {
    enqueueHandshake: ReturnType<typeof vi.fn>
    blacklist: ReturnType<typeof vi.fn>
    raiseOperatorAlert: ReturnType<typeof vi.fn>
  }
}

const CONTACT = { phone: '554399999991', name: 'João' }
const SENDER = '554399000001'
const TENANT = 'oralsin-sdr'
const TENANT_LABEL = 'Oralsin'
const LEAD_ID = 'lead-1'

function classification(category: Classification['category'], confidence = 0.9): Classification {
  return {
    category,
    confidence,
    source: 'regex',
    latency_ms: 1,
  }
}

describe('IdentityGate.check', () => {
  let db: Database.Database
  let gate: IdentityGate

  beforeEach(() => {
    db = new Database(':memory:')
    initSdrSchema(db)
    gate = new IdentityGate(db, makeDeps())
  })

  afterEach(() => db.close())

  it('returns no_history when no row exists and no outgoing history', () => {
    const r = gate.check(TENANT, SENDER, CONTACT.phone, false)
    expect(r.state).toBe('no_history')
  })

  it('returns has_history when caller reports prior outgoing and no row', () => {
    const r = gate.check(TENANT, SENDER, CONTACT.phone, true)
    expect(r.state).toBe('has_history')
  })

  it('returns the existing row state when a row exists (ignores outgoing flag)', () => {
    const deps = makeDeps()
    const g = new IdentityGate(db, deps)
    g.kickoff(TENANT, SENDER, CONTACT, LEAD_ID, TENANT_LABEL)
    const r = g.check(TENANT, SENDER, CONTACT.phone, true)
    expect(r.state).toBe('pending')
  })
})

describe('IdentityGate.kickoff', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    initSdrSchema(db)
  })

  afterEach(() => db.close())

  it('enqueues an intro with a rendered template and creates pending row', () => {
    const deps = makeDeps()
    const gate = new IdentityGate(db, deps)
    const r = gate.kickoff(TENANT, SENDER, CONTACT, LEAD_ID, TENANT_LABEL)
    expect(r.ok).toBe(true)
    expect(deps.enqueueHandshake).toHaveBeenCalledTimes(1)
    const call = deps.enqueueHandshake.mock.calls[0][0]
    expect(call.text).toContain('João')
    expect(call.text).toContain('Oralsin')
    expect(call.kind).toBe('intro')

    const row = gate.fetchRow(TENANT, SENDER, CONTACT.phone)
    expect(row).not.toBeNull()
    expect(row!.state).toBe('pending')
    expect(row!.intro_message_id).toBe(r.messageId)
  })

  it('is idempotent — re-kickoff after pending returns same id', () => {
    const deps = makeDeps()
    const gate = new IdentityGate(db, deps)
    const a = gate.kickoff(TENANT, SENDER, CONTACT, LEAD_ID, TENANT_LABEL)
    const b = gate.kickoff(TENANT, SENDER, CONTACT, LEAD_ID, TENANT_LABEL)
    expect(b.messageId).toBe(a.messageId)
    expect(deps.enqueueHandshake).toHaveBeenCalledTimes(1)
  })
})

describe('IdentityGate.handleClassification — identity phase outcomes', () => {
  let db: Database.Database
  let deps: ReturnType<typeof makeDeps>
  let gate: IdentityGate

  beforeEach(() => {
    db = new Database(':memory:')
    initSdrSchema(db)
    deps = makeDeps()
    gate = new IdentityGate(db, deps)
    gate.kickoff(TENANT, SENDER, CONTACT, LEAD_ID, TENANT_LABEL)
  })

  afterEach(() => db.close())

  it('identity_confirm → verified, no blacklist call', () => {
    const r = gate.handleClassification(
      TENANT,
      SENDER,
      CONTACT,
      LEAD_ID,
      'msg-1',
      'Sim, sou eu',
      classification('identity_confirm'),
    )
    expect(r).toBe('verified')
    expect(gate.fetchRow(TENANT, SENDER, CONTACT.phone)!.state).toBe('verified')
    expect(deps.blacklist).not.toHaveBeenCalled()
  })

  it('identity_deny → wrong_number + 30d temp blacklist', () => {
    const r = gate.handleClassification(
      TENANT,
      SENDER,
      CONTACT,
      LEAD_ID,
      'msg-1',
      'Não sou eu, número errado',
      classification('identity_deny'),
    )
    expect(r).toBe('wrong_number')
    expect(deps.blacklist).toHaveBeenCalledWith(
      CONTACT.phone,
      'sdr_wrong_number_30d',
      { ttlDays: 30 },
    )
  })

  it('opted_out → opted_out + permanent blacklist', () => {
    const r = gate.handleClassification(
      TENANT,
      SENDER,
      CONTACT,
      LEAD_ID,
      'msg-1',
      'pare de mandar',
      classification('opted_out'),
    )
    expect(r).toBe('opted_out')
    expect(deps.blacklist).toHaveBeenCalledWith(CONTACT.phone, 'sdr_opt_out')
  })

  it('ambiguous → unchanged + raises operator alert', () => {
    const r = gate.handleClassification(
      TENANT,
      SENDER,
      CONTACT,
      LEAD_ID,
      'msg-1',
      'sei la',
      classification('ambiguous', 0.2),
    )
    expect(r).toBe('unchanged')
    expect(gate.fetchRow(TENANT, SENDER, CONTACT.phone)!.state).toBe('pending')
    expect(deps.raiseOperatorAlert).toHaveBeenCalledOnce()
    expect(deps.raiseOperatorAlert.mock.calls[0][0].reason).toBe('classifier_ambiguous')
  })

  it('out-of-phase category → unchanged + operator alert with descriptive reason', () => {
    const r = gate.handleClassification(
      TENANT,
      SENDER,
      CONTACT,
      LEAD_ID,
      'msg-1',
      'quero saber mais',
      classification('interested'),
    )
    expect(r).toBe('unchanged')
    expect(deps.raiseOperatorAlert.mock.calls[0][0].reason).toContain('unexpected_category_in_identity_phase')
  })

  it('terminal state ignores subsequent classifications', () => {
    gate.handleClassification(TENANT, SENDER, CONTACT, LEAD_ID, 'msg-1', 'Sim', classification('identity_confirm'))
    const r = gate.handleClassification(TENANT, SENDER, CONTACT, LEAD_ID, 'msg-2', 'cancela', classification('opted_out'))
    expect(r).toBe('unchanged')
    expect(gate.fetchRow(TENANT, SENDER, CONTACT.phone)!.state).toBe('verified')
    expect(deps.blacklist).not.toHaveBeenCalled()
  })

  it('handleClassification on a row that never existed is a no-op', () => {
    const r = gate.handleClassification(
      TENANT,
      SENDER,
      { phone: '5511XXX', name: 'X' },
      LEAD_ID,
      'msg-X',
      'qualquer coisa',
      classification('identity_confirm'),
    )
    expect(r).toBe('unchanged')
  })
})

describe('IdentityGate.triggerNudge', () => {
  let db: Database.Database
  let deps: ReturnType<typeof makeDeps>
  let gate: IdentityGate

  beforeEach(() => {
    db = new Database(':memory:')
    initSdrSchema(db)
    deps = makeDeps()
    gate = new IdentityGate(db, deps)
    gate.kickoff(TENANT, SENDER, CONTACT, LEAD_ID, TENANT_LABEL)
    deps.enqueueHandshake.mockClear()
  })

  afterEach(() => db.close())

  it('enqueues a nudge from the NUDGE pool, records nudge_message_id', () => {
    const r = gate.triggerNudge(TENANT, SENDER, CONTACT, LEAD_ID, TENANT_LABEL)
    expect(r.ok).toBe(true)
    expect(deps.enqueueHandshake).toHaveBeenCalledOnce()
    expect(deps.enqueueHandshake.mock.calls[0][0].kind).toBe('nudge')
    expect(gate.fetchRow(TENANT, SENDER, CONTACT.phone)!.nudge_message_id).toBe(
      r.ok ? r.messageId : '',
    )
  })

  it('refuses to nudge twice', () => {
    gate.triggerNudge(TENANT, SENDER, CONTACT, LEAD_ID, TENANT_LABEL)
    const r2 = gate.triggerNudge(TENANT, SENDER, CONTACT, LEAD_ID, TENANT_LABEL)
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.reason).toBe('already_nudged')
  })

  it('refuses to nudge when state has moved past pending', () => {
    gate.handleClassification(TENANT, SENDER, CONTACT, LEAD_ID, 'msg-1', 'Sim', classification('identity_confirm'))
    const r = gate.triggerNudge(TENANT, SENDER, CONTACT, LEAD_ID, TENANT_LABEL)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('state_moved')
  })
})

describe('IdentityGate.markNoResponse', () => {
  let db: Database.Database
  let gate: IdentityGate

  beforeEach(() => {
    db = new Database(':memory:')
    initSdrSchema(db)
    gate = new IdentityGate(db, makeDeps())
    gate.kickoff(TENANT, SENDER, CONTACT, LEAD_ID, TENANT_LABEL)
  })

  afterEach(() => db.close())

  it('marks pending row as no_response', () => {
    const ok = gate.markNoResponse(TENANT, SENDER, CONTACT.phone)
    expect(ok).toBe(true)
    expect(gate.fetchRow(TENANT, SENDER, CONTACT.phone)!.state).toBe('no_response')
  })

  it('returns false on already-terminal row', () => {
    gate.handleClassification(TENANT, SENDER, CONTACT, LEAD_ID, 'm-1', 'Sim', classification('identity_confirm'))
    const ok = gate.markNoResponse(TENANT, SENDER, CONTACT.phone)
    expect(ok).toBe(false)
    expect(gate.fetchRow(TENANT, SENDER, CONTACT.phone)!.state).toBe('verified')
  })
})
