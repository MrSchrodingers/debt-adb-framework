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
