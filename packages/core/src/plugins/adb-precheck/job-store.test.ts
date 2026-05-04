import { describe, it, expect, beforeEach } from 'vitest'
import { createRequire } from 'node:module'
import { PrecheckJobStore } from './job-store.js'

const require = createRequire(import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require('better-sqlite3') as typeof import('better-sqlite3').default

describe('PrecheckJobStore.countScannedSince', () => {
  let db: ReturnType<typeof Database>
  let store: PrecheckJobStore

  beforeEach(() => {
    db = new Database(':memory:')
    store = new PrecheckJobStore(db)
    store.initialize()
  })

  function insertDeal(pasta: string, dealId: number, scannedAt: string): void {
    db.prepare(`INSERT INTO adb_precheck_deals (
      pasta, deal_id, contato_tipo, contato_id, last_job_id,
      valid_count, invalid_count, primary_valid_phone, phones_json, scanned_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      pasta, dealId, 'cliente', '1', 'job-x', 1, 0, null, '[]', scannedAt,
    )
  }

  it('returns 0/0 on empty store', () => {
    expect(store.countScannedSince('2026-01-01T00:00:00.000Z')).toEqual({ fresh: 0, total: 0 })
  })

  it('counts total across full history regardless of threshold', () => {
    insertDeal('P1', 1, '2025-01-01T00:00:00.000Z')
    insertDeal('P2', 2, '2026-04-30T00:00:00.000Z')
    expect(store.countScannedSince('2026-04-01T00:00:00.000Z').total).toBe(2)
  })

  it('counts fresh as deals at-or-after threshold', () => {
    insertDeal('P1', 1, '2026-04-01T00:00:00.000Z') // stale
    insertDeal('P2', 2, '2026-04-15T00:00:00.000Z') // fresh
    insertDeal('P3', 3, '2026-04-30T00:00:00.000Z') // fresh
    const r = store.countScannedSince('2026-04-15T00:00:00.000Z')
    expect(r.fresh).toBe(2)
    expect(r.total).toBe(3)
  })

  it('boundary: exact threshold counted as fresh', () => {
    insertDeal('P1', 1, '2026-04-15T00:00:00.000Z')
    expect(store.countScannedSince('2026-04-15T00:00:00.000Z').fresh).toBe(1)
  })
})

describe('PrecheckJobStore.reapOrphanedRunningJobs', () => {
  let db: ReturnType<typeof Database>
  let store: PrecheckJobStore

  beforeEach(() => {
    db = new Database(':memory:')
    store = new PrecheckJobStore(db)
    store.initialize()
  })

  function insertJob(id: string, status: string): void {
    db.prepare(
      `INSERT INTO adb_precheck_jobs (id, status, params_json) VALUES (?,?,?)`,
    ).run(id, status, '{}')
  }

  it('marks every running job as failed with the given reason', () => {
    insertJob('a', 'running')
    insertJob('b', 'running')
    insertJob('c', 'completed')
    const reaped = store.reapOrphanedRunningJobs('test-reason')
    expect(reaped).toBe(2)
    const rows = db
      .prepare('SELECT id, status, last_error FROM adb_precheck_jobs ORDER BY id')
      .all() as Array<{ id: string; status: string; last_error: string | null }>
    expect(rows).toEqual([
      { id: 'a', status: 'failed', last_error: 'test-reason' },
      { id: 'b', status: 'failed', last_error: 'test-reason' },
      { id: 'c', status: 'completed', last_error: null },
    ])
  })

  it('is a no-op when nothing is running', () => {
    insertJob('a', 'completed')
    insertJob('b', 'failed')
    expect(store.reapOrphanedRunningJobs()).toBe(0)
  })

  it('is idempotent across repeated calls', () => {
    insertJob('a', 'running')
    expect(store.reapOrphanedRunningJobs()).toBe(1)
    expect(store.reapOrphanedRunningJobs()).toBe(0)
  })

  it('uses the default reason when none provided', () => {
    insertJob('a', 'running')
    store.reapOrphanedRunningJobs()
    const row = db
      .prepare('SELECT last_error FROM adb_precheck_jobs WHERE id = ?')
      .get('a') as { last_error: string }
    expect(row.last_error).toBe('orphaned by service restart')
  })
})
