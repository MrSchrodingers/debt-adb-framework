import { useState, useEffect, useCallback } from 'react'
import { CORE_URL, authHeaders } from '../config'

// ── Types ──────────────────────────────────────────────────────────────────

interface HeatmapRow {
  sender: string
  label: string
  hours: number[] // 24 entries
}

interface HeatmapResponse {
  rows: HeatmapRow[]
}

interface ErrorHeatmapRow {
  signature: string
  hours: number[] // 24 entries
  examples: string[] // up to 3 message ids
}

interface ErrorHeatmapResponse {
  rows: ErrorHeatmapRow[]
}

// ── Helpers ────────────────────────────────────────────────────────────────

function cellColor(count: number, max: number): string {
  if (count === 0 || max === 0) return '#18181b' // zinc-900 — empty
  const ratio = count / max
  if (ratio < 0.33) return '#14532d' // green-900 — low
  if (ratio < 0.66) return '#854d0e' // yellow-800 — medium
  return '#991b1b' // red-800 — high
}

function textColor(count: number, max: number): string {
  if (count === 0 || max === 0) return '#3f3f46' // zinc-700
  const ratio = count / max
  if (ratio < 0.33) return '#86efac' // green-300
  if (ratio < 0.66) return '#fde047' // yellow-300
  return '#fca5a5' // red-300
}

const HOURS = Array.from({ length: 24 }, (_, i) => i)

// ── Sends Heatmap ──────────────────────────────────────────────────────────

interface SendsHeatmapProps {
  onCellClick?: (sender: string, hour: number) => void
}

export function SendsHeatmap({ onCellClick }: SendsHeatmapProps) {
  const [data, setData] = useState<HeatmapResponse | null>(null)
  const [range, setRange] = useState<'24h' | '7d'>('24h')
  const [tooltip, setTooltip] = useState<{ sender: string; hour: number; count: number } | null>(null)

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`${CORE_URL}/api/v1/insights/heatmap?range=${range}`, {
        headers: authHeaders(),
      })
      if (res.ok) {
        const json = (await res.json()) as HeatmapResponse
        setData(json)
      }
    } catch {
      // silently fail
    }
  }, [range])

  useEffect(() => {
    void fetchData()
  }, [fetchData])

  const maxCount = data
    ? Math.max(1, ...data.rows.flatMap((r) => r.hours))
    : 1

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-medium text-zinc-400">Mapa de Calor — Envios por Remetente/Hora</h3>
        <div className="flex gap-1 bg-zinc-800 rounded-md p-0.5">
          {(['24h', '7d'] as const).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`px-2 py-0.5 text-xs rounded transition ${
                range === r
                  ? 'bg-zinc-700 text-zinc-100'
                  : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      {!data || data.rows.length === 0 ? (
        <p className="text-zinc-500 text-sm text-center py-8">Sem dados de envio no período</p>
      ) : (
        <div className="overflow-x-auto">
          {/* Hour axis header */}
          <div className="flex mb-1 ml-16">
            {HOURS.map((h) => (
              <div
                key={h}
                className="flex-none text-center text-zinc-600"
                style={{ width: 28, fontSize: 9 }}
              >
                {h % 4 === 0 ? `${String(h).padStart(2, '0')}h` : ''}
              </div>
            ))}
          </div>

          {/* Rows */}
          {data.rows.map((row) => (
            <div key={row.sender} className="flex items-center mb-0.5">
              {/* Sender label */}
              <div
                className="flex-none text-right pr-2 text-zinc-400 font-mono truncate"
                style={{ width: 60, fontSize: 10 }}
                title={row.sender}
              >
                {row.label}
              </div>

              {/* Hour cells */}
              {HOURS.map((h) => {
                const count = row.hours[h] ?? 0
                const bg = cellColor(count, maxCount)
                const fg = textColor(count, maxCount)
                return (
                  <div
                    key={h}
                    role="button"
                    tabIndex={0}
                    className="flex-none flex items-center justify-center cursor-pointer rounded-sm transition-opacity hover:opacity-80 focus:outline-none focus:ring-1 focus:ring-zinc-500"
                    style={{ width: 28, height: 22, backgroundColor: bg, fontSize: 9, color: fg }}
                    onMouseEnter={() => setTooltip({ sender: row.sender, hour: h, count })}
                    onMouseLeave={() => setTooltip(null)}
                    onClick={() => onCellClick?.(row.sender, h)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') onCellClick?.(row.sender, h)
                    }}
                    title={`${row.sender} — ${String(h).padStart(2, '0')}:00 — ${count} envios`}
                  >
                    {count > 0 ? count : ''}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      )}

      {/* Tooltip overlay */}
      {tooltip && (
        <div className="mt-2 text-xs text-zinc-400">
          {tooltip.sender} | {String(tooltip.hour).padStart(2, '0')}:00–{String(tooltip.hour + 1).padStart(2, '0')}:00
          {' '}— {tooltip.count} envio{tooltip.count !== 1 ? 's' : ''}
        </div>
      )}

      {/* Legend */}
      <div className="flex items-center gap-3 mt-3">
        <span className="text-xs text-zinc-500">Legenda:</span>
        {[
          { bg: '#14532d', label: 'Baixo' },
          { bg: '#854d0e', label: 'Médio' },
          { bg: '#991b1b', label: 'Alto' },
        ].map(({ bg, label }) => (
          <div key={label} className="flex items-center gap-1">
            <div className="h-3 w-5 rounded-sm" style={{ backgroundColor: bg }} />
            <span className="text-xs text-zinc-500">{label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Error Heatmap ──────────────────────────────────────────────────────────

interface ErrorHeatmapProps {
  onCellClick?: (signature: string, hour: number, examples: string[]) => void
}

export function ErrorHeatmap({ onCellClick }: ErrorHeatmapProps) {
  const [data, setData] = useState<ErrorHeatmapResponse | null>(null)
  const [range, setRange] = useState<'24h' | '7d'>('24h')
  const [activeCell, setActiveCell] = useState<{ sig: string; hour: number; examples: string[] } | null>(null)

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`${CORE_URL}/api/v1/insights/error-heatmap?range=${range}`, {
        headers: authHeaders(),
      })
      if (res.ok) {
        const json = (await res.json()) as ErrorHeatmapResponse
        setData(json)
      }
    } catch {
      // silently fail
    }
  }, [range])

  useEffect(() => {
    void fetchData()
  }, [fetchData])

  const maxCount = data
    ? Math.max(1, ...data.rows.flatMap((r) => r.hours))
    : 1

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-medium text-zinc-400">Mapa de Calor — Erros por Tipo/Hora</h3>
        <div className="flex gap-1 bg-zinc-800 rounded-md p-0.5">
          {(['24h', '7d'] as const).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`px-2 py-0.5 text-xs rounded transition ${
                range === r
                  ? 'bg-zinc-700 text-zinc-100'
                  : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      {!data || data.rows.length === 0 ? (
        <p className="text-zinc-500 text-sm text-center py-8">Nenhum erro registrado no período</p>
      ) : (
        <div className="overflow-x-auto">
          {/* Hour axis */}
          <div className="flex mb-1 ml-56">
            {HOURS.map((h) => (
              <div
                key={h}
                className="flex-none text-center text-zinc-600"
                style={{ width: 28, fontSize: 9 }}
              >
                {h % 4 === 0 ? `${String(h).padStart(2, '0')}h` : ''}
              </div>
            ))}
          </div>

          {data.rows.map((row) => (
            <div key={row.signature} className="flex items-center mb-0.5">
              {/* Signature label */}
              <div
                className="flex-none text-right pr-2 text-zinc-400 font-mono truncate"
                style={{ width: 220, fontSize: 10 }}
                title={row.signature}
              >
                {row.signature}
              </div>

              {/* Hour cells */}
              {HOURS.map((h) => {
                const count = row.hours[h] ?? 0
                const bg = cellColor(count, maxCount)
                const fg = textColor(count, maxCount)
                return (
                  <div
                    key={h}
                    role="button"
                    tabIndex={0}
                    className="flex-none flex items-center justify-center cursor-pointer rounded-sm transition-opacity hover:opacity-80 focus:outline-none focus:ring-1 focus:ring-zinc-500"
                    style={{ width: 28, height: 22, backgroundColor: bg, fontSize: 9, color: fg }}
                    onMouseEnter={() =>
                      setActiveCell({ sig: row.signature, hour: h, examples: row.examples })
                    }
                    onMouseLeave={() => setActiveCell(null)}
                    onClick={() => onCellClick?.(row.signature, h, row.examples)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ')
                        onCellClick?.(row.signature, h, row.examples)
                    }}
                    title={`${row.signature} — ${String(h).padStart(2, '0')}:00 — ${count} erros`}
                  >
                    {count > 0 ? count : ''}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      )}

      {/* Cell hover: show examples */}
      {activeCell && activeCell.examples.length > 0 && (
        <div className="mt-2 p-2 rounded-md bg-zinc-800/60 border border-zinc-700/40">
          <p className="text-xs text-zinc-400 mb-1 font-medium">
            {activeCell.sig} | {String(activeCell.hour).padStart(2, '0')}:00 — exemplos:
          </p>
          <ul className="space-y-0.5">
            {activeCell.examples.map((id) => (
              <li key={id} className="font-mono text-xs text-zinc-500">
                {id}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
