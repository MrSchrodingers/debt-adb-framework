import { describe, it, expect, beforeEach } from 'vitest'
import { createRequire } from 'node:module'
import { PrecheckJobStore } from './job-store.js'
import { ContactRegistry } from '../../contacts/contact-registry.js'

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

describe('PrecheckJobStore — triggered_by/parent migration', () => {
  it('adds columns and indexes', () => {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    const store = new PrecheckJobStore(db)
    store.initialize()
    const cols = db
      .prepare("PRAGMA table_info('adb_precheck_jobs')")
      .all() as Array<{ name: string }>
    expect(cols.find((c) => c.name === 'triggered_by')).toBeDefined()
    expect(cols.find((c) => c.name === 'parent_job_id')).toBeDefined()
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='adb_precheck_jobs'")
      .all() as Array<{ name: string }>
    const names = idx.map((i) => i.name)
    expect(names).toContain('idx_jobs_parent')
    expect(names).toContain('idx_jobs_trigger')
  })

  it('createJob persists triggered_by and parent_job_id when supplied', () => {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    const store = new PrecheckJobStore(db)
    store.initialize()
    const parent = store.createJob({} as any, undefined)
    const child = store.createJob({} as any, undefined, {
      triggeredBy: 'retry-errors-sweep',
      parentJobId: parent.id,
    })
    const row = db
      .prepare('SELECT triggered_by, parent_job_id FROM adb_precheck_jobs WHERE id = ?')
      .get(child.id) as { triggered_by: string; parent_job_id: string }
    expect(row.triggered_by).toBe('retry-errors-sweep')
    expect(row.parent_job_id).toBe(parent.id)
  })

  it('createJob defaults triggered_by to "manual" when omitted', () => {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    const store = new PrecheckJobStore(db)
    store.initialize()
    const job = store.createJob({} as any, undefined)
    const row = db
      .prepare('SELECT triggered_by, parent_job_id FROM adb_precheck_jobs WHERE id = ?')
      .get(job.id) as { triggered_by: string; parent_job_id: string | null }
    expect(row.triggered_by).toBe('manual')
    expect(row.parent_job_id).toBeNull()
  })
})

describe('PrecheckJobStore — retry stats', () => {
  function setup() {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    const store = new PrecheckJobStore(db)
    store.initialize()
    // wa_contact_checks table is owned by ContactRegistry.
    const registry = new ContactRegistry(db)
    registry.initialize()
    return { db, store, registry }
  }

  it('getRetryStats counts probe_recover + scan_retry decisive resolutions', () => {
    const { db, store } = setup()
    const job = store.createJob({} as any)
    db.prepare("UPDATE adb_precheck_jobs SET created_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(job.id)
    // Insert a deal with one error phone for remaining_errors.
    store.upsertDeal(job.id, {
      key: { pasta: 'P-1', deal_id: 1, contato_tipo: 'X', contato_id: 1 },
      phones: [
        { column: 'tel_1', raw: '5511', normalized: '5511', outcome: 'error', source: 'adb_probe', confidence: null, variant_tried: '5511', error: null } as any,
        { column: 'tel_2', raw: '5512', normalized: '5512', outcome: 'invalid', source: 'adb_probe', confidence: 0.95, variant_tried: '5512', error: null } as any,
      ],
      valid_count: 0,
      invalid_count: 1,
      primary_valid_phone: null,
    })
    // Insert wa_contact_checks rows:
    //   'a' probe_recover decisive      → counts as level_1
    //   'b' scan_retry decisive         → counts as level_2
    //   'c' sweep_retry decisive        → NOT counted (sweep-job stat)
    //   'd' probe_initial decisive      → NOT counted
    db.prepare(`
      INSERT INTO wa_contact_checks
        (id, phone_normalized, phone_variant_tried, source, result, confidence,
         evidence, device_serial, waha_session, triggered_by, latency_ms,
         attempt_phase, checked_at)
      VALUES
        ('a','5511','5511','adb_probe','exists',0.95,NULL,NULL,NULL,'pre_check',1000,'probe_recover','2026-01-01T00:00:01Z'),
        ('b','5512','5512','adb_probe','not_exists',0.95,NULL,NULL,NULL,'pre_check',1000,'scan_retry','2026-01-01T00:00:02Z'),
        ('c','5513','5513','adb_probe','exists',0.95,NULL,NULL,NULL,'pre_check',1000,'sweep_retry','2026-01-01T00:00:03Z'),
        ('d','5514','5514','adb_probe','exists',0.95,NULL,NULL,NULL,'pre_check',1000,'probe_initial','2026-01-01T00:00:04Z')
    `).run()

    const stats = store.getRetryStats(job.id)
    expect(stats.level_1_resolves).toBe(1)
    expect(stats.level_2_resolves).toBe(1)
    expect(stats.remaining_errors).toBe(1)
    db.close()
  })

  it('getUiStateDistribution groups by ui_state from evidence', () => {
    const { db, store } = setup()
    const job = store.createJob({} as any)
    db.prepare("UPDATE adb_precheck_jobs SET created_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(job.id)
    db.prepare(`
      INSERT INTO wa_contact_checks
        (id, phone_normalized, phone_variant_tried, source, result, confidence,
         evidence, device_serial, waha_session, triggered_by, latency_ms,
         attempt_phase, checked_at)
      VALUES
        ('a','5511','5511','adb_probe','exists',0.95,'{"ui_state":"chat_open"}',NULL,NULL,'pre_check',1000,'probe_initial','2026-01-01T00:00:01Z'),
        ('b','5512','5512','adb_probe','exists',0.95,'{"ui_state":"chat_open"}',NULL,NULL,'pre_check',1000,'probe_initial','2026-01-01T00:00:02Z'),
        ('c','5513','5513','adb_probe','not_exists',0.95,'{"ui_state":"invite_modal"}',NULL,NULL,'pre_check',1000,'probe_initial','2026-01-01T00:00:03Z')
    `).run()

    const dist = store.getUiStateDistribution(job.id)
    expect(dist['chat_open']).toBe(2)
    expect(dist['invite_modal']).toBe(1)
    db.close()
  })

  it('getSnapshotsCaptured counts evidence rows with snapshot_path', () => {
    const { db, store } = setup()
    const job = store.createJob({} as any)
    db.prepare("UPDATE adb_precheck_jobs SET created_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(job.id)
    db.prepare(`
      INSERT INTO wa_contact_checks
        (id, phone_normalized, phone_variant_tried, source, result, confidence,
         evidence, device_serial, waha_session, triggered_by, latency_ms,
         attempt_phase, checked_at)
      VALUES
        ('a','5511','5511','adb_probe','inconclusive',NULL,'{"ui_state":"unknown","snapshot_path":"/tmp/x.xml"}',NULL,NULL,'pre_check',1000,'probe_initial','2026-01-01T00:00:01Z'),
        ('b','5512','5512','adb_probe','exists',0.95,'{"ui_state":"chat_open"}',NULL,NULL,'pre_check',1000,'probe_initial','2026-01-01T00:00:02Z')
    `).run()

    expect(store.getSnapshotsCaptured(job.id)).toBe(1)
    db.close()
  })

  it('returns zeros for an unknown job id', () => {
    const { db, store } = setup()
    const stats = store.getRetryStats('does-not-exist')
    expect(stats).toEqual({ level_1_resolves: 0, level_2_resolves: 0, remaining_errors: 0 })
    expect(store.getUiStateDistribution('does-not-exist')).toEqual({})
    expect(store.getSnapshotsCaptured('does-not-exist')).toBe(0)
    db.close()
  })

  // C1 regression: wa_contact_checks absent (ContactRegistry never initialized)
  it('getRetryStats returns zeros when wa_contact_checks does not exist', () => {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    const store = new PrecheckJobStore(db)
    store.initialize()
    // Note: NO ContactRegistry.initialize() here — wa_contact_checks is intentionally absent.
    const job = store.createJob({} as any)
    const stats = store.getRetryStats(job.id)
    expect(stats).toEqual({ level_1_resolves: 0, level_2_resolves: 0, remaining_errors: 0 })
    expect(store.getUiStateDistribution(job.id)).toEqual({})
    expect(store.getSnapshotsCaptured(job.id)).toBe(0)
    db.close()
  })
})

// Truth-set phone stats: derive from adb_precheck_deals.phones_json (current
// state), NOT from SUM(adb_precheck_jobs.*_phones) which double-counts retries
// (probe_recover, scan_retry, sweep_retry) and re-runs.
describe('PrecheckJobStore.aggregatePhoneStatsTruth', () => {
  function setup() {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    const store = new PrecheckJobStore(db)
    store.initialize()
    return { db, store }
  }

  function phone(column: string, normalized: string, outcome: 'valid'|'invalid'|'error') {
    return {
      column, raw: normalized, normalized, outcome,
      source: 'adb_probe', confidence: outcome === 'error' ? null : 0.95,
      variant_tried: normalized, error: null,
    } as any
  }

  it('returns zeros on empty store', () => {
    const { db, store } = setup()
    expect(store.aggregatePhoneStatsTruth()).toEqual({
      phones_checked: 0, phones_valid: 0, phones_invalid: 0, phones_error: 0,
    })
    db.close()
  })

  it('counts each phone-row from adb_precheck_deals.phones_json once per outcome', () => {
    const { db, store } = setup()
    const job = store.createJob({} as any)
    store.upsertDeal(job.id, {
      key: { pasta: 'P-1', deal_id: 1, contato_tipo: 'person', contato_id: 1 },
      phones: [
        phone('tel_1', '5511900000001', 'valid'),
        phone('tel_2', '5511900000002', 'invalid'),
        phone('tel_3', '5511900000003', 'invalid'),
        phone('tel_4', '5511900000004', 'error'),
      ],
      valid_count: 1, invalid_count: 2, primary_valid_phone: '5511900000001',
    })
    expect(store.aggregatePhoneStatsTruth()).toEqual({
      phones_checked: 4, phones_valid: 1, phones_invalid: 2, phones_error: 1,
    })
    db.close()
  })

  it('reflects CURRENT state after deal re-scan (upsert REPLACES prior phones_json)', () => {
    // This is the bug we're fixing: SUM(jobs) keeps adding retries; truth from
    // deals reflects only what is currently persisted for each (pasta, deal, contato).
    const { db, store } = setup()
    const key = { pasta: 'P-1', deal_id: 1, contato_tipo: 'person', contato_id: 1 }

    // First scan: 3 phones (1 valid, 1 invalid, 1 error)
    const job1 = store.createJob({} as any)
    store.upsertDeal(job1.id, {
      key,
      phones: [
        phone('tel_1', '5511900000001', 'valid'),
        phone('tel_2', '5511900000002', 'invalid'),
        phone('tel_3', '5511900000003', 'error'),
      ],
      valid_count: 1, invalid_count: 1, primary_valid_phone: '5511900000001',
    })
    // Bump completed-job counters as the real send pipeline would.
    db.prepare(`UPDATE adb_precheck_jobs SET status='completed',
                total_phones=3, valid_phones=1, invalid_phones=1, error_phones=1
                WHERE id = ?`).run(job1.id)

    // Retry pass resolves the error → invalid (same deal, upsert replaces row)
    const job2 = store.createJob({} as any, undefined, { triggeredBy: 'retry-errors-sweep' })
    store.upsertDeal(job2.id, {
      key,
      phones: [
        phone('tel_1', '5511900000001', 'valid'),
        phone('tel_2', '5511900000002', 'invalid'),
        phone('tel_3', '5511900000003', 'invalid'), // was error, now resolved
      ],
      valid_count: 1, invalid_count: 2, primary_valid_phone: '5511900000001',
    })
    db.prepare(`UPDATE adb_precheck_jobs SET status='completed',
                total_phones=3, valid_phones=1, invalid_phones=2, error_phones=0
                WHERE id = ?`).run(job2.id)

    // Job SUM would return 6 phones (3+3). Truth returns 3.
    expect(store.aggregatePhoneStatsTruth()).toEqual({
      phones_checked: 3, phones_valid: 1, phones_invalid: 2, phones_error: 0,
    })

    db.close()
  })

  it('ignores adb_precheck_jobs entirely — only adb_precheck_deals is consulted', () => {
    // Pathological: jobs table claims phones tested, but no deals were persisted.
    // Could happen if a job crashed mid-flight before any upsertDeal. Truth = 0.
    const { db, store } = setup()
    const job = store.createJob({} as any)
    db.prepare(`UPDATE adb_precheck_jobs SET status='completed',
                total_phones=999, valid_phones=300, invalid_phones=600, error_phones=99
                WHERE id = ?`).run(job.id)
    expect(store.aggregatePhoneStatsTruth()).toEqual({
      phones_checked: 0, phones_valid: 0, phones_invalid: 0, phones_error: 0,
    })
    db.close()
  })
})

// I4 regression: json_each filter must not false-positive on error text
describe('PrecheckJobStore — listDealsWithErrors json_each filter', () => {
  it('does NOT match phones whose error message contains the literal substring "outcome":"error"', () => {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    const store = new PrecheckJobStore(db)
    store.initialize()
    const job = store.createJob({} as any)
    // Phone with outcome='valid' but error message containing the magic substring.
    store.upsertDeal(job.id, {
      key: { pasta: 'P-1', deal_id: 1, contato_tipo: 'X', contato_id: 1 },
      phones: [
        {
          column: 'tel_1', raw: '5511', normalized: '5511',
          outcome: 'valid', source: 'adb_probe', confidence: 0.95,
          variant_tried: '5511',
          error: 'previous attempt had "outcome":"error" but resolved on retry',
        } as any,
      ],
      valid_count: 1, invalid_count: 0, primary_valid_phone: '5511',
    })
    const errorDeals = store.listDealsWithErrors(job.id)
    expect(errorDeals.length).toBe(0)  // false positive must NOT trigger
    db.close()
  })

  it('listDealsWithErrorsByFilter also uses json_each and avoids false positives', () => {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    const store = new PrecheckJobStore(db)
    store.initialize()
    const job = store.createJob({} as any)
    store.upsertDeal(job.id, {
      key: { pasta: 'P-2', deal_id: 2, contato_tipo: 'Y', contato_id: 2 },
      phones: [
        {
          column: 'tel_1', raw: '5522', normalized: '5522',
          outcome: 'invalid', source: 'adb_probe', confidence: 0.95,
          variant_tried: '5522',
          error: 'debug: previous "outcome":"error" was transient',
        } as any,
      ],
      valid_count: 0, invalid_count: 1, primary_valid_phone: null,
    })
    const results = store.listDealsWithErrorsByFilter({
      since_iso: '1970-01-01T00:00:00.000Z',
      pasta: null,
      limit: 100,
    })
    expect(results.length).toBe(0)  // false positive must NOT trigger
    db.close()
  })
})
