import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import { PipedriveActivityStore } from './pipedrive-activity-store.js'
import { PrecheckJobStore } from './job-store.js'

const require = createRequire(import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require('better-sqlite3') as typeof import('better-sqlite3').default

describe('PipedriveActivityStore — schema', () => {
  it('initialize is idempotent (re-running does not throw)', () => {
    const db = new Database(':memory:')
    const store = new PipedriveActivityStore(db)
    store.initialize()
    expect(() => store.initialize()).not.toThrow()
    db.close()
  })
})

describe('PipedriveActivityStore — insert + update lifecycle', () => {
  let db: import('better-sqlite3').Database
  let store: PipedriveActivityStore
  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    store = new PipedriveActivityStore(db)
    store.initialize()
  })
  afterEach(() => db.close())

  it('insertPending writes a retrying row with attempts=1', () => {
    const id = store.insertPending({
      scenario: 'phone_fail',
      deal_id: 143611,
      pasta: 'P-001',
      phone_normalized: '5543991938235',
      job_id: 'job-1',
      pipedrive_endpoint: '/activities',
      pipedrive_payload_json: '{"deal_id":143611}',
    })
    const row = store.getById(id)!
    expect(row.scenario).toBe('phone_fail')
    expect(row.deal_id).toBe(143611)
    expect(row.pipedrive_response_status).toBe('retrying')
    expect(row.attempts).toBe(1)
    expect(row.completed_at).toBeNull()
    expect(row.manual).toBe(0)
  })

  it('updateResult to success sets pipedrive_response_id + completed_at', () => {
    const id = store.insertPending({
      scenario: 'phone_fail',
      deal_id: 1, pasta: null, phone_normalized: null, job_id: null,
      pipedrive_endpoint: '/activities', pipedrive_payload_json: '{}',
    })
    store.updateResult(id, {
      status: 'success',
      pipedrive_response_id: 9999,
      http_status: 201,
      attempts: 1,
    })
    const row = store.getById(id)!
    expect(row.pipedrive_response_status).toBe('success')
    expect(row.pipedrive_response_id).toBe(9999)
    expect(row.http_status).toBe(201)
    expect(row.completed_at).not.toBeNull()
  })

  it('updateResult to failed sets error_msg + completed_at', () => {
    const id = store.insertPending({
      scenario: 'deal_all_fail',
      deal_id: 1, pasta: null, phone_normalized: null, job_id: null,
      pipedrive_endpoint: '/activities', pipedrive_payload_json: '{}',
    })
    store.updateResult(id, {
      status: 'failed',
      http_status: 500,
      error_msg: 'http_500: boom',
      attempts: 3,
    })
    const row = store.getById(id)!
    expect(row.pipedrive_response_status).toBe('failed')
    expect(row.error_msg).toBe('http_500: boom')
    expect(row.attempts).toBe(3)
    expect(row.completed_at).not.toBeNull()
  })

  it('updateResult takes max(attempts) — never decreases', () => {
    const id = store.insertPending({
      scenario: 'phone_fail',
      deal_id: 1, pasta: null, phone_normalized: null, job_id: null,
      pipedrive_endpoint: '/activities', pipedrive_payload_json: '{}',
    })
    store.updateResult(id, { status: 'retrying', attempts: 3 })
    store.updateResult(id, { status: 'retrying', attempts: 1 }) // shouldn't decrease
    expect(store.getById(id)!.attempts).toBe(3)
  })

  it('manual=true is reflected in the row', () => {
    const id = store.insertPending({
      scenario: 'phone_fail',
      deal_id: 1, pasta: null, phone_normalized: null, job_id: null,
      pipedrive_endpoint: '/activities', pipedrive_payload_json: '{}',
      manual: true,
      triggered_by: 'alice',
    })
    const row = store.getById(id)!
    expect(row.manual).toBe(1)
    expect(row.triggered_by).toBe('alice')
  })
})

describe('PipedriveActivityStore — list filters', () => {
  let db: import('better-sqlite3').Database
  let store: PipedriveActivityStore
  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    store = new PipedriveActivityStore(db)
    store.initialize()
    // seed
    store.insertPending({ scenario: 'phone_fail',     deal_id: 100, pasta: 'A', phone_normalized: '5511', job_id: 'j1', pipedrive_endpoint: '/activities', pipedrive_payload_json: '{}' })
    store.insertPending({ scenario: 'deal_all_fail',  deal_id: 100, pasta: 'A', phone_normalized: null,   job_id: 'j1', pipedrive_endpoint: '/activities', pipedrive_payload_json: '{}' })
    store.insertPending({ scenario: 'pasta_summary',  deal_id: 200, pasta: 'B', phone_normalized: null,   job_id: 'j2', pipedrive_endpoint: '/notes',      pipedrive_payload_json: '{}' })
    const r3 = store.list({ deal_id: 200 }).items[0]
    store.updateResult(r3.id, { status: 'failed', http_status: 500, attempts: 3, error_msg: 'x' })
  })
  afterEach(() => db.close())

  it('filter by scenario returns matching rows', () => {
    expect(store.list({ scenario: 'phone_fail' }).total).toBe(1)
    expect(store.list({ scenario: 'pasta_summary' }).total).toBe(1)
  })

  it('filter by status returns matching rows', () => {
    expect(store.list({ status: 'failed' }).total).toBe(1)
    expect(store.list({ status: 'retrying' }).total).toBe(2)
  })

  it('filter by deal_id returns matching rows', () => {
    expect(store.list({ deal_id: 100 }).total).toBe(2)
    expect(store.list({ deal_id: 200 }).total).toBe(1)
  })

  it('filter by pasta returns matching rows', () => {
    expect(store.list({ pasta: 'A' }).total).toBe(2)
    expect(store.list({ pasta: 'B' }).total).toBe(1)
  })

  it('limit + offset paginate results', () => {
    const page1 = store.list({ limit: 2, offset: 0 })
    expect(page1.items).toHaveLength(2)
    expect(page1.total).toBe(3)
    const page2 = store.list({ limit: 2, offset: 2 })
    expect(page2.items).toHaveLength(1)
  })

  it('filters compose (scenario + deal_id)', () => {
    expect(store.list({ scenario: 'phone_fail', deal_id: 100 }).total).toBe(1)
    expect(store.list({ scenario: 'phone_fail', deal_id: 200 }).total).toBe(0)
  })
})

describe('PipedriveActivityStore — stats aggregations', () => {
  let db: import('better-sqlite3').Database
  let store: PipedriveActivityStore
  let jobStore: PrecheckJobStore
  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    store = new PipedriveActivityStore(db)
    store.initialize()
    jobStore = new PrecheckJobStore(db)
    jobStore.initialize()
  })
  afterEach(() => db.close())

  it('returns zero counts on empty DB', () => {
    const s = store.stats('all')
    expect(s.totalActivitiesCreated).toBe(0)
    expect(s.coveragePercent).toBe(0)
    expect(s.totalPhonesChecked).toBe(0)
    expect(s.byScenario).toEqual({ phone_fail: 0, deal_all_fail: 0, pasta_summary: 0 })
  })

  it('byScenario + byStatus reflect inserted rows', () => {
    const a = store.insertPending({ scenario: 'phone_fail',    deal_id: 1, pasta: null, phone_normalized: null, job_id: null, pipedrive_endpoint: '/activities', pipedrive_payload_json: '{}' })
    store.insertPending({ scenario: 'phone_fail',    deal_id: 2, pasta: null, phone_normalized: null, job_id: null, pipedrive_endpoint: '/activities', pipedrive_payload_json: '{}' })
    store.insertPending({ scenario: 'deal_all_fail', deal_id: 3, pasta: null, phone_normalized: null, job_id: null, pipedrive_endpoint: '/activities', pipedrive_payload_json: '{}' })
    store.updateResult(a, { status: 'success', attempts: 1, pipedrive_response_id: 1, http_status: 201 })
    const s = store.stats('all')
    expect(s.byScenario.phone_fail).toBe(2)
    expect(s.byScenario.deal_all_fail).toBe(1)
    expect(s.byStatus.success).toBe(1)
    expect(s.byStatus.retrying).toBe(2)
  })

  it('coveragePercent comes from adb_precheck_deals.phones_json', () => {
    // Seed 2 deals: one all-valid, one mixed
    db.prepare(
      `INSERT INTO adb_precheck_deals (
        pasta, deal_id, contato_tipo, contato_id, last_job_id,
        valid_count, invalid_count, primary_valid_phone, phones_json, scanned_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run('A', 1, 'C', 1, 'j', 2, 0, '5511', JSON.stringify([
      { outcome: 'valid', source: 'adb' },
      { outcome: 'valid', source: 'cache' },
    ]), new Date().toISOString())
    db.prepare(
      `INSERT INTO adb_precheck_deals (
        pasta, deal_id, contato_tipo, contato_id, last_job_id,
        valid_count, invalid_count, primary_valid_phone, phones_json, scanned_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run('B', 2, 'C', 2, 'j', 1, 1, '5522', JSON.stringify([
      { outcome: 'valid', source: 'waha' },
      { outcome: 'invalid', source: 'adb' },
    ]), new Date().toISOString())

    const s = store.stats('all')
    expect(s.totalPhonesChecked).toBe(4)
    expect(s.totalPhonesFound).toBe(3)
    expect(s.coveragePercent).toBeCloseTo(75, 5)
    expect(s.byStrategy.adb).toBe(2)
    expect(s.byStrategy.waha).toBe(1)
    expect(s.byStrategy.cache).toBe(1)
    expect(s.byPasta).toHaveLength(2)
    const pastaA = s.byPasta.find((p) => p.pasta === 'A')!
    expect(pastaA.foundPct).toBe(100)
  })

  it('period=today only counts rows from today (UTC)', () => {
    // Insert one row with backdated created_at (yesterday)
    const id = store.insertPending({
      scenario: 'phone_fail',
      deal_id: 1, pasta: null, phone_normalized: null, job_id: null,
      pipedrive_endpoint: '/activities', pipedrive_payload_json: '{}',
    })
    db.prepare(`UPDATE pipedrive_activities SET created_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - 36 * 3_600_000).toISOString(), id)
    // And a fresh row right now
    store.insertPending({
      scenario: 'phone_fail',
      deal_id: 2, pasta: null, phone_normalized: null, job_id: null,
      pipedrive_endpoint: '/activities', pipedrive_payload_json: '{}',
    })
    expect(store.stats('today').totalActivitiesCreated).toBe(1)
    expect(store.stats('all').totalActivitiesCreated).toBe(2)
  })

  it('failureRate24h is failed/total within last 24h', () => {
    const a = store.insertPending({ scenario: 'phone_fail', deal_id: 1, pasta: null, phone_normalized: null, job_id: null, pipedrive_endpoint: '/activities', pipedrive_payload_json: '{}' })
    const b = store.insertPending({ scenario: 'phone_fail', deal_id: 2, pasta: null, phone_normalized: null, job_id: null, pipedrive_endpoint: '/activities', pipedrive_payload_json: '{}' })
    store.insertPending({ scenario: 'phone_fail', deal_id: 3, pasta: null, phone_normalized: null, job_id: null, pipedrive_endpoint: '/activities', pipedrive_payload_json: '{}' })
    store.updateResult(a, { status: 'failed', attempts: 3, http_status: 500, error_msg: 'x' })
    store.updateResult(b, { status: 'success', attempts: 1, pipedrive_response_id: 1, http_status: 201 })
    const s = store.stats('all')
    expect(s.failureRate24h).toBeCloseTo(1 / 3, 3)
  })
})

describe('PipedriveActivityStore — upsert columns', () => {
  it('adds revises_row_id and http_verb', () => {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    const store = new PipedriveActivityStore(db)
    store.initialize()
    const cols = db
      .prepare("PRAGMA table_info('pipedrive_activities')")
      .all() as Array<{ name: string; dflt_value: string | null }>
    expect(cols.find((c) => c.name === 'revises_row_id')).toBeDefined()
    const verb = cols.find((c) => c.name === 'http_verb')
    expect(verb).toBeDefined()
    expect(verb!.dflt_value).toContain('POST')
  })

  it('creates the partial idempotency indexes', () => {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    const store = new PipedriveActivityStore(db)
    store.initialize()
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='pipedrive_activities'")
      .all() as Array<{ name: string }>
    const names = idx.map((i) => i.name)
    expect(names).toContain('idx_pipedrive_pasta_current')
    expect(names).toContain('idx_pipedrive_revises')
  })

  it('migration is idempotent across initialize() calls', () => {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    const store = new PipedriveActivityStore(db)
    store.initialize()
    expect(() => store.initialize()).not.toThrow()
    const cols = db
      .prepare("PRAGMA table_info('pipedrive_activities')")
      .all() as Array<{ name: string }>
    expect(cols.filter((c) => c.name === 'revises_row_id').length).toBe(1)
    expect(cols.filter((c) => c.name === 'http_verb').length).toBe(1)
  })
})

describe('PipedriveActivityStore — findCurrentPastaNote', () => {
  it('returns most recent successful pasta_summary row', () => {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    const store = new PipedriveActivityStore(db)
    store.initialize()

    const id1 = store.insertPending({
      scenario: 'pasta_summary', deal_id: 1, pasta: 'P-1',
      phone_normalized: null, job_id: 'j1',
      pipedrive_endpoint: '/notes', pipedrive_payload_json: '{}',
    })
    store.updateResult(id1, {
      status: 'success', pipedrive_response_id: 999,
      http_status: 201, error_msg: null, attempts: 1,
    })

    const found = store.findCurrentPastaNote('P-1')
    expect(found).not.toBeNull()
    expect(found!.pipedrive_response_id).toBe(999)
    expect(found!.row_id).toBe(id1)
    expect(found!.created_at).toBeDefined()
  })

  it('returns null when no successful row exists', () => {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    const store = new PipedriveActivityStore(db)
    store.initialize()
    expect(store.findCurrentPastaNote('P-1')).toBeNull()
  })

  it('skips orphaned rows', () => {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    const store = new PipedriveActivityStore(db)
    store.initialize()
    const id = store.insertPending({
      scenario: 'pasta_summary', deal_id: 1, pasta: 'P-1',
      phone_normalized: null, job_id: 'j1',
      pipedrive_endpoint: '/notes', pipedrive_payload_json: '{}',
    })
    store.updateResult(id, { status: 'success', pipedrive_response_id: 999, http_status: 201, error_msg: null, attempts: 1 })
    store.markOrphaned(id, 'PUT 404')
    expect(store.findCurrentPastaNote('P-1')).toBeNull()
  })

  it('returns the most recent row when multiple successes exist', () => {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    const store = new PipedriveActivityStore(db)
    store.initialize()

    const id1 = store.insertPending({
      scenario: 'pasta_summary', deal_id: 1, pasta: 'P-1',
      phone_normalized: null, job_id: 'j1',
      pipedrive_endpoint: '/notes', pipedrive_payload_json: '{}',
    })
    store.updateResult(id1, { status: 'success', pipedrive_response_id: 100, http_status: 201, error_msg: null, attempts: 1 })

    // Sleep 5ms to ensure created_at differs
    const wait = Date.now() + 10
    while (Date.now() < wait) { /* spin */ }

    const id2 = store.insertPending({
      scenario: 'pasta_summary', deal_id: 1, pasta: 'P-1',
      phone_normalized: null, job_id: 'j2',
      pipedrive_endpoint: '/notes', pipedrive_payload_json: '{}',
    })
    store.updateResult(id2, { status: 'success', pipedrive_response_id: 200, http_status: 200, error_msg: null, attempts: 1 })

    const found = store.findCurrentPastaNote('P-1')
    expect(found!.pipedrive_response_id).toBe(200)
    expect(found!.row_id).toBe(id2)
  })

  it('ignores other pasta scenarios', () => {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    const store = new PipedriveActivityStore(db)
    store.initialize()
    const id = store.insertPending({
      scenario: 'deal_all_fail', deal_id: 1, pasta: 'P-1',
      phone_normalized: null, job_id: 'j1',
      pipedrive_endpoint: '/activities', pipedrive_payload_json: '{}',
    })
    store.updateResult(id, { status: 'success', pipedrive_response_id: 999, http_status: 201, error_msg: null, attempts: 1 })
    expect(store.findCurrentPastaNote('P-1')).toBeNull()
  })
})

describe('PipedriveActivityStore — listPastaNoteRevisions', () => {
  it('returns full revision chain in chronological order', () => {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    const jobStore = new PrecheckJobStore(db)
    jobStore.initialize()
    const store = new PipedriveActivityStore(db)
    store.initialize()

    const id1 = store.insertPending({
      scenario: 'pasta_summary', deal_id: 1, pasta: 'P-1',
      phone_normalized: null, job_id: 'j1',
      pipedrive_endpoint: '/notes', pipedrive_payload_json: '{}',
      http_verb: 'POST',
    })
    store.updateResult(id1, { status: 'success', pipedrive_response_id: 999, http_status: 201, error_msg: null, attempts: 1 })

    // Tiny delay so created_at differs.
    const wait = Date.now() + 5
    while (Date.now() < wait) { /* spin */ }

    const id2 = store.insertPending({
      scenario: 'pasta_summary', deal_id: 1, pasta: 'P-1',
      phone_normalized: null, job_id: 'j2',
      pipedrive_endpoint: '/notes', pipedrive_payload_json: '{}',
      http_verb: 'PUT',
      revises_row_id: id1,
    })
    store.updateResult(id2, { status: 'success', pipedrive_response_id: 999, http_status: 200, error_msg: null, attempts: 1 })

    const revisions = store.listPastaNoteRevisions('P-1')
    expect(revisions.length).toBe(2)
    expect(revisions[0].row_id).toBe(id1)
    expect(revisions[0].verb).toBe('POST')
    expect(revisions[0].revises_row_id).toBeNull()
    expect(revisions[1].row_id).toBe(id2)
    expect(revisions[1].verb).toBe('PUT')
    expect(revisions[1].revises_row_id).toBe(id1)
    db.close()
  })

  it('returns empty array when no revisions exist', () => {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    const jobStore = new PrecheckJobStore(db)
    jobStore.initialize()
    const store = new PipedriveActivityStore(db)
    store.initialize()
    expect(store.listPastaNoteRevisions('P-1')).toEqual([])
    db.close()
  })

  it('joins triggered_by from adb_precheck_jobs', () => {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    const jobStore = new PrecheckJobStore(db)
    jobStore.initialize()
    const store = new PipedriveActivityStore(db)
    store.initialize()

    const job = jobStore.createJob({} as any, undefined, { triggeredBy: 'retry-errors-sweep' })
    const noteRowId = store.insertPending({
      scenario: 'pasta_summary', deal_id: 1, pasta: 'P-1',
      phone_normalized: null, job_id: job.id,
      pipedrive_endpoint: '/notes', pipedrive_payload_json: '{}',
      http_verb: 'POST',
    })
    store.updateResult(noteRowId, { status: 'success', pipedrive_response_id: 100, http_status: 201, error_msg: null, attempts: 1 })

    const revisions = store.listPastaNoteRevisions('P-1')
    expect(revisions.length).toBe(1)
    expect(revisions[0].triggered_by).toBe('retry-errors-sweep')
    db.close()
  })

  it('ignores other scenarios (deal_all_fail)', () => {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    const jobStore = new PrecheckJobStore(db)
    jobStore.initialize()
    const store = new PipedriveActivityStore(db)
    store.initialize()
    const id = store.insertPending({
      scenario: 'deal_all_fail', deal_id: 1, pasta: 'P-1',
      phone_normalized: null, job_id: 'j1',
      pipedrive_endpoint: '/activities', pipedrive_payload_json: '{}',
    })
    store.updateResult(id, { status: 'success', pipedrive_response_id: 999, http_status: 201, error_msg: null, attempts: 1 })
    expect(store.listPastaNoteRevisions('P-1')).toEqual([])
    db.close()
  })
})

describe('PipedriveActivityStore — markOrphaned', () => {
  it('sets status to orphaned and records the reason', () => {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    const store = new PipedriveActivityStore(db)
    store.initialize()
    const id = store.insertPending({
      scenario: 'pasta_summary', deal_id: 1, pasta: 'P-1',
      phone_normalized: null, job_id: 'j1',
      pipedrive_endpoint: '/notes', pipedrive_payload_json: '{}',
    })
    store.updateResult(id, { status: 'success', pipedrive_response_id: 999, http_status: 201, error_msg: null, attempts: 1 })
    store.markOrphaned(id, 'PUT returned 404')

    const row = db.prepare('SELECT pipedrive_response_status, error_msg FROM pipedrive_activities WHERE id = ?').get(id) as {
      pipedrive_response_status: string
      error_msg: string
    }
    expect(row.pipedrive_response_status).toBe('orphaned')
    expect(row.error_msg).toBe('PUT returned 404')
  })
})

describe('PipedriveActivityStore — insertPending with revises_row_id and http_verb', () => {
  it('persists revises_row_id and http_verb when supplied', () => {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    const store = new PipedriveActivityStore(db)
    store.initialize()

    const previousId = store.insertPending({
      scenario: 'pasta_summary', deal_id: 1, pasta: 'P-1',
      phone_normalized: null, job_id: 'j1',
      pipedrive_endpoint: '/notes', pipedrive_payload_json: '{}',
    })
    store.updateResult(previousId, { status: 'success', pipedrive_response_id: 999, http_status: 201, error_msg: null, attempts: 1 })

    const newId = store.insertPending({
      scenario: 'pasta_summary', deal_id: 1, pasta: 'P-1',
      phone_normalized: null, job_id: 'j2',
      pipedrive_endpoint: '/notes', pipedrive_payload_json: '{}',
      revises_row_id: previousId,
      http_verb: 'PUT',
    })

    const row = db
      .prepare('SELECT revises_row_id, http_verb FROM pipedrive_activities WHERE id = ?')
      .get(newId) as { revises_row_id: string; http_verb: string }
    expect(row.revises_row_id).toBe(previousId)
    expect(row.http_verb).toBe('PUT')
  })

  it('defaults http_verb to POST and revises_row_id to NULL when omitted', () => {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    const store = new PipedriveActivityStore(db)
    store.initialize()
    const id = store.insertPending({
      scenario: 'pasta_summary', deal_id: 1, pasta: 'P-1',
      phone_normalized: null, job_id: 'j1',
      pipedrive_endpoint: '/notes', pipedrive_payload_json: '{}',
    })
    const row = db
      .prepare('SELECT revises_row_id, http_verb FROM pipedrive_activities WHERE id = ?')
      .get(id) as { revises_row_id: string | null; http_verb: string }
    expect(row.revises_row_id).toBeNull()
    expect(row.http_verb).toBe('POST')
  })
})

// T23: per-tenant dedup. The (tenant, dedup_key) UNIQUE INDEX is partial
// (`WHERE dedup_key IS NOT NULL`), so pre-T23 rows with NULL dedup_key
// coexist; new rows are deduped at the tenant boundary.
describe('PipedriveActivityStore — tenant dedup (T23)', () => {
  let db: import('better-sqlite3').Database
  let store: PipedriveActivityStore
  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    store = new PipedriveActivityStore(db)
    store.initialize()
  })
  afterEach(() => db.close())

  it('dedupes per (tenant, dedup_key) — same key across tenants does not collide', () => {
    const adbRowId = store.insertPending({
      scenario: 'pasta_summary',
      deal_id: 1,
      pasta: 'P-1',
      phone_normalized: null,
      job_id: 'j1',
      pipedrive_endpoint: '/notes',
      pipedrive_payload_json: '{}',
      tenant: 'adb',
      dedup_key: 'k1',
    })
    const sicoobRowId = store.insertPending({
      scenario: 'pasta_summary',
      deal_id: 1,
      pasta: 'P-1',
      phone_normalized: null,
      job_id: 'j1',
      pipedrive_endpoint: '/notes',
      pipedrive_payload_json: '{}',
      tenant: 'sicoob',
      dedup_key: 'k1',
    })
    const adb = store.findByDedupKey('adb', 'k1')
    const sicoob = store.findByDedupKey('sicoob', 'k1')
    expect(adb?.id).toBe(adbRowId)
    expect(sicoob?.id).toBe(sicoobRowId)
    expect(adb?.tenant).toBe('adb')
    expect(sicoob?.tenant).toBe('sicoob')
    expect(adb?.dedup_key).toBe('k1')
    expect(sicoob?.dedup_key).toBe('k1')
  })

  it('UNIQUE (tenant, dedup_key) rejects same key for same tenant', () => {
    store.insertPending({
      scenario: 'pasta_summary',
      deal_id: 1,
      pasta: 'P-1',
      phone_normalized: null,
      job_id: 'j1',
      pipedrive_endpoint: '/notes',
      pipedrive_payload_json: '{}',
      tenant: 'adb',
      dedup_key: 'k2',
    })
    expect(() =>
      store.insertPending({
        scenario: 'pasta_summary',
        deal_id: 1,
        pasta: 'P-1',
        phone_normalized: null,
        job_id: 'j1',
        pipedrive_endpoint: '/notes',
        pipedrive_payload_json: '{}',
        tenant: 'adb',
        dedup_key: 'k2',
      }),
    ).toThrow(/UNIQUE|constraint/i)
  })

  it('allows multiple NULL dedup_key rows (partial index excludes NULLs)', () => {
    // Two pre-T23 style rows (no dedup_key) for the same tenant must not
    // collide — the partial UNIQUE INDEX excludes them via the
    // `WHERE dedup_key IS NOT NULL` predicate.
    const id1 = store.insertPending({
      scenario: 'pasta_summary',
      deal_id: 1,
      pasta: 'P-1',
      phone_normalized: null,
      job_id: 'j1',
      pipedrive_endpoint: '/notes',
      pipedrive_payload_json: '{}',
      tenant: 'adb',
    })
    const id2 = store.insertPending({
      scenario: 'pasta_summary',
      deal_id: 1,
      pasta: 'P-1',
      phone_normalized: null,
      job_id: 'j1',
      pipedrive_endpoint: '/notes',
      pipedrive_payload_json: '{}',
      tenant: 'adb',
    })
    expect(id1).not.toBe(id2)
    expect(store.findByDedupKey('adb', '__none__')).toBeNull()
  })

  it('insertPending defaults tenant to adb when omitted (back-compat)', () => {
    const id = store.insertPending({
      scenario: 'pasta_summary',
      deal_id: 1,
      pasta: 'P-1',
      phone_normalized: null,
      job_id: 'j1',
      pipedrive_endpoint: '/notes',
      pipedrive_payload_json: '{}',
      dedup_key: 'k-default',
    })
    const row = store.findByDedupKey('adb', 'k-default')
    expect(row?.id).toBe(id)
    expect(row?.tenant).toBe('adb')
  })
})
