import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { SenderHealth } from './sender-health.js'

function createTestDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE IF NOT EXISTS sender_health (
      sender_number TEXT PRIMARY KEY,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      quarantined_until TEXT,
      last_failure_at TEXT,
      last_success_at TEXT,
      total_failures INTEGER NOT NULL DEFAULT 0,
      total_successes INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `)
  return db
}

describe('SenderHealth', () => {
  let db: InstanceType<typeof Database>

  beforeEach(() => {
    db = createTestDb()
  })

  afterEach(() => {
    vi.useRealTimers()
    db.close()
  })

  it('quarantines sender after N consecutive failures', () => {
    const health = new SenderHealth(db, { quarantineAfterFailures: 3 })
    health.recordFailure('+5543996835100')
    health.recordFailure('+5543996835100')
    expect(health.isQuarantined('+5543996835100')).toBe(false)
    health.recordFailure('+5543996835100')
    expect(health.isQuarantined('+5543996835100')).toBe(true)
  })

  it('resets failure count on success', () => {
    const health = new SenderHealth(db, { quarantineAfterFailures: 3 })
    health.recordFailure('+5543996835100')
    health.recordFailure('+5543996835100')
    health.recordSuccess('+5543996835100')
    health.recordFailure('+5543996835100')
    expect(health.isQuarantined('+5543996835100')).toBe(false)
  })

  it('auto-releases quarantine after cooldown', () => {
    vi.useFakeTimers()
    const now = new Date('2026-04-09T12:00:00.000Z')
    vi.setSystemTime(now)

    const health = new SenderHealth(db, { quarantineAfterFailures: 1, quarantineDurationMs: 60_000 })
    health.recordFailure('+5543996835100')
    expect(health.isQuarantined('+5543996835100')).toBe(true)

    // Advance past the quarantine duration
    vi.setSystemTime(new Date('2026-04-09T12:01:01.000Z'))
    expect(health.isQuarantined('+5543996835100')).toBe(false)

    // Verify consecutive_failures was reset
    const status = health.getStatus('+5543996835100')
    expect(status?.consecutiveFailures).toBe(0)
    expect(status?.quarantinedUntil).toBeNull()
  })

  it('does not quarantine below the threshold', () => {
    const health = new SenderHealth(db, { quarantineAfterFailures: 3 })
    health.recordFailure('+5543996835100')
    health.recordFailure('+5543996835100')
    expect(health.isQuarantined('+5543996835100')).toBe(false)
  })

  it('tracks independent senders separately', () => {
    const health = new SenderHealth(db, { quarantineAfterFailures: 2 })
    health.recordFailure('senderA')
    health.recordFailure('senderA')
    health.recordFailure('senderB')
    expect(health.isQuarantined('senderA')).toBe(true)
    expect(health.isQuarantined('senderB')).toBe(false)
  })

  it('uses default config when none provided', () => {
    const health = new SenderHealth(db)
    // Default is 3 failures before quarantine
    health.recordFailure('x')
    health.recordFailure('x')
    expect(health.isQuarantined('x')).toBe(false)
    health.recordFailure('x')
    expect(health.isQuarantined('x')).toBe(true)
  })

  it('does not quarantine unknown sender', () => {
    const health = new SenderHealth(db)
    expect(health.isQuarantined('never-failed')).toBe(false)
  })

  it('persists across instances', () => {
    const health1 = new SenderHealth(db, { quarantineAfterFailures: 2 })
    health1.recordFailure('persistent-sender')
    health1.recordFailure('persistent-sender')
    expect(health1.isQuarantined('persistent-sender')).toBe(true)

    // Create a second instance sharing the same DB
    const health2 = new SenderHealth(db, { quarantineAfterFailures: 2 })
    expect(health2.isQuarantined('persistent-sender')).toBe(true)
  })

  it('tracks total_failures and total_successes historically', () => {
    const health = new SenderHealth(db, { quarantineAfterFailures: 3 })
    health.recordFailure('stats-sender')
    health.recordFailure('stats-sender')
    health.recordSuccess('stats-sender') // resets consecutive, not total
    health.recordFailure('stats-sender')
    health.recordSuccess('stats-sender')

    const status = health.getStatus('stats-sender')
    expect(status).not.toBeNull()
    expect(status!.totalFailures).toBe(3)
    expect(status!.totalSuccesses).toBe(2)
    expect(status!.consecutiveFailures).toBe(0)
  })

  it('returns null for unknown sender in getStatus', () => {
    const health = new SenderHealth(db)
    expect(health.getStatus('unknown')).toBeNull()
  })
})
