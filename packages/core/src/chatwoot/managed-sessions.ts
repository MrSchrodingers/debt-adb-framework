import type Database from 'better-sqlite3'
import type { Statement } from 'better-sqlite3'
import type { ManagedSessionRecord } from './types.js'

interface Row {
  session_name: string
  phone_number: string
  device_serial: string | null
  profile_id: number | null
  chatwoot_inbox_id: number | null
  managed: number
  created_at: string
}

function rowToRecord(row: Row): ManagedSessionRecord {
  return {
    sessionName: row.session_name,
    phoneNumber: row.phone_number,
    deviceSerial: row.device_serial,
    profileId: row.profile_id,
    chatwootInboxId: row.chatwoot_inbox_id,
    managed: row.managed === 1,
    createdAt: row.created_at,
  }
}

export class ManagedSessions {
  private db: Database.Database
  private stmtAdd!: Statement
  private stmtGet!: Statement
  private stmtListAll!: Statement
  private stmtListManaged!: Statement
  private stmtSetManaged!: Statement
  private stmtUpdateInbox!: Statement
  private stmtAttachDevice!: Statement
  private stmtDetachDevice!: Statement
  private stmtSetPhone!: Statement
  private stmtRemove!: Statement
  private stmtFindByPhone!: Statement
  private stmtFindByDevice!: Statement

  constructor(db: Database.Database) {
    this.db = db
  }

  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS managed_sessions (
        session_name TEXT PRIMARY KEY,
        phone_number TEXT NOT NULL,
        device_serial TEXT,
        profile_id INTEGER,
        chatwoot_inbox_id INTEGER,
        managed INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `)

    this.stmtAdd = this.db.prepare(
      `INSERT INTO managed_sessions (session_name, phone_number, device_serial, profile_id, chatwoot_inbox_id)
       VALUES (?, ?, ?, ?, ?)`,
    )
    this.stmtGet = this.db.prepare('SELECT * FROM managed_sessions WHERE session_name = ?')
    this.stmtListAll = this.db.prepare('SELECT * FROM managed_sessions ORDER BY session_name')
    this.stmtListManaged = this.db.prepare('SELECT * FROM managed_sessions WHERE managed = 1 ORDER BY session_name')
    this.stmtSetManaged = this.db.prepare('UPDATE managed_sessions SET managed = ? WHERE session_name = ?')
    this.stmtUpdateInbox = this.db.prepare('UPDATE managed_sessions SET chatwoot_inbox_id = ? WHERE session_name = ?')
    this.stmtAttachDevice = this.db.prepare(
      'UPDATE managed_sessions SET device_serial = ?, profile_id = ? WHERE session_name = ?',
    )
    this.stmtDetachDevice = this.db.prepare(
      'UPDATE managed_sessions SET device_serial = NULL, profile_id = NULL WHERE session_name = ?',
    )
    this.stmtSetPhone = this.db.prepare(
      'UPDATE managed_sessions SET phone_number = ? WHERE session_name = ?',
    )
    this.stmtRemove = this.db.prepare('DELETE FROM managed_sessions WHERE session_name = ?')
    this.stmtFindByPhone = this.db.prepare('SELECT * FROM managed_sessions WHERE phone_number = ? ORDER BY session_name')
    this.stmtFindByDevice = this.db.prepare('SELECT * FROM managed_sessions WHERE device_serial = ? ORDER BY session_name')
  }

  add(params: {
    sessionName: string
    phoneNumber: string
    deviceSerial: string | null
    profileId: number | null
    chatwootInboxId: number | null
  }): string {
    this.stmtAdd.run(
      params.sessionName,
      params.phoneNumber,
      params.deviceSerial,
      params.profileId,
      params.chatwootInboxId,
    )
    return params.sessionName
  }

  get(sessionName: string): ManagedSessionRecord | null {
    const row = this.stmtGet.get(sessionName) as Row | undefined
    return row ? rowToRecord(row) : null
  }

  listAll(): ManagedSessionRecord[] {
    return (this.stmtListAll.all() as Row[]).map(rowToRecord)
  }

  listAllAsMap(): Map<string, ManagedSessionRecord> {
    return new Map(this.listAll().map((r) => [r.sessionName, r]))
  }

  listManaged(): ManagedSessionRecord[] {
    return (this.stmtListManaged.all() as Row[]).map(rowToRecord)
  }

  setManaged(sessionName: string, managed: boolean): void {
    const result = this.stmtSetManaged.run(managed ? 1 : 0, sessionName)
    if (result.changes === 0) {
      throw new Error(`Session ${sessionName} not found`)
    }
  }

  updateChatwootInboxId(sessionName: string, inboxId: number): void {
    this.stmtUpdateInbox.run(inboxId, sessionName)
  }

  /**
   * Pin the session to a specific (device, profile). Without this the
   * pairing flow has no way to resolve which Android user to switch to,
   * and `/waha/sessions/:name/pair` returns 412.
   */
  attachToDevice(sessionName: string, deviceSerial: string, profileId: number): void {
    const result = this.stmtAttachDevice.run(deviceSerial, profileId, sessionName)
    if (result.changes === 0) {
      throw new Error(`Session ${sessionName} not found`)
    }
  }

  /**
   * Reverse of `attachToDevice`. Used when an operator picked the wrong
   * device/profile pair (or a device is being decommissioned) and needs
   * to free the session before re-attaching elsewhere.
   *
   * No-ops when the session is already unattached, but still raises when
   * the session itself does not exist — the caller almost certainly has
   * a stale name otherwise.
   */
  detachFromDevice(sessionName: string): void {
    const result = this.stmtDetachDevice.run(sessionName)
    if (result.changes === 0) {
      // changes=0 either means the session doesn't exist OR it was
      // already unattached. Disambiguate so callers get a real 404 only
      // when the session is missing.
      if (!this.get(sessionName)) {
        throw new Error(`Session ${sessionName} not found`)
      }
    }
  }

  /** Update the phone_number after pairing completes. */
  setPhoneNumber(sessionName: string, phoneNumber: string): void {
    this.stmtSetPhone.run(phoneNumber, sessionName)
  }

  remove(sessionName: string): void {
    this.stmtRemove.run(sessionName)
  }

  findByPhoneNumber(phoneNumber: string): ManagedSessionRecord[] {
    return (this.stmtFindByPhone.all(phoneNumber) as Row[]).map(rowToRecord)
  }

  findByDeviceSerial(deviceSerial: string): ManagedSessionRecord[] {
    return (this.stmtFindByDevice.all(deviceSerial) as Row[]).map(rowToRecord)
  }
}
