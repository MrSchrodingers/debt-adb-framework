import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { PastaLockManager } from './pasta-lock-manager.js'

describe('PastaLockManager — initialize', () => {
  let db: Database.Database
  let mgr: PastaLockManager

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    mgr = new PastaLockManager(db)
  })

  afterEach(() => db.close())

  it('creates pasta_locks and pasta_lock_fences tables', () => {
    mgr.initialize()
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>
    const names = tables.map((t) => t.name)
    expect(names).toContain('pasta_locks')
    expect(names).toContain('pasta_lock_fences')
  })
})

describe('PastaLockManager — acquire', () => {
  let db: Database.Database
  let mgr: PastaLockManager

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    mgr = new PastaLockManager(db)
    mgr.initialize()
  })

  afterEach(() => db.close())

  it('returns a handle on a free key', () => {
    const handle = mgr.acquire('scan:foo', 60_000)
    expect(handle).not.toBeNull()
    expect(handle!.key).toBe('scan:foo')
    expect(handle!.fenceToken).toBe(1)
  })

  it('returns null when key is already held', () => {
    const a = mgr.acquire('scan:foo', 60_000)
    expect(a).not.toBeNull()
    const b = mgr.acquire('scan:foo', 60_000)
    expect(b).toBeNull()
  })

  it('persists context_json', () => {
    mgr.acquire('scan:foo', 60_000, { job_id: 'abc', pasta: 'P-1' })
    const row = db.prepare('SELECT context_json FROM pasta_locks WHERE lock_key=?').get('scan:foo') as { context_json: string }
    expect(JSON.parse(row.context_json)).toEqual({ job_id: 'abc', pasta: 'P-1' })
  })
})

describe('PastaLockManager — release & fence', () => {
  let db: Database.Database
  let mgr: PastaLockManager
  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    mgr = new PastaLockManager(db)
    mgr.initialize()
  })

  afterEach(() => db.close())

  it('release frees the key', () => {
    const a = mgr.acquire('scan:foo', 60_000)!
    a.release()
    const b = mgr.acquire('scan:foo', 60_000)
    expect(b).not.toBeNull()
  })

  it('release of stale holder is a no-op', () => {
    const a = mgr.acquire('scan:foo', 60_000)!
    db.prepare("UPDATE pasta_locks SET expires_at = '2000-01-01T00:00:00Z' WHERE lock_key = 'scan:foo'").run()
    const b = mgr.acquire('scan:foo', 60_000)!
    expect(b.fenceToken).toBe(2)
    a.release()
    expect(b.isStillValid()).toBe(true)
  })

  it('isStillValid returns false after takeover', () => {
    const a = mgr.acquire('scan:foo', 60_000)!
    db.prepare("UPDATE pasta_locks SET expires_at = '2000-01-01T00:00:00Z' WHERE lock_key = 'scan:foo'").run()
    mgr.acquire('scan:foo', 60_000)
    expect(a.isStillValid()).toBe(false)
  })

  it('fence token monotonic across releases', () => {
    const a = mgr.acquire('scan:foo', 60_000)!
    a.release()
    const b = mgr.acquire('scan:foo', 60_000)!
    expect(b.fenceToken).toBe(2)
    b.release()
    const c = mgr.acquire('scan:foo', 60_000)!
    expect(c.fenceToken).toBe(3)
  })
})

describe('PastaLockManager — extended API', () => {
  let db: Database.Database
  let mgr: PastaLockManager
  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    mgr = new PastaLockManager(db)
    mgr.initialize()
  })

  afterEach(() => db.close())

  it('acquireWithWait succeeds after holder releases', async () => {
    const a = mgr.acquire('scan:foo', 60_000)!
    setTimeout(() => a.release(), 100)
    const b = await mgr.acquireWithWait('scan:foo', 60_000, { timeoutMs: 1000, pollMs: 50 })
    expect(b).not.toBeNull()
  })

  it('acquireWithWait times out and returns null', async () => {
    mgr.acquire('scan:foo', 60_000)
    const b = await mgr.acquireWithWait('scan:foo', 60_000, { timeoutMs: 200, pollMs: 50 })
    expect(b).toBeNull()
  })

  it('acquireWithWait honors the full timeoutMs window (late release)', async () => {
    const a = mgr.acquire('scan:foo', 60_000)!
    // Release at deadline - 10ms, when the waiter would already be in its final sleep.
    setTimeout(() => a.release(), 190)
    const b = await mgr.acquireWithWait('scan:foo', 60_000, { timeoutMs: 200, pollMs: 50 })
    expect(b).not.toBeNull()
  })

  it('releaseExpired removes only expired rows', () => {
    mgr.acquire('a', 60_000)
    mgr.acquire('b', 60_000)
    db.prepare("UPDATE pasta_locks SET expires_at = '2000-01-01T00:00:00Z' WHERE lock_key = 'a'").run()
    const reaped = mgr.releaseExpired()
    expect(reaped).toBe(1)
    expect(mgr.describe('a')).toBeNull()
    expect(mgr.describe('b')).not.toBeNull()
  })

  it('describe returns lock state', () => {
    mgr.acquire('scan:foo', 60_000, { job_id: 'X' })
    const desc = mgr.describe('scan:foo')!
    expect(desc.key).toBe('scan:foo')
    expect(desc.context).toEqual({ job_id: 'X' })
    expect(desc.fenceToken).toBe(1)
  })

  it('listAll filters expired and returns all live', () => {
    mgr.acquire('a', 60_000)
    mgr.acquire('b', 60_000)
    db.prepare("UPDATE pasta_locks SET expires_at = '2000-01-01T00:00:00Z' WHERE lock_key = 'a'").run()
    const live = mgr.listAll()
    expect(live.map((l) => l.key)).toEqual(['b'])
  })
})

// Long-running scans (e.g. limit=1000 → 7+ hours of probe work) exceed the
// 1h TTL the scanner uses today. Without renewal, the lock auto-expires
// mid-flight and an operator could trigger a parallel scan that races our
// writes. Renewal extends the deadline only while the original holder is
// still alive — if the scanner crashes, missed renewals let the lock reap
// itself naturally (matching the existing reaper contract).
describe('PastaLockManager — renew', () => {
  let db: Database.Database
  let mgr: PastaLockManager
  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    mgr = new PastaLockManager(db)
    mgr.initialize()
  })
  afterEach(() => db.close())

  it('extends expires_at for a still-held lock and returns true', () => {
    const handle = mgr.acquire('scan:foo', 60_000)!
    const beforeRow = db.prepare('SELECT expires_at FROM pasta_locks WHERE lock_key=?').get('scan:foo') as { expires_at: string }
    const ok = handle.renew(600_000)
    expect(ok).toBe(true)
    const afterRow = db.prepare('SELECT expires_at FROM pasta_locks WHERE lock_key=?').get('scan:foo') as { expires_at: string }
    expect(new Date(afterRow.expires_at).getTime()).toBeGreaterThan(new Date(beforeRow.expires_at).getTime())
  })

  it('returns false and does NOT recreate the row after release', () => {
    const handle = mgr.acquire('scan:foo', 60_000)!
    handle.release()
    expect(handle.renew(60_000)).toBe(false)
    expect(mgr.describe('scan:foo')).toBeNull()
  })

  it('returns false after another worker has acquired the key', () => {
    const a = mgr.acquire('scan:foo', 60_000)!
    db.prepare("UPDATE pasta_locks SET expires_at = '2000-01-01T00:00:00Z' WHERE lock_key = 'scan:foo'").run()
    const b = mgr.acquire('scan:foo', 60_000)!
    expect(a.renew(60_000)).toBe(false)
    // b's deadline must be intact — renew must not touch a different holder's row.
    expect(b.isStillValid()).toBe(true)
  })

  it('keeps isStillValid true after a successful renew', () => {
    const handle = mgr.acquire('scan:foo', 60_000)!
    expect(handle.renew(60_000)).toBe(true)
    expect(handle.isStillValid()).toBe(true)
  })

  it('handle.expiresAt does not auto-update — caller relies on the boolean (and DB) for truth', () => {
    // The handle's expiresAt is the original acquire-time deadline. Renew
    // updates the DB row; callers that need the new deadline should re-call
    // describe(). This keeps the handle immutable and avoids surprising
    // callers that captured `.expiresAt` earlier.
    const handle = mgr.acquire('scan:foo', 60_000)!
    const originalExpiresAt = handle.expiresAt.getTime()
    handle.renew(600_000)
    expect(handle.expiresAt.getTime()).toBe(originalExpiresAt)
    const fresh = mgr.describe('scan:foo')!
    expect(fresh.expiresAt.getTime()).toBeGreaterThan(originalExpiresAt)
  })
})
