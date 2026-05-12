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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`DDD ${ddd} drill`}
    >
      <div
        className="bg-zinc-900 border border-zinc-800 rounded-lg max-w-4xl w-full max-h-[80vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between p-4 border-b border-zinc-800">
          <h2 className="text-sm font-semibold">DDD {ddd} — registros</h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-100 text-xl leading-none" aria-label="Fechar">×</button>
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
