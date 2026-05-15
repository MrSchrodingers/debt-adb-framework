import type Database from 'better-sqlite3'

export interface DeviceAssignment {
  device_serial: string
  tenant_name: string
  claimed_by_plugin: string
  claimed_at: string
}

export type ClaimResult =
  | { ok: true }
  | { ok: false; reason: 'already_claimed'; current_tenant: string; current_plugin: string }

export type ReleaseResult =
  | { ok: true }
  | { ok: false; reason: 'not_owner' }

/**
 * G2.1 (debt-sdr): single-row-per-device ownership table.
 *
 * Backs the hard partition between tenants: a claimed device only
 * accepts messages whose tenant_hint matches the claim. Atomicity is
 * provided by SQLite's single-writer guarantee — no application-level
 * lock is needed for claim/release/list.
 */
export class DeviceTenantAssignment {
  constructor(private readonly db: Database.Database) {
    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS device_tenant_assignment (
        device_serial TEXT PRIMARY KEY,
        tenant_name TEXT NOT NULL,
        claimed_by_plugin TEXT NOT NULL,
        claimed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )
    `).run()
  }

  /**
   * Claim a device for a (tenant, plugin) pair. Idempotent for the same
   * (tenant, plugin) tuple. Fails when another tenant/plugin already
   * holds it.
   */
  claim(deviceSerial: string, tenantName: string, pluginName: string): ClaimResult {
    const existing = this.db.prepare(
      'SELECT tenant_name, claimed_by_plugin FROM device_tenant_assignment WHERE device_serial = ?',
    ).get(deviceSerial) as { tenant_name: string; claimed_by_plugin: string } | undefined

    if (existing) {
      if (existing.tenant_name === tenantName && existing.claimed_by_plugin === pluginName) {
        return { ok: true }
      }
      return {
        ok: false,
        reason: 'already_claimed',
        current_tenant: existing.tenant_name,
        current_plugin: existing.claimed_by_plugin,
      }
    }

    this.db.prepare(`
      INSERT INTO device_tenant_assignment (device_serial, tenant_name, claimed_by_plugin)
      VALUES (?, ?, ?)
    `).run(deviceSerial, tenantName, pluginName)
    return { ok: true }
  }

  /**
   * Release a device. Ownership guard (I2): a plugin can only release
   * devices it claimed. Releasing an unclaimed device is a no-op.
   */
  release(deviceSerial: string, pluginName: string): ReleaseResult {
    const existing = this.db.prepare(
      'SELECT claimed_by_plugin FROM device_tenant_assignment WHERE device_serial = ?',
    ).get(deviceSerial) as { claimed_by_plugin: string } | undefined

    if (!existing) return { ok: true }
    if (existing.claimed_by_plugin !== pluginName) {
      return { ok: false, reason: 'not_owner' }
    }
    this.db.prepare('DELETE FROM device_tenant_assignment WHERE device_serial = ?').run(deviceSerial)
    return { ok: true }
  }

  /** Release every device owned by a plugin (auto-cleanup on destroy). */
  releaseByPlugin(pluginName: string): number {
    const r = this.db.prepare(
      'DELETE FROM device_tenant_assignment WHERE claimed_by_plugin = ?',
    ).run(pluginName)
    return r.changes
  }

  getAssignment(deviceSerial: string): DeviceAssignment | null {
    return (this.db.prepare(
      'SELECT * FROM device_tenant_assignment WHERE device_serial = ?',
    ).get(deviceSerial) as DeviceAssignment | undefined) ?? null
  }

  list(): DeviceAssignment[] {
    return this.db.prepare('SELECT * FROM device_tenant_assignment').all() as DeviceAssignment[]
  }
}
