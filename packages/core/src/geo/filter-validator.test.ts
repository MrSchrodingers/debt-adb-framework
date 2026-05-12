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
