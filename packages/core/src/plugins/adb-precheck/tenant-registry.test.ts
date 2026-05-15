import { describe, it, expect } from 'vitest'
import { TenantRegistry, TenantConfigError } from './tenant-registry.js'

describe('TenantRegistry.fromEnv', () => {
  it('loads adb tenant from unsuffixed env vars (back-compat)', () => {
    const r = TenantRegistry.fromEnv({
      PLUGIN_ADB_PRECHECK_TENANTS: 'adb',
      PLUGIN_ADB_PRECHECK_REST_BASE_URL: 'http://router/api/v1/adb',
      PLUGIN_ADB_PRECHECK_REST_API_KEY: 'k_adb',
    })
    const adb = r.get('adb')
    expect(adb.id).toBe('adb')
    expect(adb.mode).toBe('prov')
    expect(adb.restBaseUrl).toBe('http://router/api/v1/adb')
    expect(adb.writeback.invalidate).toBe(true)
  })

  it('loads sicoob with suffixed vars and raw mode', () => {
    const r = TenantRegistry.fromEnv({
      PLUGIN_ADB_PRECHECK_TENANTS: 'adb,sicoob',
      PLUGIN_ADB_PRECHECK_REST_BASE_URL: 'http://r/api/v1/adb',
      PLUGIN_ADB_PRECHECK_REST_API_KEY: 'k_adb',
      PLUGIN_ADB_PRECHECK_REST_BASE_URL_SICOOB: 'http://r/api/v1/sicoob',
      PLUGIN_ADB_PRECHECK_REST_API_KEY_SICOOB: 'k_sicoob',
      PLUGIN_ADB_PRECHECK_PIPELINE_ID_SICOOB: '14',
      PLUGIN_ADB_PRECHECK_STAGE_ID_SICOOB: '110',
      PLUGIN_ADB_PRECHECK_PIPEDRIVE_TOKEN_SICOOB: 'pd_sicoob',
    })
    const s = r.get('sicoob')
    expect(s.mode).toBe('raw')
    expect(s.defaultPipelineId).toBe(14)
    expect(s.defaultStageId).toBe(110)
    expect(s.writeback.invalidate).toBe(false)
    expect(s.writeback.localize).toBe(false)
    expect(s.writeback.pipedriveNote).toBe(true)
    expect(s.writeback.pipedriveActivity).toBe(true)
    expect(s.pipedrive?.apiToken).toBe('pd_sicoob')
  })

  it('throws when a declared tenant has missing required vars', () => {
    expect(() =>
      TenantRegistry.fromEnv({
        PLUGIN_ADB_PRECHECK_TENANTS: 'adb,sicoob',
        PLUGIN_ADB_PRECHECK_REST_BASE_URL: 'x',
        PLUGIN_ADB_PRECHECK_REST_API_KEY: 'y',
      }),
    ).toThrow(TenantConfigError)
  })

  it('list() returns tenants in declared order', () => {
    const r = TenantRegistry.fromEnv({
      PLUGIN_ADB_PRECHECK_TENANTS: 'adb',
      PLUGIN_ADB_PRECHECK_REST_BASE_URL: 'x',
      PLUGIN_ADB_PRECHECK_REST_API_KEY: 'y',
    })
    expect(r.list().map((t) => t.id)).toEqual(['adb'])
  })

  it('has() returns false for undeclared tenant', () => {
    const r = TenantRegistry.fromEnv({
      PLUGIN_ADB_PRECHECK_TENANTS: 'adb',
      PLUGIN_ADB_PRECHECK_REST_BASE_URL: 'x',
      PLUGIN_ADB_PRECHECK_REST_API_KEY: 'y',
    })
    expect(r.has('adb')).toBe(true)
    expect(r.has('sicoob' as never)).toBe(false)
  })
})
