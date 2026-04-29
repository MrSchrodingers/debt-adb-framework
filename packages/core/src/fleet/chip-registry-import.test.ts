import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { ChipRegistry } from './chip-registry.js'

function buildEnv(): { db: Database.Database; reg: ChipRegistry } {
  const db = new Database(':memory:')
  // Recreate the whatsapp_accounts schema (kept in sync with WaAccountMapper)
  db.exec(`
    CREATE TABLE whatsapp_accounts (
      device_serial TEXT NOT NULL,
      profile_id INTEGER NOT NULL,
      package_name TEXT NOT NULL,
      phone_number TEXT,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (device_serial, profile_id, package_name)
    );
    CREATE TABLE sender_mapping (
      id TEXT PRIMARY KEY,
      phone_number TEXT NOT NULL UNIQUE,
      device_serial TEXT NOT NULL,
      profile_id INTEGER NOT NULL DEFAULT 0,
      app_package TEXT NOT NULL DEFAULT 'com.whatsapp',
      waha_session TEXT,
      waha_api_url TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `)
  const reg = new ChipRegistry(db)
  reg.initialize()
  return { db, reg }
}

describe('ChipRegistry - importFromWhatsappAccounts', () => {
  it('imports rows with phone_number set, skips NULL placeholders', () => {
    const { db, reg } = buildEnv()
    db.prepare(
      "INSERT INTO whatsapp_accounts (device_serial, profile_id, package_name, phone_number) VALUES (?,?,?,?)",
    ).run('SN1', 0, 'com.whatsapp', '5543991938235')
    db.prepare(
      "INSERT INTO whatsapp_accounts (device_serial, profile_id, package_name, phone_number) VALUES (?,?,?,?)",
    ).run('SN1', 10, 'com.whatsapp', null)
    db.prepare(
      "INSERT INTO whatsapp_accounts (device_serial, profile_id, package_name, phone_number) VALUES (?,?,?,?)",
    ).run('SN2', 0, 'com.whatsapp', '5543996837813')

    const result = reg.importFromWhatsappAccounts()
    expect(result.source).toBe('whatsapp_accounts')
    expect(result.inserted).toBe(2)
    expect(result.errors).toEqual([])

    const chips = reg.listChips()
    expect(chips.map((c) => c.phone_number).sort()).toEqual([
      '5543991938235',
      '5543996837813',
    ])
    const c1 = chips.find((c) => c.phone_number === '5543991938235')!
    expect(c1.carrier).toBe('unknown')
    expect(c1.plan_name).toBe('A definir')
    expect(c1.paid_by_operator).toBe('auto-import (whatsapp_accounts)')
    expect(c1.notes).toContain('Auto-importado')
    expect(c1.device_serial).toBe('SN1')
  })

  it('is idempotent: running twice leaves the catalogue unchanged', () => {
    const { db, reg } = buildEnv()
    db.prepare(
      "INSERT INTO whatsapp_accounts (device_serial, profile_id, package_name, phone_number) VALUES (?,?,?,?)",
    ).run('SN1', 0, 'com.whatsapp', '5543991938235')

    const r1 = reg.importFromWhatsappAccounts()
    const r2 = reg.importFromWhatsappAccounts()
    expect(r1.inserted).toBe(1)
    expect(r2.inserted).toBe(0)
    expect(r2.skipped).toBe(1)
    expect(reg.listChips()).toHaveLength(1)
  })

  it('preserves operator-edited chip values across re-import', () => {
    const { db, reg } = buildEnv()
    db.prepare(
      "INSERT INTO whatsapp_accounts (device_serial, profile_id, package_name, phone_number) VALUES (?,?,?,?)",
    ).run('SN1', 0, 'com.whatsapp', '5543991938235')

    reg.importFromWhatsappAccounts()
    const c1 = reg.listChips()[0]!
    reg.updateChip(c1.id, { carrier: 'vivo', plan_name: 'Vivo Controle', monthly_cost_brl: 99.9 })

    reg.importFromWhatsappAccounts()
    const c2 = reg.getChip(c1.id)!
    expect(c2.carrier).toBe('vivo')
    expect(c2.plan_name).toBe('Vivo Controle')
    expect(c2.monthly_cost_brl).toBe(99.9)
  })

  it('deduplicates the same phone across multiple device/profile/package rows', () => {
    const { db, reg } = buildEnv()
    db.prepare(
      "INSERT INTO whatsapp_accounts (device_serial, profile_id, package_name, phone_number) VALUES (?,?,?,?)",
    ).run('SN1', 0, 'com.whatsapp', '5543991938235')
    db.prepare(
      "INSERT INTO whatsapp_accounts (device_serial, profile_id, package_name, phone_number) VALUES (?,?,?,?)",
    ).run('SN1', 0, 'com.whatsapp.w4b', '5543991938235')

    const result = reg.importFromWhatsappAccounts()
    expect(result.inserted).toBe(1)
    expect(reg.listChips()).toHaveLength(1)
  })

  it('reports skipped_no_phone count for placeholder rows in whatsapp_accounts', () => {
    const { db, reg } = buildEnv()
    db.prepare(
      "INSERT INTO whatsapp_accounts (device_serial, profile_id, package_name, phone_number) VALUES (?,?,?,?)",
    ).run('SN1', 0, 'com.whatsapp', '5543991938235')
    db.prepare(
      "INSERT INTO whatsapp_accounts (device_serial, profile_id, package_name, phone_number) VALUES (?,?,?,?)",
    ).run('SN1', 10, 'com.whatsapp', null)
    db.prepare(
      "INSERT INTO whatsapp_accounts (device_serial, profile_id, package_name, phone_number) VALUES (?,?,?,?)",
    ).run('SN1', 11, 'com.whatsapp', null)
    db.prepare(
      "INSERT INTO whatsapp_accounts (device_serial, profile_id, package_name, phone_number) VALUES (?,?,?,?)",
    ).run('SN1', 12, 'com.whatsapp', '')

    const result = reg.importFromWhatsappAccounts()
    expect(result.inserted).toBe(1)
    expect(result.already_exists).toBe(0)
    // Three rows had NULL/empty phone_number — surfaced for UI nag.
    expect(result.skipped_no_phone).toBe(3)
  })

  it('separates already_exists from skipped_no_phone on idempotent re-run', () => {
    const { db, reg } = buildEnv()
    db.prepare(
      "INSERT INTO whatsapp_accounts (device_serial, profile_id, package_name, phone_number) VALUES (?,?,?,?)",
    ).run('SN1', 0, 'com.whatsapp', '5543991938235')
    db.prepare(
      "INSERT INTO whatsapp_accounts (device_serial, profile_id, package_name, phone_number) VALUES (?,?,?,?)",
    ).run('SN1', 10, 'com.whatsapp', null)

    reg.importFromWhatsappAccounts() // first run: inserts the one with phone
    const r2 = reg.importFromWhatsappAccounts()
    expect(r2.inserted).toBe(0)
    expect(r2.already_exists).toBe(1) // the existing chip is now "already_exists"
    expect(r2.skipped_no_phone).toBe(1) // the NULL row remains
    // Backwards-compat field still mirrors already_exists
    expect(r2.skipped).toBe(r2.already_exists)
  })

  it('records an "acquired" event for each newly imported chip', () => {
    const { db, reg } = buildEnv()
    db.prepare(
      "INSERT INTO whatsapp_accounts (device_serial, profile_id, package_name, phone_number) VALUES (?,?,?,?)",
    ).run('SN1', 0, 'com.whatsapp', '5543991938235')

    reg.importFromWhatsappAccounts()
    const chip = reg.listChips()[0]!
    const events = reg.listEvents(chip.id)
    expect(events).toHaveLength(1)
    expect(events[0]!.event_type).toBe('acquired')
    const meta = JSON.parse(events[0]!.metadata_json!) as Record<string, unknown>
    expect(meta.profile_id).toBe(0)
    expect(meta.package_name).toBe('com.whatsapp')
    expect(meta.device_serial).toBe('SN1')
  })

  it('returns 0 inserted when whatsapp_accounts table is missing', () => {
    const db = new Database(':memory:')
    const reg = new ChipRegistry(db)
    reg.initialize()
    const result = reg.importFromWhatsappAccounts()
    expect(result).toEqual({
      source: 'whatsapp_accounts',
      inserted: 0,
      skipped: 0,
      already_exists: 0,
      skipped_no_phone: 0,
      errors: [],
    })
  })
})

describe('ChipRegistry - importFromSenderMapping', () => {
  it('imports active senders only', () => {
    const { db, reg } = buildEnv()
    db.prepare(
      `INSERT INTO sender_mapping (id, phone_number, device_serial, profile_id, app_package, active)
       VALUES (?,?,?,?,?,?)`,
    ).run('s1', '5543991938235', 'SN1', 0, 'com.whatsapp', 1)
    db.prepare(
      `INSERT INTO sender_mapping (id, phone_number, device_serial, profile_id, app_package, active)
       VALUES (?,?,?,?,?,?)`,
    ).run('s2', '5543996837813', 'SN2', 0, 'com.whatsapp', 0)

    const result = reg.importFromSenderMapping()
    expect(result.inserted).toBe(1)
    expect(reg.listChips()).toHaveLength(1)
    expect(reg.listChips()[0]!.phone_number).toBe('5543991938235')
  })

  it('returns 0 when sender_mapping table is missing', () => {
    const db = new Database(':memory:')
    const reg = new ChipRegistry(db)
    reg.initialize()
    const result = reg.importFromSenderMapping()
    expect(result.inserted).toBe(0)
  })
})

describe('ChipRegistry - importFromDevices (combined)', () => {
  it('runs both imports and reports per-source results', () => {
    const { db, reg } = buildEnv()
    db.prepare(
      "INSERT INTO whatsapp_accounts (device_serial, profile_id, package_name, phone_number) VALUES (?,?,?,?)",
    ).run('SN1', 0, 'com.whatsapp', '5543991938235')
    db.prepare(
      `INSERT INTO sender_mapping (id, phone_number, device_serial, profile_id, app_package, active)
       VALUES (?,?,?,?,?,?)`,
    ).run('s1', '5543996837813', 'SN2', 0, 'com.whatsapp', 1)

    const result = reg.importFromDevices()
    expect(result.whatsapp_accounts.inserted).toBe(1)
    expect(result.sender_mapping.inserted).toBe(1)
    expect(reg.listChips()).toHaveLength(2)
  })

  it('does not duplicate when same phone exists in both tables', () => {
    const { db, reg } = buildEnv()
    const phone = '5543991938235'
    db.prepare(
      "INSERT INTO whatsapp_accounts (device_serial, profile_id, package_name, phone_number) VALUES (?,?,?,?)",
    ).run('SN1', 0, 'com.whatsapp', phone)
    db.prepare(
      `INSERT INTO sender_mapping (id, phone_number, device_serial, profile_id, app_package, active)
       VALUES (?,?,?,?,?,?)`,
    ).run('s1', phone, 'SN1', 0, 'com.whatsapp', 1)

    const result = reg.importFromDevices()
    expect(result.whatsapp_accounts.inserted + result.sender_mapping.inserted).toBe(1)
    expect(reg.listChips()).toHaveLength(1)
  })
})
