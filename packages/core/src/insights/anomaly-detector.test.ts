import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { MessageQueue } from '../queue/message-queue.js'
import { detectAnomaly } from './anomaly-detector.js'

describe('detectAnomaly', () => {
  let db: Database.Database
  let queue: MessageQueue

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    queue = new MessageQueue(db)
    queue.initialize()
  })

  afterEach(() => {
    db.close()
  })

  function seedSent(createdAt: string, updatedAt: string) {
    const id = `m-${Math.random().toString(36).slice(2)}`
    db.prepare(`
      INSERT INTO messages (id, to_number, body, idempotency_key, status, created_at, updated_at)
      VALUES (?, '5543991938235', 'test', ?, 'sent', ?, ?)
    `).run(id, `k-${id}`, createdAt, updatedAt)
    return id
  }

  it('returns inactive when insufficient data', () => {
    const result = detectAnomaly(db)
    expect(result.active).toBe(false)
    expect(result.delta_pct).toBe(0)
    expect(result.started_at).toBeNull()
  })

  it('returns inactive when 30min latency is similar to 24h', () => {
    const now = Date.now()
    // Seed 5 messages in last 30min with ~1s latency
    for (let i = 0; i < 5; i++) {
      const created = new Date(now - 10 * 60 * 1000 - i * 60_000).toISOString()
      const updated = new Date(now - 10 * 60 * 1000 - i * 60_000 + 1000).toISOString()
      seedSent(created, updated)
    }
    // Seed 5 older messages in last 24h with ~1s latency
    for (let i = 0; i < 5; i++) {
      const created = new Date(now - 2 * 60 * 60 * 1000 - i * 60_000).toISOString()
      const updated = new Date(now - 2 * 60 * 60 * 1000 - i * 60_000 + 1000).toISOString()
      seedSent(created, updated)
    }

    const result = detectAnomaly(db)
    expect(result.active).toBe(false)
  })

  it('detects anomaly when 30min latency is >30% above 24h median', () => {
    const now = Date.now()
    // Normal 24h messages: 1s latency each
    for (let i = 0; i < 5; i++) {
      const created = new Date(now - 2 * 60 * 60 * 1000 - i * 60_000).toISOString()
      const updated = new Date(now - 2 * 60 * 60 * 1000 - i * 60_000 + 1000).toISOString()
      seedSent(created, updated)
    }
    // Recent 30min messages: 2s latency — 100% above baseline
    for (let i = 0; i < 5; i++) {
      const created = new Date(now - 20 * 60 * 1000 - i * 30_000).toISOString()
      const updated = new Date(now - 20 * 60 * 1000 - i * 30_000 + 2000).toISOString()
      seedSent(created, updated)
    }

    const result = detectAnomaly(db)
    expect(result.active).toBe(true)
    expect(result.delta_pct).toBeGreaterThan(30)
    expect(result.started_at).not.toBeNull()
    expect(result.latency_30min_ms).toBeGreaterThan(result.latency_24h_ms)
  })

  it('returns structured fields in all cases', () => {
    const result = detectAnomaly(db)
    expect(result).toHaveProperty('active')
    expect(result).toHaveProperty('latency_30min_ms')
    expect(result).toHaveProperty('latency_24h_ms')
    expect(result).toHaveProperty('delta_pct')
    expect(result).toHaveProperty('started_at')
  })
})
