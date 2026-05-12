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
