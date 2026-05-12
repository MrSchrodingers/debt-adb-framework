import type {
  GeoAggregation, GeoDrillResult, GeoQueryParams,
  GeoViewDefinition, GeoViewSummary, GeoViewsResponse,
} from './types.js'

interface CacheEntry {
  payload: GeoAggregation
  expiresAt: number
}

export interface GeoViewRegistryOptions {
  cacheTtlMs?: number
  cacheMaxEntries?: number
  aggregateTimeoutMs?: number
  drillTimeoutMs?: number
}

export class RegistryError extends Error {
  constructor(
    public readonly code: 'view_not_found' | 'plugin_aggregate_failed' | 'plugin_drill_failed',
    detail: string,
  ) {
    super(`${code}: ${detail}`)
    this.name = 'RegistryError'
  }
}

export class GeoViewRegistry {
  private views = new Map<string, { pluginName: string; view: GeoViewDefinition }>()
  private cache = new Map<string, CacheEntry>()
  private readonly cacheTtlMs: number
  private readonly cacheMaxEntries: number
  private readonly aggregateTimeoutMs: number
  private readonly drillTimeoutMs: number

  constructor(opts: GeoViewRegistryOptions = {}) {
    this.cacheTtlMs = opts.cacheTtlMs ?? 60_000
    this.cacheMaxEntries = opts.cacheMaxEntries ?? 256
    this.aggregateTimeoutMs = opts.aggregateTimeoutMs ?? 5_000
    this.drillTimeoutMs = opts.drillTimeoutMs ?? 8_000
  }

  register(pluginName: string, view: GeoViewDefinition): void {
    const prefix = `${pluginName}.`
    if (!view.id.startsWith(prefix)) {
      throw new Error(`GeoView id "${view.id}" must start with "${prefix}"`)
    }
    if (this.views.has(view.id)) {
      throw new Error(`GeoView "${view.id}" already registered`)
    }
    const groupFilled = view.group && view.group.length > 0 ? view.group : pluginName
    this.views.set(view.id, { pluginName, view: { ...view, group: groupFilled } })
  }

  unregisterPlugin(pluginName: string): void {
    for (const [id, { pluginName: p }] of this.views) {
      if (p === pluginName) {
        this.views.delete(id)
        this.invalidate(id)
      }
    }
  }

  get(viewId: string): GeoViewDefinition | null {
    return this.views.get(viewId)?.view ?? null
  }

  list(): GeoViewDefinition[] {
    return [...this.views.values()].map(v => v.view)
  }

  listSummary(opts: { statusByPlugin: Record<string, 'active' | 'error' | 'disabled'> }): GeoViewsResponse {
    const views: GeoViewSummary[] = []
    const groupsMap = new Map<string, { name: string; label: string; viewIds: string[] }>()
    for (const { pluginName, view } of this.views.values()) {
      const pluginStatus = opts.statusByPlugin[pluginName] ?? 'active'
      views.push({
        id: view.id, label: view.label, description: view.description,
        group: view.group, palette: view.palette, filters: view.filters,
        pluginName, pluginStatus,
      })
      if (!groupsMap.has(view.group)) {
        groupsMap.set(view.group, { name: view.group, label: view.group, viewIds: [] })
      }
      groupsMap.get(view.group)!.viewIds.push(view.id)
    }
    return {
      views, groups: [...groupsMap.values()],
      generatedAt: new Date().toISOString(),
    }
  }

  async runAggregate(viewId: string, params: GeoQueryParams): Promise<GeoAggregation> {
    const entry = this.views.get(viewId)
    if (!entry) throw new RegistryError('view_not_found', `viewId="${viewId}"`)
    const cacheKey = `${viewId}::${hashParams(params)}`
    const now = Date.now()
    const cached = this.cache.get(cacheKey)
    if (cached && cached.expiresAt > now) return cached.payload
    try {
      const payload = await withTimeout(
        entry.view.aggregate(params),
        this.aggregateTimeoutMs, 'aggregate_timeout',
      )
      this.setCache(cacheKey, payload)
      return payload
    } catch (err) {
      throw new RegistryError(
        'plugin_aggregate_failed',
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  async runDrill(viewId: string, ddd: string, params: GeoQueryParams): Promise<GeoDrillResult> {
    const entry = this.views.get(viewId)
    if (!entry) throw new RegistryError('view_not_found', `viewId="${viewId}"`)
    try {
      return await withTimeout(
        entry.view.drill(ddd, params),
        this.drillTimeoutMs, 'drill_timeout',
      )
    } catch (err) {
      throw new RegistryError(
        'plugin_drill_failed',
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  invalidate(viewId: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${viewId}::`)) this.cache.delete(key)
    }
  }

  private setCache(key: string, payload: GeoAggregation): void {
    if (this.cache.size >= this.cacheMaxEntries) {
      const oldestKey = this.cache.keys().next().value
      if (oldestKey) this.cache.delete(oldestKey)
    }
    this.cache.set(key, { payload, expiresAt: Date.now() + this.cacheTtlMs })
  }
}

function hashParams(params: GeoQueryParams): string {
  const keys = Object.keys(params.filters).sort()
  const filterStr = keys.map(k => `${k}=${params.filters[k]}`).join('|')
  return `${params.window}::${filterStr}::p${params.page ?? 1}::ps${params.pageSize ?? 50}`
}

async function withTimeout<T>(p: Promise<T>, ms: number, code: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(code)), ms)
    p.then(v => { clearTimeout(t); resolve(v) }, e => { clearTimeout(t); reject(e) })
  })
}
