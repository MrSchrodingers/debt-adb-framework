import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { ThrottleGate, type ThrottleConfig } from './throttle-gate.js'

const config: ThrottleConfig = {
  per_sender_daily_max: 5,
  min_interval_minutes: 10,
  operating_hours: { start: '09:00', end: '18:00' },
  tz: 'America/Sao_Paulo',
}

function setupDb(): Database.Database {
  const db = new Database(':memory:')
  // Minimal messages table — only the columns the throttle gate reads.
  db.prepare(
    `CREATE TABLE messages (
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
  return db
}

function insertSent(db: Database.Database, sender: string, sentAtIso: string, idx = 0): void {
  db.prepare(
    `INSERT INTO messages (id, to_number, body, idempotency_key, sender_number, status, sent_at, updated_at)
     VALUES (?, '5599', 'x', ?, ?, 'sent', ?, ?)`,
  ).run(`m-${idx}-${Math.random().toString(36).slice(2, 8)}`, `k-${idx}-${Math.random().toString(36).slice(2, 8)}`, sender, sentAtIso, sentAtIso)
}

// Helper — a fixed UTC instant inside operating hours for America/Sao_Paulo (UTC-3).
const NOON_LOCAL_UTC = Date.UTC(2026, 4, 14, 15, 0) // 12:00 -03:00 = 15:00 UTC

describe('ThrottleGate.check — operating hours', () => {
  let db: Database.Database
  beforeEach(() => { db = setupDb() })
  afterEach(() => db.close())

  it('allows when inside operating hours and no prior sends', () => {
    const gate = new ThrottleGate(db, { now: () => NOON_LOCAL_UTC })
    const r = gate.check('554399000001', config)
    expect(r.allowed).toBe(true)
  })

  it('blocks before opening hour', () => {
    const before = Date.UTC(2026, 4, 14, 11, 0) // 08:00 -03:00
    const gate = new ThrottleGate(db, { now: () => before })
    const r = gate.check('554399000001', config)
    expect(r.allowed).toBe(false)
    if (!r.allowed) {
      expect(r.reason).toBe('outside_hours')
      expect(r.next_eligible_at).toBeTruthy()
    }
  })

  it('blocks at and after closing hour', () => {
    const after = Date.UTC(2026, 4, 14, 21, 30) // 18:30 -03:00
    const gate = new ThrottleGate(db, { now: () => after })
    const r = gate.check('554399000001', config)
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.reason).toBe('outside_hours')
  })
})

describe('ThrottleGate.check — daily max', () => {
  let db: Database.Database
  beforeEach(() => { db = setupDb() })
  afterEach(() => db.close())

  it('blocks when daily count >= per_sender_daily_max', () => {
    // 5 sends already today.
    for (let i = 0; i < 5; i++) {
      insertSent(db, '554399000001', new Date(NOON_LOCAL_UTC - i * 60 * 1000).toISOString(), i)
    }
    const gate = new ThrottleGate(db, { now: () => NOON_LOCAL_UTC })
    const r = gate.check('554399000001', config)
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.reason).toBe('daily_max')
  })

  it('counts only the queried sender', () => {
    for (let i = 0; i < 5; i++) {
      insertSent(db, '554399000002', new Date(NOON_LOCAL_UTC - i * 60 * 1000).toISOString(), i)
    }
    const gate = new ThrottleGate(db, { now: () => NOON_LOCAL_UTC })
    const r = gate.check('554399000001', config)
    expect(r.allowed).toBe(true)
  })

  it('allows when below daily max', () => {
    for (let i = 0; i < 4; i++) {
      insertSent(db, '554399000001', new Date(NOON_LOCAL_UTC - i * 60 * 60 * 1000).toISOString(), i)
    }
    const gate = new ThrottleGate(db, { now: () => NOON_LOCAL_UTC + 60 * 60 * 1000 })
    const r = gate.check('554399000001', { ...config, min_interval_minutes: 0 })
    expect(r.allowed).toBe(true)
  })
})

describe('ThrottleGate.check — min interval', () => {
  let db: Database.Database
  beforeEach(() => { db = setupDb() })
  afterEach(() => db.close())

  it('blocks when last send was within the min interval', () => {
    // Last send was 5 minutes ago; min_interval=10.
    insertSent(db, '554399000001', new Date(NOON_LOCAL_UTC - 5 * 60 * 1000).toISOString())
    const gate = new ThrottleGate(db, { now: () => NOON_LOCAL_UTC })
    const r = gate.check('554399000001', config)
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.reason).toBe('min_interval')
  })

  it('allows when last send was outside the min interval', () => {
    insertSent(db, '554399000001', new Date(NOON_LOCAL_UTC - 15 * 60 * 1000).toISOString())
    const gate = new ThrottleGate(db, { now: () => NOON_LOCAL_UTC })
    const r = gate.check('554399000001', config)
    expect(r.allowed).toBe(true)
  })

  it('returns next_eligible_at exactly min_interval after last send', () => {
    const lastSent = NOON_LOCAL_UTC - 5 * 60 * 1000
    insertSent(db, '554399000001', new Date(lastSent).toISOString())
    const gate = new ThrottleGate(db, { now: () => NOON_LOCAL_UTC })
    const r = gate.check('554399000001', config)
    expect(r.allowed).toBe(false)
    if (!r.allowed && r.reason === 'min_interval') {
      const expected = new Date(lastSent + 10 * 60 * 1000).toISOString()
      expect(r.next_eligible_at).toBe(expected)
    }
  })
})

describe('ThrottleGate.check — resolution order', () => {
  let db: Database.Database
  beforeEach(() => { db = setupDb() })
  afterEach(() => db.close())

  it('outside_hours wins over daily_max and min_interval', () => {
    // 5 sends + recent send + outside hours → outside_hours wins.
    for (let i = 0; i < 5; i++) {
      insertSent(db, '554399000001', new Date(NOON_LOCAL_UTC - i * 60 * 1000).toISOString(), i)
    }
    const before = Date.UTC(2026, 4, 14, 8, 0)
    const gate = new ThrottleGate(db, { now: () => before })
    const r = gate.check('554399000001', config)
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.reason).toBe('outside_hours')
  })
})
