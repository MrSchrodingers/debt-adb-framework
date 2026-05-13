import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { GeoViewRegistry } from '../geo/registry.js'
import { buildAdbPrecheckGeoViews } from './adb-precheck-plugin.js'

describe('adb-precheck.no-match geo view', () => {
  let db: Database.Database
  let registry: GeoViewRegistry

  beforeEach(() => {
    db = new Database(':memory:')
    db.prepare(`
      CREATE TABLE hygiene_job_items (
        id INTEGER PRIMARY KEY, job_id TEXT, phone_normalized TEXT,
        status TEXT, updated_at TEXT
      )
    `).run()
    const now = new Date().toISOString()
    const ins = db.prepare(`INSERT INTO hygiene_job_items VALUES (?, ?, ?, ?, ?)`)
    ins.run(1, 'j1', '551187654321', 'invalid', now)
    ins.run(2, 'j1', '551187654322', 'invalid', now)
    ins.run(3, 'j1', '552187654323', 'invalid', now)
    ins.run(4, 'j1', '551187654324', 'valid',   now)
    ins.run(5, 'j1', null,           'invalid', now)
    registry = new GeoViewRegistry()
    for (const v of buildAdbPrecheckGeoViews(db)) registry.register('adb-precheck', v)
  })

  it('aggregates status=invalid by DDD, skipping null phones', async () => {
    const view = registry.get('adb-precheck.no-match')!
    const r = await view.aggregate({ window: '7d', filters: {} })
    expect(r.buckets).toEqual({ '11': 2, '21': 1 })
    expect(r.total).toBe(3)
  })

  it('drill returns rows for given DDD', async () => {
    const view = registry.get('adb-precheck.no-match')!
    const r = await view.drill('11', { window: '7d', filters: {}, page: 1, pageSize: 50 })
    expect(r.rows).toHaveLength(2)
    expect(r.total).toBe(2)
  })
})

describe('adb-precheck.valid geo view', () => {
  let db: Database.Database
  let registry: GeoViewRegistry

  beforeEach(() => {
    db = new Database(':memory:')
    db.prepare(`
      CREATE TABLE wa_contact_checks (
        id TEXT PRIMARY KEY, phone_normalized TEXT NOT NULL,
        result TEXT NOT NULL, checked_at TEXT NOT NULL
      )
    `).run()
    const now = new Date().toISOString()
    const ins = db.prepare(`INSERT INTO wa_contact_checks VALUES (?, ?, ?, ?)`)
    ins.run('c1', '551187654321', 'exists',     now)
    ins.run('c2', '551187654322', 'exists',     now)
    ins.run('c3', '552187654323', 'exists',     now)
    ins.run('c4', '551187654324', 'not_exists', now)
    registry = new GeoViewRegistry()
    for (const v of buildAdbPrecheckGeoViews(db)) registry.register('adb-precheck', v)
  })

  it('aggregates result=exists by DDD', async () => {
    const view = registry.get('adb-precheck.valid')!
    const r = await view.aggregate({ window: '7d', filters: {} })
    expect(r.buckets).toEqual({ '11': 2, '21': 1 })
  })

  it('drill returns recent checks', async () => {
    const view = registry.get('adb-precheck.valid')!
    const r = await view.drill('11', { window: '7d', filters: {}, page: 1, pageSize: 50 })
    expect(r.rows).toHaveLength(2)
  })
})

describe('adb-precheck.pipedrive-mapped geo view', () => {
  let db: Database.Database
  let registry: GeoViewRegistry

  beforeEach(() => {
    db = new Database(':memory:')
    db.prepare(`
      CREATE TABLE adb_precheck_deals (
        id INTEGER PRIMARY KEY, primary_valid_phone TEXT,
        scanned_at TEXT NOT NULL, deleted_at TEXT
      )
    `).run()
    const now = new Date().toISOString()
    const ins = db.prepare(`INSERT INTO adb_precheck_deals (primary_valid_phone, scanned_at, deleted_at) VALUES (?, ?, ?)`)
    ins.run('11987654321', now, null)    // 11 digits (no country code)
    ins.run('11987654322', now, null)    // 11 digits
    ins.run('21987654323', now, null)    // 11 digits
    ins.run('5511987654328', now, null)  // 13 digits with country code
    ins.run('11987654324', now, now)     // tombstoned
    ins.run(null,           now, null)   // null phone
    registry = new GeoViewRegistry()
    for (const v of buildAdbPrecheckGeoViews(db)) registry.register('adb-precheck', v)
  })

  it('handles 11-digit and 13-digit phone formats (strips 55 prefix)', async () => {
    const view = registry.get('adb-precheck.pipedrive-mapped')!
    const r = await view.aggregate({ window: '7d', filters: {} })
    // 3 phones with 11 digits → DDD chars 1-2 → 11,11,21
    // 1 phone with 13 digits + 55 → strip 55 → DDD chars 1-2 → 11
    expect(r.buckets).toEqual({ '11': 3, '21': 1 })
  })

  it('excludes tombstoned deals', async () => {
    const view = registry.get('adb-precheck.pipedrive-mapped')!
    const r = await view.aggregate({ window: '7d', filters: {} })
    // 1 tombstoned (deleted_at !== null) excluded — would have been DDD 11
    expect(r.buckets['11']).toBe(3)
  })
})
