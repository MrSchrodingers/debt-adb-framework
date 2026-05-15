import { describe, it, expect } from 'vitest'
import { TenantRegistry } from './adb-precheck/tenant-registry.js'

describe('AdbPrecheckPlugin route /tenants', () => {
  it('lists configured tenants without leaking secrets', async () => {
    const registry = TenantRegistry.fromEnv({
      PLUGIN_ADB_PRECHECK_TENANTS: 'adb,sicoob',
      PLUGIN_ADB_PRECHECK_REST_BASE_URL: 'http://r/api/v1/adb',
      PLUGIN_ADB_PRECHECK_REST_API_KEY: 'secret_adb',
      PLUGIN_ADB_PRECHECK_REST_BASE_URL_SICOOB: 'http://r/api/v1/sicoob',
      PLUGIN_ADB_PRECHECK_REST_API_KEY_SICOOB: 'secret_sicoob',
      PLUGIN_ADB_PRECHECK_PIPELINE_ID_SICOOB: '14',
      PLUGIN_ADB_PRECHECK_STAGE_ID_SICOOB: '110',
      PLUGIN_ADB_PRECHECK_PIPEDRIVE_TOKEN_SICOOB: 'pd_sicoob',
    })
    // Sanitized response shape: tenant id, label, mode, defaultPipelineId, defaultStageId, writeback flags, no tokens or URLs
    const sanitized = registry.list().map((t) => ({
      id: t.id,
      label: t.label,
      mode: t.mode,
      defaultPipelineId: t.defaultPipelineId,
      defaultStageId: t.defaultStageId,
      writeback: t.writeback,
      pipedriveEnabled: Boolean(t.pipedrive?.apiToken),
    }))
    expect(sanitized).toHaveLength(2)
    expect(sanitized[0].id).toBe('adb')
    expect(sanitized[1]).toMatchObject({ id: 'sicoob', mode: 'raw', defaultPipelineId: 14, defaultStageId: 110, pipedriveEnabled: true })
    expect(JSON.stringify(sanitized)).not.toContain('secret_')
    expect(JSON.stringify(sanitized)).not.toContain('pd_sicoob')
  })
})
