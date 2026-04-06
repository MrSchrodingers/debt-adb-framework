import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { MessageQueue } from '../queue/message-queue.js'
import { MessageHistory } from '../waha/message-history.js'
import { AuditService } from './audit.js'

describe('AuditService', () => {
  let db: Database.Database
  let queue: MessageQueue
  let history: MessageHistory
  let audit: AuditService

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    queue = new MessageQueue(db)
    queue.initialize()
    history = new MessageHistory(db)
    history.initialize()
    audit = new AuditService(db)
  })

  afterEach(() => {
    db.close()
  })

  describe('listCombined', () => {
    it('returns combined data from messages and message_history with pagination', () => {
      // Seed messages table
      queue.enqueue({ to: '5543991938235', body: 'Msg 1', idempotencyKey: 'key-1' })
      queue.enqueue({ to: '5543991938235', body: 'Msg 2', idempotencyKey: 'key-2' })

      // Seed message_history table (incoming via WAHA)
      history.insert({
        direction: 'incoming',
        fromNumber: '5543991938235',
        toNumber: '5543996835104',
        text: 'Reply from user',
        capturedVia: 'waha_webhook',
      })

      const result = audit.listCombined({ limit: 50, offset: 0 })
      expect(result.items.length).toBe(3)
      expect(result.total).toBe(3)
      // Items should be sorted by createdAt DESC
      expect(result.items[0].createdAt).toBeDefined()
    })

    it('paginates correctly', () => {
      for (let i = 0; i < 5; i++) {
        queue.enqueue({ to: '5543991938235', body: `Msg ${i}`, idempotencyKey: `key-${i}` })
      }

      const page1 = audit.listCombined({ limit: 2, offset: 0 })
      expect(page1.items.length).toBe(2)
      expect(page1.total).toBe(5)

      const page2 = audit.listCombined({ limit: 2, offset: 2 })
      expect(page2.items.length).toBe(2)

      const page3 = audit.listCombined({ limit: 2, offset: 4 })
      expect(page3.items.length).toBe(1)
    })

    it('filters by phone number (partial match)', () => {
      queue.enqueue({ to: '5543991938235', body: 'A', idempotencyKey: 'k1' })
      queue.enqueue({ to: '5511999887766', body: 'B', idempotencyKey: 'k2' })

      history.insert({
        direction: 'incoming',
        fromNumber: '5543991938235',
        toNumber: null,
        text: 'Incoming',
        capturedVia: 'waha_webhook',
      })

      const result = audit.listCombined({ phone: '5543' })
      // Should match message to 5543... and history from 5543...
      expect(result.items.length).toBe(2)
      expect(result.total).toBe(2)
    })

    it('filters by date range', () => {
      queue.enqueue({ to: '5543991938235', body: 'Today msg', idempotencyKey: 'k-today' })

      // Manually insert an old record
      db.prepare(`
        INSERT INTO messages (id, to_number, body, idempotency_key, priority, status, created_at, updated_at)
        VALUES ('old-1', '5543991938235', 'Old msg', 'k-old', 5, 'sent',
                '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')
      `).run()

      const result = audit.listCombined({
        dateFrom: '2025-06-01',
        dateTo: '2027-12-31',
      })
      // Only the "today" message should match (the old one is from 2025-01-01)
      expect(result.items.length).toBe(1)
    })

    it('filters by status', () => {
      const msg = queue.enqueue({ to: '5543991938235', body: 'Will be sent', idempotencyKey: 'ks1' })
      queue.updateStatus(msg.id, 'sent')
      queue.enqueue({ to: '5543991938235', body: 'Still queued', idempotencyKey: 'ks2' })

      const result = audit.listCombined({ status: 'sent' })
      expect(result.items.length).toBe(1)
      expect(result.items[0].status).toBe('sent')
    })

    it('filters by direction', () => {
      queue.enqueue({ to: '5543991938235', body: 'Outgoing queue', idempotencyKey: 'kd1' })

      history.insert({
        direction: 'incoming',
        fromNumber: '5543991938235',
        toNumber: null,
        text: 'Incoming WAHA',
        capturedVia: 'waha_webhook',
      })

      history.insert({
        direction: 'outgoing',
        fromNumber: null,
        toNumber: '5543991938235',
        text: 'Outgoing WAHA',
        capturedVia: 'adb_send',
      })

      const incoming = audit.listCombined({ direction: 'incoming' })
      expect(incoming.items.length).toBe(1)
      expect(incoming.items[0].direction).toBe('incoming')

      const outgoing = audit.listCombined({ direction: 'outgoing' })
      // Queue messages are outgoing + the outgoing history entry
      expect(outgoing.items.length).toBe(2)
    })

    it('filters by plugin name', () => {
      queue.enqueue({
        to: '5543991938235',
        body: 'From oralsin',
        idempotencyKey: 'kp1',
        pluginName: 'oralsin',
      })
      queue.enqueue({ to: '5543991938235', body: 'No plugin', idempotencyKey: 'kp2' })

      const result = audit.listCombined({ plugin: 'oralsin' })
      expect(result.items.length).toBe(1)
    })
  })

  describe('getTimeline', () => {
    it('returns events in chronological order for a queue message', () => {
      const msg = queue.enqueue({ to: '5543991938235', body: 'Timeline test', idempotencyKey: 'kt1' })

      // Simulate status transitions
      queue.updateStatus(msg.id, 'sending')
      queue.updateStatus(msg.id, 'sent')

      // Add a WAHA capture for correlation
      history.insert({
        messageId: msg.id,
        direction: 'outgoing',
        fromNumber: null,
        toNumber: '5543991938235',
        text: 'Timeline test',
        capturedVia: 'adb_send',
      })

      const timeline = audit.getTimeline(msg.id)
      expect(timeline.length).toBeGreaterThanOrEqual(2)

      // First event should be "queued" (earliest)
      expect(timeline[0].event).toBe('queued')
      // Should have a "sent" event
      const sentEvent = timeline.find(e => e.event === 'sent')
      expect(sentEvent).toBeDefined()
    })

    it('returns empty array for non-existent message ID', () => {
      const timeline = audit.getTimeline('nonexistent-id')
      expect(timeline).toEqual([])
    })

    it('includes message_history events linked to the message', () => {
      const msg = queue.enqueue({ to: '5543991938235', body: 'Correlated', idempotencyKey: 'kc1' })

      history.insert({
        messageId: msg.id,
        direction: 'outgoing',
        fromNumber: null,
        toNumber: '5543991938235',
        text: 'Correlated',
        capturedVia: 'adb_send',
      })

      history.insert({
        messageId: msg.id,
        direction: 'outgoing',
        fromNumber: null,
        toNumber: '5543991938235',
        text: 'Correlated',
        wahaMessageId: 'waha-123',
        capturedVia: 'waha_webhook',
      })

      const timeline = audit.getTimeline(msg.id)
      const wahaEvent = timeline.find(e => e.event === 'waha_captured')
      expect(wahaEvent).toBeDefined()
    })
  })
})
