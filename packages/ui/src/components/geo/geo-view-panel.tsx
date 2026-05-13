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

  // Re-init filter state when view changes
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
  const median = useMemo(() => {
    if (!aggregation) return 0
    const values = Object.values(aggregation.buckets).filter(v => v > 0).sort((a, b) => a - b)
    if (values.length === 0) return 0
    return values[Math.floor(values.length / 2)] ?? 0
  }, [aggregation])

  const topDdds = useMemo(() => {
    if (!aggregation) return []
    return Object.entries(aggregation.buckets)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
  }, [aggregation])

  return (
    <div className="space-y-4">
      {/* Header: title + total stat */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-base font-semibold text-zinc-100">{view.label}</h2>
          {view.description && (
            <p className="mt-1 text-xs text-zinc-500 max-w-2xl">{view.description}</p>
          )}
        </div>
        {aggregation && (
          <div className="flex items-center gap-4 text-sm">
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-wider text-zinc-500">Total</div>
              <div className="text-xl font-bold text-emerald-400 tabular-nums">
                {aggregation.total.toLocaleString('pt-BR')}
              </div>
            </div>
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-wider text-zinc-500">DDDs</div>
              <div className="text-xl font-bold text-zinc-300 tabular-nums">
                {Object.keys(aggregation.buckets).length}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Controls */}
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

      {error && (
        <div className="rounded-lg border border-red-900/40 bg-red-950/40 p-3 text-xs text-red-300">
          Erro: {error}. Plugin pode estar indisponível.
        </div>
      )}

      {loading && !aggregation && (
        <div className="text-xs text-zinc-500 p-4">Carregando agregação…</div>
      )}

      {!error && !showTable && aggregation && (
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-4">
          <BrazilMapDDD
            topology={topology}
            buckets={aggregation.buckets}
            palette={view.palette}
            onDddClick={setDrillDdd}
            max={max}
          />
          {/* Top-K sidebar */}
          <aside className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 flex flex-col">
            <h3 className="text-[10px] uppercase tracking-wider text-zinc-500 font-medium mb-2">
              Top DDDs
            </h3>
            <ol className="space-y-1 flex-1">
              {topDdds.map(([ddd, count], i) => (
                <li key={ddd}>
                  <button
                    type="button"
                    onClick={() => setDrillDdd(ddd)}
                    className="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded hover:bg-zinc-800/60 transition-colors group"
                  >
                    <span className="flex items-center gap-2">
                      <span className="text-[10px] text-zinc-600 font-mono w-4 text-right">{i + 1}</span>
                      <span className="font-mono text-sm text-zinc-200 group-hover:text-emerald-400">
                        {ddd}
                      </span>
                    </span>
                    <span className="font-mono text-xs text-zinc-400 tabular-nums">
                      {count.toLocaleString('pt-BR')}
                    </span>
                  </button>
                </li>
              ))}
              {topDdds.length === 0 && (
                <li className="text-xs text-zinc-500 italic px-2">Sem dados na janela</li>
              )}
            </ol>
            <p className="text-[10px] text-zinc-600 mt-2 pt-2 border-t border-zinc-800">
              Clique pra detalhar
            </p>
          </aside>
        </div>
      )}

      {!error && showTable && aggregation && <FallbackTable aggregation={aggregation} />}

      {aggregation && (
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <Legend max={max} palette={view.palette} median={median} />
          {loading && (
            <span className="text-xs text-zinc-500 whitespace-nowrap animate-pulse">
              Atualizando…
            </span>
          )}
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
