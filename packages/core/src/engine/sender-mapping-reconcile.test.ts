import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { SenderMapping } from './sender-mapping.js'

const CREATE_WA_ACCOUNTS = `CREATE TABLE IF NOT EXISTS whatsapp_accounts (
  device_serial TEXT NOT NULL,
  profile_id INTEGER NOT NULL,
  package_name TEXT NOT NULL,
  phone_number TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (device_serial, profile_id, package_name)
)`

describe('SenderMapping.reconcileFromWhatsappAccounts', () => {
  let db: Database.Database
  let mapping: SenderMapping

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    mapping = new SenderMapping(db)
    mapping.initialize()
    db.prepare(CREATE_WA_ACCOUNTS).run()
  })

  afterEach(() => {
    db.close()
  })

  function seedAccount(
    device: string,
    profile: number,
    pkg: string,
    phone: string | null,
  ): void {
    db.prepare(
      `INSERT OR REPLACE INTO whatsapp_accounts (device_serial, profile_id, package_name, phone_number)
       VALUES (?, ?, ?, ?)`,
    ).run(device, profile, pkg, phone)
  }

  it('inserts a sender_mapping row for every paired (device, profile, package)', () => {
    seedAccount('POCO-1', 0, 'com.whatsapp', '5543996835100')
    const r = mapping.reconcileFromWhatsappAccounts()
    expect(r.inserted).toBe(1)
    expect(mapping.getByPhone('5543996835100')?.device_serial).toBe('POCO-1')
  })

  it('preserves placeholder rows even when whatsapp_accounts has nothing matching them', () => {
    mapping.create({
      phoneNumber: '99999100200',
      deviceSerial: 'POCO-1',
      profileId: 10,
      wahaSession: 'oralsin_2_1',
    })
    const r = mapping.reconcileFromWhatsappAccounts()
    expect(r.deleted).toBe(0)
    expect(mapping.getByPhone('99999100200')).not.toBeNull()
  })

  it('preserves operator-pinned rows (waha_session set) when device profile is still unpaired', () => {
    // Production scenario: operator pinned oralsin_2_1 to (POCO-1, 10)
    // before pairing completed. whatsapp_accounts has NULL for that
    // profile. Without the waha_session guard, the next reconcile
    // cycle wipes the pin silently.
    mapping.create({
      phoneNumber: '554396835095',
      deviceSerial: 'POCO-1',
      profileId: 10,
      wahaSession: 'oralsin_2_1',
    })
    seedAccount('POCO-1', 10, 'com.whatsapp', null)
    const r = mapping.reconcileFromWhatsappAccounts()
    expect(r.deleted).toBe(0)
    expect(mapping.getByPhone('554396835095')).not.toBeNull()
  })

  it('still deletes stale rows that have no waha_session pin', () => {
    mapping.create({
      phoneNumber: '554396835500',
      deviceSerial: 'POCO-1',
      profileId: 0,
    })
    seedAccount('POCO-1', 0, 'com.whatsapp', '5543996835100')
    const r = mapping.reconcileFromWhatsappAccounts()
    expect(r.deleted).toBe(1)
    expect(mapping.getByPhone('554396835500')).toBeNull()
    expect(mapping.getByPhone('5543996835100')).not.toBeNull()
  })
})
