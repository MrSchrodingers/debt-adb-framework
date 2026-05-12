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
    expect(registry.get('oralsin.sends')?.id).toBe('oralsin.sends')
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
