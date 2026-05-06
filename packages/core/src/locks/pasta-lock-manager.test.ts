import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { PastaLockManager } from './pasta-lock-manager.js'

describe('PastaLockManager — initialize', () => {
  it('creates pasta_locks and pasta_lock_fences tables', () => {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    const mgr = new PastaLockManager(db)
    mgr.initialize()
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>
    const names = tables.map((t) => t.name)
    expect(names).toContain('pasta_locks')
    expect(names).toContain('pasta_lock_fences')
  })
})
