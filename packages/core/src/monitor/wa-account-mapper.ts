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

      // Extract phone numbers via contacts content provider (works without root)
      const phonesByType = await this.extractPhoneNumbers(serial, profileId)

      for (const pkg of installed) {
        const accountType = pkg // com.whatsapp or com.whatsapp.w4b
        const phoneNumber = phonesByType[accountType] ?? null
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

  private async extractPhoneNumbers(
    serial: string,
    profileId: number,
  ): Promise<Record<string, string>> {
    const result: Record<string, string> = {}

    for (const pkg of WA_PACKAGES) {
      try {
        const output = await this.adb.shell(
          serial,
          `content query --uri content://com.android.contacts/raw_contacts --where "account_type='${pkg}'" --projection sync1 --user ${profileId}`,
        )
        // Format: Row: 0 sync1=554391938235@s.whatsapp.net
        const match = output.match(/sync1=(\d+)@s\.whatsapp\.net/)
        if (match) {
          result[pkg] = match[1]
        }
      } catch {
        // Content provider not available for this user — try run-as fallback
        try {
          const xml = await this.adb.shell(
            serial,
            `run-as ${pkg} --user ${profileId} cat shared_prefs/${PREFS_FILE[pkg]}`,
          )
          const match = xml.match(/registration_jid[^>]*>(\d+)@/)
          if (match) {
            result[pkg] = match[1]
          }
        } catch {
          // 3rd attempt: root access to SharedPrefs
          try {
            const prefsFile = PREFS_FILE[pkg]
            await this.adb.shell(
              serial,
              `su -c "cp /data/user/${profileId}/${pkg}/shared_prefs/${prefsFile} /sdcard/dispatch_wa_prefs_${profileId}.xml"`,
            )
            const prefs = await this.adb.shell(
              serial,
              `cat /sdcard/dispatch_wa_prefs_${profileId}.xml`,
            )

            const ccMatch = prefs.match(/<string name="cc">(\d+)<\/string>/)
            const jidMatch = prefs.match(/<string name="registration_jid">(\d+)@/)
            const lidMatch = prefs.match(/<string name="self_lid">(\d+)@/)
            const number = jidMatch?.[1] ?? lidMatch?.[1]

            if (number && ccMatch) {
              result[pkg] = ccMatch[1] + number
            } else if (number) {
              result[pkg] = number
            }

            // Cleanup temp file
            await this.adb.shell(
              serial,
              `rm -f /sdcard/dispatch_wa_prefs_${profileId}.xml`,
            )
          } catch {
            // Root not available or WA not installed — continue with no phone number
          }
        }
      }
    }

    return result
  }

  private upsertAccounts(serial: string, accounts: WhatsAppAccount[]): void {
    const txn = this.db.transaction(() => {
      const upsert = this.db.prepare(`
        INSERT INTO whatsapp_accounts (device_serial, profile_id, package_name, phone_number, updated_at)
        VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        ON CONFLICT(device_serial, profile_id, package_name) DO UPDATE SET
          phone_number = COALESCE(excluded.phone_number, whatsapp_accounts.phone_number),
          updated_at = excluded.updated_at
      `)

      for (const acc of accounts) {
        upsert.run(acc.deviceSerial, acc.profileId, acc.packageName, acc.phoneNumber)
      }
    })
    txn()
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
