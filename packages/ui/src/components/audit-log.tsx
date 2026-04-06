import { useEffect, useState, useCallback } from 'react'
import { CORE_URL, authHeaders } from '../config'

// ── Types ──

interface AuditItem {
  id: string
  source: 'queue' | 'history'
  direction: 'incoming' | 'outgoing'
  fromNumber: string | null
  toNumber: string | null
  text: string | null
  status: string | null
  capturedVia: string | null
  pluginName: string | null
  correlationId: string | null
  createdAt: string
}

interface AuditListResult {
  items: AuditItem[]
  total: number
  limit: number
  offset: number
}

interface TimelineEvent {
  event: string
  timestamp: string
  detail: string | null
}

// ── Filter chips ──

const STATUS_OPTIONS = ['queued', 'locked', 'sending', 'sent', 'failed', 'permanently_failed'] as const
const DIRECTION_OPTIONS = [
  { value: '', label: 'Todos' },
  { value: 'incoming', label: 'Entrada' },
  { value: 'outgoing', label: 'Saida' },
] as const

const directionLabels: Record<string, string> = {
  incoming: 'Entrada',
  outgoing: 'Saida',
}

const statusStyles: Record<string, string> = {
  queued: 'text-zinc-400 bg-zinc-800',
  locked: 'text-blue-400 bg-blue-950',
  sending: 'text-yellow-400 bg-yellow-950',
  sent: 'text-emerald-400 bg-emerald-950',
  failed: 'text-red-400 bg-red-950',
  permanently_failed: 'text-red-400 bg-red-950',
}

const directionStyles: Record<string, string> = {
  incoming: 'text-cyan-400 bg-cyan-950',
  outgoing: 'text-violet-400 bg-violet-950',
}

// ── CSV Export ──

function exportToCsv(items: AuditItem[]): void {
  const headers = ['Direcao', 'De', 'Para', 'Texto', 'Status', 'Via', 'Criado']
  const rows = items.map(item => [
    item.direction,
    item.fromNumber ?? '',
    item.toNumber ?? '',
    (item.text ?? '').replace(/"/g, '""'),
    item.status ?? '',
    item.capturedVia ?? (item.source === 'queue' ? 'adb_queue' : ''),
    item.createdAt,
  ])

  const csv = [
    headers.join(','),
    ...rows.map(r => r.map(c => `"${c}"`).join(',')),
  ].join('\n')

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `auditoria-${new Date().toISOString().slice(0, 10)}.csv`
  link.click()
  URL.revokeObjectURL(url)
}

// ── Component ──

export function AuditLog() {
  const [items, setItems] = useState<AuditItem[]>([])
  const [total, setTotal] = useState(0)
  const [limit] = useState(50)
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(false)

  // Filters
  const [phone, setPhone] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [status, setStatus] = useState('')
  const [direction, setDirection] = useState('')

  // Timeline expansion
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [timeline, setTimeline] = useState<TimelineEvent[]>([])
  const [timelineLoading, setTimelineLoading] = useState(false)

  const fetchItems = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      params.set('limit', String(limit))
      params.set('offset', String(offset))
      if (phone) params.set('phone', phone)
      if (dateFrom) params.set('dateFrom', dateFrom)
      if (dateTo) params.set('dateTo', dateTo)
      if (status) params.set('status', status)
      if (direction) params.set('direction', direction)

      const res = await fetch(`${CORE_URL}/api/v1/audit/messages?${params}`, {
        headers: authHeaders(),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data: AuditListResult = await res.json()
      setItems(data.items)
      setTotal(data.total)
    } catch {
      setItems([])
      setTotal(0)
    } finally {
      setLoading(false)
    }
  }, [limit, offset, phone, dateFrom, dateTo, status, direction])

  useEffect(() => {
    fetchItems()
  }, [fetchItems])

  // Reset offset when filters change
  useEffect(() => {
    setOffset(0)
  }, [phone, dateFrom, dateTo, status, direction])

  const fetchTimeline = useCallback(async (id: string) => {
    if (expandedId === id) {
      setExpandedId(null)
      return
    }
    setTimelineLoading(true)
    setExpandedId(id)
    try {
      const res = await fetch(`${CORE_URL}/api/v1/audit/messages/${id}`, {
        headers: authHeaders(),
      })
      if (!res.ok) {
        setTimeline([])
        return
      }
      const data: TimelineEvent[] = await res.json()
      setTimeline(data)
    } catch {
      setTimeline([])
    } finally {
      setTimelineLoading(false)
    }
  }, [expandedId])

  const pageStart = offset + 1
  const pageEnd = Math.min(offset + limit, total)
  const hasPrev = offset > 0
  const hasNext = offset + limit < total

  return (
    <div className="space-y-4">
      {/* Filter Bar */}
      <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/60 p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          {/* Phone search */}
          <div className="relative">
            <svg
              className="absolute left-2.5 top-2.5 h-4 w-4 text-zinc-500"
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="M21 21l-4.35-4.35" />
            </svg>
            <input
              type="text"
              placeholder="Buscar telefone..."
              value={phone}
              onChange={e => setPhone(e.target.value)}
              className="rounded-lg bg-zinc-800/80 border border-zinc-700 pl-9 pr-3 py-1.5 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-600 w-48"
            />
          </div>

          {/* Date range */}
          <input
            type="date"
            value={dateFrom}
            onChange={e => setDateFrom(e.target.value)}
            className="rounded-lg bg-zinc-800/80 border border-zinc-700 px-3 py-1.5 text-sm text-zinc-100 focus:outline-none focus:ring-1 focus:ring-zinc-600"
          />
          <span className="text-zinc-500 text-xs">ate</span>
          <input
            type="date"
            value={dateTo}
            onChange={e => setDateTo(e.target.value)}
            className="rounded-lg bg-zinc-800/80 border border-zinc-700 px-3 py-1.5 text-sm text-zinc-100 focus:outline-none focus:ring-1 focus:ring-zinc-600"
          />

          {/* CSV Export */}
          <button
            onClick={() => exportToCsv(items)}
            disabled={items.length === 0}
            className="ml-auto rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700 disabled:opacity-50 transition"
          >
            Exportar CSV
          </button>
        </div>

        {/* Direction chips */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-500 mr-1">Direcao:</span>
          {DIRECTION_OPTIONS.map(opt => (
            <button
              key={opt.value}
              onClick={() => setDirection(opt.value)}
              className={`rounded-full px-2.5 py-1 text-xs border transition ${
                direction === opt.value
                  ? 'border-zinc-500 bg-zinc-700 text-zinc-100'
                  : 'border-zinc-800 text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {opt.label}
            </button>
          ))}

          <span className="text-xs text-zinc-500 ml-4 mr-1">Status:</span>
          {STATUS_OPTIONS.map(s => (
            <button
              key={s}
              onClick={() => setStatus(status === s ? '' : s)}
              className={`rounded-full px-2.5 py-1 text-xs border transition ${
                status === s
                  ? 'border-zinc-500 bg-zinc-700 text-zinc-100'
                  : 'border-zinc-800 text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* Results */}
      <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/60">
        {loading ? (
          <div className="p-6 text-center text-zinc-500 text-sm">Carregando...</div>
        ) : items.length === 0 ? (
          <div className="p-6 text-center text-zinc-500 text-sm">Nenhum registro encontrado.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-left text-zinc-500">
                  <th className="p-3">Direcao</th>
                  <th className="p-3">De</th>
                  <th className="p-3">Para</th>
                  <th className="p-3">Texto</th>
                  <th className="p-3">Status</th>
                  <th className="p-3">Via</th>
                  <th className="p-3">Criado</th>
                </tr>
              </thead>
              <tbody>
                {items.map(item => (
                  <>
                    <tr
                      key={item.id}
                      onClick={() => item.source === 'queue' ? fetchTimeline(item.id) : undefined}
                      className={`border-b border-zinc-800/50 transition ${
                        item.source === 'queue' ? 'cursor-pointer hover:bg-zinc-800/40' : ''
                      } ${expandedId === item.id ? 'bg-zinc-800/30' : ''}`}
                    >
                      <td className="p-3">
                        <span className={`rounded px-2 py-0.5 text-xs ${directionStyles[item.direction] ?? ''}`}>
                          {directionLabels[item.direction] ?? item.direction}
                        </span>
                      </td>
                      <td className="p-3 font-mono text-xs">{item.fromNumber ?? '-'}</td>
                      <td className="p-3 font-mono text-xs">{item.toNumber ?? '-'}</td>
                      <td className="p-3 max-w-xs truncate">{item.text ?? '-'}</td>
                      <td className="p-3">
                        {item.status ? (
                          <span className={`rounded px-2 py-0.5 text-xs ${statusStyles[item.status] ?? ''}`}>
                            {item.status}
                          </span>
                        ) : (
                          <span className="text-zinc-600 text-xs">-</span>
                        )}
                      </td>
                      <td className="p-3 text-xs text-zinc-500">
                        {item.capturedVia ?? (item.source === 'queue' ? 'adb_queue' : '-')}
                      </td>
                      <td className="p-3 text-xs text-zinc-500">
                        {new Date(item.createdAt).toLocaleString('pt-BR')}
                      </td>
                    </tr>
                    {expandedId === item.id && (
                      <tr key={`${item.id}-timeline`}>
                        <td colSpan={7} className="p-0">
                          <TimelinePanel events={timeline} loading={timelineLoading} />
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {total > 0 && (
          <div className="flex items-center justify-between border-t border-zinc-800 px-4 py-3">
            <span className="text-xs text-zinc-500">
              {pageStart}-{pageEnd} de {total}
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => setOffset(Math.max(0, offset - limit))}
                disabled={!hasPrev}
                className="rounded bg-zinc-800 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-700 disabled:opacity-50 transition"
              >
                Anterior
              </button>
              <button
                onClick={() => setOffset(offset + limit)}
                disabled={!hasNext}
                className="rounded bg-zinc-800 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-700 disabled:opacity-50 transition"
              >
                Proximo
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Timeline Sub-component ──

function TimelinePanel({ events, loading }: { events: TimelineEvent[]; loading: boolean }) {
  if (loading) {
    return <div className="p-4 text-xs text-zinc-500">Carregando timeline...</div>
  }
  if (events.length === 0) {
    return <div className="p-4 text-xs text-zinc-500">Nenhum evento encontrado.</div>
  }

  const eventColors: Record<string, string> = {
    queued: 'bg-zinc-500',
    locked: 'bg-blue-500',
    sending: 'bg-yellow-500',
    adb_send: 'bg-violet-500',
    sent: 'bg-emerald-500',
    waha_captured: 'bg-cyan-500',
    failed: 'bg-red-500',
    permanently_failed: 'bg-red-600',
  }

  return (
    <div className="bg-zinc-950/50 border-t border-zinc-800/50 px-6 py-4">
      <h4 className="text-xs font-medium text-zinc-400 mb-3">Timeline</h4>
      <div className="relative space-y-3 pl-4">
        {/* Vertical line */}
        <div className="absolute left-[7px] top-2 bottom-2 w-px bg-zinc-700" />

        {events.map((ev, idx) => (
          <div key={idx} className="relative flex items-start gap-3">
            <div className={`mt-1.5 h-2.5 w-2.5 rounded-full ring-2 ring-zinc-900 ${eventColors[ev.event] ?? 'bg-zinc-600'}`} />
            <div>
              <span className="text-xs font-medium text-zinc-200">{ev.event}</span>
              <span className="text-xs text-zinc-500 ml-2">
                {new Date(ev.timestamp).toLocaleString('pt-BR')}
              </span>
              {ev.detail && (
                <span className="text-xs text-zinc-600 ml-2">({ev.detail})</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
