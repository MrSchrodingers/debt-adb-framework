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
