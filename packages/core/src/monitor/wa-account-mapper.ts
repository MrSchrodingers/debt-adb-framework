import type Database from 'better-sqlite3'
import type { WhatsAppAccount, AdbShellAdapter } from './types.js'

const PROFILES = [0, 10, 11, 12]
const WA_PACKAGES = ['com.whatsapp', 'com.whatsapp.w4b'] as const

const PREFS_FILE: Record<string, string> = {
  'com.whatsapp': 'com.whatsapp_preferences_light.xml',
  'com.whatsapp.w4b': 'com.whatsapp.w4b_preferences_light.xml',
}

export class WaAccountMapper {
  private db: Database.Database
  private adb: AdbShellAdapter

  constructor(db: Database.Database, adb: AdbShellAdapter) {
    this.db = db
    this.adb = adb
  }

  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS whatsapp_accounts (
        device_serial TEXT NOT NULL,
        profile_id INTEGER NOT NULL,
        package_name TEXT NOT NULL,
        phone_number TEXT,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        PRIMARY KEY (device_serial, profile_id, package_name)
      )
    `)
  }

  async mapAccounts(serial: string): Promise<WhatsAppAccount[]> {
    const accounts: WhatsAppAccount[] = []

    for (const profileId of PROFILES) {
      const output = await this.adb.shell(serial, `pm list packages --user ${profileId} whatsapp`)
      const installed = output
        .split('\n')
        .map((line) => line.replace('package:', '').trim())
        .filter((pkg): pkg is (typeof WA_PACKAGES)[number] =>
          (WA_PACKAGES as readonly string[]).includes(pkg),
        )

      for (const pkg of installed) {
        let phoneNumber: string | null = null
        try {
          const xml = await this.adb.shell(
            serial,
            `run-as ${pkg} --user ${profileId} cat shared_prefs/${PREFS_FILE[pkg]}`,
          )
          const match = xml.match(/registration_jid[^>]*>(\d+)@/)
          phoneNumber = match ? match[1] : null
        } catch {
          // Permission denied or file not found — continue with null phone
        }

        accounts.push({ deviceSerial: serial, profileId, packageName: pkg, phoneNumber })
      }
    }

    this.upsertAccounts(serial, accounts)
    return accounts
  }

  getAccountsByDevice(serial: string): WhatsAppAccount[] {
    const rows = this.db
      .prepare('SELECT * FROM whatsapp_accounts WHERE device_serial = ?')
      .all(serial) as Record<string, unknown>[]
    return rows.map(rowToAccount)
  }

  getAccountByNumber(phoneNumber: string): WhatsAppAccount | null {
    const row = this.db
      .prepare('SELECT * FROM whatsapp_accounts WHERE phone_number = ?')
      .get(phoneNumber) as Record<string, unknown> | undefined
    return row ? rowToAccount(row) : null
  }

  private upsertAccounts(serial: string, accounts: WhatsAppAccount[]): void {
    this.db.prepare('DELETE FROM whatsapp_accounts WHERE device_serial = ?').run(serial)

    const insert = this.db.prepare(`
      INSERT INTO whatsapp_accounts (device_serial, profile_id, package_name, phone_number, updated_at)
      VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    `)

    for (const acc of accounts) {
      insert.run(acc.deviceSerial, acc.profileId, acc.packageName, acc.phoneNumber)
    }
  }
}

function rowToAccount(row: Record<string, unknown>): WhatsAppAccount {
  return {
    deviceSerial: row.device_serial as string,
    profileId: row.profile_id as number,
    packageName: row.package_name as WhatsAppAccount['packageName'],
    phoneNumber: row.phone_number as string | null,
  }
}
