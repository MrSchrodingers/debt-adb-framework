import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { MessageQueue } from '../queue/message-queue.js'
import { getHeatmap, getErrorHeatmap } from './insights-heatmap.js'

describe('getHeatmap', () => {
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

  function seedSentMessage(senderNumber: string, sentAt: string) {
    const id = `msg-${Math.random().toString(36).slice(2)}`
    db.prepare(`
      INSERT INTO messages (id, to_number, body, idempotency_key, sender_number, status, sent_at, created_at, updated_at)
      VALUES (?, '5543991938235', 'test', ?, ?, 'sent', ?, ?, ?)
    `).run(id, `key-${id}`, senderNumber, sentAt, sentAt, sentAt)
    return id
  }

  it('returns empty rows when no messages', () => {
    const result = getHeatmap(db, '24h')
    expect(result.rows).toHaveLength(0)
  })

  it('groups sent messages by sender and UTC hour', () => {
    const now = new Date()
    // Pin to a specific hour (current UTC hour)
    const hour = now.getUTCHours()
    const sentAt = now.toISOString()

    seedSentMessage('5543000000001', sentAt)
    seedSentMessage('5543000000001', sentAt)
    seedSentMessage('5543000000002', sentAt)

    const result = getHeatmap(db, '24h')
    expect(result.rows).toHaveLength(2)

    const sender1 = result.rows.find((r) => r.sender === '5543000000001')
    expect(sender1).toBeDefined()
    expect(sender1!.hours[hour]).toBe(2)
    expect(sender1!.hours.length).toBe(24)
    expect(sender1!.label).toBe(`…0001`)

    const sender2 = result.rows.find((r) => r.sender === '5543000000002')
    expect(sender2!.hours[hour]).toBe(1)
  })

  it('excludes messages older than the requested range', () => {
    const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
    seedSentMessage('5543000000001', oldDate)

    const result = getHeatmap(db, '24h')
    expect(result.rows).toHaveLength(0)
  })

  it('includes messages within 7d range', () => {
    const recentDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString()
    seedSentMessage('5543000000001', recentDate)

    const result = getHeatmap(db, '7d')
    expect(result.rows).toHaveLength(1)
  })
})

describe('getErrorHeatmap', () => {
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

  function seedFailedMessage(updatedAt: string, errorMeta?: string) {
    const id = `fail-${Math.random().toString(36).slice(2)}`
    db.prepare(`
      INSERT INTO messages (id, to_number, body, idempotency_key, status, updated_at, created_at)
      VALUES (?, '5543991938235', 'test', ?, 'permanently_failed', ?, ?)
    `).run(id, `key-${id}`, updatedAt, updatedAt)

    if (errorMeta) {
      db.prepare(`
        INSERT INTO message_events (message_id, event, metadata, created_at)
        VALUES (?, 'send_failed', ?, ?)
      `).run(id, errorMeta, updatedAt)
    }
    return id
  }

  it('returns empty rows when no failures', () => {
    const result = getErrorHeatmap(db, '24h')
    expect(result.rows).toHaveLength(0)
  })

  it('groups failures by normalised error signature', () => {
    const now = new Date().toISOString()
    // Same error text → same signature
    seedFailedMessage(now, JSON.stringify({ error: 'ADB send timeout' }))
    seedFailedMessage(now, JSON.stringify({ error: 'ADB send timeout' }))
    seedFailedMessage(now, JSON.stringify({ error: 'Device offline' }))

    const result = getErrorHeatmap(db, '24h')
    expect(result.rows.length).toBeGreaterThanOrEqual(1)

    // We should have at least the ADB send timeout signature
    const adbRow = result.rows.find((r) => r.signature.includes('ADB'))
    expect(adbRow).toBeDefined()
    expect(adbRow!.hours.length).toBe(24)
  })

  it('strips dynamic ids from error signatures', () => {
    const now = new Date().toISOString()
    // Two errors with different nanoid-like strings → same normalised signature
    seedFailedMessage(now, JSON.stringify({ error: 'Failed msg abc123def456 at time' }))
    seedFailedMessage(now, JSON.stringify({ error: 'Failed msg xyz789uvw012 at time' }))

    const result = getErrorHeatmap(db, '24h')
    // Both should collapse into 1 signature
    const rows = result.rows.filter((r) => r.signature.includes('Failed'))
    expect(rows.length).toBe(1)
    expect(rows[0]!.examples.length).toBeLessThanOrEqual(3)
  })
})
