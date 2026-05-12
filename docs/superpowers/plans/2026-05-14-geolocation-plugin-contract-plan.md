# Geolocalização (plugin-first) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Geolocalização" tab to Dispatch UI that renders a Brazilian choropleth map by DDD. Plugins contribute their own views via `ctx.registerGeoView(...)`; core hosts only the map framework + topology + delegation endpoints + dynamic tabs UI. Core works with zero plugins.

**Architecture:** Plugin-first. Core exposes `GeoViewRegistry` and 3 generic REST endpoints (`/api/v1/geo/views`, `/api/v1/geo/views/:id/aggregate`, `/api/v1/geo/views/:id/drill`). Each plugin registers `GeoViewDefinition`s on `init()` with `aggregate(params)` and `drill(ddd, params)` callbacks. Frontend discovers views dynamically and renders dynamic tabs. Rendering uses deck.gl GeoJsonLayer (choropleth via fill color, base map=null, zero token).

**Tech Stack:** TypeScript, Fastify, Vitest, React 19, Vite, deck.gl 9.x, d3-scale-chromatic, topojson-client. SQLite (existing). better-sqlite3 expressional indexes.

**Spec:** `docs/superpowers/specs/2026-05-14-geolocation-plugin-contract-design.md`

**Phases:**
- **A. Backend core** — Tasks 1–7 (DDD util, registry, validator, API, server wiring, indices)
- **B. Plugin contributions** — Tasks 8–12 (4 views + smoke)
- **C. Frontend foundation** — Tasks 13–17 (deps, topology asset, types, BrazilMap, FilterBar)
- **D. Frontend assembly** — Tasks 18–24 (legend, drill, panel, tabs, page, sidebar wiring)
- **E. Deploy + gates** — Tasks 25–30

Frequent commits: 1 commit per task (or per logical unit within task), all on `main`.

---

## FASE A — Backend core

### Task 1: DDD extractor utility

**Files:**
- Create: `packages/core/src/util/ddd.ts`
- Create: `packages/core/src/util/ddd.test.ts`
- Modify: `packages/core/src/validator/br-phone-resolver.ts` (export VALID_BR_DDDS)

- [ ] **Step 1: Export `VALID_BR_DDDS` from existing resolver**

In `packages/core/src/validator/br-phone-resolver.ts` line 19, change the `const VALID_BR_DDDS = new Set([...])` to `export const VALID_BR_DDDS = new Set([...])`. Same content.

- [ ] **Step 2: Write failing tests for `extractDdd`**

Create `packages/core/src/util/ddd.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { extractDdd } from './ddd.js'

describe('extractDdd', () => {
  it('returns DDD from 13-digit phone with country code', () => {
    expect(extractDdd('5511987654321')).toBe('11')
  })

  it('returns DDD from 12-digit phone with country code (landline)', () => {
    expect(extractDdd('551133334444')).toBe('11')
  })

  it('returns DDD from 11-digit phone without country code', () => {
    expect(extractDdd('11987654321')).toBe('11')
  })

  it('returns DDD from 10-digit phone without country code (landline, no 9)', () => {
    expect(extractDdd('1133334444')).toBe('11')
  })

  it('returns null for invalid DDD (not in BR allocation)', () => {
    expect(extractDdd('5520987654321')).toBeNull()
  })

  it('returns null for phone shorter than 10 digits after strip', () => {
    expect(extractDdd('123456')).toBeNull()
  })

  it('handles +, spaces and hyphens', () => {
    expect(extractDdd('+55 (11) 98765-4321')).toBe('11')
  })

  it('returns null for empty string', () => {
    expect(extractDdd('')).toBeNull()
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd /var/www/adb_tools && pnpm --filter @dispatch/core test src/util/ddd.test.ts`
Expected: FAIL — `Cannot find module './ddd.js'`.

- [ ] **Step 4: Implement `extractDdd`**

Create `packages/core/src/util/ddd.ts`:

```ts
import { VALID_BR_DDDS } from '../validator/br-phone-resolver.js'

export { VALID_BR_DDDS }

/**
 * Idempotent DDD extractor. Handles 13-digit (55+DDD+9+8digits), 12-digit
 * (55+DDD+8digits landline), 11-digit (DDD+9+8digits without country code),
 * and 10-digit (DDD+8digits without country code) BR phone formats.
 */
export function extractDdd(phone: string): string | null {
  const digits = phone.replace(/\D/g, '')
  const stripped = digits.startsWith('55') && digits.length >= 12 ? digits.slice(2) : digits
  if (stripped.length < 10) return null
  const ddd = stripped.slice(0, 2)
  return VALID_BR_DDDS.has(ddd) ? ddd : null
}
```

- [ ] **Step 5: Run tests + commit**

```bash
pnpm --filter @dispatch/core test src/util/ddd.test.ts
git add packages/core/src/util/ddd.ts packages/core/src/util/ddd.test.ts packages/core/src/validator/br-phone-resolver.ts
git commit -m "feat(geo): extractDdd utility — 11/12/13-digit BR phone support"
```

---

### Task 2: GeoView types

**Files:**
- Create: `packages/core/src/geo/types.ts`

- [ ] **Step 1: Create types file**

```ts
/**
 * Geographic visualization framework — types only.
 * Plugins register GeoViewDefinition via PluginContext.registerGeoView.
 */

export type GeoPalette = 'sequential' | 'diverging' | 'rate'
export type GeoWindow = '24h' | '7d' | '30d' | 'all'

export interface GeoWindowFilterSpec {
  type: 'window'
  id: string
  defaultValue: '24h' | '7d' | '30d'
  options: GeoWindow[]
}

export interface GeoSelectFilterSpec {
  type: 'select'
  id: string
  label: string
  defaultValue: string
  options: Array<{ value: string; label: string }>
}

export type GeoFilterSpec = GeoWindowFilterSpec | GeoSelectFilterSpec

export interface GeoQueryParams {
  window: GeoWindow
  filters: Record<string, string>
  page?: number
  pageSize?: number
}

export interface GeoAggregation {
  buckets: Record<string, number>
  total: number
  generatedAt: string
}

export interface GeoDrillColumn {
  key: string
  label: string
  type?: 'date' | 'number' | 'string' | 'phone'
}

export interface GeoDrillResult {
  columns: GeoDrillColumn[]
  rows: Array<Record<string, unknown>>
  total: number
  page: number
  pageSize: number
}

export interface GeoViewDefinition {
  id: string
  label: string
  description?: string
  group: string
  palette: GeoPalette
  filters: GeoFilterSpec[]
  aggregate(params: GeoQueryParams): Promise<GeoAggregation>
  drill(ddd: string, params: GeoQueryParams): Promise<GeoDrillResult>
}

export interface GeoViewSummary {
  id: string
  label: string
  description?: string
  group: string
  palette: GeoPalette
  filters: GeoFilterSpec[]
  pluginName: string
  pluginStatus: 'active' | 'error' | 'disabled'
}

export interface GeoViewsResponse {
  views: GeoViewSummary[]
  groups: Array<{ name: string; label: string; viewIds: string[] }>
  generatedAt: string
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/core/src/geo/types.ts
git commit -m "feat(geo): GeoView types — definition, query params, response shapes"
```

---

### Task 3: GeoViewRegistry with LRU cache

**Files:**
- Create: `packages/core/src/geo/registry.ts`
- Create: `packages/core/src/geo/registry.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/core/src/geo/registry.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { GeoViewRegistry } from './registry.js'
import type { GeoViewDefinition, GeoAggregation } from './types.js'

const makeView = (overrides: Partial<GeoViewDefinition> = {}): GeoViewDefinition => ({
  id: 'oralsin.sends',
  label: 'Envios',
  group: 'oralsin',
  palette: 'sequential',
  filters: [],
  aggregate: vi.fn(async (): Promise<GeoAggregation> => ({
    buckets: { '11': 10 }, total: 10, generatedAt: new Date().toISOString(),
  })),
  drill: vi.fn(async () => ({ columns: [], rows: [], total: 0, page: 1, pageSize: 50 })),
  ...overrides,
})

describe('GeoViewRegistry', () => {
  let registry: GeoViewRegistry
  beforeEach(() => { registry = new GeoViewRegistry({ cacheTtlMs: 60_000 }) })

  it('stores view under id', () => {
    registry.register('oralsin', makeView())
    expect(registry.list()).toHaveLength(1)
  })

  it('rejects view id without plugin prefix', () => {
    expect(() => registry.register('oralsin', makeView({ id: 'sends' })))
      .toThrow(/must start with "oralsin\."/)
  })

  it('rejects duplicate id', () => {
    registry.register('oralsin', makeView())
    expect(() => registry.register('oralsin', makeView()))
      .toThrow(/already registered/)
  })

  it('auto-fills group with pluginName when missing', () => {
    registry.register('oralsin', makeView({ group: '' as unknown as string }))
    expect(registry.list()[0]!.group).toBe('oralsin')
  })

  it('get returns view by id', () => {
    const view = makeView()
    registry.register('oralsin', view)
    expect(registry.get('oralsin.sends')).toBe(view)
  })

  it('get returns null for unknown id', () => {
    expect(registry.get('foo.bar')).toBeNull()
  })

  it('unregisterPlugin removes all views from plugin', () => {
    registry.register('oralsin', makeView({ id: 'oralsin.sends' }))
    registry.register('oralsin', makeView({ id: 'oralsin.failures' }))
    registry.register('adb-precheck', makeView({ id: 'adb-precheck.valid', group: 'adb-precheck' }))
    registry.unregisterPlugin('oralsin')
    expect(registry.list().map(v => v.id)).toEqual(['adb-precheck.valid'])
  })

  it('cache hits return same payload within TTL', async () => {
    const view = makeView()
    registry.register('oralsin', view)
    const params = { window: '7d' as const, filters: {} }
    await registry.runAggregate('oralsin.sends', params)
    await registry.runAggregate('oralsin.sends', params)
    expect(view.aggregate).toHaveBeenCalledTimes(1)
  })

  it('different params bust cache', async () => {
    const view = makeView()
    registry.register('oralsin', view)
    await registry.runAggregate('oralsin.sends', { window: '7d', filters: {} })
    await registry.runAggregate('oralsin.sends', { window: '24h', filters: {} })
    expect(view.aggregate).toHaveBeenCalledTimes(2)
  })

  it('runAggregate throws view_not_found when unknown', async () => {
    await expect(registry.runAggregate('foo.bar', { window: '7d', filters: {} }))
      .rejects.toThrow(/view_not_found/)
  })

  it('wraps plugin errors as plugin_aggregate_failed', async () => {
    const view = makeView({ aggregate: vi.fn().mockRejectedValue(new Error('SQL boom')) })
    registry.register('oralsin', view)
    await expect(registry.runAggregate('oralsin.sends', { window: '7d', filters: {} }))
      .rejects.toThrow(/plugin_aggregate_failed/)
  })

  it('invalidate clears cache for viewId', async () => {
    const view = makeView()
    registry.register('oralsin', view)
    const params = { window: '7d' as const, filters: {} }
    await registry.runAggregate('oralsin.sends', params)
    registry.invalidate('oralsin.sends')
    await registry.runAggregate('oralsin.sends', params)
    expect(view.aggregate).toHaveBeenCalledTimes(2)
  })

  it('listSummary returns grouped response', () => {
    registry.register('oralsin', makeView({ id: 'oralsin.sends', group: 'oralsin' }))
    registry.register('adb-precheck', makeView({ id: 'adb-precheck.valid', group: 'adb-precheck' }))
    const summary = registry.listSummary({ statusByPlugin: { oralsin: 'active', 'adb-precheck': 'active' } })
    expect(summary.views).toHaveLength(2)
    expect(summary.groups).toHaveLength(2)
    expect(summary.groups.find(g => g.name === 'oralsin')!.viewIds).toEqual(['oralsin.sends'])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @dispatch/core test src/geo/registry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `GeoViewRegistry`**

Create `packages/core/src/geo/registry.ts`:

```ts
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
```

- [ ] **Step 4: Run tests + commit**

```bash
pnpm --filter @dispatch/core test src/geo/registry.test.ts
git add packages/core/src/geo/registry.ts packages/core/src/geo/registry.test.ts
git commit -m "feat(geo): GeoViewRegistry with LRU cache, timeouts, plugin isolation"
```

---

### Task 4: Filter validator

**Files:**
- Create: `packages/core/src/geo/filter-validator.ts`
- Create: `packages/core/src/geo/filter-validator.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect } from 'vitest'
import { validateGeoQuery } from './filter-validator.js'
import type { GeoFilterSpec } from './types.js'

const windowSpec: GeoFilterSpec = {
  type: 'window', id: 'window', defaultValue: '7d', options: ['24h', '7d', '30d'],
}
const statusSpec: GeoFilterSpec = {
  type: 'select', id: 'status', label: 'Status', defaultValue: 'sent',
  options: [{ value: 'sent', label: 'Enviadas' }, { value: 'failed', label: 'Falhadas' }],
}

describe('validateGeoQuery', () => {
  it('parses valid query', () => {
    const r = validateGeoQuery({ query: { window: '7d', status: 'sent' }, filterSpecs: [windowSpec, statusSpec] })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.params.filters).toEqual({ status: 'sent' })
  })

  it('applies defaults for missing filters', () => {
    const r = validateGeoQuery({ query: {}, filterSpecs: [windowSpec, statusSpec] })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.params.window).toBe('7d')
      expect(r.params.filters.status).toBe('sent')
    }
  })

  it('rejects invalid window', () => {
    const r = validateGeoQuery({ query: { window: 'foo' }, filterSpecs: [windowSpec] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.field).toBe('window')
  })

  it('rejects select value not in options', () => {
    const r = validateGeoQuery({
      query: { window: '7d', status: 'unknown' },
      filterSpecs: [windowSpec, statusSpec],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.field).toBe('status')
  })

  it('clamps pageSize to cap', () => {
    const r = validateGeoQuery({ query: { window: '7d', pageSize: '500' }, filterSpecs: [windowSpec] })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.params.pageSize).toBe(200)
  })

  it('rejects page < 1', () => {
    const r = validateGeoQuery({ query: { window: '7d', page: '0' }, filterSpecs: [windowSpec] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.field).toBe('page')
  })
})
```

- [ ] **Step 2: Run to fail. Then implement**

Create `packages/core/src/geo/filter-validator.ts`:

```ts
import type { GeoFilterSpec, GeoQueryParams } from './types.js'

export type ValidationResult =
  | { ok: true; params: GeoQueryParams }
  | { ok: false; field: string; reason: string }

const WINDOW_VALUES = new Set(['24h', '7d', '30d', 'all'])

export function validateGeoQuery(opts: {
  query: Record<string, string | undefined>
  filterSpecs: GeoFilterSpec[]
}): ValidationResult {
  const { query, filterSpecs } = opts

  const windowSpec = filterSpecs.find(
    (f): f is Extract<GeoFilterSpec, { type: 'window' }> => f.type === 'window'
  )
  let window: GeoQueryParams['window'] = windowSpec?.defaultValue ?? '7d'
  if (query.window !== undefined) {
    if (!WINDOW_VALUES.has(query.window)) {
      return { ok: false, field: 'window', reason: `value "${query.window}" not allowed` }
    }
    if (windowSpec && !windowSpec.options.includes(query.window as GeoQueryParams['window'])) {
      return { ok: false, field: 'window', reason: `value "${query.window}" not in view options` }
    }
    window = query.window as GeoQueryParams['window']
  }

  const filters: Record<string, string> = {}
  for (const spec of filterSpecs) {
    if (spec.type !== 'select') continue
    const provided = query[spec.id]
    if (provided === undefined) {
      filters[spec.id] = spec.defaultValue
      continue
    }
    const allowed = spec.options.some(o => o.value === provided)
    if (!allowed) {
      return { ok: false, field: spec.id, reason: `value "${provided}" not in options` }
    }
    filters[spec.id] = provided
  }

  let page = 1
  if (query.page !== undefined) {
    const parsed = Number.parseInt(query.page, 10)
    if (!Number.isFinite(parsed) || parsed < 1) {
      return { ok: false, field: 'page', reason: 'must be integer >= 1' }
    }
    page = parsed
  }

  let pageSize = 50
  if (query.pageSize !== undefined) {
    const parsed = Number.parseInt(query.pageSize, 10)
    if (!Number.isFinite(parsed) || parsed < 1) {
      return { ok: false, field: 'pageSize', reason: 'must be integer >= 1' }
    }
    pageSize = Math.min(parsed, 200)
  }

  return { ok: true, params: { window, filters, page, pageSize } }
}
```

- [ ] **Step 3: Run + commit**

```bash
pnpm --filter @dispatch/core test src/geo/filter-validator.test.ts
git add packages/core/src/geo/filter-validator.ts packages/core/src/geo/filter-validator.test.ts
git commit -m "feat(geo): filter-validator with defaults, page caps, type-safe parse"
```

---

### Task 5: PluginContext extension + loader wiring

**Files:**
- Modify: `packages/core/src/plugins/types.ts`
- Modify: `packages/core/src/plugins/plugin-loader.ts`
- Modify: `packages/core/src/plugins/plugin-loader.test.ts`

- [ ] **Step 1: Add `registerGeoView` to `PluginContext`**

In `packages/core/src/plugins/types.ts`, at the top imports, add:

```ts
import type { GeoViewDefinition } from '../geo/types.js'
```

Inside the `PluginContext` interface (after `registerRoute`):

```ts
  /**
   * Register a geographic view. Core hosts /api/v1/geo/views/:id/aggregate
   * and /drill that delegate to view.aggregate/view.drill. View id MUST
   * start with `${plugin.name}.` — loader enforces.
   */
  registerGeoView(view: GeoViewDefinition): void
```

- [ ] **Step 2: Write failing test for loader wiring**

In `packages/core/src/plugins/plugin-loader.test.ts`, add import at top:

```ts
import { GeoViewRegistry } from '../geo/registry.js'
```

Add a `describe` block at end of the file (before final closing brace of outer describe):

```ts
  describe('PluginContext.registerGeoView', () => {
    it('routes registerGeoView through GeoViewRegistry with pluginName', async () => {
      let capturedCtx: PluginContext | null = null
      ;(plugin.init as ReturnType<typeof vi.fn>).mockImplementation(async (ctx: PluginContext) => {
        capturedCtx = ctx
      })
      const geoRegistry = new GeoViewRegistry()
      // Pass geoRegistry to PluginLoader constructor (extra optional arg).
      const loader = makeLoaderWithGeo(geoRegistry)
      await loader.load(plugin)

      capturedCtx!.registerGeoView({
        id: 'test-plugin.demo',
        label: 'Demo', group: 'test-plugin', palette: 'sequential', filters: [],
        aggregate: vi.fn(async () => ({ buckets: {}, total: 0, generatedAt: '' })),
        drill: vi.fn(async () => ({ columns: [], rows: [], total: 0, page: 1, pageSize: 50 })),
      })

      expect(geoRegistry.list()).toHaveLength(1)
      expect(geoRegistry.list()[0]!.id).toBe('test-plugin.demo')
    })

    it('unregisters views on destroy', async () => {
      const geoRegistry = new GeoViewRegistry()
      ;(plugin.init as ReturnType<typeof vi.fn>).mockImplementation(async (ctx: PluginContext) => {
        ctx.registerGeoView({
          id: 'test-plugin.demo', label: 'X', group: 'test-plugin',
          palette: 'sequential', filters: [],
          aggregate: vi.fn(async () => ({ buckets: {}, total: 0, generatedAt: '' })),
          drill: vi.fn(async () => ({ columns: [], rows: [], total: 0, page: 1, pageSize: 50 })),
        })
      })
      const loader = makeLoaderWithGeo(geoRegistry)
      await loader.load(plugin)
      await loader.unload(plugin.name)
      expect(geoRegistry.list()).toHaveLength(0)
    })
  })
```

Add a helper at the top of the file (or before this describe) that builds a `PluginLoader` with the geo registry — exact signature depends on the loader constructor; read it first and adapt `makeLoaderWithGeo`.

- [ ] **Step 3: Run tests to fail. Then wire in `plugin-loader.ts`**

Open `packages/core/src/plugins/plugin-loader.ts`. Add to imports:

```ts
import type { GeoViewRegistry } from '../geo/registry.js'
import type { GeoViewDefinition } from '../geo/types.js'
```

In constructor params, add optional `geoRegistry?: GeoViewRegistry`. Store on instance.

In `createContext(pluginName)`, in the returned object add:

```ts
registerGeoView: (view: GeoViewDefinition) => {
  if (!this.geoRegistry) {
    logger.warn('registerGeoView called but GeoViewRegistry not provided to PluginLoader')
    return
  }
  this.geoRegistry.register(pluginName, view)
},
```

In `unload(name)` (or equivalent destroy path), after `plugin.destroy()`:

```ts
this.geoRegistry?.unregisterPlugin(name)
```

- [ ] **Step 4: Run + commit**

```bash
pnpm --filter @dispatch/core test src/plugins/plugin-loader.test.ts src/geo/
git add packages/core/src/plugins/types.ts packages/core/src/plugins/plugin-loader.ts packages/core/src/plugins/plugin-loader.test.ts
git commit -m "feat(geo): PluginContext.registerGeoView + loader wiring + destroy cleanup"
```

---

### Task 6: Geo REST API routes

**Files:**
- Create: `packages/core/src/api/geo.ts`
- Create: `packages/core/src/api/geo.test.ts`

- [ ] **Step 1: Write failing integration tests**

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerGeoRoutes } from './geo.js'
import { GeoViewRegistry } from '../geo/registry.js'
import type { GeoViewDefinition } from '../geo/types.js'

const API_KEY = 'test-key'

const makeView = (overrides: Partial<GeoViewDefinition> = {}): GeoViewDefinition => ({
  id: 'oralsin.sends', label: 'Envios', group: 'oralsin', palette: 'sequential',
  filters: [
    { type: 'window', id: 'window', defaultValue: '7d', options: ['24h', '7d', '30d'] },
    { type: 'select', id: 'status', label: 'Status', defaultValue: 'sent',
      options: [{ value: 'sent', label: 'Enviadas' }, { value: 'failed', label: 'Falhadas' }] },
  ],
  aggregate: vi.fn(async () => ({ buckets: { '11': 5 }, total: 5, generatedAt: '2026-05-14T00:00:00.000Z' })),
  drill: vi.fn(async () => ({
    columns: [{ key: 'phone', label: 'Phone', type: 'phone' as const }],
    rows: [{ phone: '5511987654321' }], total: 1, page: 1, pageSize: 50,
  })),
  ...overrides,
})

describe('Geo routes', () => {
  let app: FastifyInstance
  let registry: GeoViewRegistry

  beforeEach(async () => {
    app = Fastify()
    registry = new GeoViewRegistry()
    registerGeoRoutes(app, {
      registry, apiKey: API_KEY,
      getPluginStatuses: () => ({ oralsin: 'active', 'adb-precheck': 'active' }),
    })
    await app.ready()
  })

  it('rejects no API key', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/v1/geo/views' })
    expect(r.statusCode).toBe(401)
  })

  it('GET /views with zero plugins returns empty', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/v1/geo/views', headers: { 'x-api-key': API_KEY } })
    expect(r.statusCode).toBe(200)
    expect(r.json().views).toEqual([])
  })

  it('GET /views lists registered views with plugin status', async () => {
    registry.register('oralsin', makeView())
    const r = await app.inject({ method: 'GET', url: '/api/v1/geo/views', headers: { 'x-api-key': API_KEY } })
    expect(r.statusCode).toBe(200)
    expect(r.json().views).toHaveLength(1)
    expect(r.json().views[0].pluginName).toBe('oralsin')
    expect(r.json().views[0].pluginStatus).toBe('active')
  })

  it('GET /views/:id/aggregate returns 404 for unknown view', async () => {
    const r = await app.inject({
      method: 'GET', url: '/api/v1/geo/views/foo.bar/aggregate?window=7d',
      headers: { 'x-api-key': API_KEY },
    })
    expect(r.statusCode).toBe(404)
    expect(r.json().error).toBe('view_not_found')
  })

  it('GET /views/:id/aggregate returns 400 for invalid filter', async () => {
    registry.register('oralsin', makeView())
    const r = await app.inject({
      method: 'GET', url: '/api/v1/geo/views/oralsin.sends/aggregate?window=foo',
      headers: { 'x-api-key': API_KEY },
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().error).toBe('invalid_filter')
  })

  it('GET /views/:id/aggregate calls plugin and returns payload', async () => {
    const view = makeView()
    registry.register('oralsin', view)
    const r = await app.inject({
      method: 'GET', url: '/api/v1/geo/views/oralsin.sends/aggregate?window=7d&status=sent',
      headers: { 'x-api-key': API_KEY },
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().buckets).toEqual({ '11': 5 })
    expect(view.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({ window: '7d', filters: { status: 'sent' } }),
    )
  })

  it('GET /views/:id/aggregate returns 503 when plugin throws', async () => {
    const view = makeView({ aggregate: vi.fn().mockRejectedValue(new Error('boom')) })
    registry.register('oralsin', view)
    const r = await app.inject({
      method: 'GET', url: '/api/v1/geo/views/oralsin.sends/aggregate?window=7d',
      headers: { 'x-api-key': API_KEY },
    })
    expect(r.statusCode).toBe(503)
    expect(r.json().error).toBe('plugin_aggregate_failed')
    expect(r.json().retryable).toBe(true)
  })

  it('GET /views/:id/drill returns 400 for invalid ddd', async () => {
    registry.register('oralsin', makeView())
    const r = await app.inject({
      method: 'GET', url: '/api/v1/geo/views/oralsin.sends/drill?ddd=20&window=7d',
      headers: { 'x-api-key': API_KEY },
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().field).toBe('ddd')
  })

  it('GET /views/:id/drill returns plugin rows', async () => {
    const view = makeView()
    registry.register('oralsin', view)
    const r = await app.inject({
      method: 'GET', url: '/api/v1/geo/views/oralsin.sends/drill?ddd=11&window=7d',
      headers: { 'x-api-key': API_KEY },
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().rows).toEqual([{ phone: '5511987654321' }])
    expect(view.drill).toHaveBeenCalledWith('11', expect.objectContaining({ window: '7d' }))
  })
})
```

- [ ] **Step 2: Run to fail. Then implement**

Create `packages/core/src/api/geo.ts`:

```ts
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { GeoViewRegistry, RegistryError } from '../geo/registry.js'
import { validateGeoQuery } from '../geo/filter-validator.js'
import { VALID_BR_DDDS } from '../util/ddd.js'

export interface GeoRoutesOptions {
  registry: GeoViewRegistry
  apiKey: string
  getPluginStatuses(): Record<string, 'active' | 'error' | 'disabled'>
}

export function registerGeoRoutes(app: FastifyInstance, opts: GeoRoutesOptions): void {
  const { registry, apiKey, getPluginStatuses } = opts

  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith('/api/v1/geo')) return
    const provided = req.headers['x-api-key']
    if (provided !== apiKey) {
      reply.code(401).send({ error: 'unauthorized' })
    }
  })

  app.get('/api/v1/geo/views', async () => {
    return registry.listSummary({ statusByPlugin: getPluginStatuses() })
  })

  app.get('/api/v1/geo/views/:viewId/aggregate', async (req, reply) => {
    const { viewId } = req.params as { viewId: string }
    const view = registry.get(viewId)
    if (!view) { reply.code(404).send({ error: 'view_not_found', viewId }); return }
    const q = normalizeQuery(req.query)
    const result = validateGeoQuery({ query: q, filterSpecs: view.filters })
    if (!result.ok) {
      reply.code(400).send({ error: 'invalid_filter', field: result.field, reason: result.reason })
      return
    }
    try {
      const payload = await registry.runAggregate(viewId, result.params)
      return payload
    } catch (err) {
      if (err instanceof RegistryError && err.code === 'plugin_aggregate_failed') {
        reply.code(503).send({
          error: 'plugin_aggregate_failed', viewId,
          pluginError: err.message, retryable: true,
        })
        return
      }
      throw err
    }
  })

  app.get('/api/v1/geo/views/:viewId/drill', async (req, reply) => {
    const { viewId } = req.params as { viewId: string }
    const view = registry.get(viewId)
    if (!view) { reply.code(404).send({ error: 'view_not_found', viewId }); return }
    const q = normalizeQuery(req.query)
    const ddd = q.ddd
    if (!ddd || !/^\d{2}$/.test(ddd) || !VALID_BR_DDDS.has(ddd)) {
      reply.code(400).send({ error: 'invalid_filter', field: 'ddd', reason: `value "${ddd ?? ''}" not a valid BR DDD` })
      return
    }
    const validation = validateGeoQuery({ query: q, filterSpecs: view.filters })
    if (!validation.ok) {
      reply.code(400).send({ error: 'invalid_filter', field: validation.field, reason: validation.reason })
      return
    }
    try {
      const payload = await registry.runDrill(viewId, ddd, validation.params)
      return payload
    } catch (err) {
      if (err instanceof RegistryError && err.code === 'plugin_drill_failed') {
        reply.code(503).send({
          error: 'plugin_drill_failed', viewId,
          pluginError: err.message, retryable: true,
        })
        return
      }
      throw err
    }
  })
}

function normalizeQuery(q: unknown): Record<string, string | undefined> {
  if (typeof q !== 'object' || q === null) return {}
  const out: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(q as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v
    else if (typeof v === 'number') out[k] = String(v)
  }
  return out
}
```

- [ ] **Step 3: Run + commit**

```bash
pnpm --filter @dispatch/core test src/api/geo.test.ts
git add packages/core/src/api/geo.ts packages/core/src/api/geo.test.ts
git commit -m "feat(geo): REST routes /geo/views /aggregate /drill + auth + error contract"
```

---

### Task 7: Wire into server.ts + DDD indices

**Files:**
- Modify: `packages/core/src/server.ts`
- Modify: `packages/core/src/hygiene/hygiene-job-service.ts`
- Modify: `packages/core/src/contacts/contact-registry.ts`
- Modify: `packages/core/src/plugins/adb-precheck/job-store.ts`

- [ ] **Step 1: Wire into server.ts**

Read `server.ts`. Locate (a) `new PluginLoader(...)` call, (b) where routes are registered. Add at top:

```ts
import { GeoViewRegistry } from './geo/registry.js'
import { registerGeoRoutes } from './api/geo.js'
```

Near other registry/service instantiations:

```ts
const geoRegistry = new GeoViewRegistry({ cacheTtlMs: 60_000 })
```

In `new PluginLoader(...)` args (extra option):

```ts
geoRegistry,
```

After other `register*Routes(app, ...)` calls:

```ts
registerGeoRoutes(app, {
  registry: geoRegistry,
  apiKey: process.env.DISPATCH_API_KEY ?? '',
  getPluginStatuses: () => {
    const out: Record<string, 'active' | 'error' | 'disabled'> = {}
    for (const p of pluginRegistry.list()) {
      out[p.name] = p.status === 'active' ? 'active' : p.status === 'error' ? 'error' : 'disabled'
    }
    return out
  },
})
```

(Replace `pluginRegistry.list()` with the real accessor for plugin statuses in this codebase.)

- [ ] **Step 2: Add DDD index to HygieneJobService**

In `packages/core/src/hygiene/hygiene-job-service.ts` constructor, alongside other `CREATE INDEX IF NOT EXISTS` statements, add:

```ts
this.db.prepare(`
  CREATE INDEX IF NOT EXISTS idx_hygiene_items_ddd_updated
    ON hygiene_job_items(substr(phone_normalized, 3, 2), updated_at)
`).run()
```

(If the file already uses `this.db.exec` blocks for DDL, follow that pattern instead — it is the existing convention. The CREATE INDEX is equivalent either way.)

- [ ] **Step 3: Add DDD index to ContactRegistry**

In `packages/core/src/contacts/contact-registry.ts` constructor:

```ts
this.db.prepare(`
  CREATE INDEX IF NOT EXISTS idx_wa_checks_ddd_checked
    ON wa_contact_checks(substr(phone_normalized, 3, 2), checked_at)
`).run()
```

- [ ] **Step 4: Add DDD index to JobStore (adb-precheck)**

In `packages/core/src/plugins/adb-precheck/job-store.ts` constructor:

```ts
this.db.prepare(`
  CREATE INDEX IF NOT EXISTS idx_deals_ddd_scanned
    ON adb_precheck_deals(substr(primary_valid_phone, 1, 2), scanned_at)
    WHERE primary_valid_phone IS NOT NULL AND deleted_at IS NULL
`).run()
```

- [ ] **Step 5: Run all backend tests + typecheck**

```bash
pnpm --filter @dispatch/core test
pnpm --filter @dispatch/core typecheck
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/server.ts packages/core/src/hygiene/hygiene-job-service.ts packages/core/src/contacts/contact-registry.ts packages/core/src/plugins/adb-precheck/job-store.ts
git commit -m "feat(geo): wire GeoViewRegistry into server + 3 DDD expressional indexes"
```

---

## FASE B — Plugin contributions

### Task 8: Oralsin `oralsin.sends` view

**Files:**
- Modify: `packages/core/src/plugins/oralsin-plugin.ts`
- Modify: `packages/core/src/plugins/oralsin-plugin.test.ts` (or create dedicated test file)

- [ ] **Step 1: Read `oralsin-plugin.ts` to confirm DB access pattern**

Note how the plugin gets a `Database` handle (constructor injection, ctx, etc).

- [ ] **Step 2: Write failing test**

Create `packages/core/src/plugins/oralsin-geo.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { GeoViewRegistry } from '../geo/registry.js'
import type { GeoViewDefinition } from '../geo/types.js'

// Minimal harness: replicate the plugin's init() against an in-memory DB.
// This isolates the SQL from the rest of the plugin's HTTP/Pipedrive deps.
function registerOralsinSendsView(opts: { db: Database.Database; registry: GeoViewRegistry }): void {
  // After Task 8 Step 3 lands, replace this stub with `import { buildOralsinSendsView }
  // from './oralsin-plugin.js'` and call it. For RED phase, leave empty so the test fails.
}

describe('oralsin.sends geo view', () => {
  let db: Database.Database
  let registry: GeoViewRegistry

  beforeEach(() => {
    db = new Database(':memory:')
    db.prepare(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, to_number TEXT, body TEXT, status TEXT,
        sender_number TEXT, plugin_name TEXT, created_at TEXT
      )
    `).run()
    const ins = db.prepare(`INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)`)
    ins.run('m1', '5511987654321', 'hi', 'sent',    null, 'oralsin', new Date().toISOString())
    ins.run('m2', '5511987654322', 'hi', 'sent',    null, 'oralsin', new Date().toISOString())
    ins.run('m3', '5521987654323', 'hi', 'sent',    null, 'oralsin', new Date().toISOString())
    ins.run('m4', '5521987654324', 'hi', 'failed',  null, 'oralsin', new Date().toISOString())
    ins.run('m5', '5511987654325', 'hi', 'sent',    null, 'other',   new Date().toISOString())
    registry = new GeoViewRegistry()
    registerOralsinSendsView({ db, registry })
  })

  it('aggregates sent messages by DDD', async () => {
    const view = registry.get('oralsin.sends')!
    const r = await view.aggregate({ window: '24h', filters: { status: 'sent' } })
    expect(r.buckets).toEqual({ '11': 2, '21': 1 })
    expect(r.total).toBe(3)
  })

  it('filters by status', async () => {
    const view = registry.get('oralsin.sends')!
    const r = await view.aggregate({ window: '24h', filters: { status: 'failed' } })
    expect(r.buckets).toEqual({ '21': 1 })
  })

  it('excludes other plugins', async () => {
    const view = registry.get('oralsin.sends')!
    const r = await view.aggregate({ window: '24h', filters: { status: 'sent' } })
    expect(r.buckets['11']).toBe(2)
  })

  it('drill returns phones for given DDD', async () => {
    const view = registry.get('oralsin.sends')!
    const r = await view.drill('11', { window: '24h', filters: { status: 'sent' }, page: 1, pageSize: 50 })
    expect(r.rows.map(x => x.phone)).toEqual(['5511987654321', '5511987654322'])
    expect(r.total).toBe(2)
  })
})
```

- [ ] **Step 3: Export `buildOralsinSendsView` from plugin file**

Add to `packages/core/src/plugins/oralsin-plugin.ts`:

```ts
import type { GeoViewDefinition } from '../geo/types.js'

export function buildOralsinSendsView(db: Database.Database): GeoViewDefinition {
  return {
    id: 'oralsin.sends',
    label: 'Envios',
    description: 'Heatmap de envios da fila por DDD',
    group: 'oralsin',
    palette: 'sequential',
    filters: [
      { type: 'window', id: 'window', defaultValue: '7d', options: ['24h', '7d', '30d'] },
      { type: 'select', id: 'status', label: 'Status', defaultValue: 'sent',
        options: [
          { value: 'sent', label: 'Enviadas' },
          { value: 'failed', label: 'Falhadas' },
          { value: 'permanently_failed', label: 'Permanentes' },
          { value: 'queued', label: 'Em fila' },
          { value: 'sending', label: 'Enviando' },
        ] },
    ],
    aggregate: async (params) => {
      const since = windowToIso(params.window)
      const rows = db.prepare(`
        SELECT substr(to_number, 3, 2) AS ddd, COUNT(*) AS count
        FROM messages
        WHERE plugin_name = 'oralsin'
          AND status = ?
          AND created_at >= ?
        GROUP BY ddd
      `).all(params.filters.status, since) as Array<{ ddd: string; count: number }>
      const buckets: Record<string, number> = {}
      for (const r of rows) if (r.ddd) buckets[r.ddd] = r.count
      return {
        buckets,
        total: rows.reduce((s, r) => s + r.count, 0),
        generatedAt: new Date().toISOString(),
      }
    },
    drill: async (ddd, params) => {
      const since = windowToIso(params.window)
      const pageSize = params.pageSize ?? 50
      const offset = ((params.page ?? 1) - 1) * pageSize
      const rows = db.prepare(`
        SELECT id, to_number AS phone, status, created_at, sender_number
        FROM messages
        WHERE plugin_name = 'oralsin'
          AND status = ?
          AND created_at >= ?
          AND substr(to_number, 3, 2) = ?
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `).all(params.filters.status, since, ddd, pageSize, offset)
      const total = (db.prepare(`
        SELECT COUNT(*) AS c FROM messages
        WHERE plugin_name = 'oralsin' AND status = ? AND created_at >= ?
          AND substr(to_number, 3, 2) = ?
      `).get(params.filters.status, since, ddd) as { c: number }).c
      return {
        columns: [
          { key: 'id', label: 'ID', type: 'string' },
          { key: 'phone', label: 'Telefone', type: 'phone' },
          { key: 'status', label: 'Status', type: 'string' },
          { key: 'created_at', label: 'Data', type: 'date' },
          { key: 'sender_number', label: 'Sender', type: 'phone' },
        ],
        rows: rows as Array<Record<string, unknown>>,
        total, page: params.page ?? 1, pageSize,
      }
    },
  }
}
```

Add helper at file bottom (or extract to `util/window.ts` to share later):

```ts
function windowToIso(window: '24h' | '7d' | '30d' | 'all'): string {
  if (window === 'all') return '1970-01-01T00:00:00.000Z'
  const ms = window === '24h' ? 24 * 60 * 60 * 1000
           : window === '7d'  ? 7  * 24 * 60 * 60 * 1000
           :                    30 * 24 * 60 * 60 * 1000
  return new Date(Date.now() - ms).toISOString()
}
```

In `OralsinPlugin.init(ctx)`, after existing route registrations:

```ts
ctx.registerGeoView(buildOralsinSendsView(this.db))
```

(Adapt `this.db` to actual DB handle on the plugin instance.)

In the test file, replace the empty `registerOralsinSendsView` stub with:

```ts
import { buildOralsinSendsView } from './oralsin-plugin.js'

function registerOralsinSendsView(opts: { db: Database.Database; registry: GeoViewRegistry }): void {
  opts.registry.register('oralsin', buildOralsinSendsView(opts.db))
}
```

- [ ] **Step 4: Run + commit**

```bash
pnpm --filter @dispatch/core test src/plugins/oralsin-geo.test.ts
git add packages/core/src/plugins/oralsin-plugin.ts packages/core/src/plugins/oralsin-geo.test.ts
git commit -m "feat(geo): Oralsin contributes 'oralsin.sends' view (aggregate + drill)"
```

---

### Task 9: adb-precheck `no-match` view

**Files:**
- Modify: `packages/core/src/plugins/adb-precheck-plugin.ts`
- Create: `packages/core/src/plugins/adb-precheck-geo.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { GeoViewRegistry } from '../geo/registry.js'
import { buildAdbPrecheckGeoViews } from './adb-precheck-plugin.js' // will export in Step 3

describe('adb-precheck.no-match geo view', () => {
  let db: Database.Database
  let registry: GeoViewRegistry

  beforeEach(() => {
    db = new Database(':memory:')
    db.prepare(`
      CREATE TABLE hygiene_job_items (
        id INTEGER PRIMARY KEY, job_id TEXT, phone_normalized TEXT,
        status TEXT, updated_at TEXT
      )
    `).run()
    const ins = db.prepare(`INSERT INTO hygiene_job_items VALUES (?, ?, ?, ?, ?)`)
    ins.run(1, 'j1', '551187654321', 'invalid', new Date().toISOString())
    ins.run(2, 'j1', '551187654322', 'invalid', new Date().toISOString())
    ins.run(3, 'j1', '552187654323', 'invalid', new Date().toISOString())
    ins.run(4, 'j1', '551187654324', 'valid',   new Date().toISOString())
    ins.run(5, 'j1', null,           'invalid', new Date().toISOString())

    registry = new GeoViewRegistry()
    for (const v of buildAdbPrecheckGeoViews(db)) registry.register('adb-precheck', v)
  })

  it('aggregates status=invalid by DDD, skipping null phones', async () => {
    const view = registry.get('adb-precheck.no-match')!
    const r = await view.aggregate({ window: '7d', filters: {} })
    expect(r.buckets).toEqual({ '11': 2, '21': 1 })
    expect(r.total).toBe(3)
  })

  it('drill returns rows for given DDD', async () => {
    const view = registry.get('adb-precheck.no-match')!
    const r = await view.drill('11', { window: '7d', filters: {}, page: 1, pageSize: 50 })
    expect(r.rows).toHaveLength(2)
    expect(r.total).toBe(2)
  })
})
```

- [ ] **Step 2: Implement `buildAdbPrecheckGeoViews`**

Add to `packages/core/src/plugins/adb-precheck-plugin.ts`:

```ts
import type { GeoViewDefinition } from '../geo/types.js'

export function buildAdbPrecheckGeoViews(db: Database.Database): GeoViewDefinition[] {
  const windowFilter = {
    type: 'window' as const, id: 'window',
    defaultValue: '7d' as const, options: ['24h', '7d', '30d', 'all'] as const,
  }

  const noMatch: GeoViewDefinition = {
    id: 'adb-precheck.no-match',
    label: 'Não existentes',
    description: 'DDDs com mais números rejeitados por inexistência',
    group: 'adb-precheck',
    palette: 'sequential',
    filters: [windowFilter],
    aggregate: async (params) => {
      const since = windowToIso(params.window)
      const rows = db.prepare(`
        SELECT substr(phone_normalized, 3, 2) AS ddd, COUNT(*) AS count
        FROM hygiene_job_items
        WHERE status = 'invalid' AND updated_at >= ?
          AND phone_normalized IS NOT NULL
        GROUP BY ddd
      `).all(since) as Array<{ ddd: string; count: number }>
      const buckets: Record<string, number> = {}
      for (const r of rows) if (r.ddd) buckets[r.ddd] = r.count
      return { buckets, total: rows.reduce((s, r) => s + r.count, 0), generatedAt: new Date().toISOString() }
    },
    drill: async (ddd, params) => {
      const since = windowToIso(params.window)
      const pageSize = params.pageSize ?? 50
      const offset = ((params.page ?? 1) - 1) * pageSize
      const rows = db.prepare(`
        SELECT id, job_id, phone_normalized AS phone, updated_at
        FROM hygiene_job_items
        WHERE status = 'invalid' AND updated_at >= ?
          AND phone_normalized IS NOT NULL
          AND substr(phone_normalized, 3, 2) = ?
        ORDER BY updated_at DESC
        LIMIT ? OFFSET ?
      `).all(since, ddd, pageSize, offset)
      const total = (db.prepare(`
        SELECT COUNT(*) AS c FROM hygiene_job_items
        WHERE status='invalid' AND updated_at >= ?
          AND phone_normalized IS NOT NULL AND substr(phone_normalized,3,2)=?
      `).get(since, ddd) as { c: number }).c
      return {
        columns: [
          { key: 'job_id', label: 'Job', type: 'string' },
          { key: 'phone', label: 'Telefone', type: 'phone' },
          { key: 'updated_at', label: 'Data', type: 'date' },
        ],
        rows: rows as Array<Record<string, unknown>>,
        total, page: params.page ?? 1, pageSize,
      }
    },
  }

  return [noMatch] // Tasks 10 and 11 append more
}

function windowToIso(window: '24h' | '7d' | '30d' | 'all'): string {
  if (window === 'all') return '1970-01-01T00:00:00.000Z'
  const ms = window === '24h' ? 24 * 60 * 60 * 1000
           : window === '7d'  ? 7  * 24 * 60 * 60 * 1000
           :                    30 * 24 * 60 * 60 * 1000
  return new Date(Date.now() - ms).toISOString()
}
```

In `AdbPrecheckPlugin.init(ctx)`:

```ts
for (const v of buildAdbPrecheckGeoViews(this.db)) ctx.registerGeoView(v)
```

- [ ] **Step 3: Run + commit**

```bash
pnpm --filter @dispatch/core test src/plugins/adb-precheck-geo.test.ts
git add packages/core/src/plugins/adb-precheck-plugin.ts packages/core/src/plugins/adb-precheck-geo.test.ts
git commit -m "feat(geo): adb-precheck 'no-match' view (status=invalid hygiene items)"
```

---

### Task 10: adb-precheck `valid` view

**Files:** same as Task 9.

- [ ] **Step 1: Append failing test**

Append to `adb-precheck-geo.test.ts`:

```ts
describe('adb-precheck.valid geo view', () => {
  let db: Database.Database
  let registry: GeoViewRegistry

  beforeEach(() => {
    db = new Database(':memory:')
    db.prepare(`
      CREATE TABLE wa_contact_checks (
        id TEXT PRIMARY KEY, phone_normalized TEXT NOT NULL,
        result TEXT NOT NULL, checked_at TEXT NOT NULL
      )
    `).run()
    const ins = db.prepare(`INSERT INTO wa_contact_checks VALUES (?, ?, ?, ?)`)
    ins.run('c1', '551187654321', 'exists',     new Date().toISOString())
    ins.run('c2', '551187654322', 'exists',     new Date().toISOString())
    ins.run('c3', '552187654323', 'exists',     new Date().toISOString())
    ins.run('c4', '551187654324', 'not_exists', new Date().toISOString())
    registry = new GeoViewRegistry()
    for (const v of buildAdbPrecheckGeoViews(db)) registry.register('adb-precheck', v)
  })

  it('aggregates result=exists by DDD', async () => {
    const view = registry.get('adb-precheck.valid')!
    const r = await view.aggregate({ window: '7d', filters: {} })
    expect(r.buckets).toEqual({ '11': 2, '21': 1 })
  })

  it('drill returns recent checks', async () => {
    const view = registry.get('adb-precheck.valid')!
    const r = await view.drill('11', { window: '7d', filters: {}, page: 1, pageSize: 50 })
    expect(r.rows).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Append view to `buildAdbPrecheckGeoViews`**

In `adb-precheck-plugin.ts`, change the return to include a `valid` view. Replace `return [noMatch]` with:

```ts
const validView: GeoViewDefinition = {
  id: 'adb-precheck.valid',
  label: 'Validados',
  description: 'DDDs com mais números validados (existentes no WhatsApp)',
  group: 'adb-precheck',
  palette: 'sequential',
  filters: [windowFilter],
  aggregate: async (params) => {
    const since = windowToIso(params.window)
    const rows = db.prepare(`
      SELECT substr(phone_normalized, 3, 2) AS ddd, COUNT(*) AS count
      FROM wa_contact_checks
      WHERE result = 'exists' AND checked_at >= ?
      GROUP BY ddd
    `).all(since) as Array<{ ddd: string; count: number }>
    const buckets: Record<string, number> = {}
    for (const r of rows) if (r.ddd) buckets[r.ddd] = r.count
    return { buckets, total: rows.reduce((s, r) => s + r.count, 0), generatedAt: new Date().toISOString() }
  },
  drill: async (ddd, params) => {
    const since = windowToIso(params.window)
    const pageSize = params.pageSize ?? 50
    const offset = ((params.page ?? 1) - 1) * pageSize
    const rows = db.prepare(`
      SELECT id, phone_normalized AS phone, result, checked_at
      FROM wa_contact_checks
      WHERE result = 'exists' AND checked_at >= ?
        AND substr(phone_normalized, 3, 2) = ?
      ORDER BY checked_at DESC
      LIMIT ? OFFSET ?
    `).all(since, ddd, pageSize, offset)
    const total = (db.prepare(`
      SELECT COUNT(*) AS c FROM wa_contact_checks
      WHERE result='exists' AND checked_at >= ? AND substr(phone_normalized,3,2)=?
    `).get(since, ddd) as { c: number }).c
    return {
      columns: [
        { key: 'phone', label: 'Telefone', type: 'phone' },
        { key: 'checked_at', label: 'Validado em', type: 'date' },
      ],
      rows: rows as Array<Record<string, unknown>>,
      total, page: params.page ?? 1, pageSize,
    }
  },
}

return [noMatch, validView]
```

- [ ] **Step 3: Run + commit**

```bash
pnpm --filter @dispatch/core test src/plugins/adb-precheck-geo.test.ts
git add packages/core/src/plugins/adb-precheck-plugin.ts packages/core/src/plugins/adb-precheck-geo.test.ts
git commit -m "feat(geo): adb-precheck 'valid' view (wa_contact_checks result=exists)"
```

---

### Task 11: adb-precheck `pipedrive-mapped` view

**Files:** same.

- [ ] **Step 1: Append failing test**

```ts
describe('adb-precheck.pipedrive-mapped geo view', () => {
  let db: Database.Database
  let registry: GeoViewRegistry

  beforeEach(() => {
    db = new Database(':memory:')
    db.prepare(`
      CREATE TABLE adb_precheck_deals (
        id INTEGER PRIMARY KEY, primary_valid_phone TEXT,
        scanned_at TEXT NOT NULL, deleted_at TEXT
      )
    `).run()
    const ins = db.prepare(`INSERT INTO adb_precheck_deals (primary_valid_phone, scanned_at, deleted_at) VALUES (?, ?, ?)`)
    ins.run('11987654321', new Date().toISOString(), null)
    ins.run('11987654322', new Date().toISOString(), null)
    ins.run('21987654323', new Date().toISOString(), null)
    ins.run('11987654324', new Date().toISOString(), new Date().toISOString()) // tombstoned
    ins.run(null,           new Date().toISOString(), null)                    // null phone
    registry = new GeoViewRegistry()
    for (const v of buildAdbPrecheckGeoViews(db)) registry.register('adb-precheck', v)
  })

  it('aggregates live deals (deleted_at NULL) by DDD using chars 1-2', async () => {
    const view = registry.get('adb-precheck.pipedrive-mapped')!
    const r = await view.aggregate({ window: '7d', filters: {} })
    expect(r.buckets).toEqual({ '11': 2, '21': 1 })
  })

  it('excludes tombstoned deals', async () => {
    const view = registry.get('adb-precheck.pipedrive-mapped')!
    const r = await view.aggregate({ window: '7d', filters: {} })
    expect(r.buckets['11']).toBe(2)
  })
})
```

- [ ] **Step 2: Append view to `buildAdbPrecheckGeoViews`**

Add `pipedriveMappedView` before the final `return`:

```ts
const pipedriveMappedView: GeoViewDefinition = {
  id: 'adb-precheck.pipedrive-mapped',
  label: 'Mapeados no Pipedrive',
  description: 'DDDs com deals reconciliados (live, sem tombstone)',
  group: 'adb-precheck',
  palette: 'sequential',
  filters: [windowFilter],
  aggregate: async (params) => {
    const since = windowToIso(params.window)
    const rows = db.prepare(`
      SELECT substr(primary_valid_phone, 1, 2) AS ddd, COUNT(*) AS count
      FROM adb_precheck_deals
      WHERE deleted_at IS NULL AND scanned_at >= ?
        AND primary_valid_phone IS NOT NULL
      GROUP BY ddd
    `).all(since) as Array<{ ddd: string; count: number }>
    const buckets: Record<string, number> = {}
    for (const r of rows) if (r.ddd) buckets[r.ddd] = r.count
    return { buckets, total: rows.reduce((s, r) => s + r.count, 0), generatedAt: new Date().toISOString() }
  },
  drill: async (ddd, params) => {
    const since = windowToIso(params.window)
    const pageSize = params.pageSize ?? 50
    const offset = ((params.page ?? 1) - 1) * pageSize
    const rows = db.prepare(`
      SELECT id, primary_valid_phone AS phone, scanned_at
      FROM adb_precheck_deals
      WHERE deleted_at IS NULL AND scanned_at >= ?
        AND primary_valid_phone IS NOT NULL
        AND substr(primary_valid_phone, 1, 2) = ?
      ORDER BY scanned_at DESC
      LIMIT ? OFFSET ?
    `).all(since, ddd, pageSize, offset)
    const total = (db.prepare(`
      SELECT COUNT(*) AS c FROM adb_precheck_deals
      WHERE deleted_at IS NULL AND scanned_at >= ?
        AND primary_valid_phone IS NOT NULL AND substr(primary_valid_phone,1,2)=?
    `).get(since, ddd) as { c: number }).c
    return {
      columns: [
        { key: 'id', label: 'Deal ID', type: 'string' },
        { key: 'phone', label: 'Telefone', type: 'phone' },
        { key: 'scanned_at', label: 'Scaneado em', type: 'date' },
      ],
      rows: rows as Array<Record<string, unknown>>,
      total, page: params.page ?? 1, pageSize,
    }
  },
}

return [noMatch, validView, pipedriveMappedView]
```

- [ ] **Step 3: Run + commit**

```bash
pnpm --filter @dispatch/core test src/plugins/adb-precheck-geo.test.ts
git add packages/core/src/plugins/adb-precheck-plugin.ts packages/core/src/plugins/adb-precheck-geo.test.ts
git commit -m "feat(geo): adb-precheck 'pipedrive-mapped' view (11-digit DDD path, tombstone filter)"
```

---

### Task 12: Backend smoke

- [ ] **Step 1: Full test suite + typecheck**

```bash
pnpm --filter @dispatch/core test
pnpm --filter @dispatch/core typecheck
```

Expected: all green.

- [ ] **Step 2: Boot local core**

```bash
cd /var/www/adb_tools/packages/core
pnpm dev
```

- [ ] **Step 3: curl discovery + aggregate**

In another shell (DISPATCH_API_KEY from your local env):

```bash
curl -s -H "X-API-Key: $DISPATCH_API_KEY" http://127.0.0.1:7890/api/v1/geo/views | jq '.views[].id'
```

Expected: 4 ids (oralsin.sends + adb-precheck.no-match + adb-precheck.valid + adb-precheck.pipedrive-mapped).

```bash
curl -s -H "X-API-Key: $DISPATCH_API_KEY" \
  "http://127.0.0.1:7890/api/v1/geo/views/oralsin.sends/aggregate?window=7d&status=sent" | jq .
```

Expected: HTTP 200 + `{buckets:{...},total:N,generatedAt:...}` (buckets can be empty).

- [ ] **Step 4: Stop core. No commit.**

---

## FASE C — Frontend foundation

### Task 13: Install deck.gl deps

**Files:**
- Modify: `packages/ui/package.json`

- [ ] **Step 1: Install**

```bash
cd /var/www/adb_tools/packages/ui
pnpm add @deck.gl/core@^9 @deck.gl/layers@^9 @deck.gl/react@^9 d3-scale-chromatic@^3 topojson-client@^3
pnpm add -D @types/d3-scale-chromatic @types/topojson-client
```

- [ ] **Step 2: Build check**

```bash
pnpm typecheck
pnpm build
```

Expected: success.

- [ ] **Step 3: Commit**

```bash
git add packages/ui/package.json ../../pnpm-lock.yaml
git commit -m "chore(geo-ui): install deck.gl 9.x + d3-scale-chromatic + topojson-client"
```

---

### Task 14: BR DDD GeoJSON asset

**Files:**
- Create: `packages/ui/public/topology/br-ddds.geojson`
- Create: `packages/ui/public/topology/README.md`

- [ ] **Step 1: Fetch**

```bash
cd /var/www/adb_tools/packages/ui
mkdir -p public/topology
curl -fsSL -o public/topology/br-ddds.geojson \
  "https://gist.githubusercontent.com/guilhermeprokisch/080c2cb1bd28e8aca54d114e453c91a4/raw/e3af50027ae0fd0b637f4cb60e19552b9f5e0a2a/brazil_phone_area_codes.geojson"
```

- [ ] **Step 2: Validate**

```bash
node -e "const d=require('./public/topology/br-ddds.geojson'); \
  console.log('features:', d.features.length); \
  console.log('sample property:', d.features[0].properties)"
```

Expected: `features: 67`, property has numeric `description`.

- [ ] **Step 3: README**

Create `packages/ui/public/topology/README.md`:

```markdown
# BR DDD GeoJSON

Source: https://gist.github.com/guilhermeprokisch/080c2cb1bd28e8aca54d114e453c91a4

67 active Brazilian DDD area codes. Property `description` is numeric (cast with `Number()`).

**License**: not explicitly declared. Internal use OK. Production fallback: derive from
`tbrugz/geodata-br` (IBGE municipalities) + `kelvins/municipios-brasileiros` (MIT) via
mapshaper dissolve by DDD (~2-3h work).
```

- [ ] **Step 4: Commit**

```bash
git add packages/ui/public/topology/br-ddds.geojson packages/ui/public/topology/README.md
git commit -m "chore(geo-ui): add BR DDD GeoJSON (67 features) + license note"
```

---

### Task 15: Frontend types

**Files:**
- Create: `packages/ui/src/components/geo/geo.types.ts`

```ts
export type GeoPalette = 'sequential' | 'diverging' | 'rate'
export type GeoWindow = '24h' | '7d' | '30d' | 'all'

export interface GeoWindowFilterSpec {
  type: 'window'
  id: string
  defaultValue: '24h' | '7d' | '30d'
  options: GeoWindow[]
}

export interface GeoSelectFilterSpec {
  type: 'select'
  id: string
  label: string
  defaultValue: string
  options: Array<{ value: string; label: string }>
}

export type GeoFilterSpec = GeoWindowFilterSpec | GeoSelectFilterSpec

export interface GeoViewSummary {
  id: string
  label: string
  description?: string
  group: string
  palette: GeoPalette
  filters: GeoFilterSpec[]
  pluginName: string
  pluginStatus: 'active' | 'error' | 'disabled'
}

export interface GeoViewsResponse {
  views: GeoViewSummary[]
  groups: Array<{ name: string; label: string; viewIds: string[] }>
  generatedAt: string
}

export interface GeoAggregation {
  buckets: Record<string, number>
  total: number
  generatedAt: string
}

export interface GeoDrillColumn {
  key: string
  label: string
  type?: 'date' | 'number' | 'string' | 'phone'
}

export interface GeoDrillResult {
  columns: GeoDrillColumn[]
  rows: Array<Record<string, unknown>>
  total: number
  page: number
  pageSize: number
}

export interface GeoFilterState {
  window: GeoWindow
  filters: Record<string, string>
}
```

- [ ] Commit:

```bash
git add packages/ui/src/components/geo/geo.types.ts
git commit -m "feat(geo-ui): frontend types mirror of core/geo/types.ts"
```

---

### Task 16: BrazilMapDDD component

**Files:**
- Create: `packages/ui/src/components/geo/brazil-map-ddd.tsx`
- Create: `packages/ui/src/components/geo/brazil-map-ddd.test.tsx`

- [ ] **Step 1: RTL smoke test**

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { BrazilMapDDD } from './brazil-map-ddd.js'

vi.mock('@deck.gl/react', () => ({
  DeckGL: ({ children }: { children?: React.ReactNode }) => <div data-testid="deck-mock">{children}</div>,
}))

const fakeTopology = {
  type: 'FeatureCollection' as const,
  features: [
    { type: 'Feature', properties: { description: 11 }, geometry: { type: 'Polygon', coordinates: [[[0,0],[1,0],[1,1],[0,0]]] } },
  ],
}

describe('BrazilMapDDD', () => {
  it('renders DeckGL wrapper', () => {
    render(<BrazilMapDDD topology={fakeTopology as never} buckets={{ '11': 5 }} palette="sequential" onDddClick={() => {}} />)
    expect(screen.getByTestId('deck-mock')).toBeInTheDocument()
  })

  it('handles empty buckets', () => {
    render(<BrazilMapDDD topology={fakeTopology as never} buckets={{}} palette="sequential" onDddClick={() => {}} />)
    expect(screen.getByTestId('deck-mock')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Implement**

```tsx
import { DeckGL } from '@deck.gl/react'
import { GeoJsonLayer } from '@deck.gl/layers'
import { interpolateViridis, interpolateRdYlGn, interpolatePuOr } from 'd3-scale-chromatic'
import { useMemo } from 'react'
import type { GeoPalette } from './geo.types.js'

interface DddFeature {
  type: 'Feature'
  properties: { description: number; [k: string]: unknown }
  geometry: unknown
}

export interface BrazilMapDDDProps {
  topology: { type: 'FeatureCollection'; features: DddFeature[] }
  buckets: Record<string, number>
  palette: GeoPalette
  onDddClick: (ddd: string) => void
  max?: number
}

const INITIAL_VIEW_STATE = {
  longitude: -53, latitude: -14, zoom: 3.4,
  minZoom: 2, maxZoom: 8, pitch: 0, bearing: 0,
}

export function BrazilMapDDD(props: BrazilMapDDDProps) {
  const { topology, buckets, palette, onDddClick } = props
  const max = props.max ?? Math.max(1, ...Object.values(buckets))
  const colorFn = paletteToColorFn(palette)

  const layer = useMemo(() => new GeoJsonLayer<DddFeature>({
    id: 'br-ddd-choropleth',
    data: topology.features as never,
    pickable: true, stroked: true, filled: true,
    lineWidthMinPixels: 0.5,
    getLineColor: [255, 255, 255, 80],
    getFillColor: (f: DddFeature) => {
      const ddd = String(Math.trunc(Number(f.properties.description)))
      const count = buckets[ddd] ?? 0
      const t = count === 0 ? 0 : count / max
      const [r, g, b] = parseRgb(colorFn(t))
      return count === 0 ? [40, 40, 40, 60] : [r, g, b, 220]
    },
    updateTriggers: { getFillColor: [buckets, max, palette] },
    onClick: (info) => {
      const f = info.object as DddFeature | undefined
      if (!f) return
      onDddClick(String(Math.trunc(Number(f.properties.description))))
    },
  }), [topology, buckets, max, palette, onDddClick])

  return (
    <div className="relative h-[520px] w-full rounded-lg border border-zinc-800 overflow-hidden">
      <DeckGL
        initialViewState={INITIAL_VIEW_STATE}
        controller={true}
        layers={[layer]}
        getTooltip={({ object }) => {
          const f = object as DddFeature | undefined
          if (!f) return null
          const ddd = String(Math.trunc(Number(f.properties.description)))
          const count = buckets[ddd] ?? 0
          return {
            html: `<div style="padding:6px 8px"><b>DDD ${ddd}</b><br/>${count} registros</div>`,
            style: { background: 'rgba(20,20,20,0.95)', color: '#fff', border: '1px solid #444', borderRadius: '4px' },
          }
        }}
      />
    </div>
  )
}

function paletteToColorFn(p: GeoPalette): (t: number) => string {
  if (p === 'rate') return interpolateRdYlGn
  if (p === 'diverging') return interpolatePuOr
  return interpolateViridis
}

function parseRgb(input: string): [number, number, number] {
  const m = /rgb\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)\s*\)/.exec(input)
  if (!m) return [0, 0, 0]
  return [parseInt(m[1]!, 10), parseInt(m[2]!, 10), parseInt(m[3]!, 10)]
}
```

- [ ] **Step 3: Run + commit**

```bash
pnpm --filter @dispatch/ui test src/components/geo/brazil-map-ddd.test.tsx
git add packages/ui/src/components/geo/brazil-map-ddd.tsx packages/ui/src/components/geo/brazil-map-ddd.test.tsx
git commit -m "feat(geo-ui): BrazilMapDDD (deck.gl GeoJsonLayer choropleth)"
```

---

### Task 17: FilterBar component

**Files:**
- Create: `packages/ui/src/components/geo/filter-bar.tsx`
- Create: `packages/ui/src/components/geo/filter-bar.test.tsx`

- [ ] **Step 1: Test**

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { FilterBar } from './filter-bar.js'
import type { GeoFilterSpec } from './geo.types.js'

const specs: GeoFilterSpec[] = [
  { type: 'window', id: 'window', defaultValue: '7d', options: ['24h', '7d', '30d'] },
  { type: 'select', id: 'status', label: 'Status', defaultValue: 'sent',
    options: [{ value: 'sent', label: 'Enviadas' }, { value: 'failed', label: 'Falhadas' }] },
]

describe('FilterBar', () => {
  it('renders window options', () => {
    render(<FilterBar specs={specs} state={{ window: '7d', filters: { status: 'sent' } }} onChange={() => {}} />)
    expect(screen.getByText('24h')).toBeInTheDocument()
  })

  it('calls onChange when window button clicked', () => {
    const fn = vi.fn()
    render(<FilterBar specs={specs} state={{ window: '7d', filters: { status: 'sent' } }} onChange={fn} />)
    fireEvent.click(screen.getByText('24h'))
    expect(fn).toHaveBeenCalledWith(expect.objectContaining({ window: '24h' }))
  })

  it('calls onChange when select changes', () => {
    const fn = vi.fn()
    render(<FilterBar specs={specs} state={{ window: '7d', filters: { status: 'sent' } }} onChange={fn} />)
    fireEvent.change(screen.getByLabelText('Status:'), { target: { value: 'failed' } })
    expect(fn).toHaveBeenCalledWith(expect.objectContaining({ filters: { status: 'failed' } }))
  })
})
```

- [ ] **Step 2: Implement**

```tsx
import type { GeoFilterSpec, GeoFilterState, GeoWindow } from './geo.types.js'

export interface FilterBarProps {
  specs: GeoFilterSpec[]
  state: GeoFilterState
  onChange: (next: GeoFilterState) => void
}

export function FilterBar({ specs, state, onChange }: FilterBarProps) {
  return (
    <div className="flex flex-wrap items-center gap-3 p-3 bg-zinc-900/40 rounded-lg border border-zinc-800">
      {specs.map((spec) => {
        if (spec.type === 'window') {
          return (
            <div key={spec.id} className="flex items-center gap-1" role="group" aria-label="Janela temporal">
              {spec.options.map((opt) => (
                <button
                  key={opt}
                  type="button"
                  className={`px-3 py-1 text-xs rounded-md ${state.window === opt
                    ? 'bg-emerald-600 text-white'
                    : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'}`}
                  onClick={() => onChange({ ...state, window: opt as GeoWindow })}
                >
                  {opt}
                </button>
              ))}
            </div>
          )
        }
        return (
          <label key={spec.id} className="flex items-center gap-2 text-xs text-zinc-400">
            <span>{spec.label}:</span>
            <select
              aria-label={`${spec.label}:`}
              className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-zinc-100"
              value={state.filters[spec.id] ?? spec.defaultValue}
              onChange={(e) => onChange({ ...state, filters: { ...state.filters, [spec.id]: e.target.value } })}
            >
              {spec.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 3: Run + commit**

```bash
pnpm --filter @dispatch/ui test src/components/geo/filter-bar.test.tsx
git add packages/ui/src/components/geo/filter-bar.tsx packages/ui/src/components/geo/filter-bar.test.tsx
git commit -m "feat(geo-ui): FilterBar — window buttons + select from declarative spec"
```

---

## FASE D — Frontend assembly

### Task 18: Legend

**Files:**
- Create: `packages/ui/src/components/geo/legend.tsx`

```tsx
import { interpolateViridis, interpolateRdYlGn, interpolatePuOr } from 'd3-scale-chromatic'
import type { GeoPalette } from './geo.types.js'

export interface LegendProps {
  max: number
  palette: GeoPalette
}

export function Legend({ max, palette }: LegendProps) {
  const colorFn =
    palette === 'rate' ? interpolateRdYlGn :
    palette === 'diverging' ? interpolatePuOr :
    interpolateViridis
  const stops = Array.from({ length: 12 }, (_, i) => colorFn(i / 11))
  const gradient = `linear-gradient(90deg, ${stops.join(', ')})`
  return (
    <div
      className="flex items-center gap-2 p-3 bg-zinc-900/40 rounded-lg border border-zinc-800"
      aria-label={`Escala de cores de 0 a ${max}`}
    >
      <span className="text-xs text-zinc-500 font-mono w-8 text-right">0</span>
      <div className="h-4 flex-1 rounded" style={{ background: gradient }} role="presentation" />
      <span className="text-xs text-zinc-500 font-mono w-12">{max}</span>
    </div>
  )
}
```

- [ ] Commit:

```bash
git add packages/ui/src/components/geo/legend.tsx
git commit -m "feat(geo-ui): Legend with palette gradient + aria-label"
```

---

### Task 19: DrillModal

**Files:**
- Create: `packages/ui/src/components/geo/drill-modal.tsx`

```tsx
import { useEffect, useState } from 'react'
import { CORE_URL, authHeaders } from '../../config.js'
import type { GeoDrillResult, GeoFilterState } from './geo.types.js'

export interface DrillModalProps {
  open: boolean
  viewId: string | null
  ddd: string | null
  state: GeoFilterState
  onClose: () => void
}

export function DrillModal(props: DrillModalProps) {
  const { open, viewId, ddd, state, onClose } = props
  const [data, setData] = useState<GeoDrillResult | null>(null)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open || !viewId || !ddd) return
    setLoading(true)
    const url = new URL(`${CORE_URL}/api/v1/geo/views/${viewId}/drill`)
    url.searchParams.set('ddd', ddd)
    url.searchParams.set('window', state.window)
    url.searchParams.set('page', String(page))
    for (const [k, v] of Object.entries(state.filters)) url.searchParams.set(k, v)
    fetch(url.toString(), { headers: authHeaders() })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(String(r.status))))
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false))
  }, [open, viewId, ddd, state, page])

  useEffect(() => { setPage(1) }, [open, viewId, ddd])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-zinc-900 border border-zinc-800 rounded-lg max-w-4xl w-full max-h-[80vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between p-4 border-b border-zinc-800">
          <h2 className="text-sm font-semibold">DDD {ddd} — registros</h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-100" aria-label="Fechar">×</button>
        </header>
        <div className="flex-1 overflow-auto p-4">
          {loading && <p className="text-xs text-zinc-500">Carregando…</p>}
          {!loading && (!data || data.rows.length === 0) && (
            <p className="text-xs text-zinc-500">Sem registros nesta janela.</p>
          )}
          {!loading && data && data.rows.length > 0 && (
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-zinc-800">
                  {data.columns.map((c) => (
                    <th key={c.key} className="text-left p-2 text-zinc-400 font-medium">{c.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row, i) => (
                  <tr key={i} className="border-b border-zinc-900">
                    {data.columns.map((c) => (
                      <td key={c.key} className="p-2 text-zinc-200 font-mono">{formatCell(row[c.key], c.type)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {data && data.total > data.pageSize && (
          <footer className="flex items-center justify-between p-3 border-t border-zinc-800">
            <span className="text-xs text-zinc-500">Página {page} • {data.total} total</span>
            <div className="flex gap-2">
              <button
                disabled={page <= 1}
                className="px-2 py-1 text-xs bg-zinc-800 rounded disabled:opacity-30"
                onClick={() => setPage(p => Math.max(1, p - 1))}
              >Anterior</button>
              <button
                disabled={page * data.pageSize >= data.total}
                className="px-2 py-1 text-xs bg-zinc-800 rounded disabled:opacity-30"
                onClick={() => setPage(p => p + 1)}
              >Próxima</button>
            </div>
          </footer>
        )}
      </div>
    </div>
  )
}

function formatCell(val: unknown, type?: string): string {
  if (val === null || val === undefined) return '—'
  if (type === 'date' && typeof val === 'string') {
    const d = new Date(val)
    if (!isNaN(d.getTime())) return d.toLocaleString('pt-BR')
  }
  return String(val)
}
```

- [ ] Commit:

```bash
git add packages/ui/src/components/geo/drill-modal.tsx
git commit -m "feat(geo-ui): DrillModal — paginated table fed by /drill endpoint"
```

---

### Task 20: EmptyState + FallbackTable

**Files:**
- Create: `packages/ui/src/components/geo/empty-state.tsx`
- Create: `packages/ui/src/components/geo/fallback-table.tsx`

`empty-state.tsx`:

```tsx
export function EmptyState() {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-8 text-center">
      <h3 className="text-sm font-medium text-zinc-300">Nenhuma visão geográfica ativa</h3>
      <p className="mt-2 text-xs text-zinc-500 max-w-md mx-auto">
        Habilite um plugin com visão geográfica em <code className="text-zinc-300">/admin/plugins</code>.
      </p>
    </div>
  )
}
```

`fallback-table.tsx`:

```tsx
import type { GeoAggregation } from './geo.types.js'

export interface FallbackTableProps {
  aggregation: GeoAggregation
}

export function FallbackTable({ aggregation }: FallbackTableProps) {
  const sorted = Object.entries(aggregation.buckets).sort(([, a], [, b]) => b - a)
  return (
    <table className="w-full text-xs mt-4">
      <thead>
        <tr className="border-b border-zinc-800">
          <th className="text-left p-2 text-zinc-400">DDD</th>
          <th className="text-right p-2 text-zinc-400">Registros</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map(([ddd, count]) => (
          <tr key={ddd} className="border-b border-zinc-900">
            <td className="p-2 text-zinc-200 font-mono">{ddd}</td>
            <td className="p-2 text-zinc-200 font-mono text-right">{count}</td>
          </tr>
        ))}
        {sorted.length === 0 && (
          <tr><td colSpan={2} className="p-4 text-center text-zinc-500">Sem registros</td></tr>
        )}
      </tbody>
    </table>
  )
}
```

- [ ] Commit:

```bash
git add packages/ui/src/components/geo/empty-state.tsx packages/ui/src/components/geo/fallback-table.tsx
git commit -m "feat(geo-ui): EmptyState + FallbackTable (a11y/no-WebGL fallback)"
```

---

### Task 21: GeoViewPanel

**Files:**
- Create: `packages/ui/src/components/geo/geo-view-panel.tsx`

```tsx
import { useEffect, useMemo, useState } from 'react'
import { CORE_URL, authHeaders } from '../../config.js'
import { BrazilMapDDD } from './brazil-map-ddd.js'
import { FilterBar } from './filter-bar.js'
import { Legend } from './legend.js'
import { DrillModal } from './drill-modal.js'
import { FallbackTable } from './fallback-table.js'
import type { GeoAggregation, GeoFilterState, GeoViewSummary } from './geo.types.js'

export interface GeoViewPanelProps {
  view: GeoViewSummary
  topology: { type: 'FeatureCollection'; features: never[] }
}

export function GeoViewPanel({ view, topology }: GeoViewPanelProps) {
  const initialState: GeoFilterState = useMemo(() => {
    const filters: Record<string, string> = {}
    let window: GeoFilterState['window'] = '7d'
    for (const spec of view.filters) {
      if (spec.type === 'window') window = spec.defaultValue
      else filters[spec.id] = spec.defaultValue
    }
    return { window, filters }
  }, [view.filters])

  const [state, setState] = useState<GeoFilterState>(initialState)
  const [aggregation, setAggregation] = useState<GeoAggregation | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [showTable, setShowTable] = useState(false)
  const [drillDdd, setDrillDdd] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    const url = new URL(`${CORE_URL}/api/v1/geo/views/${view.id}/aggregate`)
    url.searchParams.set('window', state.window)
    for (const [k, v] of Object.entries(state.filters)) url.searchParams.set(k, v)
    fetch(url.toString(), { headers: authHeaders() })
      .then(r => r.ok ? r.json() : r.json().then(b => Promise.reject(b)))
      .then(setAggregation)
      .catch((b) => setError((b && b.error) ?? 'fetch_failed'))
      .finally(() => setLoading(false))
  }, [view.id, state])

  const max = aggregation ? Math.max(0, ...Object.values(aggregation.buckets)) : 0

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <FilterBar specs={view.filters} state={state} onChange={setState} />
        <button
          type="button"
          onClick={() => setShowTable(v => !v)}
          className="text-xs text-zinc-400 hover:text-zinc-100 underline"
        >
          {showTable ? 'Ver mapa' : 'Ver como tabela'}
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-900/40 bg-red-950/40 p-3 text-xs text-red-300">
          Erro: {error}. Plugin pode estar indisponível.
        </div>
      )}

      {!error && !showTable && (
        <BrazilMapDDD
          topology={topology}
          buckets={aggregation?.buckets ?? {}}
          palette={view.palette}
          onDddClick={setDrillDdd}
          max={max}
        />
      )}

      {!error && showTable && aggregation && <FallbackTable aggregation={aggregation} />}

      {aggregation && (
        <div className="flex items-center justify-between gap-3">
          <Legend max={max} palette={view.palette} />
          <span className="text-xs text-zinc-500">{loading ? 'Carregando…' : `Total: ${aggregation.total}`}</span>
        </div>
      )}

      <DrillModal
        open={drillDdd !== null}
        viewId={view.id}
        ddd={drillDdd}
        state={state}
        onClose={() => setDrillDdd(null)}
      />
    </div>
  )
}
```

- [ ] Commit:

```bash
git add packages/ui/src/components/geo/geo-view-panel.tsx
git commit -m "feat(geo-ui): GeoViewPanel composes Map+Filter+Legend+Drill+Fallback"
```

---

### Task 22: GeoTabs

**Files:**
- Create: `packages/ui/src/components/geo/geo-tabs.tsx`

```tsx
import { useState } from 'react'
import type { GeoViewsResponse } from './geo.types.js'
import { GeoViewPanel } from './geo-view-panel.js'

export interface GeoTabsProps {
  data: GeoViewsResponse
  topology: { type: 'FeatureCollection'; features: never[] }
}

export function GeoTabs({ data, topology }: GeoTabsProps) {
  const firstGroup = data.groups[0]?.name ?? ''
  const firstView = data.groups[0]?.viewIds[0] ?? ''
  const [groupName, setGroupName] = useState(firstGroup)
  const [viewId, setViewId] = useState(firstView)

  const group = data.groups.find(g => g.name === groupName) ?? data.groups[0]
  const view = data.views.find(v => v.id === viewId) ?? data.views[0]
  if (!group || !view) return null

  return (
    <div className="space-y-4">
      {data.groups.length > 1 && (
        <nav className="flex gap-1 border-b border-zinc-800" role="tablist" aria-label="Grupos">
          {data.groups.map((g) => (
            <button
              key={g.name}
              role="tab"
              aria-selected={g.name === groupName}
              className={`px-4 py-2 text-xs font-medium ${g.name === groupName
                ? 'border-b-2 border-emerald-500 text-zinc-100'
                : 'text-zinc-500 hover:text-zinc-300'}`}
              onClick={() => { setGroupName(g.name); setViewId(g.viewIds[0] ?? '') }}
            >
              {labelize(g.name)}
            </button>
          ))}
        </nav>
      )}

      {group.viewIds.length > 1 && (
        <nav className="flex flex-wrap gap-2" role="tablist" aria-label="Visões">
          {group.viewIds.map((id) => {
            const v = data.views.find(view => view.id === id)
            return (
              <button
                key={id}
                role="tab"
                aria-selected={id === viewId}
                className={`px-3 py-1 text-xs rounded-md ${id === viewId
                  ? 'bg-emerald-600 text-white'
                  : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'}`}
                onClick={() => setViewId(id)}
              >
                {v?.label ?? id}
              </button>
            )
          })}
        </nav>
      )}

      <GeoViewPanel view={view} topology={topology} />
    </div>
  )
}

function labelize(name: string): string {
  return name.split(/[-_.]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}
```

- [ ] Commit:

```bash
git add packages/ui/src/components/geo/geo-tabs.tsx
git commit -m "feat(geo-ui): GeoTabs dynamic groups + sub-tabs"
```

---

### Task 23: GeoPage (root)

**Files:**
- Create: `packages/ui/src/components/geo/geo-page.tsx`

```tsx
import { useEffect, useState } from 'react'
import { CORE_URL, authHeaders } from '../../config.js'
import { GeoTabs } from './geo-tabs.js'
import { EmptyState } from './empty-state.js'
import type { GeoViewsResponse } from './geo.types.js'

export function GeoPage() {
  const [views, setViews] = useState<GeoViewsResponse | null>(null)
  const [topology, setTopology] = useState<{ type: 'FeatureCollection'; features: never[] } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch(`${CORE_URL}/api/v1/geo/views`, { headers: authHeaders() })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(String(r.status))))
      .then(setViews)
      .catch((e) => setError(e.message))
  }, [])

  useEffect(() => {
    fetch('/topology/br-ddds.geojson')
      .then(r => r.ok ? r.json() : Promise.reject(new Error(String(r.status))))
      .then(setTopology)
      .catch((e) => setError(e.message))
  }, [])

  if (error) {
    return (
      <div className="rounded-lg border border-red-900/40 bg-red-950/40 p-4 text-sm text-red-300">
        Erro carregando geolocalização: {error}
      </div>
    )
  }
  if (!views || !topology) {
    return <div className="text-xs text-zinc-500">Carregando geolocalização…</div>
  }
  if (views.views.length === 0) {
    return <EmptyState />
  }
  return <GeoTabs data={views} topology={topology} />
}
```

- [ ] Commit:

```bash
git add packages/ui/src/components/geo/geo-page.tsx
git commit -m "feat(geo-ui): GeoPage root — loads /geo/views + topology, empty state"
```

---

### Task 24: Wire into App.tsx + Sidebar

**Files:**
- Modify: `packages/ui/src/App.tsx`
- Modify: `packages/ui/src/components/sidebar.tsx`

- [ ] **Step 1: App.tsx**

At top, replace any static import of GeoPage with a lazy import:

```ts
import { lazy, Suspense } from 'react'
const GeoPage = lazy(() => import('./components/geo/geo-page.js').then(m => ({ default: m.GeoPage })))
```

In the `Tab` type around line 33, add `'geo'`:

```ts
type Tab = 'devices' | 'queue' | 'senders' | 'sessions' | 'metricas' | 'auditoria' | 'plugins' | 'contatos' | 'admin' | 'mirror' | 'fleet' | 'geo'
```

In the content switch (before final else branch):

```tsx
) : activeTab === 'geo' ? (
  <Suspense fallback={<div className="text-xs text-zinc-500">Carregando geolocalização…</div>}>
    <GeoPage />
  </Suspense>
) : activeTab === 'admin' ? (
```

In keyboard nav useEffect around line 237, after the `if (seqRef.current === 'ga')` line:

```ts
if (seqRef.current === 'gl') { setActiveTab('geo'); seqRef.current = '' }
```

- [ ] **Step 2: Sidebar**

Read `packages/ui/src/components/sidebar.tsx`. Match the pattern used for other tabs (icon + label + tab name). Use `Map` icon from `lucide-react`:

```tsx
import { Map as MapIcon } from 'lucide-react'

// In items list, alongside 'plugins', 'contatos':
{ tab: 'geo' as Tab, label: 'Geolocalização', icon: MapIcon }
```

- [ ] **Step 3: Build + local smoke**

```bash
cd /var/www/adb_tools/packages/ui
pnpm typecheck && pnpm build
```

Expected: clean.

Start dev server from monorepo root and open `http://localhost:5173`, click "Geolocalização".

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/App.tsx packages/ui/src/components/sidebar.tsx
git commit -m "feat(geo-ui): wire Geolocalização tab (lazy) into Sidebar + App.tsx"
```

---

## FASE E — Deploy + gates

### Task 25: Full test + typecheck + build

- [ ] **Step 1:**

```bash
cd /var/www/adb_tools
pnpm test
pnpm -r typecheck
pnpm -r build
```

Expected: all green.

---

### Task 26: Push to origin/main

- [ ] **Step 1:**

```bash
git status
git log --oneline origin/main..HEAD | head -30
git push origin main
```

---

### Task 27: Deploy to Kali

- [ ] **Step 1: SSH pull + build**

```bash
ssh root@dispatch 'cd /var/www/debt-adb-framework && git fetch origin && git checkout main && git pull --ff-only origin main && pnpm install --frozen-lockfile && pnpm -r build'
```

- [ ] **Step 2: Restart**

```bash
ssh root@dispatch 'systemctl restart dispatch-core && sleep 3 && systemctl status dispatch-core --no-pager | head -20'
```

Expected: `active (running)`. (If unit name differs, check `/etc/systemd/system/` for actual dispatch unit.)

- [ ] **Step 3: Verify endpoint**

```bash
ssh root@dispatch 'curl -fsS -H "X-API-Key: $(cat /etc/dispatch.api.key)" http://127.0.0.1:7890/api/v1/geo/views | head -c 400'
```

Expected: HTTP 200 with views/groups keys.

---

### Task 28: Smoke endpoints in production

- [ ] **Step 1: Curl** (API_KEY = the user's dev key)

```bash
curl -fsS -H "X-API-Key: $API_KEY" https://dispatch.tail106aa2.ts.net/api/v1/geo/views | jq '.views[].id'
curl -fsS -H "X-API-Key: $API_KEY" "https://dispatch.tail106aa2.ts.net/api/v1/geo/views/oralsin.sends/aggregate?window=7d&status=sent" | jq .
curl -fsS -H "X-API-Key: $API_KEY" "https://dispatch.tail106aa2.ts.net/api/v1/geo/views/adb-precheck.valid/drill?ddd=11&window=7d" | jq .
```

Expected: HTTP 200 each.

- [ ] **Step 2: UI smoke**

Open https://dispatch.tail106aa2.ts.net/ → login → click "Geolocalização" → verify:
- 1 group tab (adb-precheck has 3 sub-tabs; oralsin has 1)
- Map renders with DDDs colored
- Click DDD → drill modal with rows
- Window filter triggers refetch
- "Ver como tabela" toggle works

- [ ] **Step 3: Screenshot**

Save manually to `/var/www/adb_tools/reports/2026-05-14-geolocation-tab.png` (mkdir reports if missing).

- [ ] **Step 4: Commit + push**

```bash
mkdir -p /var/www/adb_tools/reports
# manual screenshot save to that path
git add reports/2026-05-14-geolocation-tab.png
git commit -m "chore(geo): screenshot proof of Geolocalização tab live in prod"
git push origin main
```

---

### Task 29: Plugin isolation verification

- [ ] **Step 1: Disable Oralsin plugin via admin API**

```bash
curl -fsS -X POST -H "X-API-Key: $API_KEY" https://dispatch.tail106aa2.ts.net/api/v1/admin/plugins/oralsin/disable
```

(Replace with real disable endpoint — check `packages/core/src/api/admin/plugins.ts` or similar for actual path.)

- [ ] **Step 2: Refresh UI**

Expected: oralsin group/sub-tab gone; only adb-precheck shows.

- [ ] **Step 3: Re-enable**

```bash
curl -fsS -X POST -H "X-API-Key: $API_KEY" https://dispatch.tail106aa2.ts.net/api/v1/admin/plugins/oralsin/enable
```

Refresh UI: oralsin returns.

- [ ] **Step 4: Document in progress.md**

Append at end of "Session Notes" in `.dev-state/progress.md`:

```markdown
- 2026-05-14: Geolocalização (plugin-first) shipped. Tab adds dynamic group/view UI driven by
  `ctx.registerGeoView(...)`. 4 views in MVP: oralsin.sends, adb-precheck.{no-match, valid, pipedrive-mapped}.
  Backend: GeoViewRegistry (LRU cache 60s, 5s/8s timeouts), 3 generic REST routes, 3 expressional
  DDD indexes. Frontend: deck.gl GeoJsonLayer choropleth (base map null), dynamic tabs, declarative
  FilterBar, DrillModal, FallbackTable for a11y. Plugin isolation verified — disable Oralsin → its
  tab gone, re-enable → returns. Topology: gist guilhermeprokisch (67 DDDs, license follow-up open).
```

- [ ] **Step 5: Commit + push**

```bash
git add .dev-state/progress.md
git commit -m "docs(progress): Geolocalização shipped + plugin isolation verified"
git push origin main
```

---

### Task 30: Quality gates final checklist

Confirm each:

- [ ] **Plugin isolation 1**: core boot with zero plugins → `/geo/views` returns `{views:[],groups:[]}`, UI shows EmptyState.
- [ ] **Plugin isolation 2**: disable Oralsin → its views disappear (Task 29).
- [ ] **Cobertura**: 4 views render map + filter + legend.
- [ ] **Filtros**: window + status select trigger re-fetch.
- [ ] **Drill**: click DDD opens paginated modal.
- [ ] **Endpoints**: `/geo/views`, `/aggregate`, `/drill` return 200 with X-API-Key (Task 28).
- [ ] **Backend tests**: ~50+ tests passing (8 ddd + 12 registry + 6 validator + 9 routes + 4 oralsin + 8 adb-precheck).
- [ ] **UI build**: tsc + vite build clean.
- [ ] **A11y**: Legend aria-label, FallbackTable toggle, FilterBar role="group".
- [ ] **Deploy**: HEAD local = origin/main = Kali (Task 27).
- [ ] **Screenshot**: `reports/2026-05-14-geolocation-tab.png` committed.

If any fails → STOP, fix, re-deploy.

---

## Self-review

**Spec coverage:**
- §2 (princípio) → Task 1-7. ✓
- §3 (contract) → Task 2. ✓
- §4 (REST) → Task 6. ✓
- §5 (frontend) → Tasks 13-24. ✓
- §6.2 (sources) → Tasks 8-11. ✓
- §6.3 (indices) → Task 7 steps 2-4. ✓
- §6.4 (cache) → Task 3 (LRU). ✓
- §10 (gates) → Task 30. ✓
- §11 (TopoJSON license risk) → Task 14 README. ✓

**Placeholder scan:** zero. Every code step has full block. References that say "adapt to actual" point at concrete file:line context (e.g., `this.db` access pattern, sidebar item shape).

**Type consistency:** `GeoViewDefinition`, `GeoQueryParams`, `GeoAggregation`, `GeoDrillResult` declared in Task 2 — identical shape reused in Tasks 3, 5, 6, 8-11, 15.

**Total tasks:** 30, organized in 5 phases. ~25 commits.
