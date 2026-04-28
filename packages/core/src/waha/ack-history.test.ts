import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { AckHistory } from './ack-history.js'
import { MessageHistory } from './message-history.js'

describe('AckHistory', () => {
  let db: Database.Database
  let history: MessageHistory
  let ackHistory: AckHistory

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    history = new MessageHistory(db)
    history.initialize()
    ackHistory = new AckHistory(db, history)
    ackHistory.initialize()
  })

  afterEach(() => {
    db.close()
  })

  describe('initialize', () => {
    it('creates message_ack_history table', () => {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='message_ack_history'")
        .all()
      expect(tables).toHaveLength(1)
    })

    it('creates table with required columns', () => {
      const columns = db
        .prepare('PRAGMA table_info(message_ack_history)')
        .all() as { name: string }[]
      const names = columns.map((c) => c.name)
      expect(names).toContain('id')
      expect(names).toContain('waha_message_id')
      expect(names).toContain('ack_level')
      expect(names).toContain('ack_level_name')
      expect(names).toContain('delivered_at')
      expect(names).toContain('read_at')
      expect(names).toContain('observed_at')
      expect(names).toContain('sender_phone')
      expect(names).toContain('recipient_phone')
    })

    it('creates index on sender_phone + observed_at for fast calibration queries', () => {
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='message_ack_history'")
        .all() as { name: string }[]
      const names = indexes.map((i) => i.name)
      expect(names.some((n) => n.includes('ack_sender_observed'))).toBe(true)
    })

    it('creates index on waha_message_id', () => {
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='message_ack_history'")
        .all() as { name: string }[]
      const names = indexes.map((i) => i.name)
      expect(names.some((n) => n.includes('ack_msgid'))).toBe(true)
    })

    it('is idempotent (safe to re-initialize)', () => {
      expect(() => ackHistory.initialize()).not.toThrow()
      expect(() => ackHistory.initialize()).not.toThrow()
    })
  })

  describe('insert', () => {
    it('persists ack with denormalized sender/recipient pulled from message_history', () => {
      // First insert the original outgoing message
      history.insert({
        direction: 'outgoing',
        fromNumber: '554396835104',
        toNumber: '5543991938235',
        text: 'Test',
        wahaMessageId: 'true_554396835104@c.us_AAAA',
        wahaSessionName: 'oralsin_main_1',
        capturedVia: 'waha_webhook',
      })

      const ackId = ackHistory.insert({
        wahaMessageId: 'true_554396835104@c.us_AAAA',
        ackLevel: 3,
        ackLevelName: 'read',
        deliveredAt: '2026-04-28T10:00:00.000Z',
        readAt: '2026-04-28T10:01:00.000Z',
      })

      expect(ackId).toBeTruthy()

      const row = db
        .prepare('SELECT * FROM message_ack_history WHERE id = ?')
        .get(ackId) as Record<string, unknown>

      expect(row.waha_message_id).toBe('true_554396835104@c.us_AAAA')
      expect(row.ack_level).toBe(3)
      expect(row.ack_level_name).toBe('read')
      expect(row.delivered_at).toBe('2026-04-28T10:00:00.000Z')
      expect(row.read_at).toBe('2026-04-28T10:01:00.000Z')
      // Denormalized columns must be populated from message_history join
      expect(row.sender_phone).toBe('554396835104')
      expect(row.recipient_phone).toBe('5543991938235')
    })

    it('inserts NULL sender/recipient when message_history has no matching record', () => {
      // No prior insert → ack arrives before message_history has the waha_message_id
      const ackId = ackHistory.insert({
        wahaMessageId: 'true_orphan@c.us_ZZZZ',
        ackLevel: 1,
        ackLevelName: 'server',
        deliveredAt: null,
        readAt: null,
      })

      const row = db
        .prepare('SELECT * FROM message_ack_history WHERE id = ?')
        .get(ackId) as Record<string, unknown>

      expect(row.sender_phone).toBeNull()
      expect(row.recipient_phone).toBeNull()
    })

    it('uses ON CONFLICT to deduplicate by (waha_message_id, ack_level)', () => {
      history.insert({
        direction: 'outgoing',
        fromNumber: '554396835104',
        toNumber: '5543991938235',
        text: 'Test',
        wahaMessageId: 'true_554396835104@c.us_DUP',
        capturedVia: 'waha_webhook',
      })

      const id1 = ackHistory.insert({
        wahaMessageId: 'true_554396835104@c.us_DUP',
        ackLevel: 3,
        ackLevelName: 'read',
        deliveredAt: null,
        readAt: '2026-04-28T10:00:00.000Z',
      })

      // Same (waha_message_id, ack_level) → duplicate; insert should not throw
      // and the result should still be queryable (returns existing or null)
      const id2 = ackHistory.insert({
        wahaMessageId: 'true_554396835104@c.us_DUP',
        ackLevel: 3,
        ackLevelName: 'read',
        deliveredAt: null,
        readAt: '2026-04-28T10:05:00.000Z',
      })

      // Only one row should exist for that pair
      const rows = db
        .prepare('SELECT * FROM message_ack_history WHERE waha_message_id = ?')
        .all('true_554396835104@c.us_DUP')
      expect(rows).toHaveLength(1)
      // First insert id is the canonical one; second returns null to signal dedup
      expect(id1).toBeTruthy()
      expect(id2).toBeNull()
    })

    it('allows multiple ack levels for the same waha_message_id', () => {
      history.insert({
        direction: 'outgoing',
        fromNumber: '554396835104',
        toNumber: '5543991938235',
        text: 'Test',
        wahaMessageId: 'true_554396835104@c.us_MULTI',
        capturedVia: 'waha_webhook',
      })

      ackHistory.insert({
        wahaMessageId: 'true_554396835104@c.us_MULTI',
        ackLevel: 1,
        ackLevelName: 'server',
        deliveredAt: null,
        readAt: null,
      })
      ackHistory.insert({
        wahaMessageId: 'true_554396835104@c.us_MULTI',
        ackLevel: 2,
        ackLevelName: 'device',
        deliveredAt: '2026-04-28T10:00:00.000Z',
        readAt: null,
      })
      ackHistory.insert({
        wahaMessageId: 'true_554396835104@c.us_MULTI',
        ackLevel: 3,
        ackLevelName: 'read',
        deliveredAt: '2026-04-28T10:00:00.000Z',
        readAt: '2026-04-28T10:01:00.000Z',
      })

      const rows = db
        .prepare('SELECT * FROM message_ack_history WHERE waha_message_id = ? ORDER BY ack_level')
        .all('true_554396835104@c.us_MULTI') as Record<string, unknown>[]
      expect(rows).toHaveLength(3)
      expect(rows.map((r) => r.ack_level)).toEqual([1, 2, 3])
    })
  })

  describe('queryByMessageId', () => {
    it('returns all acks for a given waha_message_id ordered by ack_level', () => {
      history.insert({
        direction: 'outgoing',
        fromNumber: '554396835104',
        toNumber: '5543991938235',
        text: 'Test',
        wahaMessageId: 'true_query@c.us_QQ',
        capturedVia: 'waha_webhook',
      })

      ackHistory.insert({
        wahaMessageId: 'true_query@c.us_QQ',
        ackLevel: 3,
        ackLevelName: 'read',
        deliveredAt: '2026-04-28T10:00:00.000Z',
        readAt: '2026-04-28T10:01:00.000Z',
      })
      ackHistory.insert({
        wahaMessageId: 'true_query@c.us_QQ',
        ackLevel: 1,
        ackLevelName: 'server',
        deliveredAt: null,
        readAt: null,
      })

      const records = ackHistory.queryByMessageId('true_query@c.us_QQ')
      expect(records).toHaveLength(2)
      expect(records[0].ackLevel).toBe(1)
      expect(records[1].ackLevel).toBe(3)
    })

    it('returns empty array for unknown waha_message_id', () => {
      const records = ackHistory.queryByMessageId('nonexistent')
      expect(records).toHaveLength(0)
    })
  })

  describe('queryBySenderInRange', () => {
    it('returns ack events for a sender within a time window', () => {
      history.insert({
        direction: 'outgoing',
        fromNumber: '554396835104',
        toNumber: '5543991938235',
        text: 'A',
        wahaMessageId: 'msgA',
        capturedVia: 'waha_webhook',
      })
      history.insert({
        direction: 'outgoing',
        fromNumber: '554396835104',
        toNumber: '5541999999999',
        text: 'B',
        wahaMessageId: 'msgB',
        capturedVia: 'waha_webhook',
      })

      ackHistory.insert({
        wahaMessageId: 'msgA',
        ackLevel: 3,
        ackLevelName: 'read',
        deliveredAt: null,
        readAt: '2026-04-28T10:00:00.000Z',
      })
      ackHistory.insert({
        wahaMessageId: 'msgB',
        ackLevel: 2,
        ackLevelName: 'device',
        deliveredAt: '2026-04-28T10:00:00.000Z',
        readAt: null,
      })

      const sinceMs = Date.now() - 60_000
      const untilMs = Date.now() + 60_000
      const records = ackHistory.queryBySenderInRange('554396835104', sinceMs, untilMs)
      expect(records).toHaveLength(2)
      expect(records.every((r) => r.senderPhone === '554396835104')).toBe(true)
    })

    it('skips records outside the time range', () => {
      history.insert({
        direction: 'outgoing',
        fromNumber: '554396835104',
        toNumber: '5543991938235',
        text: 'A',
        wahaMessageId: 'msgOld',
        capturedVia: 'waha_webhook',
      })

      // Insert ack with backdated observed_at
      const id = ackHistory.insert({
        wahaMessageId: 'msgOld',
        ackLevel: 3,
        ackLevelName: 'read',
        deliveredAt: null,
        readAt: '2025-01-01T00:00:00.000Z',
      })
      // Manually backdate observed_at
      db.prepare('UPDATE message_ack_history SET observed_at = ? WHERE id = ?').run(
        '2025-01-01 00:00:00',
        id,
      )

      const sinceMs = Date.now() - 60_000
      const untilMs = Date.now() + 60_000
      const records = ackHistory.queryBySenderInRange('554396835104', sinceMs, untilMs)
      expect(records).toHaveLength(0)
    })

    it('does NOT return rows with NULL sender_phone (orphan acks)', () => {
      // Orphan ack — message_history has no matching record
      ackHistory.insert({
        wahaMessageId: 'orphan',
        ackLevel: 3,
        ackLevelName: 'read',
        deliveredAt: null,
        readAt: '2026-04-28T10:00:00.000Z',
      })

      const records = ackHistory.queryBySenderInRange(
        '554396835104',
        Date.now() - 60_000,
        Date.now() + 60_000,
      )
      expect(records).toHaveLength(0)
    })
  })

  describe('queryAllInRange', () => {
    it('returns all events including orphans (NULL sender) in time range', () => {
      history.insert({
        direction: 'outgoing',
        fromNumber: '554396835104',
        toNumber: '5543991938235',
        text: 'A',
        wahaMessageId: 'msgWith',
        capturedVia: 'waha_webhook',
      })
      ackHistory.insert({
        wahaMessageId: 'msgWith',
        ackLevel: 3,
        ackLevelName: 'read',
        deliveredAt: null,
        readAt: '2026-04-28T10:00:00.000Z',
      })
      ackHistory.insert({
        wahaMessageId: 'orphan',
        ackLevel: 1,
        ackLevelName: 'server',
        deliveredAt: null,
        readAt: null,
      })

      const records = ackHistory.queryAllInRange(
        Date.now() - 60_000,
        Date.now() + 60_000,
      )
      expect(records).toHaveLength(2)
    })
  })
})
