import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { IdempotencyCache } from './idempotency-cache.js'

// ── Test Helpers ──

function makeCache(db: Database.Database, nowFn?: () => number): IdempotencyCache {
  const cache = new IdempotencyCache(db, {
    defaultTtlSec: 3600,
    now: nowFn,
  })
  cache.initialize()
  return cache
}

describe('IdempotencyCache', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
  })

  afterEach(() => {
    db.close()
  })

  // ── T1: Fresh key → miss ──

  it('fresh key returns hit=false with the provided messageId', () => {
    const cache = makeCache(db)
    const result = cache.checkAndReserve('k1', 'msg-1', 60)

    expect(result).toEqual({ hit: false, messageId: 'msg-1' })

    // Row must exist in DB
    const row = cache.get('k1')
    expect(row).not.toBeNull()
    expect(row!.messageId).toBe('msg-1')
  })

  // ── T2: Same key within TTL → hit ──

  it('same key reserved twice within TTL returns hit=true with original messageId', () => {
    const cache = makeCache(db)

    cache.checkAndReserve('k1', 'msg-1', 60)
    const second = cache.checkAndReserve('k1', 'msg-2', 60)

    // Second call should be a hit; msg-2 is ignored
    expect(second).toEqual({ hit: true, messageId: 'msg-1' })
  })

  // ── T3: Same key after TTL expired → new miss ──

  it('same key after TTL expired returns hit=false with the new messageId', () => {
    const mockNow = { value: Date.now() }
    const cache = makeCache(db, () => mockNow.value)

    cache.checkAndReserve('k1', 'msg-1', 60)

    // Advance clock beyond TTL (61 seconds)
    mockNow.value += 61 * 1000

    const third = cache.checkAndReserve('k1', 'msg-2', 60)
    expect(third).toEqual({ hit: false, messageId: 'msg-2' })

    // Row now points to msg-2
    const row = cache.get('k1')
    expect(row!.messageId).toBe('msg-2')
  })

  // ── T4: Different keys are independent ──

  it('different keys are independent — each gets its own miss', () => {
    const cache = makeCache(db)

    const r1 = cache.checkAndReserve('key-a', 'msg-a', 60)
    const r2 = cache.checkAndReserve('key-b', 'msg-b', 60)

    expect(r1).toEqual({ hit: false, messageId: 'msg-a' })
    expect(r2).toEqual({ hit: false, messageId: 'msg-b' })

    // Re-checking each yields hits with the correct original ID
    expect(cache.checkAndReserve('key-a', 'msg-x', 60)).toEqual({ hit: true, messageId: 'msg-a' })
    expect(cache.checkAndReserve('key-b', 'msg-x', 60)).toEqual({ hit: true, messageId: 'msg-b' })
  })

  // ── T5: cleanupExpired ──

  it('cleanupExpired deletes only expired rows and returns the count', () => {
    const mockNow = { value: Date.now() }
    const cache = makeCache(db, () => mockNow.value)

    // Three rows: 2 expire in 60s, 1 expires in 7200s
    cache.checkAndReserve('exp-1', 'id-1', 60)
    cache.checkAndReserve('exp-2', 'id-2', 60)
    cache.checkAndReserve('keep', 'id-3', 7200)

    // Advance clock so exp-1 and exp-2 are past their TTL
    mockNow.value += 61 * 1000

    const deleted = cache.cleanupExpired()
    expect(deleted).toBe(2)

    // 'keep' row survives
    expect(cache.get('keep')).not.toBeNull()
    // expired rows are gone
    expect(cache.get('exp-1')).toBeNull()
    expect(cache.get('exp-2')).toBeNull()
  })

  // ── T6: get() ──

  it('get() returns null for unknown key and populated row for known key', () => {
    const cache = makeCache(db)

    expect(cache.get('unknown')).toBeNull()

    cache.checkAndReserve('known', 'msg-known', 60)
    const row = cache.get('known')

    expect(row).not.toBeNull()
    expect(row!.key).toBe('known')
    expect(row!.messageId).toBe('msg-known')
    expect(typeof row!.expiresAt).toBe('string')
    // expiresAt should be a valid ISO string in the future
    expect(new Date(row!.expiresAt).getTime()).toBeGreaterThan(Date.now())
  })

  // ── T7: Concurrent calls with same key ──

  it('concurrent calls (Promise.all 5) with same key — exactly 1 miss, 4 hits', async () => {
    const cache = makeCache(db)

    const results = await Promise.all([
      Promise.resolve(cache.checkAndReserve('concurrent-key', 'msg-0', 60)),
      Promise.resolve(cache.checkAndReserve('concurrent-key', 'msg-1', 60)),
      Promise.resolve(cache.checkAndReserve('concurrent-key', 'msg-2', 60)),
      Promise.resolve(cache.checkAndReserve('concurrent-key', 'msg-3', 60)),
      Promise.resolve(cache.checkAndReserve('concurrent-key', 'msg-4', 60)),
    ])

    const misses = results.filter((r) => !r.hit)
    const hits = results.filter((r) => r.hit)

    // better-sqlite3 is synchronous — first call wins, rest are hits
    expect(misses).toHaveLength(1)
    expect(hits).toHaveLength(4)

    // All hits return the SAME messageId as the single miss
    const winnerMsgId = misses[0].messageId
    for (const h of hits) {
      expect(h.messageId).toBe(winnerMsgId)
    }
  })

  // ── T8: Idempotent initialize() ──

  it('calling initialize() twice does not throw and table stays intact', () => {
    const cache = makeCache(db)

    // Already initialized by makeCache; calling again must not throw
    expect(() => cache.initialize()).not.toThrow()

    // Data written before the second init survives
    cache.checkAndReserve('stable', 'msg-stable', 60)
    cache.initialize()
    const row = cache.get('stable')
    expect(row).not.toBeNull()
    expect(row!.messageId).toBe('msg-stable')
  })

  // ── T9: Default TTL via config ──

  it('uses config.defaultTtlSec when ttlSec is omitted', () => {
    const mockNow = { value: Date.now() }
    const cache = new IdempotencyCache(db, { defaultTtlSec: 120, now: () => mockNow.value })
    cache.initialize()

    cache.checkAndReserve('ttl-test', 'msg-ttl')

    // 119 seconds later — still within default 120s TTL
    mockNow.value += 119 * 1000
    const stillHit = cache.checkAndReserve('ttl-test', 'msg-other')
    expect(stillHit.hit).toBe(true)

    // 2 more seconds later — expired
    mockNow.value += 2 * 1000
    const afterExpiry = cache.checkAndReserve('ttl-test', 'msg-new')
    expect(afterExpiry.hit).toBe(false)
    expect(afterExpiry.messageId).toBe('msg-new')
  })
})
