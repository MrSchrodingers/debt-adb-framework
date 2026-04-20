import { useState, useCallback, useEffect } from 'react'
import { Search, ChevronLeft, ChevronRight } from 'lucide-react'
import { CORE_URL, authHeaders } from '../config'
import type { Message } from '../types'
import { formatRelativeTime } from '../utils/time'

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

export function MessageList({ senderNumber }: MessageListProps = {}) {
  const [messages, setMessages] = useState<Message[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [phoneSearch, setPhoneSearch] = useState('')
  const [loading, setLoading] = useState(false)

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
  }

  const handlePhoneChange = (value: string) => {
    setPhoneSearch(value)
    setOffset(0)
  }

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
      </div>

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
                <tr key={msg.id} className="border-b border-zinc-800/50">
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
    </div>
  )
}
