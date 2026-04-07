import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { MessageQueue } from './message-queue.js'

describe('MessageQueue.dequeueBySender', () => {
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

  it('returns messages grouped by sender with most pending', () => {
    // Sender A has 3 messages, Sender B has 2
    queue.enqueue({ to: '5543991111111', body: 'A1', idempotencyKey: 'a1', senderNumber: '+554396837945' })
    queue.enqueue({ to: '5543992222222', body: 'A2', idempotencyKey: 'a2', senderNumber: '+554396837945' })
    queue.enqueue({ to: '5543993333333', body: 'A3', idempotencyKey: 'a3', senderNumber: '+554396837945' })
    queue.enqueue({ to: '5543994444444', body: 'B1', idempotencyKey: 'b1', senderNumber: '+554396837844' })
    queue.enqueue({ to: '5543995555555', body: 'B2', idempotencyKey: 'b2', senderNumber: '+554396837844' })

    const batch = queue.dequeueBySender('device-001', 50)

    // Should return sender A's messages (most pending)
    expect(batch.length).toBe(3)
    expect(batch.every((m) => m.senderNumber === '+554396837945')).toBe(true)
    expect(batch.every((m) => m.status === 'locked')).toBe(true)
  })

  it('respects batch size limit', () => {
    for (let i = 0; i < 10; i++) {
      queue.enqueue({ to: `554399${i}000000`, body: `Msg ${i}`, idempotencyKey: `limit-${i}`, senderNumber: '+554396837945' })
    }

    const batch = queue.dequeueBySender('device-001', 3)

    expect(batch.length).toBe(3)
  })

  it('dequeues high-priority first regardless of sender group', () => {
    // Normal priority sender A messages
    queue.enqueue({ to: '5543991111111', body: 'Normal A1', idempotencyKey: 'normal-a1', senderNumber: '+554396837945', priority: 5 })
    queue.enqueue({ to: '5543992222222', body: 'Normal A2', idempotencyKey: 'normal-a2', senderNumber: '+554396837945', priority: 5 })

    // High priority sender B message
    queue.enqueue({ to: '5543993333333', body: 'High B1', idempotencyKey: 'high-b1', senderNumber: '+554396837844', priority: 1 })

    const batch = queue.dequeueBySender('device-001', 50)

    // High priority should come first
    expect(batch[0].priority).toBe(1)
    expect(batch[0].senderNumber).toBe('+554396837844')
  })

  it('locks all messages in batch atomically', () => {
    queue.enqueue({ to: '5543991111111', body: 'Msg 1', idempotencyKey: 'atomic-1', senderNumber: '+554396837945' })
    queue.enqueue({ to: '5543992222222', body: 'Msg 2', idempotencyKey: 'atomic-2', senderNumber: '+554396837945' })

    const batch = queue.dequeueBySender('device-001', 50)

    expect(batch).toHaveLength(2)
    expect(batch.every((m) => m.lockedBy === 'device-001')).toBe(true)
    expect(batch.every((m) => m.lockedAt !== null)).toBe(true)

    // Second dequeue should return empty (all locked)
    const batch2 = queue.dequeueBySender('device-002', 50)
    expect(batch2).toHaveLength(0)
  })

  it('stale lock cleanup handles batch-locked messages', () => {
    queue.enqueue({ to: '5543991111111', body: 'Msg 1', idempotencyKey: 'stale-1', senderNumber: '+554396837945' })
    queue.enqueue({ to: '5543992222222', body: 'Msg 2', idempotencyKey: 'stale-2', senderNumber: '+554396837945' })

    queue.dequeueBySender('device-001', 50)

    // Simulate stale locks by updating locked_at to old timestamp
    db.prepare("UPDATE messages SET locked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-300 seconds') WHERE status = 'locked'").run()

    const cleaned = queue.cleanStaleLocks()
    expect(cleaned).toBe(2)

    // Now they should be available again
    const batch = queue.dequeueBySender('device-002', 50)
    expect(batch).toHaveLength(2)
  })

  it('returns empty array when no queued messages', () => {
    const batch = queue.dequeueBySender('device-001', 50)
    expect(batch).toHaveLength(0)
  })

  it('orders messages within batch by priority then created_at', () => {
    queue.enqueue({ to: '5543991111111', body: 'Lower priority', idempotencyKey: 'order-1', senderNumber: '+554396837945', priority: 8 })
    queue.enqueue({ to: '5543992222222', body: 'Higher priority', idempotencyKey: 'order-2', senderNumber: '+554396837945', priority: 5 })

    const batch = queue.dequeueBySender('device-001', 50)

    expect(batch).toHaveLength(2)
    expect(batch[0].body).toBe('Higher priority')
    expect(batch[1].body).toBe('Lower priority')
  })
})
