import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { SenderScoring } from './sender-scoring.js'
import { SenderHealth } from './sender-health.js'

// ── Test helpers ────────────────────────────────────────────────────────────

function createTestDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
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

// Epoch anchor for deterministic tests
const T0 = new Date('2026-01-01T12:00:00.000Z').getTime()
const SEC = 1000

function makeScoring(db: Database.Database, health: SenderHealth, overrides: Parameters<typeof SenderScoring>[2] = {}) {
  const scoring = new SenderScoring(health, db, { now: () => T0, ...overrides })
  scoring.initialize()
  return scoring
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('SenderScoring', () => {
  let db: Database.Database
  let health: SenderHealth

  beforeEach(() => {
    db = createTestDb()
    health = new SenderHealth(db, { quarantineAfterFailures: 3 })
  })

  afterEach(() => {
    db.close()
  })

  // Test 1: fresh sender — no history
  it('fresh sender scores as role_weight × 1.0 (all other factors neutral)', () => {
    const scoring = makeScoring(db, health)
    const result = scoring.scoreSender({
      phone: '551100000001',
      role: 'primary',
      health: null,
      lastSendAt: null,
    })

    // No health, no recent send: healthScore = irF = timeFactor = 1.0
    expect(result.breakdown.healthScore).toBe(1.0)
    expect(result.breakdown.inverseRecentFailures).toBe(1.0)
    expect(result.breakdown.timeSinceLastSendFactor).toBe(1.0)
    expect(result.breakdown.pluginPriorityWeight).toBe(1.0)
    expect(result.score).toBe(1.0)
  })

  // Test 2: quarantined sender — score = 0
  it('quarantined sender returns score=0', () => {
    // 3 failures triggers quarantine (threshold=3)
    health.recordFailure('551100000002')
    health.recordFailure('551100000002')
    health.recordFailure('551100000002')
    expect(health.isQuarantined('551100000002')).toBe(true)

    const scoring = makeScoring(db, health)
    const result = scoring.scoreSender({
      phone: '551100000002',
      role: 'primary',
    })

    expect(result.score).toBe(0)
    expect(result.breakdown.healthScore).toBe(0)
    expect(result.breakdown.inverseRecentFailures).toBe(0)
    expect(result.breakdown.timeSinceLastSendFactor).toBe(0)
  })

  // Test 3: paused sender must be filtered before reaching scoring
  // (The scoring module does not check paused; caller filters. This test
  //  confirms that if a paused sender somehow reaches scoring, it still
  //  gets a non-zero score — meaning caller MUST pre-filter.)
  it('scoring does NOT hard-block a paused sender (caller responsibility)', () => {
    const scoring = makeScoring(db, health)
    const result = scoring.scoreSender({
      phone: '551100000003',
      role: 'primary',
      health: null,
      lastSendAt: null,
    })
    // No quarantine, no failures: should score > 0
    expect(result.score).toBeGreaterThan(0)
  })

  // Test 4: equal role, more-idle wins
  it('equal role: more-idle sender wins', () => {
    const scoring = makeScoring(db, health)

    // Sender A: sent 30 minutes ago
    const sentRecentIso = new Date(T0 - 30 * 60 * SEC).toISOString()
    // Sender B: sent 10 minutes ago
    const sentJustNowIso = new Date(T0 - 10 * 60 * SEC).toISOString()

    const a = scoring.scoreSender({ phone: 'A', role: 'primary', health: null, lastSendAt: sentRecentIso })
    const b = scoring.scoreSender({ phone: 'B', role: 'primary', health: null, lastSendAt: sentJustNowIso })

    // A is more idle => higher timeSinceLastSendFactor => higher score
    expect(a.breakdown.timeSinceLastSendFactor).toBeGreaterThan(b.breakdown.timeSinceLastSendFactor)
    expect(a.score).toBeGreaterThan(b.score)
  })

  // Test 5: equal idle, lower-failure wins
  it('equal idle and same role: fewer consecutive failures wins', () => {
    const scoring = makeScoring(db, health)

    const goodHealth = { consecutiveFailures: 0, quarantinedUntil: null, totalFailures: 0, totalSuccesses: 10 }
    const badHealth  = { consecutiveFailures: 2, quarantinedUntil: null, totalFailures: 2, totalSuccesses: 8 }

    const good = scoring.scoreSender({ phone: 'good', role: 'overflow', health: goodHealth, lastSendAt: null })
    const bad  = scoring.scoreSender({ phone: 'bad',  role: 'overflow', health: badHealth,  lastSendAt: null })

    expect(good.score).toBeGreaterThan(bad.score)
  })

  // Test 6: equal failures and idle, higher role weight wins
  it('equal failures and idle: primary wins over overflow', () => {
    const scoring = makeScoring(db, health)
    const noHealth = { consecutiveFailures: 0, quarantinedUntil: null, totalFailures: 0, totalSuccesses: 0 }

    const primary  = scoring.scoreSender({ phone: 'P', role: 'primary',  health: noHealth, lastSendAt: null })
    const overflow = scoring.scoreSender({ phone: 'O', role: 'overflow', health: noHealth, lastSendAt: null })

    expect(primary.score).toBeGreaterThan(overflow.score)
    expect(overflow.breakdown.pluginPriorityWeight).toBe(0.7)
    expect(primary.breakdown.pluginPriorityWeight).toBe(1.0)
  })

  // Test 7: breakdown accurately reflects each factor
  it('breakdown components multiply to the total score', () => {
    const scoring = makeScoring(db, health)

    const h = { consecutiveFailures: 1, quarantinedUntil: null, totalFailures: 2, totalSuccesses: 8 }
    const lastSendAt = new Date(T0 - 1800 * SEC).toISOString() // 30 min ago

    const result = scoring.scoreSender({ phone: 'X', role: 'backup', health: h, lastSendAt })

    const { healthScore, inverseRecentFailures, timeSinceLastSendFactor, pluginPriorityWeight } = result.breakdown
    const expected = healthScore * inverseRecentFailures * timeSinceLastSendFactor * pluginPriorityWeight

    expect(result.score).toBeCloseTo(expected, 10)
    // Sanity-check individual components are in (0,1]
    expect(healthScore).toBeGreaterThan(0)
    expect(healthScore).toBeLessThanOrEqual(1)
    expect(inverseRecentFailures).toBeGreaterThan(0)
    expect(inverseRecentFailures).toBeLessThan(1) // 1 consecutive failure must penalise
    expect(timeSinceLastSendFactor).toBeGreaterThan(0)
    expect(timeSinceLastSendFactor).toBeLessThan(1)
    expect(pluginPriorityWeight).toBe(0.5) // backup
  })

  // Test 8: multiplicative behaviour — recent failure drags down even a decent idle sender
  it('single recent failure makes a sender lose to a completely fresh competitor', () => {
    const scoring = makeScoring(db, health)

    const freshHealth    = { consecutiveFailures: 0, quarantinedUntil: null, totalFailures: 0, totalSuccesses: 5 }
    const recentlyFailed = { consecutiveFailures: 1, quarantinedUntil: null, totalFailures: 1, totalSuccesses: 4 }

    // Both never sent (max idle) for fair comparison
    const fresh  = scoring.scoreSender({ phone: 'F', role: 'primary', health: freshHealth,    lastSendAt: null })
    const guilty = scoring.scoreSender({ phone: 'G', role: 'primary', health: recentlyFailed, lastSendAt: null })

    expect(fresh.score).toBeGreaterThan(guilty.score)
    expect(guilty.breakdown.inverseRecentFailures).toBeLessThan(1.0)
  })

  // Test 9: custom config overrides defaults
  it('custom failurePenalty and role weights are applied', () => {
    const scoring = makeScoring(db, health, {
      failurePenalty: 2.0,
      rolePriorityWeights: { primary: 0.9, overflow: 0.5 },
    })

    const h1 = { consecutiveFailures: 1, quarantinedUntil: null, totalFailures: 1, totalSuccesses: 9 }
    const r = scoring.scoreSender({ phone: 'Y', role: 'primary', health: h1, lastSendAt: null })

    expect(r.breakdown.pluginPriorityWeight).toBe(0.9)
    // With penalty=2: 1 / (1 + 1^2 * 2) = 1/3 ≈ 0.333
    expect(r.breakdown.inverseRecentFailures).toBeCloseTo(1 / 3, 5)
  })

  // Test 10: deterministic ordering with injected clock
  it('scoreChain returns deterministic descending order with injected clock', () => {
    const fixedNow = T0
    const scoring = new SenderScoring(health, db, { now: () => fixedNow })
    scoring.initialize()

    // primary: no failures, weight 1.0
    //   score = 1.0 × 1.0 × 1.0 × 1.0 = 1.0
    // overflow: no failures, weight 0.7
    //   score = 1.0 × 1.0 × 1.0 × 0.7 = 0.7
    // reserve: no failures, weight 0.3
    //   score = 1.0 × 1.0 × 1.0 × 0.3 = 0.3
    const ranked = scoring.scoreChain([
      { phone: 'reserve-1',  role: 'reserve',  health: null, lastSendAt: null },
      { phone: 'primary-1',  role: 'primary',  health: null, lastSendAt: null },
      { phone: 'overflow-1', role: 'overflow', health: null, lastSendAt: null },
    ])

    expect(ranked).toHaveLength(3)
    expect(ranked[0].candidate.phone).toBe('primary-1')
    expect(ranked[1].candidate.phone).toBe('overflow-1')
    expect(ranked[2].candidate.phone).toBe('reserve-1')

    // Strictly descending
    for (let i = 0; i < ranked.length - 1; i++) {
      expect(ranked[i].score).toBeGreaterThan(ranked[i + 1].score)
    }
  })

  // Additional: pickBest returns null when all are quarantined
  it('pickBest returns null when all candidates are quarantined', () => {
    const qHealth = new SenderHealth(db, { quarantineAfterFailures: 1 })
    qHealth.recordFailure('q1')
    qHealth.recordFailure('q2')

    const scoring = makeScoring(db, qHealth)
    const result = scoring.pickBest([
      { phone: 'q1', role: 'primary' },
      { phone: 'q2', role: 'overflow' },
    ])

    expect(result).toBeNull()
  })

  // Additional: scoreChain excludes score=0 entries
  it('scoreChain excludes quarantined senders from results', () => {
    const qHealth = new SenderHealth(db, { quarantineAfterFailures: 1 })
    qHealth.recordFailure('quarantined-phone')

    const scoring = makeScoring(db, qHealth)
    const ranked = scoring.scoreChain([
      { phone: 'quarantined-phone', role: 'primary' },
      { phone: 'healthy-phone',     role: 'overflow', health: null, lastSendAt: null },
    ])

    expect(ranked).toHaveLength(1)
    expect(ranked[0].candidate.phone).toBe('healthy-phone')
  })

  // Additional: recordSend writes last_send_at and affects subsequent scoring
  it('recordSend writes last_send_at, idle factor decreases on next score', () => {
    const scoring = makeScoring(db, health)
    scoring.recordSend('track-me')

    // Right after send: nearly 0 idle seconds => time factor near 0
    const right = scoring.scoreSender({ phone: 'track-me', role: 'primary', health: null })
    expect(right.breakdown.timeSinceLastSendFactor).toBeCloseTo(0, 3)

    // 2 hours later (scoring re-created with shifted clock)
    const laterScoring = new SenderScoring(health, db, {
      now: () => T0 + 2 * 3600 * SEC,
    })
    laterScoring.initialize()
    const later = laterScoring.scoreSender({ phone: 'track-me', role: 'primary', health: null })
    // 2h idle >= 1h saturation => capped at 1.0
    expect(later.breakdown.timeSinceLastSendFactor).toBe(1.0)
  })

  // Additional: initialize is idempotent
  it('initialize can be called multiple times without error', () => {
    const scoring = makeScoring(db, health)
    expect(() => {
      scoring.initialize()
      scoring.initialize()
    }).not.toThrow()
  })

  // Additional: time factor saturates at 1.0 even with very old lastSendAt
  it('timeSinceLastSendFactor caps at 1.0 for very old sends', () => {
    const scoring = makeScoring(db, health)
    // 48 hours ago — way past 1h saturation
    const veryOld = new Date(T0 - 48 * 3600 * SEC).toISOString()
    const result = scoring.scoreSender({
      phone: 'old-sender', role: 'primary', health: null, lastSendAt: veryOld,
    })
    expect(result.breakdown.timeSinceLastSendFactor).toBe(1.0)
  })
})
