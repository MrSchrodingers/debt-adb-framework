import type Database from 'better-sqlite3'
import { nanoid } from 'nanoid'

export interface SenderMappingRecord {
  id: string
  phone_number: string
  device_serial: string
  profile_id: number
  app_package: string
  waha_session: string | null
  waha_api_url: string | null
  active: number
  paused: number
  paused_at: string | null
  paused_reason: string | null
  created_at: string
  updated_at: string
}

export interface CreateSenderMappingParams {
  phoneNumber: string
  deviceSerial: string
  profileId?: number
  appPackage?: string
  wahaSession?: string
  wahaApiUrl?: string
}

export interface UpdateSenderMappingParams {
  deviceSerial?: string
  profileId?: number
  appPackage?: string
  wahaSession?: string
  wahaApiUrl?: string
  active?: boolean
}

export interface SenderConfig {
  phone: string
  session: string
  pair: string
  role: 'primary' | 'overflow' | 'backup' | 'reserve'
}

export interface ResolvedSender {
  mapping: SenderMappingRecord
  sender: SenderConfig
}

export class SenderMapping {
  constructor(private db: Database.Database) {}

  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sender_mapping (
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

      CREATE INDEX IF NOT EXISTS idx_sender_mapping_device ON sender_mapping(device_serial);
      CREATE INDEX IF NOT EXISTS idx_sender_mapping_active ON sender_mapping(active);
    `)

    // Migration: add paused columns if not present
    const cols = this.db.prepare('PRAGMA table_info(sender_mapping)').all() as { name: string }[]
    if (!cols.some(c => c.name === 'paused')) {
      this.db.exec('ALTER TABLE sender_mapping ADD COLUMN paused INTEGER NOT NULL DEFAULT 0')
      this.db.exec('ALTER TABLE sender_mapping ADD COLUMN paused_at TEXT')
      this.db.exec('ALTER TABLE sender_mapping ADD COLUMN paused_reason TEXT')
    }
  }

  create(params: CreateSenderMappingParams): SenderMappingRecord {
    const id = nanoid()
    const row = this.db.prepare(`
      INSERT INTO sender_mapping (id, phone_number, device_serial, profile_id, app_package, waha_session, waha_api_url)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `).get(
      id,
      params.phoneNumber,
      params.deviceSerial,
      params.profileId ?? 0,
      params.appPackage ?? 'com.whatsapp',
      params.wahaSession ?? null,
      params.wahaApiUrl ?? null,
    ) as SenderMappingRecord
    return row
  }

  getByPhone(phoneNumber: string): SenderMappingRecord | null {
    const row = this.db.prepare(
      'SELECT * FROM sender_mapping WHERE phone_number = ? AND active = 1',
    ).get(phoneNumber) as SenderMappingRecord | undefined
    return row ?? null
  }

  listAll(): SenderMappingRecord[] {
    return this.db.prepare(
      'SELECT * FROM sender_mapping WHERE active = 1 ORDER BY created_at ASC',
    ).all() as SenderMappingRecord[]
  }

  getByDeviceSerial(deviceSerial: string): SenderMappingRecord[] {
    return this.db.prepare(
      'SELECT * FROM sender_mapping WHERE device_serial = ? AND active = 1 ORDER BY profile_id ASC',
    ).all(deviceSerial) as SenderMappingRecord[]
  }

  update(phoneNumber: string, params: UpdateSenderMappingParams): SenderMappingRecord | null {
    const fields: string[] = []
    const values: unknown[] = []

    if (params.deviceSerial !== undefined) {
      fields.push('device_serial = ?')
      values.push(params.deviceSerial)
    }
    if (params.profileId !== undefined) {
      fields.push('profile_id = ?')
      values.push(params.profileId)
    }
    if (params.appPackage !== undefined) {
      fields.push('app_package = ?')
      values.push(params.appPackage)
    }
    if (params.wahaSession !== undefined) {
      fields.push('waha_session = ?')
      values.push(params.wahaSession)
    }
    if (params.wahaApiUrl !== undefined) {
      fields.push('waha_api_url = ?')
      values.push(params.wahaApiUrl)
    }
    if (params.active !== undefined) {
      fields.push('active = ?')
      values.push(params.active ? 1 : 0)
    }

    if (fields.length === 0) return this.getByPhone(phoneNumber)

    fields.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')")
    values.push(phoneNumber)

    const row = this.db.prepare(
      `UPDATE sender_mapping SET ${fields.join(', ')} WHERE phone_number = ? AND active = 1 RETURNING *`,
    ).get(...values) as SenderMappingRecord | undefined

    return row ?? null
  }

  deactivate(phoneNumber: string): boolean {
    const result = this.db.prepare(
      "UPDATE sender_mapping SET active = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE phone_number = ?",
    ).run(phoneNumber)
    return result.changes > 0
  }

  remove(phoneNumber: string): boolean {
    const result = this.db.prepare(
      'DELETE FROM sender_mapping WHERE phone_number = ?',
    ).run(phoneNumber)
    return result.changes > 0
  }

  pauseSender(phone: string, reason?: string): void {
    const now = new Date().toISOString()
    this.db.prepare(
      'UPDATE sender_mapping SET paused = 1, paused_at = ?, paused_reason = ?, updated_at = ? WHERE phone_number = ?',
    ).run(now, reason ?? null, now, phone)
  }

  resumeSender(phone: string): void {
    const now = new Date().toISOString()
    this.db.prepare(
      'UPDATE sender_mapping SET paused = 0, paused_at = NULL, paused_reason = NULL, updated_at = ? WHERE phone_number = ?',
    ).run(now, phone)
  }

  isPaused(phone: string): boolean {
    const row = this.db.prepare(
      'SELECT paused FROM sender_mapping WHERE phone_number = ?',
    ).get(phone) as { paused: number } | undefined
    return row?.paused === 1
  }

  /**
   * Walk the senders array in order, returning the first sender
   * that has an active mapping. Returns null if none found.
   */
  resolveSenderChain(senders: SenderConfig[]): ResolvedSender | null {
    for (const sender of senders) {
      const record = this.getByPhone(sender.phone)
      if (record) {
        return { mapping: record, sender }
      }
    }
    return null
  }
}
