import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { MessageHistory } from './message-history.js'
import type { MessageHistoryRecord } from './types.js'

describe('MessageHistory', () => {
  let db: Database.Database
  let history: MessageHistory

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    history = new MessageHistory(db)
    history.initialize()
  })

  afterEach(() => {
    db.close()
  })

  describe('initialize', () => {
    it('creates message_history table in SQLite', () => {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='message_history'")
        .all()
      expect(tables).toHaveLength(1)
    })

    it('creates table with required columns', () => {
      const columns = db.prepare('PRAGMA table_info(message_history)').all() as { name: string }[]
      const names = columns.map((c) => c.name)
      expect(names).toContain('id')
      expect(names).toContain('message_id')
      expect(names).toContain('direction')
      expect(names).toContain('from_number')
      expect(names).toContain('to_number')
      expect(names).toContain('text')
      expect(names).toContain('media_type')
      expect(names).toContain('media_path')
      expect(names).toContain('device_serial')
      expect(names).toContain('profile_id')
      expect(names).toContain('waha_message_id')
      expect(names).toContain('waha_session_name')
      expect(names).toContain('captured_via')
      expect(names).toContain('created_at')
    })

    it('creates index on from_number + to_number + created_at', () => {
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='message_history'")
        .all() as { name: string }[]
      const names = indexes.map((i) => i.name)
      expect(names.some((n) => n.includes('history_numbers'))).toBe(true)
    })
  })

  describe('insert', () => {
    it('stores incoming message with full metadata', () => {
      const id = history.insert({
        direction: 'incoming',
        fromNumber: '5543991938235',
        toNumber: '554396835104',
        text: 'Hello from customer',
        mediaType: null,
        wahaMessageId: 'true_5543991938235@c.us_AAAA',
        wahaSessionName: 'oralsin_main_1',
        capturedVia: 'waha_webhook',
      })

      expect(id).toBeTruthy()
      const record = history.getById(id)
      expect(record).not.toBeNull()
      expect(record!.direction).toBe('incoming')
      expect(record!.fromNumber).toBe('5543991938235')
      expect(record!.toNumber).toBe('554396835104')
      expect(record!.text).toBe('Hello from customer')
      expect(record!.wahaMessageId).toBe('true_5543991938235@c.us_AAAA')
      expect(record!.wahaSessionName).toBe('oralsin_main_1')
      expect(record!.capturedVia).toBe('waha_webhook')
      expect(record!.createdAt).toBeTruthy()
    })

    it('stores outgoing message from ADB send', () => {
      const id = history.insert({
        messageId: 'msg-001',
        direction: 'outgoing',
        fromNumber: '554396835104',
        toNumber: '5543991938235',
        text: 'Payment reminder',
        deviceSerial: '9b01005930533036340030832250ac',
        profileId: 0,
        capturedVia: 'adb_send',
      })

      expect(id).toBeTruthy()
      const record = history.getById(id)
      expect(record).not.toBeNull()
      expect(record!.messageId).toBe('msg-001')
      expect(record!.direction).toBe('outgoing')
      expect(record!.capturedVia).toBe('adb_send')
      expect(record!.deviceSerial).toBe('9b01005930533036340030832250ac')
    })

    it('stores media metadata', () => {
      const id = history.insert({
        direction: 'incoming',
        fromNumber: '5543991938235',
        toNumber: '554396835104',
        text: null,
        mediaType: 'image/jpeg',
        mediaPath: 'data/media/oralsin_main_1/2026-04-02/img001.jpg',
        wahaMessageId: 'true_5543991938235@c.us_BBBB',
        wahaSessionName: 'oralsin_main_1',
        capturedVia: 'waha_webhook',
      })

      const record = history.getById(id)
      expect(record!.mediaType).toBe('image/jpeg')
      expect(record!.mediaPath).toBe('data/media/oralsin_main_1/2026-04-02/img001.jpg')
    })
  })

  describe('findByDedup', () => {
    it('finds record by toNumber within ±30s window', () => {
      const now = new Date()
      history.insert({
        messageId: 'msg-adb-001',
        direction: 'outgoing',
        fromNumber: '554396835104',
        toNumber: '5543991938235',
        text: 'Test message',
        capturedVia: 'adb_send',
      })

      // Search within 30s window of now
      const found = history.findByDedup('5543991938235', now.toISOString(), 30)
      expect(found).not.toBeNull()
      expect(found!.messageId).toBe('msg-adb-001')
      expect(found!.capturedVia).toBe('adb_send')
    })

    it('returns null when no match within window', () => {
      // Insert a record from 2 minutes ago
      const twoMinutesAgo = new Date(Date.now() - 120_000)
      // We need to insert with a specific timestamp — the insert should use the provided time
      history.insert({
        messageId: 'msg-old',
        direction: 'outgoing',
        fromNumber: '554396835104',
        toNumber: '5543991938235',
        text: 'Old message',
        capturedVia: 'adb_send',
      })

      // Search with a timestamp 2 minutes in the future
      const futureTime = new Date(Date.now() + 120_000)
      const found = history.findByDedup('5543991938235', futureTime.toISOString(), 30)
      expect(found).toBeNull()
    })

    it('matches only outgoing adb_send records for dedup', () => {
      history.insert({
        direction: 'incoming',
        fromNumber: '5543991938235',
        toNumber: '554396835104',
        text: 'Incoming message',
        capturedVia: 'waha_webhook',
      })

      const now = new Date()
      const found = history.findByDedup('554396835104', now.toISOString(), 30)
      // Should not match incoming messages for dedup
      expect(found).toBeNull()
    })
  })

  describe('updateWithWahaId', () => {
    it('adds waha_message_id to existing record', () => {
      const id = history.insert({
        messageId: 'msg-adb-002',
        direction: 'outgoing',
        fromNumber: '554396835104',
        toNumber: '5543991938235',
        text: 'Test',
        capturedVia: 'adb_send',
      })

      history.updateWithWahaId(id, 'true_554396835104@c.us_CCCC')

      const record = history.getById(id)
      expect(record!.wahaMessageId).toBe('true_554396835104@c.us_CCCC')
    })
  })

  describe('query', () => {
    beforeEach(() => {
      history.insert({
        direction: 'incoming',
        fromNumber: '5543991938235',
        toNumber: '554396835104',
        text: 'Incoming 1',
        wahaSessionName: 'oralsin_main_1',
        capturedVia: 'waha_webhook',
      })
      history.insert({
        direction: 'outgoing',
        fromNumber: '554396835104',
        toNumber: '5543991938235',
        text: 'Outgoing 1',
        wahaSessionName: 'oralsin_main_1',
        capturedVia: 'adb_send',
      })
      history.insert({
        direction: 'incoming',
        fromNumber: '5541999999999',
        toNumber: '554396835104',
        text: 'Incoming 2 from different number',
        wahaSessionName: 'oralsin_main_1',
        capturedVia: 'waha_webhook',
      })
    })

    it('filters by fromNumber', () => {
      const results = history.query({ fromNumber: '5543991938235' })
      expect(results).toHaveLength(1)
      expect(results[0].text).toBe('Incoming 1')
    })

    it('filters by direction', () => {
      const results = history.query({ direction: 'outgoing' })
      expect(results).toHaveLength(1)
      expect(results[0].text).toBe('Outgoing 1')
    })

    it('filters by toNumber', () => {
      const results = history.query({ toNumber: '5543991938235' })
      expect(results).toHaveLength(1)
      expect(results[0].direction).toBe('outgoing')
    })

    it('respects limit', () => {
      const results = history.query({ limit: 2 })
      expect(results).toHaveLength(2)
    })
  })

  describe('cleanup', () => {
    it('deletes records older than retention days', () => {
      // Insert a record (will be "current")
      history.insert({
        direction: 'incoming',
        fromNumber: '5543991938235',
        toNumber: '554396835104',
        text: 'Recent message',
        capturedVia: 'waha_webhook',
      })

      // Manually backdate a record to simulate old data
      db.prepare(`
        INSERT INTO message_history (id, direction, from_number, to_number, text, captured_via, created_at)
        VALUES ('old-record', 'incoming', '5541999999999', '554396835104', 'Old message', 'waha_webhook', datetime('now', '-100 days'))
      `).run()

      const deleted = history.cleanup(90)
      expect(deleted).toBe(1)

      // Recent record still exists
      const remaining = history.query({})
      expect(remaining).toHaveLength(1)
      expect(remaining[0].text).toBe('Recent message')
    })

    it('returns 0 when nothing to clean', () => {
      history.insert({
        direction: 'incoming',
        fromNumber: '5543991938235',
        toNumber: '554396835104',
        text: 'Recent',
        capturedVia: 'waha_webhook',
      })

      const deleted = history.cleanup(90)
      expect(deleted).toBe(0)
    })
  })
})
