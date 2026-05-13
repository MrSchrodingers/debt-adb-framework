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
      CREATE TABLE wa_contact_checks (
        id TEXT PRIMARY KEY, phone_normalized TEXT NOT NULL,
        result TEXT NOT NULL, checked_at TEXT NOT NULL
      )
    `).run()
    const now = new Date().toISOString()
    const ins = db.prepare(`INSERT INTO wa_contact_checks VALUES (?, ?, ?, ?)`)
    // Re-check the same phone 3 times — DISTINCT should de-dupe.
    ins.run('c1', '551187654321', 'not_exists', now)
    ins.run('c2', '551187654321', 'not_exists', now)
    ins.run('c3', '551187654321', 'not_exists', now)
    ins.run('c4', '551187654322', 'not_exists', now)
    ins.run('c5', '552187654323', 'not_exists', now)
    ins.run('c6', '551187654324', 'exists',     now)  // ignored (different cohort)
    registry = new GeoViewRegistry()
    for (const v of buildAdbPrecheckGeoViews(db)) registry.register('adb-precheck', v)
  })

  it('aggregates DISTINCT phones by DDD (re-checks dedup)', async () => {
    const view = registry.get('adb-precheck.no-match')!
    const r = await view.aggregate({ window: '7d', filters: {} })
    // 5 rows but only 3 distinct phones: 2 in DDD 11, 1 in DDD 21
    expect(r.buckets).toEqual({ '11': 2, '21': 1 })
    expect(r.total).toBe(3)
  })

  it('drill returns DISTINCT phones for given DDD', async () => {
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
        pasta TEXT NOT NULL, deal_id INTEGER NOT NULL,
        contato_tipo TEXT NOT NULL, contato_id INTEGER NOT NULL,
        primary_valid_phone TEXT, phones_json TEXT NOT NULL,
        scanned_at TEXT NOT NULL, deleted_at TEXT,
        PRIMARY KEY (pasta, deal_id, contato_tipo, contato_id)
      )
    `).run()
    const now = new Date().toISOString()
    const ins = db.prepare(`INSERT INTO adb_precheck_deals (pasta, deal_id, contato_tipo, contato_id, primary_valid_phone, phones_json, scanned_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    // Deal 1: 2 phones (both DDD 11)
    ins.run('p', 1, 'cli', 1, '5511987654321',
      JSON.stringify([
        { column: 't1', normalized: '5511987654321', outcome: 'valid' },
        { column: 't2', normalized: '5511987654322', outcome: 'invalid' },
      ]), now, null)
    // Deal 2: 1 phone (DDD 21)
    ins.run('p', 2, 'cli', 1, '5521987654323',
      JSON.stringify([{ column: 't1', normalized: '5521987654323', outcome: 'valid' }]), now, null)
    // Deal 3: 1 phone (DDD 11), tombstoned — excluded
    ins.run('p', 3, 'cli', 1, '5511987654324',
      JSON.stringify([{ column: 't1', normalized: '5511987654324', outcome: 'valid' }]), now, now)
    // Deal 4: empty phones_json — excluded
    ins.run('p', 4, 'cli', 1, null, JSON.stringify([]), now, null)
    // Deal 5: phone without primary_valid (all invalid) — STILL counted
    ins.run('p', 5, 'cli', 1, null,
      JSON.stringify([{ column: 't1', normalized: '5541987654329', outcome: 'invalid' }]), now, null)
    registry = new GeoViewRegistry()
    for (const v of buildAdbPrecheckGeoViews(db)) registry.register('adb-precheck', v)
  })

  it('explodes phones_json and counts every phone by DDD (not just primary)', async () => {
    const view = registry.get('adb-precheck.pipedrive-mapped')!
    const r = await view.aggregate({ window: '7d', filters: {} })
    // Live deals: deal 1 (2 phones DDD 11), deal 2 (1 phone DDD 21), deal 5 (1 phone DDD 41)
    // Deal 3 tombstoned, deal 4 empty.
    expect(r.buckets).toEqual({ '11': 2, '21': 1, '41': 1 })
    expect(r.total).toBe(4)
  })

  it('counts phones without primary_valid (no-primary deals still mapped)', async () => {
    const view = registry.get('adb-precheck.pipedrive-mapped')!
    const r = await view.aggregate({ window: '7d', filters: {} })
    // Deal 5 has no primary but its phone should still be counted in DDD 41
    expect(r.buckets['41']).toBe(1)
  })

  it('excludes tombstoned deals (deleted_at NOT NULL)', async () => {
    const view = registry.get('adb-precheck.pipedrive-mapped')!
    const r = await view.aggregate({ window: '7d', filters: {} })
    // Deal 3 tombstoned would have added 1 to DDD 11. Total stays at 2.
    expect(r.buckets['11']).toBe(2)
  })

  it('uses Pipeboard upstream aggregation when client provides it', async () => {
    const registryWithUpstream = new GeoViewRegistry()
    const pipeboardClient = {
      aggregatePhoneDddDistribution: async () => ({ '11': 9999, '21': 5000, '41': 1234 }),
    }
    for (const v of buildAdbPrecheckGeoViews(db, pipeboardClient)) {
      registryWithUpstream.register('adb-precheck', v)
    }
    const view = registryWithUpstream.get('adb-precheck.pipedrive-mapped')!
    const r = await view.aggregate({ window: '7d', filters: {} })
    expect(r.buckets).toEqual({ '11': 9999, '21': 5000, '41': 1234 })
    expect(r.total).toBe(16233)
  })

  it('falls back to local SQLite when Pipeboard client throws', async () => {
    const registryWithFailingUpstream = new GeoViewRegistry()
    const failingClient = {
      aggregatePhoneDddDistribution: async () => { throw new Error('postgres unreachable') },
    }
    for (const v of buildAdbPrecheckGeoViews(db, failingClient)) {
      registryWithFailingUpstream.register('adb-precheck', v)
    }
    const view = registryWithFailingUpstream.get('adb-precheck.pipedrive-mapped')!
    const r = await view.aggregate({ window: '7d', filters: {} })
    // Should fall through to the local fixture (4 phones across 11/21/41)
    expect(r.total).toBe(4)
  })
})
