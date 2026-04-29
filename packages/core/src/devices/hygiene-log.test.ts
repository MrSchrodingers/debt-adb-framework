import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { HygieneLog } from './hygiene-log.js'

function buildLog(): { db: Database.Database; log: HygieneLog } {
  const db = new Database(':memory:')
  const log = new HygieneLog(db)
  log.initialize()
  return { db, log }
}

describe('HygieneLog', () => {
  it('initialize creates the table + indexes (idempotent)', () => {
    const { db, log } = buildLog()
    log.initialize() // 2nd call must not throw

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='device_hygiene_log'")
      .all()
    expect(tables).toHaveLength(1)

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='device_hygiene_log'")
      .all() as { name: string }[]
    const names = indexes.map((i) => i.name)
    expect(names).toContain('idx_dhl_device')
    expect(names).toContain('idx_dhl_status')
  })

  it('start creates a running row', () => {
    const { db, log } = buildLog()
    const id = log.start({ device_serial: 'dev1', triggered_by: 'auto:device_connected' })
    expect(id).toMatch(/.+/)

    const row = db.prepare('SELECT * FROM device_hygiene_log WHERE id = ?').get(id) as Record<string, unknown>
    expect(row.device_serial).toBe('dev1')
    expect(row.triggered_by).toBe('auto:device_connected')
    expect(row.status).toBe('running')
    expect(row.finished_at).toBeNull()
  })

  it('finish updates status + per-profile + survived packages', () => {
    const { log } = buildLog()
    const id = log.start({ device_serial: 'dev1', triggered_by: 'manual:operator' })
    log.finish(id, {
      status: 'completed',
      profiles_processed: [0, 10, 11, 12],
      bloat_removed_count: 42,
      per_profile_log: { 0: 'switch:ok, bloat:42', 10: 'switch:ok, bloat:0' },
      survived_packages: { 0: ['com.google.android.youtube'], 10: [] },
    })

    const last = log.getLastSuccess('dev1')
    expect(last).not.toBeNull()
    expect(last!.status).toBe('completed')
    expect(last!.bloat_removed_count).toBe(42)
    const profiles = JSON.parse(last!.profiles_processed_json!) as number[]
    expect(profiles).toEqual([0, 10, 11, 12])
    const survived = JSON.parse(last!.survived_packages_json!) as Record<string, string[]>
    expect(survived['0']).toContain('com.google.android.youtube')
  })

  it('isDue returns true when never run', () => {
    const { log } = buildLog()
    expect(log.isDue('dev1', 14)).toBe(true)
  })

  it('isDue returns false when last success is fresh', () => {
    const { log } = buildLog()
    const id = log.start({ device_serial: 'dev1', triggered_by: 'auto:device_connected' })
    log.finish(id, { status: 'completed' })
    expect(log.isDue('dev1', 14)).toBe(false)
  })

  it('isDue returns true when last success is older than ttl', () => {
    const { db, log } = buildLog()
    const id = log.start({ device_serial: 'dev1', triggered_by: 'auto:device_connected' })
    // Manually set finished_at to 30 days ago
    const past = new Date(Date.now() - 30 * 86_400_000).toISOString()
    db.prepare("UPDATE device_hygiene_log SET status='completed', finished_at=? WHERE id=?")
      .run(past, id)
    expect(log.isDue('dev1', 14)).toBe(true)
  })

  it('getLast returns most-recent regardless of status', async () => {
    const { db, log } = buildLog()
    const id1 = log.start({ device_serial: 'dev1', triggered_by: 'auto:device_connected' })
    log.finish(id1, { status: 'failed', error_msg: 'oops' })
    // Force distinct started_at by patching directly (millisecond-resolution
    // ISO timestamps would otherwise collide on fast machines).
    db.prepare("UPDATE device_hygiene_log SET started_at=? WHERE id=?")
      .run('2026-01-01T00:00:00.000Z', id1)
    const id2 = log.start({ device_serial: 'dev1', triggered_by: 'manual:api' })
    log.finish(id2, { status: 'completed' })

    const last = log.getLast('dev1')
    expect(last!.id).toBe(id2)
    expect(last!.status).toBe('completed')
  })

  it('list returns up to N rows ordered by started_at DESC', () => {
    const { log } = buildLog()
    for (let i = 0; i < 5; i++) {
      const id = log.start({ device_serial: 'dev1', triggered_by: 'auto:device_connected' })
      log.finish(id, { status: 'completed' })
    }
    const items = log.list('dev1', 3)
    expect(items).toHaveLength(3)
  })
})
