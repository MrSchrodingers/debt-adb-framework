export type TenantId = 'adb' | 'sicoob' | 'oralsin'
export type TenantMode = 'prov' | 'raw'

export interface TenantWriteback {
  invalidate: boolean
  localize: boolean
  pipedriveNote: boolean
  pipedriveActivity: boolean
}

export interface TenantConfig {
  id: TenantId
  label: string
  mode: TenantMode
  restBaseUrl: string
  restApiKey: string
  restTimeoutMs?: number
  defaultPipelineId?: number
  defaultStageId?: number
  pipedrive?: {
    apiToken: string
    companyDomain?: string
  }
  writeback: TenantWriteback
}

export class TenantConfigError extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = 'TenantConfigError'
  }
}

const TENANT_LABELS: Record<TenantId, string> = {
  adb: 'ADB/Debt',
  sicoob: 'Sicoob',
  oralsin: 'Oralsin',
}

const TENANT_MODES: Record<TenantId, TenantMode> = {
  adb: 'prov',
  sicoob: 'raw',
  oralsin: 'raw',
}

const WRITEBACK_BY_MODE: Record<TenantMode, TenantWriteback> = {
  prov: { invalidate: true, localize: true, pipedriveNote: true, pipedriveActivity: true },
  raw: { invalidate: false, localize: false, pipedriveNote: true, pipedriveActivity: true },
}

function reqEnv(env: NodeJS.ProcessEnv, key: string, tenantId: TenantId): string {
  const v = env[key]
  if (!v || v.trim() === '') {
    throw new TenantConfigError(`tenant=${tenantId}: missing env ${key}`)
  }
  return v
}

function optEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const v = env[key]
  return v && v.trim() !== '' ? v : undefined
}

function parseInt32(s: string | undefined, label: string, tenantId: TenantId): number | undefined {
  if (!s) return undefined
  const n = Number(s)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new TenantConfigError(`tenant=${tenantId}: invalid integer for ${label}: ${s}`)
  }
  return n
}

export class TenantRegistry {
  private tenants: TenantConfig[]
  private byId: Map<TenantId, TenantConfig>

  private constructor(tenants: TenantConfig[]) {
    this.tenants = tenants
    this.byId = new Map(tenants.map((t) => [t.id, t]))
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): TenantRegistry {
    const raw = env.PLUGIN_ADB_PRECHECK_TENANTS
    if (!raw || raw.trim() === '') {
      // Back-compat: legacy single-tenant deployments default to adb-only.
      return new TenantRegistry([buildAdbFromLegacyEnv(env)])
    }
    const ids = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    const seen = new Set<string>()
    const tenants: TenantConfig[] = []
    for (const id of ids) {
      if (!isTenantId(id)) {
        throw new TenantConfigError(`unknown tenant id in PLUGIN_ADB_PRECHECK_TENANTS: ${id}`)
      }
      if (seen.has(id)) {
        throw new TenantConfigError(`duplicate tenant id: ${id}`)
      }
      seen.add(id)
      tenants.push(id === 'adb' ? buildAdbFromLegacyEnv(env) : buildSuffixedTenant(env, id))
    }
    return new TenantRegistry(tenants)
  }

  list(): TenantConfig[] {
    return [...this.tenants]
  }

  get(id: TenantId): TenantConfig {
    const t = this.byId.get(id)
    if (!t) throw new TenantConfigError(`tenant not configured: ${id}`)
    return t
  }

  has(id: TenantId): boolean {
    return this.byId.has(id)
  }
}

function isTenantId(s: string): s is TenantId {
  return s === 'adb' || s === 'sicoob' || s === 'oralsin'
}

function buildAdbFromLegacyEnv(env: NodeJS.ProcessEnv): TenantConfig {
  return {
    id: 'adb',
    label: TENANT_LABELS.adb,
    mode: TENANT_MODES.adb,
    restBaseUrl: reqEnv(env, 'PLUGIN_ADB_PRECHECK_REST_BASE_URL', 'adb'),
    restApiKey: reqEnv(env, 'PLUGIN_ADB_PRECHECK_REST_API_KEY', 'adb'),
    restTimeoutMs: parseInt32(env.PLUGIN_ADB_PRECHECK_REST_TIMEOUT_MS, 'REST_TIMEOUT_MS', 'adb'),
    pipedrive: env.PIPEDRIVE_API_TOKEN
      ? {
          apiToken: env.PIPEDRIVE_API_TOKEN,
          companyDomain: optEnv(env, 'PIPEDRIVE_COMPANY_DOMAIN'),
        }
      : undefined,
    writeback: WRITEBACK_BY_MODE.prov,
  }
}

function buildSuffixedTenant(env: NodeJS.ProcessEnv, id: TenantId): TenantConfig {
  const u = id.toUpperCase()
  return {
    id,
    label: TENANT_LABELS[id],
    mode: TENANT_MODES[id],
    restBaseUrl: reqEnv(env, `PLUGIN_ADB_PRECHECK_REST_BASE_URL_${u}`, id),
    restApiKey: reqEnv(env, `PLUGIN_ADB_PRECHECK_REST_API_KEY_${u}`, id),
    restTimeoutMs: parseInt32(env[`PLUGIN_ADB_PRECHECK_REST_TIMEOUT_MS_${u}`], `REST_TIMEOUT_MS_${u}`, id),
    defaultPipelineId: parseInt32(env[`PLUGIN_ADB_PRECHECK_PIPELINE_ID_${u}`], `PIPELINE_ID_${u}`, id),
    defaultStageId: parseInt32(env[`PLUGIN_ADB_PRECHECK_STAGE_ID_${u}`], `STAGE_ID_${u}`, id),
    pipedrive: env[`PLUGIN_ADB_PRECHECK_PIPEDRIVE_TOKEN_${u}`]
      ? {
          apiToken: env[`PLUGIN_ADB_PRECHECK_PIPEDRIVE_TOKEN_${u}`]!,
          companyDomain: optEnv(env, `PLUGIN_ADB_PRECHECK_PIPEDRIVE_DOMAIN_${u}`),
        }
      : undefined,
    writeback: WRITEBACK_BY_MODE[TENANT_MODES[id]],
  }
}
