import { useEffect, useMemo, useState } from 'react'
import { CORE_URL, authHeaders } from '../../config.js'
import { BrazilMapDDD } from './brazil-map-ddd.js'
import { FilterBar } from './filter-bar.js'
import { Legend } from './legend.js'
import { DrillModal } from './drill-modal.js'
import { FallbackTable } from './fallback-table.js'
import type { DddTopology, GeoAggregation, GeoFilterState, GeoViewSummary } from './geo.types.js'

export interface GeoViewPanelProps {
  view: GeoViewSummary
  topology: DddTopology
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

  // Re-init filter state when view changes (e.g. tab switch)
  useEffect(() => { setState(initialState) }, [initialState])

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
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <FilterBar specs={view.filters} state={state} onChange={setState} />
        <button
          type="button"
          onClick={() => setShowTable(v => !v)}
          className="text-xs text-zinc-400 hover:text-zinc-100 underline whitespace-nowrap"
        >
          {showTable ? 'Ver mapa' : 'Ver como tabela'}
        </button>
      </div>

      {view.description && (
        <p className="text-xs text-zinc-500">{view.description}</p>
      )}

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
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <Legend max={max} palette={view.palette} />
          <span className="text-xs text-zinc-500 whitespace-nowrap">
            {loading ? 'Carregando…' : `Total: ${aggregation.total}`}
          </span>
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
