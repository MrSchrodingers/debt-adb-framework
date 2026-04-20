import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { ReceiptTracker, normalizeBrPhoneForMatching } from './receipt-tracker.js'
import { MessageQueue } from '../queue/message-queue.js'
import { DispatchEmitter } from '../events/index.js'

describe('normalizeBrPhoneForMatching', () => {
  it('converts 13-digit BR mobile to 12-digit WAHA format', () => {
    // 5543991938235 → 554391938235 (remove 5th digit '9')
    expect(normalizeBrPhoneForMatching('5543991938235')).toBe('554391938235')
  })

  it('converts E.164 format with + prefix', () => {
    expect(normalizeBrPhoneForMatching('+5543991938235')).toBe('554391938235')
  })

  it('leaves 12-digit number unchanged', () => {
    expect(normalizeBrPhoneForMatching('554391938235')).toBe('554391938235')
  })

  it('strips @c.us suffix from WAHA format', () => {
    expect(normalizeBrPhoneForMatching('554391938235@c.us')).toBe('554391938235')
  })

  it('handles non-BR numbers gracefully (no transformation)', () => {
    expect(normalizeBrPhoneForMatching('14155551234')).toBe('14155551234')
  })

  it('handles sender number with 13 digits starting with 55', () => {
    // +554396837945 → 554396837945 → 554396837945 (5th digit is 6, not 9 — no mobile removal)
    // Wait: this is a sender number, 13 digits, starts with 55, 5th digit is '9'?
    // 554396837945: digits[4] = '9' → remove it → 55436837945 (11 digits)
    // Hmm, that's wrong. Let's check: 5-5-4-3-9-6-8-3-7-9-4-5 → digits[4]='9' → remove → 554368379455 (11 digits)
    // Actually: 554396837945 has 12 digits already! With + it's +554396837945 = 13 digits
    // As plain digits: 554396837945 = 12 digits. So no transformation needed.
    expect(normalizeBrPhoneForMatching('554396837945')).toBe('554396837945')
  })

  it('handles 13-digit sender number in E.164 format', () => {
    // +554396837945 → strip + → 554396837945 (12 digits) → no change
    expect(normalizeBrPhoneForMatching('+554396837945')).toBe('554396837945')
  })
})

describe('ReceiptTracker', () => {
  let db: Database.Database
  let queue: MessageQueue
  let emitter: DispatchEmitter
  let tracker: ReceiptTracker

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    queue = new MessageQueue(db)
    queue.initialize()
    emitter = new DispatchEmitter()
    tracker = new ReceiptTracker(db, queue, emitter)
    tracker.initialize()
  })

  afterEach(() => {
    db.close()
  })

  describe('registerSent', () => {
    it('stores a pending correlation entry', () => {
      tracker.registerSent({
        messageId: 'msg-001',
        toNumber: '5543991938235',
        senderNumber: '+554396837945',
        sentAt: new Date().toISOString(),
      })

      // Verify entry exists in pending_correlations
      const row = db.prepare('SELECT * FROM pending_correlations WHERE message_id = ?').get('msg-001')
      expect(row).toBeDefined()
    })

    it('normalizes phone numbers on register', () => {
      tracker.registerSent({
        messageId: 'msg-002',
        toNumber: '5543991938235',
        senderNumber: '+554396837945',
        sentAt: new Date().toISOString(),
      })

      const row = db.prepare('SELECT to_number_normalized, sender_number_normalized FROM pending_correlations WHERE message_id = ?').get('msg-002') as {
        to_number_normalized: string
        sender_number_normalized: string
      }
      expect(row.to_number_normalized).toBe('554391938235')
      expect(row.sender_number_normalized).toBe('554396837945')
    })
  })

  describe('correlateOutgoing', () => {
    it('correlates ADB send with WAHA outgoing message within 60s', () => {
      const sentAt = new Date().toISOString()
      tracker.registerSent({
        messageId: 'msg-003',
        toNumber: '5543991938235',
        senderNumber: '+554396837945',
        sentAt,
      })

      // WAHA sees the same message (c.us format, 12 digits)
      const result = tracker.correlateOutgoing({
        wahaMessageId: 'true_554396837945@c.us_ABCD',
        toNumber: '554391938235',
        senderNumber: '554396837945',
        timestamp: new Date().toISOString(),
      })

      expect(result).not.toBeNull()
      expect(result!.messageId).toBe('msg-003')
    })

    it('rejects correlation outside 60s window', () => {
      // Register sent 2 minutes ago
      const twoMinutesAgo = new Date(Date.now() - 120_000).toISOString()
      tracker.registerSent({
        messageId: 'msg-004',
        toNumber: '5543991938235',
        senderNumber: '+554396837945',
        sentAt: twoMinutesAgo,
      })

      const result = tracker.correlateOutgoing({
        wahaMessageId: 'true_554396837945@c.us_EFGH',
        toNumber: '554391938235',
        senderNumber: '554396837945',
        timestamp: new Date().toISOString(),
      })

      expect(result).toBeNull()
    })

    it('stores waha_message_id in messages table after correlation', () => {
      // Enqueue a message in the queue first
      const msg = queue.enqueue({
        to: '5543991938235',
        body: 'Test',
        idempotencyKey: 'test-corr-1',
        senderNumber: '+554396837945',
      })

      tracker.registerSent({
        messageId: msg.id,
        toNumber: '5543991938235',
        senderNumber: '+554396837945',
        sentAt: new Date().toISOString(),
      })

      tracker.correlateOutgoing({
        wahaMessageId: 'waha-msg-123',
        toNumber: '554391938235',
        senderNumber: '554396837945',
        timestamp: new Date().toISOString(),
      })

      const updated = queue.getById(msg.id)
      expect(updated!.wahaMessageId).toBe('waha-msg-123')
    })

    it('does not double-correlate same WAHA message', () => {
      tracker.registerSent({
        messageId: 'msg-005',
        toNumber: '5543991938235',
        senderNumber: '+554396837945',
        sentAt: new Date().toISOString(),
      })

      const first = tracker.correlateOutgoing({
        wahaMessageId: 'waha-dup-1',
        toNumber: '554391938235',
        senderNumber: '554396837945',
        timestamp: new Date().toISOString(),
      })
      expect(first).not.toBeNull()

      // Same WAHA message arrives again
      const second = tracker.correlateOutgoing({
        wahaMessageId: 'waha-dup-1',
        toNumber: '554391938235',
        senderNumber: '554396837945',
        timestamp: new Date().toISOString(),
      })
      expect(second).toBeNull()
    })
  })

  describe('handleAck', () => {
    it('emits message:delivered on ACK level 2', () => {
      const events: unknown[] = []
      emitter.on('message:delivered', (data) => events.push(data))

      // Set up correlation
      const msg = queue.enqueue({
        to: '5543991938235',
        body: 'Test',
        idempotencyKey: 'ack-test-1',
        senderNumber: '+554396837945',
      })

      tracker.registerSent({
        messageId: msg.id,
        toNumber: '5543991938235',
        senderNumber: '+554396837945',
        sentAt: new Date().toISOString(),
      })

      tracker.correlateOutgoing({
        wahaMessageId: 'waha-ack-1',
        toNumber: '554391938235',
        senderNumber: '554396837945',
        timestamp: new Date().toISOString(),
      })

      // ACK level 2 (device delivered)
      tracker.handleAck('waha-ack-1', 2, new Date().toISOString())

      expect(events).toHaveLength(1)
      expect((events[0] as { id: string }).id).toBe(msg.id)
    })

    it('emits message:read on ACK level 3', () => {
      const events: unknown[] = []
      emitter.on('message:read', (data) => events.push(data))

      const msg = queue.enqueue({
        to: '5543991938235',
        body: 'Test',
        idempotencyKey: 'ack-test-2',
        senderNumber: '+554396837945',
      })

      tracker.registerSent({
        messageId: msg.id,
        toNumber: '5543991938235',
        senderNumber: '+554396837945',
        sentAt: new Date().toISOString(),
      })

      tracker.correlateOutgoing({
        wahaMessageId: 'waha-ack-2',
        toNumber: '554391938235',
        senderNumber: '554396837945',
        timestamp: new Date().toISOString(),
      })

      tracker.handleAck('waha-ack-2', 3, new Date().toISOString())

      expect(events).toHaveLength(1)
      expect((events[0] as { id: string }).id).toBe(msg.id)
    })

    it('ignores ACK for uncorrelated messages', () => {
      const deliveredEvents: unknown[] = []
      const readEvents: unknown[] = []
      emitter.on('message:delivered', (data) => deliveredEvents.push(data))
      emitter.on('message:read', (data) => readEvents.push(data))

      // ACK for unknown waha message
      tracker.handleAck('unknown-waha-id', 3, new Date().toISOString())

      expect(deliveredEvents).toHaveLength(0)
      expect(readEvents).toHaveLength(0)
    })

    it('emits both delivered and read on ACK level 3 if delivered not yet emitted', () => {
      const deliveredEvents: unknown[] = []
      const readEvents: unknown[] = []
      emitter.on('message:delivered', (data) => deliveredEvents.push(data))
      emitter.on('message:read', (data) => readEvents.push(data))

      const msg = queue.enqueue({
        to: '5543991938235',
        body: 'Test',
        idempotencyKey: 'ack-test-3',
        senderNumber: '+554396837945',
      })

      tracker.registerSent({
        messageId: msg.id,
        toNumber: '5543991938235',
        senderNumber: '+554396837945',
        sentAt: new Date().toISOString(),
      })

      tracker.correlateOutgoing({
        wahaMessageId: 'waha-ack-3',
        toNumber: '554391938235',
        senderNumber: '554396837945',
        timestamp: new Date().toISOString(),
      })

      // Skip level 2, go directly to level 3
      tracker.handleAck('waha-ack-3', 3, new Date().toISOString())

      // Should emit both delivered and read
      expect(deliveredEvents).toHaveLength(1)
      expect(readEvents).toHaveLength(1)
    })

    it('does not re-emit delivered if already emitted', () => {
      const deliveredEvents: unknown[] = []
      emitter.on('message:delivered', (data) => deliveredEvents.push(data))

      const msg = queue.enqueue({
        to: '5543991938235',
        body: 'Test',
        idempotencyKey: 'ack-test-4',
        senderNumber: '+554396837945',
      })

      tracker.registerSent({
        messageId: msg.id,
        toNumber: '5543991938235',
        senderNumber: '+554396837945',
        sentAt: new Date().toISOString(),
      })

      tracker.correlateOutgoing({
        wahaMessageId: 'waha-ack-4',
        toNumber: '554391938235',
        senderNumber: '554396837945',
        timestamp: new Date().toISOString(),
      })

      // First ACK level 2
      tracker.handleAck('waha-ack-4', 2, new Date().toISOString())
      // Second ACK level 3 (should not re-emit delivered)
      tracker.handleAck('waha-ack-4', 3, new Date().toISOString())

      expect(deliveredEvents).toHaveLength(1)
    })
  })

  describe('cleanup', () => {
    it('removes expired correlations older than TTL', () => {
      // Insert an old correlation
      db.prepare(`
        INSERT INTO pending_correlations (message_id, to_number_normalized, sender_number_normalized, sent_at, created_at)
        VALUES (?, ?, ?, ?, datetime('now', '-49 hours'))
      `).run('old-msg', '554391938235', '554396837945', new Date(Date.now() - 49 * 3600_000).toISOString())

      tracker.registerSent({
        messageId: 'new-msg',
        toNumber: '5543991938235',
        senderNumber: '+554396837945',
        sentAt: new Date().toISOString(),
      })

      const removed = tracker.cleanup()
      expect(removed).toBe(1)

      // New one should still exist
      const row = db.prepare('SELECT * FROM pending_correlations WHERE message_id = ?').get('new-msg')
      expect(row).toBeDefined()
    })
  })
})
