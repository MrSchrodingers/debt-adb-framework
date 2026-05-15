import { describe, it, expect } from 'vitest'
import { sdrPluginConfigSchema, loadSdrPluginConfig } from './tenant-config.js'

function validTenant(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    name: 'oralsin-sdr',
    label: 'Oralsin',
    pipeboard_tenant: 'oralsin',
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
    devices: ['863d00583048303634510c7e48da4c'],
    senders: [
      { phone: '554399000001', app: 'com.whatsapp' },
      { phone: '554399000002', app: 'com.whatsapp.w4b' },
    ],
    sequence_id: 'oralsin-cold-v1',
    throttle: {
      per_sender_daily_max: 40,
      min_interval_minutes: 8,
      operating_hours: { start: '09:00', end: '18:00' },
      tz: 'America/Sao_Paulo',
    },
    identity_gate: {
      enabled: true,
      nudge_after_hours: 48,
      abort_after_hours: 96,
    },
    ...overrides,
  }
}

function validConfig() {
  return {
    tenants: [
      validTenant(),
      {
        ...validTenant({
          name: 'sicoob-sdr',
          label: 'Sicoob',
          pipeboard_tenant: 'tenant_sicoob',
        }),
        pipedrive: {
          ...validTenant().pipedrive,
          domain: 'sicoob-xyz',
          api_token_env: 'PIPEDRIVE_TOKEN_SICOOB_SDR',
        },
        devices: ['R9QT804RWDN'],
        senders: [
          { phone: '5543984016805', app: 'com.whatsapp' as const },
          { phone: '5543984330739', app: 'com.whatsapp.w4b' as const },
        ],
        sequence_id: 'sicoob-cold-v1',
      },
    ],
  }
}

describe('SDR tenant config validator', () => {
  it('accepts a complete valid config (oralsin + sicoob)', () => {
    expect(() => loadSdrPluginConfig(validConfig())).not.toThrow()
  })

  it('rejects an empty tenants array', () => {
    expect(() => loadSdrPluginConfig({ tenants: [] })).toThrow(/at least one tenant/)
  })

  it('rejects a phone that is not BR digits-only', () => {
    const cfg = validConfig()
    cfg.tenants[0].senders[0].phone = '+55-43-9999-0001'
    expect(() => loadSdrPluginConfig(cfg)).toThrow(/digits-only/)
  })

  it('rejects an unknown app value', () => {
    const cfg = validConfig() as { tenants: { senders: { phone: string; app: string }[] }[] }
    cfg.tenants[0].senders[0].app = 'com.whatsapp.business' // not in enum
    expect(() => loadSdrPluginConfig(cfg)).toThrow()
  })

  it('rejects operating_hours where start >= end', () => {
    const cfg = validConfig()
    cfg.tenants[0].throttle.operating_hours = { start: '18:00', end: '09:00' }
    expect(() => loadSdrPluginConfig(cfg)).toThrow(/start must be strictly less than end/)
  })

  it('rejects identity_gate.abort_after_hours <= nudge_after_hours', () => {
    const cfg = validConfig()
    cfg.tenants[0].identity_gate = { enabled: true, nudge_after_hours: 96, abort_after_hours: 48 }
    expect(() => loadSdrPluginConfig(cfg)).toThrow(/abort_after_hours must be > nudge_after_hours/)
  })

  it('rejects duplicate tenant names', () => {
    const cfg = validConfig()
    cfg.tenants[1].name = cfg.tenants[0].name
    expect(() => loadSdrPluginConfig(cfg)).toThrow(/duplicate tenant name/)
  })

  it('rejects a device claimed by two tenants (I1)', () => {
    const cfg = validConfig()
    cfg.tenants[1].devices = cfg.tenants[0].devices.slice()
    expect(() => loadSdrPluginConfig(cfg)).toThrow(/already claimed by tenant/)
  })

  it('rejects a (phone, app) reused across tenants (I3)', () => {
    const cfg = validConfig()
    cfg.tenants[1].senders[0] = { ...cfg.tenants[0].senders[0] }
    expect(() => loadSdrPluginConfig(cfg)).toThrow(/sender .* already claimed/)
  })

  it('rejects api_token_env reused across tenants (token sharing)', () => {
    const cfg = validConfig()
    cfg.tenants[1].pipedrive.api_token_env = cfg.tenants[0].pipedrive.api_token_env
    expect(() => loadSdrPluginConfig(cfg)).toThrow(/token sharing is forbidden/)
  })

  it('rejects api_token_env with lowercase letters', () => {
    const cfg = validConfig()
    cfg.tenants[0].pipedrive.api_token_env = 'pipedrive_token_oralsin'
    expect(() => loadSdrPluginConfig(cfg)).toThrow(/UPPER_SNAKE_CASE/)
  })

  it('rejects sequence_id not ending with -v<N>', () => {
    const cfg = validConfig()
    cfg.tenants[0].sequence_id = 'oralsin-cold'
    expect(() => loadSdrPluginConfig(cfg)).toThrow()
  })

  it('exposes sdrPluginConfigSchema for safeParse use', () => {
    const r = sdrPluginConfigSchema.safeParse(validConfig())
    expect(r.success).toBe(true)
  })
})
