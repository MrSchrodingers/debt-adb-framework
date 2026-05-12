import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { EventEmitter } from 'node:events'
import { AckClusterDetector } from './ack-cluster-detector.js'
import type { DispatchEmitter } from '../events/index.js'

const SCHEMA_WITH_COLUMNS = `
  CREATE TABLE sender_health (
    sender_number TEXT PRIMARY KEY,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    quarantined_until TEXT,
    timelock_until TEXT,
    pause_reason TEXT,
    last_failure_at TEXT,
    last_success_at TEXT,
    total_failures INTEGER NOT NULL DEFAULT 0,
    total_successes INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
`

const SCHEMA_LEGACY = `
  CREATE TABLE sender_health (
    sender_number TEXT PRIMARY KEY,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    quarantined_until TEXT,
    updated_at TEXT
  );
`

function makeDetector(db: Database.Database, emitter: EventEmitter): AckClusterDetector {
  return new AckClusterDetector(db, emitter as unknown as DispatchEmitter, {
    clusterCount: 3,
    windowMs: 60_000,
    pauseMs: 300_000,
  })
}

describe('AckClusterDetector', () => {
  let db: Database.Database
  let emitter: EventEmitter
  let detector: AckClusterDetector

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(SCHEMA_WITH_COLUMNS)
    emitter = new EventEmitter()
    detector = makeDetector(db, emitter)
  })

  it('does not trigger below cluster threshold', () => {
    const t = Date.now()
    detector.recordAckError('+5543991111', t)
    detector.recordAckError('+5543991111', t + 1000)
    const row = db
      .prepare('SELECT timelock_until FROM sender_health WHERE sender_number = ?')
      .get('+5543991111') as { timelock_until: string | null } | undefined
    expect(row?.timelock_until ?? null).toBeNull()
  })

  it('triggers timelock when cluster threshold reached within window', () => {
    const t = Date.now()
    const handler = vi.fn()
    emitter.on('sender:timelock_suspected', handler)

    detector.recordAckError('+5543992222', t)
    detector.recordAckError('+5543992222', t + 1000)
    detector.recordAckError('+5543992222', t + 2000)

    const row = db
      .prepare('SELECT timelock_until, pause_reason FROM sender_health WHERE sender_number = ?')
      .get('+5543992222') as { timelock_until: string; pause_reason: string }
    expect(row.timelock_until).toBeDefined()
    expect(row.pause_reason).toBe('timelock_suspected')
    const untilMs = new Date(row.timelock_until).getTime()
    expect(untilMs).toBeGreaterThan(t + 290_000)
    expect(untilMs).toBeLessThan(t + 310_000)
    expect(handler).toHaveBeenCalledOnce()
    expect(handler).toHaveBeenCalledWith({
      sender: '+5543992222',
      timelockUntil: row.timelock_until,
      clusterCount: 3,
      windowMs: 60_000,
    })
  })

  it('does NOT trigger when errors span outside the window', () => {
    const t = Date.now()
    detector.recordAckError('+5543993333', t)
    detector.recordAckError('+5543993333', t + 30_000)
    detector.recordAckError('+5543993333', t + 70_000)
    const row = db
      .prepare('SELECT timelock_until FROM sender_health WHERE sender_number = ?')
      .get('+5543993333') as { timelock_until: string | null } | undefined
    expect(row?.timelock_until ?? null).toBeNull()
  })

  it('resets the window after a trigger so 2 more errors do not re-pause', () => {
    const t = Date.now()
    for (let i = 0; i < 3; i++) detector.recordAckError('+5543994444', t + i)
    const firstUntil = (db
      .prepare('SELECT timelock_until FROM sender_health WHERE sender_number = ?')
      .get('+5543994444') as { timelock_until: string }).timelock_until

    detector.recordAckError('+5543994444', t + 1000)
    detector.recordAckError('+5543994444', t + 2000)
    const secondUntil = (db
      .prepare('SELECT timelock_until FROM sender_health WHERE sender_number = ?')
      .get('+5543994444') as { timelock_until: string }).timelock_until
    expect(secondUntil).toBe(firstUntil)
  })

  it('isolates per-sender windows', () => {
    const t = Date.now()
    detector.recordAckError('+5543995555', t)
    detector.recordAckError('+5543995555', t + 100)
    detector.recordAckError('+5543996666', t + 200)
    const row5555 = db
      .prepare('SELECT timelock_until FROM sender_health WHERE sender_number = ?')
      .get('+5543995555') as { timelock_until: string | null } | undefined
    expect(row5555?.timelock_until ?? null).toBeNull()
  })

  it('ignores empty sender phone', () => {
    detector.recordAckError('', Date.now())
    detector.recordAckError('', Date.now())
    detector.recordAckError('', Date.now())
    const rows = db.prepare('SELECT * FROM sender_health').all()
    expect(rows.length).toBe(0)
  })

  it('initialize() adds timelock_until + pause_reason to legacy schema', () => {
    const db2 = new Database(':memory:')
    db2.exec(SCHEMA_LEGACY)
    const det2 = makeDetector(db2, new EventEmitter())
    det2.initialize()
    const cols = db2.prepare('PRAGMA table_info(sender_health)').all() as Array<{ name: string }>
    const names = cols.map((c) => c.name)
    expect(names).toContain('timelock_until')
    expect(names).toContain('pause_reason')
  })

  it('initialize() is idempotent', () => {
    detector.initialize()
    detector.initialize()
    const cols = db.prepare('PRAGMA table_info(sender_health)').all() as Array<{ name: string }>
    const timelockCount = cols.filter((c) => c.name === 'timelock_until').length
    expect(timelockCount).toBe(1)
  })
})
