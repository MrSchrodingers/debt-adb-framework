import Database from 'better-sqlite3'
import { describe, it, expect, beforeEach } from 'vitest'
import { QualityHistory } from './quality-history.js'
import type { QualityScoreComponents } from './quality-score.js'

function components(overrides: Partial<QualityScoreComponents> = {}): QualityScoreComponents {
  return {
    ackRate: 0.9,
    banHistory: 1,
    age: 0.8,
    warmupCompletion: 1,
    volumeFit: 0.95,
    fingerprintFreshness: 0.7,
    recipientResponse: 0.4,
    ...overrides,
  }
}

describe('QualityHistory', () => {
  let db: Database.Database
  let history: QualityHistory

  beforeEach(() => {
    db = new Database(':memory:')
    history = new QualityHistory(db)
    history.initialize()
  })

  it('records and retrieves latest sample', () => {
    history.record({ senderPhone: '5511999999999', total: 87, components: components() })
    const got = history.latest('5511999999999')
    expect(got).not.toBeNull()
    expect(got!.total).toBe(87)
    expect(got!.components.ackRate).toBe(0.9)
  })

  it('latest returns most recent when multiple rows exist', () => {
    history.record({ senderPhone: '5511999999999', total: 50, components: components(), computedAt: '2026-04-01 10:00:00' })
    history.record({ senderPhone: '5511999999999', total: 75, components: components(), computedAt: '2026-04-02 10:00:00' })
    const got = history.latest('5511999999999')
    expect(got!.total).toBe(75)
  })

  it('returns null for unknown sender', () => {
    expect(history.latest('5500000000000')).toBeNull()
  })

  it('sampleAtOrBefore picks latest <= cutoff', () => {
    history.record({ senderPhone: '551199', total: 80, components: components(), computedAt: '2026-04-01 10:00:00' })
    history.record({ senderPhone: '551199', total: 60, components: components(), computedAt: '2026-04-02 10:00:00' })
    history.record({ senderPhone: '551199', total: 40, components: components(), computedAt: '2026-04-03 10:00:00' })
    const got = history.sampleAtOrBefore('551199', '2026-04-02 12:00:00')
    expect(got!.total).toBe(60)
  })

  it('series filters by time window', () => {
    history.record({ senderPhone: '551199', total: 40, components: components(), computedAt: '2026-04-01 10:00:00' })
    history.record({ senderPhone: '551199', total: 60, components: components(), computedAt: '2026-04-02 10:00:00' })
    history.record({ senderPhone: '551199', total: 80, components: components(), computedAt: '2026-04-03 10:00:00' })
    const got = history.series('551199', '2026-04-02 00:00:00', '2026-04-02 23:59:59')
    expect(got.length).toBe(1)
    expect(got[0].total).toBe(60)
  })

  it('latestPerSender returns one row per sender, sorted by score asc', () => {
    history.record({ senderPhone: '551199', total: 80, components: components(), computedAt: '2026-04-01 10:00:00' })
    history.record({ senderPhone: '551199', total: 60, components: components(), computedAt: '2026-04-02 10:00:00' })
    history.record({ senderPhone: '551188', total: 30, components: components(), computedAt: '2026-04-02 10:00:00' })
    history.record({ senderPhone: '551177', total: 95, components: components(), computedAt: '2026-04-02 10:00:00' })
    const rows = history.latestPerSender()
    expect(rows.length).toBe(3)
    expect(rows[0].senderPhone).toBe('551188')
    expect(rows[0].total).toBe(30)
    expect(rows[1].senderPhone).toBe('551199')
    expect(rows[1].total).toBe(60)
    expect(rows[2].senderPhone).toBe('551177')
  })

  it('prune drops samples older than retention', () => {
    db.prepare(`INSERT INTO chip_quality_history (id, sender_phone, computed_at, total_score, components_json) VALUES (?, ?, datetime('now', '-100 days'), ?, ?)`)
      .run('old1', '551199', 50, '{}')
    history.record({ senderPhone: '551199', total: 80, components: components() })
    const pruned = history.prune(30)
    expect(pruned).toBe(1)
    expect(history.latest('551199')!.total).toBe(80)
  })
})
