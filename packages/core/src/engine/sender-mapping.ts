import type Database from 'better-sqlite3'
import { nanoid } from 'nanoid'
import type { SenderScoring } from './sender-scoring.js'
import type { SenderHealth } from './sender-health.js'

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
  tenant: string | null
  created_at: string
  updated_at: string
}

export type SetSenderTenantResult =
  | { ok: true }
  | { ok: false; reason: 'phone_not_found' }
  | { ok: false; reason: 'conflicting_tenant'; current_tenant: string }

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
  constructor(
    private db: Database.Database,
    private scoring?: SenderScoring,
    private senderHealth?: SenderHealth,
  ) {}

  /** Decision #39: Normalize phone to digits-only (Postel's Law) */
  private normalizePhone(phone: string): string {
    return phone.replace(/\D/g, '')
  }

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

    // G1 (debt-sdr): tenant ownership column. Nullable for legacy senders.
    if (!cols.some(c => c.name === 'tenant')) {
      this.db.prepare('ALTER TABLE sender_mapping ADD COLUMN tenant TEXT').run()
    }
    this.db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_sender_mapping_tenant
        ON sender_mapping(tenant) WHERE tenant IS NOT NULL
    `).run()
  }

  create(params: CreateSenderMappingParams): SenderMappingRecord {
    const id = nanoid()
    const row = this.db.prepare(`
      INSERT INTO sender_mapping (id, phone_number, device_serial, profile_id, app_package, waha_session, waha_api_url)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `).get(
      id,
      this.normalizePhone(params.phoneNumber),
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
    ).get(this.normalizePhone(phoneNumber)) as SenderMappingRecord | undefined
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
   * G1 (debt-sdr): set tenant ownership for a sender phone.
   *
   * Idempotent for the same tenant. Rejects a different tenant on a phone
   * already owned by another tenant. Phones with no tenant become
   * tenant-owned; the row is identified by normalized phone_number (UNIQUE).
   *
   * Atomicity: the read-then-write is wrapped in a single CAS UPDATE
   * (`WHERE tenant IS NULL OR tenant = ?`) so two concurrent claims for
   * the same phone but different tenants cannot both succeed — last
   * writer can only succeed if the row is still uncontested. We then
   * re-read to determine which case fired.
   */
  setSenderTenant(phone: string, tenant: string): SetSenderTenantResult {
    const normalized = this.normalizePhone(phone)

    // Confirm existence up front so we can distinguish phone_not_found
    // from conflicting_tenant without an extra round-trip on the hot path.
    const existing = this.db
      .prepare('SELECT tenant FROM sender_mapping WHERE phone_number = ?')
      .get(normalized) as { tenant: string | null } | undefined
    if (!existing) return { ok: false, reason: 'phone_not_found' }

    // Single-statement CAS: only sets tenant when the slot is still ours
    // (null) or already ours (idempotent). better-sqlite3's single-writer
    // guarantee makes this atomic across concurrent processes — no two
    // tenants can both win.
    const result = this.db
      .prepare(
        `UPDATE sender_mapping
            SET tenant = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE phone_number = ?
            AND (tenant IS NULL OR tenant = ?)`,
      )
      .run(tenant, normalized, tenant)

    if (result.changes > 0) return { ok: true }

    // Zero changes means the CAS missed — another writer claimed the
    // slot. Re-read for the winning tenant.
    const after = this.db
      .prepare('SELECT tenant FROM sender_mapping WHERE phone_number = ?')
      .get(normalized) as { tenant: string | null } | undefined
    if (!after) return { ok: false, reason: 'phone_not_found' }
    // after.tenant must be non-null here (CAS only fails when tenant is
    // a different non-null value). Treat null as a defensive no-op success.
    if (after.tenant === null || after.tenant === tenant) return { ok: true }
    return { ok: false, reason: 'conflicting_tenant', current_tenant: after.tenant }
  }

  /** G1: list all active senders owned by a tenant. */
  listByTenant(tenant: string): SenderMappingRecord[] {
    return this.db
      .prepare('SELECT * FROM sender_mapping WHERE tenant = ? AND active = 1 ORDER BY created_at ASC')
      .all(tenant) as SenderMappingRecord[]
  }

  /**
   * Reconcile sender_mapping with the truth in whatsapp_accounts.
   *
   * Rules:
   *   - For every (device, profile, package) in whatsapp_accounts with
   *     a real phone: ensure a sender_mapping row exists with the
   *     correct phone. If a row already exists for the same
   *     (device, profile, package) with a DIFFERENT phone, it's stale
   *     (account was switched on the device) — delete it and insert
   *     the fresh one.
   *   - For every sender_mapping row whose phone_number is "real"
   *     (does NOT start with the placeholder prefix) and whose
   *     (device, profile, package) is NOT present in whatsapp_accounts
   *     with that exact phone → DELETE. The phone left the device.
   *   - Placeholder rows (`PLACEHOLDER_PREFIX` below) are PRESERVED:
   *     they belong to managed sessions waiting for QR scan.
   *   - Operator-pinned rows (waha_session IS NOT NULL) are also
   *     PRESERVED. The attach endpoint creates these the moment the
   *     operator pins a session to (device, profile) — frequently for
   *     a profile whose WhatsApp hasn't been opened yet, so
   *     whatsapp_accounts has nothing to match. Without this guard the
   *     5-minute mapAllAccounts cycle silently wipes the pin and the
   *     operator's choice vanishes from the senders list. The DELETE
   *     /sessions/managed/:name/device endpoint is the proper way to
   *     clean these up.
   *
   * Returns counts so the caller can log a reconciliation summary.
   */
  reconcileFromWhatsappAccounts(): { inserted: number; updated: number; deleted: number } {
    const PLACEHOLDER_PREFIX = '99999'
    const truth = this.db
      .prepare(
        `SELECT device_serial, profile_id, package_name, phone_number
           FROM whatsapp_accounts
          WHERE phone_number IS NOT NULL AND phone_number != ''`,
      )
      .all() as Array<{
        device_serial: string
        profile_id: number
        package_name: string
        phone_number: string
      }>

    const truthByDevProfPkg = new Map<string, string>()
    for (const t of truth) {
      truthByDevProfPkg.set(`${t.device_serial}|${t.profile_id}|${t.package_name}`, t.phone_number)
    }

    const existing = this.db
      .prepare(
        `SELECT id, phone_number, device_serial, profile_id, app_package, waha_session
           FROM sender_mapping WHERE active = 1`,
      )
      .all() as Array<{
        id: string
        phone_number: string
        device_serial: string
        profile_id: number
        app_package: string
        waha_session: string | null
      }>

    let inserted = 0
    let updated = 0
    let deleted = 0
    const txn = this.db.transaction(() => {
      // Pass 1: delete stale rows whose (dev, prof, pkg) no longer
      // matches truth. Placeholders AND operator-pinned (waha_session
      // set) rows are preserved unconditionally — both represent
      // intent that hasn't yet materialized as a paired phone in
      // whatsapp_accounts.
      for (const e of existing) {
        if (e.phone_number.startsWith(PLACEHOLDER_PREFIX)) continue
        if (e.waha_session) continue
        const key = `${e.device_serial}|${e.profile_id}|${e.app_package}`
        const truthPhone = truthByDevProfPkg.get(key)
        if (truthPhone !== e.phone_number) {
          this.db.prepare('DELETE FROM sender_mapping WHERE id = ?').run(e.id)
          deleted++
        }
      }

      // Pass 2: ensure every truth row has a matching sender_mapping.
      const stmtCheck = this.db.prepare(
        'SELECT id FROM sender_mapping WHERE phone_number = ? AND active = 1',
      )
      for (const t of truth) {
        const row = stmtCheck.get(t.phone_number) as { id: string } | undefined
        if (row) {
          // Already exists — make sure (device, profile, package) is correct.
          const r = this.db
            .prepare(
              `UPDATE sender_mapping
                  SET device_serial = ?, profile_id = ?, app_package = ?,
                      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE phone_number = ?
                  AND (device_serial != ? OR profile_id != ? OR app_package != ?)`,
            )
            .run(
              t.device_serial,
              t.profile_id,
              t.package_name,
              t.phone_number,
              t.device_serial,
              t.profile_id,
              t.package_name,
            )
          if ((r.changes ?? 0) > 0) updated++
        } else {
          this.create({
            phoneNumber: t.phone_number,
            deviceSerial: t.device_serial,
            profileId: t.profile_id,
            appPackage: t.package_name as 'com.whatsapp' | 'com.whatsapp.w4b',
          })
          inserted++
        }
      }
    })
    txn()
    return { inserted, updated, deleted }
  }

  /**
   * Resolve the best available sender from the chain.
   *
   * With scoring injected (smart path):
   *   1. Build candidates: load mapping + health for each sender in the chain.
   *   2. Skip senders that have no mapping, are inactive (mapping = null), or are paused.
   *   3. Delegate to SenderScoring.pickBest() — winner is the highest-scoring active sender.
   *   4. Call scoring.recordSend(winner.phone) to update last_send_at for the next dispatch.
   *
   * Without scoring (legacy fallback):
   *   Walk in order and return the first active sender (original order-walk behaviour).
   *   All existing tests continue to pass without modification.
   */
  resolveSenderChain(senders: SenderConfig[]): ResolvedSender | null {
    if (!this.scoring) {
      // ── Legacy order-walk (backward compat) ────────────────────────────
      for (const sender of senders) {
        const record = this.getByPhone(sender.phone)
        if (record && record.paused === 0) {
          return { mapping: record, sender }
        }
      }
      return null
    }

    // ── Smart path: build candidates, score, pick best ──────────────────
    const candidates: Array<{ mapping: SenderMappingRecord; sender: SenderConfig }> = []
    for (const sender of senders) {
      const record = this.getByPhone(sender.phone)
      if (!record || record.paused !== 0) continue
      candidates.push({ mapping: record, sender })
    }

    if (candidates.length === 0) return null

    const scoringCandidates = candidates.map(({ mapping, sender }) => ({
      phone: mapping.phone_number,
      role: sender.role,
      health: this.senderHealth?.getStatus(mapping.phone_number) ?? null,
      // lastSendAt is fetched inside SenderScoring.scoreSender via DB
    }))

    const best = this.scoring.pickBest(scoringCandidates)
    if (!best) return null

    // Record the dispatch so idle-time tracking stays accurate
    this.scoring.recordSend(best.candidate.phone)

    const winner = candidates.find(c => c.mapping.phone_number === best.candidate.phone)
    if (!winner) return null

    return { mapping: winner.mapping, sender: winner.sender }
  }
}
