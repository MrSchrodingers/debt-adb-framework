import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { initSdrSchema, SDR_TABLES } from './migrations.js'

describe('SDR migrations', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
  })

  afterEach(() => {
    db.close()
  })

  it('creates all required SDR tables', () => {
    initSdrSchema(db)
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => (r as { name: string }).name)
    for (const t of SDR_TABLES) {
      expect(tables).toContain(t)
    }
  })

  it('is idempotent (safe to re-run)', () => {
    initSdrSchema(db)
    expect(() => initSdrSchema(db)).not.toThrow()
    initSdrSchema(db)
  })

  it('enforces UNIQUE(tenant, pipedrive_deal_id) on sdr_lead_queue', () => {
    initSdrSchema(db)
    const insert = db.prepare(
      `INSERT INTO sdr_lead_queue
         (id, tenant, pipedrive_deal_id, contact_phone, contact_name, pulled_at, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    insert.run('id1', 'oralsin-sdr', 100, '554399999991', 'Cliente', 'now', 'pulled', 'now', 'now')
    expect(() =>
      insert.run('id2', 'oralsin-sdr', 100, '554399999991', 'Cliente', 'now', 'pulled', 'now', 'now'),
    ).toThrow(/UNIQUE/)
  })

  it('allows same deal_id across different tenants', () => {
    initSdrSchema(db)
    const insert = db.prepare(
      `INSERT INTO sdr_lead_queue
         (id, tenant, pipedrive_deal_id, contact_phone, contact_name, pulled_at, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    insert.run('id1', 'oralsin-sdr', 100, '554399999991', 'Cliente', 'now', 'pulled', 'now', 'now')
    expect(() =>
      insert.run('id2', 'sicoob-sdr', 100, '554399999992', 'Cliente', 'now', 'pulled', 'now', 'now'),
    ).not.toThrow()
  })

  it('enforces composite PK (tenant, sender_phone, contact_phone) on sdr_contact_identity', () => {
    initSdrSchema(db)
    const insert = db.prepare(
      `INSERT INTO sdr_contact_identity
         (tenant, sender_phone, contact_phone, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    insert.run('oralsin-sdr', '554399000001', '554399999991', 'pending', 'now', 'now')
    expect(() =>
      insert.run('oralsin-sdr', '554399000001', '554399999991', 'verified', 'now', 'now'),
    ).toThrow(/UNIQUE|PRIMARY/)
  })

  it('cascades DELETE from sdr_lead_queue → sdr_sequence_state', () => {
    initSdrSchema(db)
    db.pragma('foreign_keys = ON')
    db.prepare(
      `INSERT INTO sdr_lead_queue
         (id, tenant, pipedrive_deal_id, contact_phone, contact_name, pulled_at, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('lead1', 'oralsin-sdr', 100, '554399999991', 'Cliente', 'now', 'pulled', 'now', 'now')
    db.prepare(
      `INSERT INTO sdr_sequence_state
         (lead_id, sequence_id, sender_phone, status, next_action_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('lead1', 'oralsin-cold-v1', '554399000001', 'active', 'now')

    db.prepare('DELETE FROM sdr_lead_queue WHERE id = ?').run('lead1')
    const remaining = db.prepare('SELECT COUNT(*) AS n FROM sdr_sequence_state').get() as { n: number }
    expect(remaining.n).toBe(0)
  })

  it('creates expected indexes', () => {
    initSdrSchema(db)
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index'")
      .all()
      .map((r) => (r as { name: string }).name)
    expect(indexes).toEqual(
      expect.arrayContaining([
        'idx_sdr_lead_state',
        'idx_sdr_lead_tenant',
        'idx_sdr_seq_ready',
        'idx_sdr_identity_pending',
        'idx_classifier_lead',
        'idx_classifier_source',
        'idx_writeback_pending',
      ]),
    )
  })
})
