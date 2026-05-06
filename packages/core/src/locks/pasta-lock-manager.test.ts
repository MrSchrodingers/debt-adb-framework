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
