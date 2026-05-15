import type Database from 'better-sqlite3'
import type {
  DispatchPlugin,
  PluginContext,
  DispatchEventName,
} from '@dispatch/core'
import { loadSdrPluginConfig, type SdrPluginConfig, type SdrTenantConfig } from './config/tenant-config.js'
import { initSdrSchema } from './db/migrations.js'

interface ClaimedDevice {
  serial: string
  tenant: string
}

/**
 * debt-sdr — multi-tenant SDR outbound plugin.
 *
 * init() flow (spec §3 + §5):
 *   1. Parse config (Zod) — throws on invalid
 *   2. Run migrations (idempotent)
 *   3. Preflight: refuse to claim a device that already has a sender owned
 *      by a different tenant (defense for A9 — stale cross-tenant senders)
 *   4. Claim each device via ctx.requestDeviceAssignment (I1)
 *   5. Assert each sender via ctx.assertSenderInTenant (I3)
 *   6. On any failure, release everything claimed so far and rethrow.
 *      No "split-tenant" partial init is permitted.
 *
 * destroy() flow:
 *   - Stop any registered crons (Phase D wires these)
 *   - Explicitly release every claimed device (defense in depth — the
 *     loader's auto-cleanup also runs)
 *   - Idempotent (safe to call after a failed init)
 */
export class DebtSdrPlugin implements DispatchPlugin {
  readonly name = 'debt-sdr'
  readonly version = '0.1.0'
  readonly manifest = {
    name: 'debt-sdr',
    version: '0.1.0',
    sdkVersion: '^1.0.0',
    description:
      'SDR outbound — multi-tenant, identity gate, hybrid classifier (regex+LLM), Pipedrive writeback, 3-touch sequence',
    author: 'DEBT',
  }
  readonly events: DispatchEventName[] = ['message:sent', 'message:failed']
  readonly webhookUrl: string

  private readonly config: SdrPluginConfig
  private readonly db: Database.Database
  private ctx: PluginContext | null = null
  private claimedDevices: ClaimedDevice[] = []

  constructor(webhookUrl: string, rawConfig: unknown, db: Database.Database) {
    this.webhookUrl = webhookUrl
    this.config = loadSdrPluginConfig(rawConfig)
    this.db = db
  }

  async init(ctx: PluginContext): Promise<void> {
    this.ctx = ctx

    initSdrSchema(this.db)

    // Preflight: refuse to start if any target device already hosts a
    // sender owned by another tenant. Catches A9 (stale cross-tenant
    // senders that survived a previous tenant swap).
    this.assertNoCrossTenantSenders()

    try {
      for (const tenant of this.config.tenants) {
        await this.claimTenantDevices(tenant)
        this.assertTenantSenders(tenant)
      }
      ctx.logger.info('debt-sdr initialized', {
        tenants: this.config.tenants.map((t) => t.name),
        claimed_devices: this.claimedDevices.length,
      })
    } catch (err) {
      // Roll back any partial claims so the loader doesn't have to
      // (defense in depth — releaseByPlugin will catch leftovers too).
      this.releaseAllClaimed()
      throw err
    }
  }

  async destroy(): Promise<void> {
    if (!this.ctx) return
    // Phase D wires crons; this site is the single place to stop them.
    this.releaseAllClaimed()
    this.ctx.logger.info('debt-sdr destroyed')
    this.ctx = null
  }

  // ── helpers ────────────────────────────────────────────────────────────

  getConfig(): SdrPluginConfig {
    return this.config
  }

  /** Test hook — device serials this instance has claimed. */
  getClaimedDevices(): readonly ClaimedDevice[] {
    return this.claimedDevices
  }

  private async claimTenantDevices(tenant: SdrTenantConfig): Promise<void> {
    if (!this.ctx) throw new Error('init must set ctx before claiming devices')
    for (const serial of tenant.devices) {
      const r = this.ctx.requestDeviceAssignment(serial, tenant.name)
      if (!r.ok) {
        throw new Error(
          `debt-sdr cannot claim device ${serial} for tenant ${tenant.name}: ` +
            `${r.reason} (current tenant=${r.current_tenant}, plugin=${r.current_plugin})`,
        )
      }
      this.claimedDevices.push({ serial, tenant: tenant.name })
    }
  }

  private assertTenantSenders(tenant: SdrTenantConfig): void {
    if (!this.ctx) throw new Error('init must set ctx before asserting senders')
    for (const sender of tenant.senders) {
      const r = this.ctx.assertSenderInTenant(sender.phone, tenant.name)
      if (!r.ok) {
        if (r.reason === 'conflicting_tenant') {
          throw new Error(
            `debt-sdr cannot assert sender ${sender.phone} for tenant ${tenant.name}: ` +
              `already owned by ${r.current_tenant}`,
          )
        }
        if (r.reason === 'phone_not_found') {
          throw new Error(
            `debt-sdr sender ${sender.phone} (${sender.app}) for tenant ${tenant.name} ` +
              `has no row in sender_mapping — operator must add the mapping first`,
          )
        }
      }
    }
  }

  /**
   * Preflight (A9 defense): for each target device, refuse to start if
   * any active sender_mapping row on that device is owned by a tenant
   * that isn't ours. A stale cross-tenant sender on a device we're about
   * to claim would lead to messages going out on the wrong account.
   */
  private assertNoCrossTenantSenders(): void {
    const stmt = this.db.prepare(
      `SELECT phone_number, tenant
         FROM sender_mapping
        WHERE device_serial = ?
          AND active = 1
          AND tenant IS NOT NULL`,
    )
    const conflicts: Array<{ device: string; tenant: string; foreign: string; phone: string }> = []
    for (const tenant of this.config.tenants) {
      for (const device of tenant.devices) {
        const rows = stmt.all(device) as Array<{ phone_number: string; tenant: string }>
        for (const row of rows) {
          if (row.tenant !== tenant.name) {
            conflicts.push({
              device,
              tenant: tenant.name,
              foreign: row.tenant,
              phone: row.phone_number,
            })
          }
        }
      }
    }
    if (conflicts.length > 0) {
      const detail = conflicts
        .map((c) => `${c.device}: phone=${c.phone} tenant=${c.foreign} (expected ${c.tenant})`)
        .join('; ')
      throw new Error(`debt-sdr preflight: cross-tenant senders on target devices: ${detail}`)
    }
  }

  private releaseAllClaimed(): void {
    if (!this.ctx) {
      this.claimedDevices = []
      return
    }
    for (const claim of this.claimedDevices) {
      this.ctx.releaseDeviceAssignment(claim.serial)
    }
    this.claimedDevices = []
  }
}
