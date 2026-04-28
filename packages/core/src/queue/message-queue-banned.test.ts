/**
 * Task 5.4 — Auto-banned-number list
 *
 * Tests for:
 *  - recordBan() insert / upsert semantics
 *  - isBlacklisted() reflecting recordBan()
 *  - ALTER guard idempotency (initialize() twice)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { MessageQueue } from './message-queue.js'

// ── helpers ──────────────────────────────────────────────────────────────────

function makeQueue(db: Database.Database): MessageQueue {
  const q = new MessageQueue(db)
  q.initialize()
  return q
}

interface BlacklistRow {
  phone_number: string
  reason: string
  hits: number
  last_hit_at: string | null
  created_at: string
}

function getRow(db: Database.Database, phone: string): BlacklistRow | undefined {
  return db
    .prepare('SELECT * FROM blacklist WHERE phone_number = ?')
    .get(phone) as BlacklistRow | undefined
}

// ── schema / migration ────────────────────────────────────────────────────────

describe('MessageQueue.initialize() — blacklist schema (Task 5.4)', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
  })
  afterEach(() => db.close())

  it('creates hits and last_hit_at columns on fresh DB', () => {
    const q = makeQueue(db)
    q.recordBan('5500000000001', 'engine_failures')
    const row = getRow(db, '5500000000001')
    expect(row).toBeDefined()
    expect(row!.hits).toBe(1)
    expect(row!.last_hit_at).toBeTruthy()
  })

  it('initialize() is idempotent — calling twice does not error', () => {
    const q = new MessageQueue(db)
    q.initialize()
    expect(() => q.initialize()).not.toThrow()
  })

  it('creates idx_blacklist_source_hit index', () => {
    makeQueue(db)
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_blacklist_source_hit'")
      .get() as { name: string } | undefined
    expect(row?.name).toBe('idx_blacklist_source_hit')
  })

  it('ALTER guard is safe on pre-existing DB that already has blacklist table without new columns', () => {
    db.exec(`
      CREATE TABLE blacklist (
        phone_number TEXT PRIMARY KEY,
        reason TEXT NOT NULL,
        detected_message TEXT,
        detected_pattern TEXT,
        source_session TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )
    `)
    const q = makeQueue(db)
    const cols = db.prepare('PRAGMA table_info(blacklist)').all() as { name: string }[]
    const names = cols.map(c => c.name)
    expect(names).toContain('hits')
    expect(names).toContain('last_hit_at')
    q.recordBan('5500000000099', 'precheck_invalid')
    expect(getRow(db, '5500000000099')?.hits).toBe(1)
  })
})

// ── recordBan ────────────────────────────────────────────────────────────────

describe('MessageQueue.recordBan()', () => {
  let db: Database.Database
  let queue: MessageQueue

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    queue = makeQueue(db)
  })
  afterEach(() => db.close())

  it('inserts with hits=1 when phone is new', () => {
    queue.recordBan('5500000000002', 'engine_failures')
    const row = getRow(db, '5500000000002')
    expect(row).toBeDefined()
    expect(row!.hits).toBe(1)
    expect(row!.reason).toBe('engine_failures')
  })

  it('increments hits on second call for same phone', () => {
    queue.recordBan('5500000000003', 'engine_failures')
    queue.recordBan('5500000000003', 'engine_failures')
    const row = getRow(db, '5500000000003')!
    expect(row.hits).toBe(2)
    expect(row.last_hit_at).toBeTruthy()
  })

  it('updates the source (reason) on re-detection', () => {
    queue.recordBan('5500000000004', 'engine_failures')
    queue.recordBan('5500000000004', 'precheck_invalid')
    const row = getRow(db, '5500000000004')!
    expect(row.reason).toBe('precheck_invalid')
    expect(row.hits).toBe(2)
  })

  it('stores optional meta fields', () => {
    queue.recordBan('5500000000005', 'ocr_ban_detected', {
      detectedMessage: 'Number not found',
      detectedPattern: 'not_on_whatsapp',
      sourceSession: 'waha-session-1',
    })
    const row = db
      .prepare('SELECT detected_message, detected_pattern, source_session FROM blacklist WHERE phone_number = ?')
      .get('5500000000005') as { detected_message: string; detected_pattern: string; source_session: string }
    expect(row.detected_message).toBe('Number not found')
    expect(row.detected_pattern).toBe('not_on_whatsapp')
    expect(row.source_session).toBe('waha-session-1')
  })

  it('does not overwrite existing meta with null on re-ban without meta', () => {
    queue.recordBan('5500000000006', 'engine_failures', { detectedMessage: 'original-msg' })
    queue.recordBan('5500000000006', 'engine_failures')
    const row = db
      .prepare('SELECT detected_message FROM blacklist WHERE phone_number = ?')
      .get('5500000000006') as { detected_message: string | null }
    expect(row.detected_message).toBe('original-msg')
  })
})

// ── isBlacklisted after recordBan ────────────────────────────────────────────

describe('isBlacklisted() — reflects recordBan()', () => {
  let db: Database.Database
  let queue: MessageQueue

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    queue = makeQueue(db)
  })
  afterEach(() => db.close())

  it('returns true after recordBan', () => {
    expect(queue.isBlacklisted('5500000000010')).toBe(false)
    queue.recordBan('5500000000010', 'engine_failures')
    expect(queue.isBlacklisted('5500000000010')).toBe(true)
  })

  it('returns false for a phone that was never banned', () => {
    expect(queue.isBlacklisted('5599999999999')).toBe(false)
  })

  it('enqueue() throws after recordBan()', () => {
    queue.recordBan('5500000000011', 'precheck_invalid')
    expect(() =>
      queue.enqueue({ to: '5500000000011', body: 'Hi', idempotencyKey: 'ban-enq-1' }),
    ).toThrow(/blacklisted/)
  })

  it('enqueueBatch() skips banned numbers with reason blacklisted', () => {
    queue.recordBan('5500000000012', 'precheck_invalid')
    const result = queue.enqueueBatch([
      { to: '5500000000012', body: 'Blocked', idempotencyKey: 'ban-batch-1' },
      { to: '5500000000013', body: 'OK', idempotencyKey: 'ban-batch-2' },
    ])
    expect(result.enqueued).toHaveLength(1)
    expect(result.enqueued[0].to).toBe('5500000000013')
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0].reason).toBe('blacklisted')
  })
})
