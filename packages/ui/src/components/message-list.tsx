import { useState, useCallback, useEffect } from 'react'
import { Search, ChevronLeft, ChevronRight, X, RotateCcw, Download } from 'lucide-react'
import { CORE_URL, authHeaders } from '../config'
import type { Message } from '../types'
import { formatRelativeTime } from '../utils/time'
import { MessageTimeline } from './message-timeline'
import { useCsvExport } from '../utils/csv'

const STATUS_FILTERS = ['all', 'queued', 'sending', 'sent', 'failed'] as const
type StatusFilter = (typeof STATUS_FILTERS)[number]

const statusStyles: Record<string, string> = {
  queued: 'text-zinc-400 bg-zinc-800',
  locked: 'text-blue-400 bg-blue-950',
  sending: 'text-yellow-400 bg-yellow-950',
  sent: 'text-emerald-400 bg-emerald-950',
  failed: 'text-red-400 bg-red-950',
  permanently_failed: 'text-red-400 bg-red-950',
  waiting_device: 'text-amber-400 bg-amber-950',
}

const PAGE_SIZE = 50

interface PaginatedResponse {
  data: Message[]
  total: number
}

interface MessageListProps {
  senderNumber?: string | null
}

interface BulkRetryResponse {
  retried: number
  failed: Array<{ id: string; reason: string }>
  skipped: string[]
}

export function MessageList({ senderNumber }: MessageListProps = {}) {
  const [messages, setMessages] = useState<Message[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [phoneSearch, setPhoneSearch] = useState('')
  const [loading, setLoading] = useState(false)

  // Timeline drawer state (Task 7.1)
  const [drawerMessageId, setDrawerMessageId] = useState<string | null>(null)

  // Bulk retry state (Task 7.2)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [retrying, setRetrying] = useState(false)
  const [retryResult, setRetryResult] = useState<BulkRetryResponse | null>(null)

  const fetchMessages = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      params.set('limit', String(PAGE_SIZE))
      params.set('offset', String(offset))
      if (statusFilter !== 'all') {
        params.set('status', statusFilter)
      }
      if (phoneSearch.trim()) {
        params.set('phone', phoneSearch.trim())
      }
      if (senderNumber) {
        params.set('senderNumber', senderNumber)
      }

      const res = await fetch(`${CORE_URL}/api/v1/messages?${params.toString()}`, { headers: authHeaders() })
      if (!res.ok) return

      const data: PaginatedResponse = await res.json()
      setMessages(data.data)
      setTotal(data.total)
    } catch {
      // silently fail
    } finally {
      setLoading(false)
    }
  }, [offset, statusFilter, phoneSearch, senderNumber])

  useEffect(() => {
    fetchMessages()
  }, [fetchMessages])

  // Reset offset when filters change
  const handleStatusChange = (status: StatusFilter) => {
    setStatusFilter(status)
    setOffset(0)
    setSelected(new Set())
  }

  const handlePhoneChange = (value: string) => {
    setPhoneSearch(value)
    setOffset(0)
    setSelected(new Set())
  }

  // Row click opens drawer (Task 7.1)
  const handleRowClick = (id: string) => {
    setDrawerMessageId(prev => (prev === id ? null : id))
  }

  // Checkbox logic (Task 7.2)
  const allSelected = messages.length > 0 && messages.every(m => selected.has(m.id))
  const someSelected = !allSelected && messages.some(m => selected.has(m.id))

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelected(new Set())
    } else {
      setSelected(new Set(messages.map(m => m.id)))
    }
    setRetryResult(null)
  }

  const toggleSelect = (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
    setRetryResult(null)
  }

  // Bulk retry (Task 7.2)
  const handleBulkRetry = useCallback(async () => {
    if (selected.size === 0 || retrying) return
    setRetrying(true)
    setRetryResult(null)
    try {
      const res = await fetch(`${CORE_URL}/api/v1/admin/messages/bulk-retry`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ message_ids: [...selected] }),
      })
      if (res.ok) {
        const data: BulkRetryResponse = await res.json()
        setRetryResult(data)
        setSelected(new Set())
        // Refresh list after retry
        void fetchMessages()
      }
    } catch {
      // silently fail
    } finally {
      setRetrying(false)
    }
  }, [selected, retrying, fetchMessages])

  // CSV export (Task 7.4)
  const csvFields = ['id', 'to', 'body', 'status', 'pluginName', 'priority', 'createdAt'] as const
  const { exportToCsv } = useCsvExport(messages, `mensagens-${new Date().toISOString().slice(0, 10)}.csv`, csvFields)

  const currentPage = Math.floor(offset / PAGE_SIZE) + 1
  const totalPages = Math.ceil(total / PAGE_SIZE)
  const rangeStart = total === 0 ? 0 : offset + 1
  const rangeEnd = Math.min(offset + PAGE_SIZE, total)

  return (
    <div className="space-y-3">
      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        {/* Status filter chips */}
        <div className="flex flex-wrap gap-1.5">
          {STATUS_FILTERS.map((status) => (
            <button
              key={status}
              onClick={() => handleStatusChange(status)}
              className={`rounded-full px-2.5 py-1 text-xs border transition min-h-[44px] sm:min-h-0 ${
                statusFilter === status
                  ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                  : 'bg-zinc-800/60 text-zinc-400 border-zinc-700/40 hover:bg-zinc-700/60'
              }`}
            >
              {status === 'all' ? 'Todos' : status.charAt(0).toUpperCase() + status.slice(1)}
            </button>
          ))}
        </div>

        {/* Phone search */}
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-500" />
          <input
            type="text"
            placeholder="Buscar telefone..."
            value={phoneSearch}
            onChange={(e) => handlePhoneChange(e.target.value)}
            className="w-full rounded-lg bg-zinc-800/80 border border-zinc-700/40 pl-10 pr-3 py-2.5 text-sm text-zinc-200 placeholder:text-zinc-500 focus:outline-none focus:border-zinc-600 min-h-[44px]"
          />
        </div>

        {/* Export CSV button */}
        <button
          onClick={() => exportToCsv()}
          disabled={messages.length === 0}
          className="ml-auto flex items-center gap-1.5 rounded-lg bg-zinc-800 border border-zinc-700/40 px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-700 disabled:opacity-50 transition"
          title="Exportar CSV"
        >
          <Download className="h-3.5 w-3.5" />
          CSV
        </button>
      </div>

      {/* Retry result feedback */}
      {retryResult && (
        <div className="rounded-lg border border-zinc-700 bg-zinc-800/60 px-3 py-2 text-xs text-zinc-300 flex items-center gap-2">
          <span className="text-emerald-400">{retryResult.retried} reenfileiradas</span>
          {retryResult.failed.length > 0 && (
            <span className="text-red-400">{retryResult.failed.length} falharam</span>
          )}
          {retryResult.skipped.length > 0 && (
            <span className="text-zinc-500">{retryResult.skipped.length} ignoradas</span>
          )}
          <button
            onClick={() => setRetryResult(null)}
            className="ml-auto text-zinc-500 hover:text-zinc-300"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      {/* Table */}
      {loading ? (
        <p className="text-zinc-500 text-sm">Carregando...</p>
      ) : messages.length === 0 ? (
        <p className="text-zinc-500 text-sm">Nenhuma mensagem encontrada.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 text-left text-zinc-500">
                {/* Select-all checkbox */}
                <th className="pb-2 pr-2 w-8">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    ref={el => {
                      if (el) el.indeterminate = someSelected
                    }}
                    onChange={toggleSelectAll}
                    className="rounded border-zinc-600 bg-zinc-800 text-emerald-500 focus:ring-0 cursor-pointer"
                  />
                </th>
                <th className="pb-2 pr-4">Para</th>
                <th className="pb-2 pr-4 hidden sm:table-cell">Corpo</th>
                <th className="pb-2 pr-4">Status</th>
                <th className="pb-2 pr-4 hidden sm:table-cell">Plugin</th>
                <th className="pb-2 pr-4 hidden md:table-cell">Prioridade</th>
                <th className="pb-2">Criado</th>
              </tr>
            </thead>
            <tbody>
              {messages.map((msg) => (
                <tr
                  key={msg.id}
                  onClick={() => handleRowClick(msg.id)}
                  className={`border-b border-zinc-800/50 cursor-pointer transition-colors hover:bg-zinc-800/30 ${
                    drawerMessageId === msg.id ? 'bg-zinc-800/30' : ''
                  }`}
                >
                  {/* Per-row checkbox */}
                  <td className="py-2 pr-2" onClick={e => toggleSelect(msg.id, e)}>
                    <input
                      type="checkbox"
                      checked={selected.has(msg.id)}
                      onChange={() => {/* handled by td onClick */}}
                      onClick={e => e.stopPropagation()}
                      className="rounded border-zinc-600 bg-zinc-800 text-emerald-500 focus:ring-0 cursor-pointer"
                    />
                  </td>
                  <td className="py-2 pr-4 font-mono text-xs">{msg.to}</td>
                  <td className="py-2 pr-4 max-w-xs truncate hidden sm:table-cell">{msg.body}</td>
                  <td className="py-2 pr-4">
                    <span
                      className={`rounded px-2 py-0.5 text-xs ${statusStyles[msg.status] ?? ''}`}
                    >
                      {msg.status}
                    </span>
                  </td>
                  <td className="py-2 pr-4 text-zinc-500 text-xs hidden sm:table-cell">
                    {msg.pluginName ?? '-'}
                  </td>
                  <td className="py-2 pr-4 text-zinc-500 hidden md:table-cell">{msg.priority}</td>
                  <td className="py-2 text-xs text-zinc-500" title={new Date(msg.createdAt).toLocaleString()}>
                    {formatRelativeTime(msg.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Timeline Drawer (Task 7.1) */}
      {drawerMessageId && (
        <div className="rounded-xl border border-zinc-700/60 bg-zinc-900/80 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-zinc-800">
            <span className="text-xs font-medium text-zinc-300">
              Timeline — <span className="font-mono text-zinc-500">{drawerMessageId.slice(0, 12)}...</span>
            </span>
            <button
              onClick={() => setDrawerMessageId(null)}
              className="text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <MessageTimeline messageId={drawerMessageId} />
        </div>
      )}

      {/* Pagination */}
      {total > 0 && (
        <div className="flex items-center justify-between">
          <span className="text-xs text-zinc-500">
            {rangeStart}-{rangeEnd} de {total}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              disabled={offset === 0}
              className="rounded-lg bg-zinc-800 border border-zinc-700/40 px-3 py-2 text-xs text-zinc-400 hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed min-h-[44px] sm:min-h-0"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-xs text-zinc-400">
              {currentPage} / {totalPages}
            </span>
            <button
              onClick={() => setOffset(offset + PAGE_SIZE)}
              disabled={offset + PAGE_SIZE >= total}
              className="rounded-lg bg-zinc-800 border border-zinc-700/40 px-3 py-2 text-xs text-zinc-400 hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed min-h-[44px] sm:min-h-0"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* Floating Bulk Action Bar (Task 7.2) */}
      {selected.size > 0 && (
        <div className="sticky bottom-4 flex items-center gap-3 rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-3 shadow-xl">
          <span className="text-xs text-zinc-400">
            {selected.size} mensagem{selected.size !== 1 ? 's' : ''} selecionada{selected.size !== 1 ? 's' : ''}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={handleBulkRetry}
              disabled={retrying}
              className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50 transition min-h-[44px] sm:min-h-0"
            >
              <RotateCcw className={`h-3.5 w-3.5 ${retrying ? 'animate-spin' : ''}`} />
              {retrying ? 'Reenfileirando...' : `Retry ${selected.size}`}
            </button>
            <button
              onClick={() => { setSelected(new Set()); setRetryResult(null) }}
              className="flex items-center gap-1 rounded-lg bg-zinc-700 px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-600 transition min-h-[44px] sm:min-h-0"
            >
              <X className="h-3 w-3" />
              Limpar
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
