import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { DebtSdrPlugin } from './sdr-plugin.js'
import type { PluginContext } from '@dispatch/core'
import type { SdrPluginConfig } from './config/tenant-config.js'

function validRawConfig(overrides: Record<string, unknown> = {}): unknown {
  return {
    tenants: [
      {
        name: 'oralsin-sdr',
        label: 'Oralsin',
        pipedrive: {
          domain: 'oralsin-xyz',
          api_token_env: 'PIPEDRIVE_TOKEN_ORALSIN_SDR',
          pull: {
            stage_id: 5,
            poll_interval_minutes: 15,
            batch_size: 50,
            max_age_days: 30,
            phone_field_key: 'phone',
          },
          writeback: {
            stage_qualified_id: 6,
            stage_disqualified_id: 7,
            stage_needs_human_id: 8,
            stage_no_response_id: 9,
            activity_subject_template: 'SDR: {{outcome}}',
          },
        },
        devices: ['devA'],
        senders: [{ phone: '554399000001', app: 'com.whatsapp' as const }],
        sequence_id: 'oralsin-cold-v1',
        throttle: {
          per_sender_daily_max: 40,
          min_interval_minutes: 8,
          operating_hours: { start: '09:00', end: '18:00' },
          tz: 'America/Sao_Paulo',
        },
        identity_gate: { enabled: true, nudge_after_hours: 48, abort_after_hours: 96 },
      },
      {
        name: 'sicoob-sdr',
        label: 'Sicoob',
        pipedrive: {
          domain: 'sicoob-xyz',
          api_token_env: 'PIPEDRIVE_TOKEN_SICOOB_SDR',
          pull: {
            stage_id: 5,
            poll_interval_minutes: 15,
            batch_size: 50,
            max_age_days: 30,
            phone_field_key: 'phone',
          },
          writeback: {
            stage_qualified_id: 6,
            stage_disqualified_id: 7,
            stage_needs_human_id: 8,
            stage_no_response_id: 9,
            activity_subject_template: 'SDR: {{outcome}}',
          },
        },
        devices: ['devB'],
        senders: [{ phone: '554399000002', app: 'com.whatsapp' as const }],
        sequence_id: 'sicoob-cold-v1',
        throttle: {
          per_sender_daily_max: 30,
          min_interval_minutes: 8,
          operating_hours: { start: '09:00', end: '18:00' },
          tz: 'America/Sao_Paulo',
        },
        identity_gate: { enabled: true, nudge_after_hours: 48, abort_after_hours: 96 },
      },
    ],
    ...overrides,
  }
}

interface CtxMockOptions {
  claimRejectFor?: string
  assertRejectFor?: string
  assertNotFoundFor?: string
}

function makeCtx(opts: CtxMockOptions = {}) {
  const requestDeviceAssignment = vi.fn((serial: string, _tenant: string) => {
    if (opts.claimRejectFor === serial) {
      return {
        ok: false as const,
        reason: 'already_claimed' as const,
        current_tenant: 'other',
        current_plugin: 'other-plugin',
      }
    }
    return { ok: true as const }
  })
  const releaseDeviceAssignment = vi.fn(() => ({ ok: true as const }))
  const assertSenderInTenant = vi.fn((phone: string, _tenant: string) => {
    if (opts.assertRejectFor === phone) {
      return {
        ok: false as const,
        reason: 'conflicting_tenant' as const,
        current_tenant: 'other-sdr',
      }
    }
    if (opts.assertNotFoundFor === phone) {
      return { ok: false as const, reason: 'phone_not_found' as const }
    }
    return { ok: true as const }
  })
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }

  const ctx: Partial<PluginContext> = {
    requestDeviceAssignment,
    releaseDeviceAssignment,
    assertSenderInTenant,
    logger,
  }
  return {
    ctx: ctx as PluginContext,
    requestDeviceAssignment,
    releaseDeviceAssignment,
    assertSenderInTenant,
    logger,
  }
}

describe('DebtSdrPlugin', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    // The plugin's preflight reads from sender_mapping; minimal stub for tests.
    db.prepare(`
      CREATE TABLE sender_mapping (
        id TEXT PRIMARY KEY,
        phone_number TEXT NOT NULL UNIQUE,
        device_serial TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        tenant TEXT
      )
    `).run()
  })

  afterEach(() => {
    db.close()
  })

  it('parses valid config in the constructor', () => {
    expect(() => new DebtSdrPlugin('http://localhost/x', validRawConfig(), db)).not.toThrow()
  })

  it('throws on invalid config in the constructor', () => {
    const bad = validRawConfig() as { tenants: { devices: string[] }[] }
    bad.tenants[0].devices = []
    expect(() => new DebtSdrPlugin('http://localhost/x', bad, db)).toThrow()
  })

  it('init claims every device and asserts every sender', async () => {
    const plugin = new DebtSdrPlugin('http://localhost/x', validRawConfig(), db)
    const m = makeCtx()
    await plugin.init(m.ctx)

    expect(m.requestDeviceAssignment).toHaveBeenCalledWith('devA', 'oralsin-sdr')
    expect(m.requestDeviceAssignment).toHaveBeenCalledWith('devB', 'sicoob-sdr')
    expect(m.assertSenderInTenant).toHaveBeenCalledWith('554399000001', 'oralsin-sdr')
    expect(m.assertSenderInTenant).toHaveBeenCalledWith('554399000002', 'sicoob-sdr')
    expect(plugin.getClaimedDevices()).toEqual([
      { serial: 'devA', tenant: 'oralsin-sdr' },
      { serial: 'devB', tenant: 'sicoob-sdr' },
    ])
  })

  it('init runs SDR migrations (creates sdr_lead_queue)', async () => {
    const plugin = new DebtSdrPlugin('http://localhost/x', validRawConfig(), db)
    await plugin.init(makeCtx().ctx)

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'sdr_%'")
      .all()
      .map((r) => (r as { name: string }).name)
    expect(tables).toContain('sdr_lead_queue')
    expect(tables).toContain('sdr_sequence_state')
  })

  it('init throws and releases partial claims when a device is already claimed', async () => {
    const plugin = new DebtSdrPlugin('http://localhost/x', validRawConfig(), db)
    const m = makeCtx({ claimRejectFor: 'devB' })

    await expect(plugin.init(m.ctx)).rejects.toThrow(/cannot claim device devB/)
    // devA was claimed before devB failed; rollback must release it.
    expect(m.releaseDeviceAssignment).toHaveBeenCalledWith('devA')
    expect(plugin.getClaimedDevices()).toEqual([])
  })

  it('init throws and releases when a sender has conflicting tenant', async () => {
    const plugin = new DebtSdrPlugin('http://localhost/x', validRawConfig(), db)
    const m = makeCtx({ assertRejectFor: '554399000002' })

    await expect(plugin.init(m.ctx)).rejects.toThrow(/sender 554399000002.*already owned/)
    // Both devices were claimed before the second tenant's sender check failed.
    expect(m.releaseDeviceAssignment).toHaveBeenCalledWith('devA')
    expect(m.releaseDeviceAssignment).toHaveBeenCalledWith('devB')
  })

  it('init throws when a sender has no row in sender_mapping (operator must seed)', async () => {
    const plugin = new DebtSdrPlugin('http://localhost/x', validRawConfig(), db)
    const m = makeCtx({ assertNotFoundFor: '554399000001' })

    await expect(plugin.init(m.ctx)).rejects.toThrow(/no row in sender_mapping/)
  })

  it('preflight rejects when target device already has a cross-tenant sender (A9)', async () => {
    // Seed a sender on devA owned by sicoob-sdr; oralsin-sdr should refuse devA.
    db.prepare(
      `INSERT INTO sender_mapping (id, phone_number, device_serial, tenant) VALUES (?, ?, ?, ?)`,
    ).run('sm1', '554399000999', 'devA', 'sicoob-sdr')

    const plugin = new DebtSdrPlugin('http://localhost/x', validRawConfig(), db)

    await expect(plugin.init(makeCtx().ctx)).rejects.toThrow(/cross-tenant senders/)
  })

  it('destroy releases all claimed devices', async () => {
    const plugin = new DebtSdrPlugin('http://localhost/x', validRawConfig(), db)
    const m = makeCtx()
    await plugin.init(m.ctx)
    await plugin.destroy()

    expect(m.releaseDeviceAssignment).toHaveBeenCalledWith('devA')
    expect(m.releaseDeviceAssignment).toHaveBeenCalledWith('devB')
    expect(plugin.getClaimedDevices()).toEqual([])
  })

  it('destroy without init is a no-op', async () => {
    const plugin = new DebtSdrPlugin('http://localhost/x', validRawConfig(), db)
    await expect(plugin.destroy()).resolves.not.toThrow()
  })

  it('destroy is idempotent', async () => {
    const plugin = new DebtSdrPlugin('http://localhost/x', validRawConfig(), db)
    await plugin.init(makeCtx().ctx)
    await plugin.destroy()
    await expect(plugin.destroy()).resolves.not.toThrow()
  })

  it('getConfig returns the parsed config', () => {
    const plugin = new DebtSdrPlugin('http://localhost/x', validRawConfig(), db)
    const cfg: SdrPluginConfig = plugin.getConfig()
    expect(cfg.tenants).toHaveLength(2)
    expect(cfg.tenants[0].name).toBe('oralsin-sdr')
  })
})
