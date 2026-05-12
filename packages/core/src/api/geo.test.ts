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
