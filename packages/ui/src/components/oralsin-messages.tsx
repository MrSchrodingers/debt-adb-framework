import { useState, useCallback, useEffect, Fragment } from 'react'
import { ChevronLeft, ChevronRight, Check, CheckCheck, AlertCircle } from 'lucide-react'
import { CORE_URL, authHeaders } from '../config'
import { formatRelativeTime } from '../utils/time'

const PAGE_SIZE = 50
const REFRESH_INTERVAL = 15_000

type MessageStatus =
  | 'queued'
  | 'locked'
  | 'sending'
  | 'sent'
  | 'delivered'
  | 'read'
  | 'failed'
  | 'permanently_failed'

interface OralsinMessage {
  id: string
  toNumber: string
  body: string
  senderNumber: string | null
  status: MessageStatus
  priority: number
  attempts: number
  fallbackUsed: boolean
  fallbackProvider: string | null
  correlationId: string | null
  context: Record<string, unknown> | null
  idempotencyKey: string
  wahaMessageId: string | null
  delivered: boolean
  read: boolean
  createdAt: string
  updatedAt: string
}

interface PaginatedResponse {
  data: OralsinMessage[]
  total: number
}

const STATUS_FILTERS = [
  'all',
  'queued',
  'sending',
  'sent',
  'delivered',
  'read',
  'failed',
  'permanently_failed',
] as const
type StatusFilter = (typeof STATUS_FILTERS)[number]

const STATUS_LABEL: Record<MessageStatus, string> = {
  queued: 'queued',
  locked: 'locked',
  sending: 'sending',
  sent: 'sent',
  delivered: 'entregue',
  read: 'lida',
  failed: 'falhou',
  permanently_failed: 'falha perm.',
}

function StatusBadge({ status }: { status: MessageStatus }) {
  const base = 'inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium'

  switch (status) {
    case 'queued':
      return <span className={`${base} bg-zinc-800 text-zinc-400`}>{STATUS_LABEL[status]}</span>

    case 'locked':
      return <span className={`${base} bg-zinc-800 text-zinc-300`}>{STATUS_LABEL[status]}</span>

    case 'sending':
      return (
        <span className={`${base} bg-blue-950 text-blue-400`}>
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse" />
          {STATUS_LABEL[status]}
        </span>
      )

    case 'sent':
      return (
        <span className={`${base} bg-emerald-950 text-emerald-400`}>
          {STATUS_LABEL[status]}
        </span>
      )

    case 'delivered':
      return (
        <span className={`${base} bg-teal-950 text-teal-400`}>
          <Check className="h-3 w-3" />
          {STATUS_LABEL[status]}
        </span>
      )

    case 'read':
      return (
        <span className={`${base} bg-sky-950 text-sky-400`}>
          <CheckCheck className="h-3 w-3" />
          {STATUS_LABEL[status]}
        </span>
      )

    case 'failed':
      return (
        <span className={`${base} bg-red-950 text-red-400`}>
          <AlertCircle className="h-3 w-3" />
          {STATUS_LABEL[status]}
        </span>
      )

    case 'permanently_failed':
      return (
        <span className={`${base} bg-red-950 text-red-400`}>
          <AlertCircle className="h-3 w-3" />
          {STATUS_LABEL[status]}
        </span>
      )

    default:
      return <span className={`${base} bg-zinc-800 text-zinc-400`}>{status}</span>
  }
}

function formatLatency(createdAt: string, updatedAt: string): string {
  const diffMs = new Date(updatedAt).getTime() - new Date(createdAt).getTime()
  if (diffMs <= 0) return '-'
  const secs = Math.floor(diffMs / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}min`
  const hours = Math.floor(mins / 60)
  return `${hours}h ${mins % 60}min`
}

function ExpandedRow({ msg }: { msg: OralsinMessage }) {
  return (
    <tr className="border-b border-zinc-800/40 bg-zinc-950/60">
      <td colSpan={7} className="px-4 py-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
          {/* Full message body */}
          <div className="space-y-1">
            <div className="text-zinc-500 uppercase tracking-wider font-medium">Texto Completo</div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-3 text-zinc-300 whitespace-pre-wrap break-words leading-relaxed">
              {msg.body}
            </div>
          </div>

          {/* Context JSON */}
          {msg.context && (
            <div className="space-y-1">
              <div className="text-zinc-500 uppercase tracking-wider font-medium">Contexto</div>
              <pre className="rounded-lg border border-zinc-800 bg-zinc-900 p-3 text-zinc-300 overflow-x-auto text-xs leading-relaxed">
                {JSON.stringify(msg.context, null, 2)}
              </pre>
            </div>
          )}

          {/* Screenshot proof */}
          {(msg.status === 'sent' || msg.status === 'delivered' || msg.status === 'read') && (
            <div className="space-y-1">
              <div className="text-zinc-500 uppercase tracking-wider font-medium">Screenshot</div>
              <img
                src={`${CORE_URL}/api/v1/messages/${msg.id}/screenshot`}
                alt="Screenshot do envio"
                className="rounded-lg border border-zinc-800 max-h-48 object-contain bg-zinc-900"
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
              />
            </div>
          )}

          {/* Metadata grid */}
          <div className="space-y-2 md:col-span-2">
            <div className="text-zinc-500 uppercase tracking-wider font-medium">Metadados</div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <MetaItem label="Idempotency Key" value={msg.idempotencyKey} mono />
              <MetaItem label="Correlation ID" value={msg.correlationId ?? '-'} mono />
              <MetaItem label="WAHA Message ID" value={msg.wahaMessageId ?? '-'} mono />
              <MetaItem label="Tentativas" value={String(msg.attempts)} />
              {msg.fallbackUsed && (
                <MetaItem
                  label="Fallback Provider"
                  value={msg.fallbackProvider ?? 'desconhecido'}
                />
              )}
            </div>
          </div>
        </div>
      </td>
    </tr>
  )
}

function MetaItem({
  label,
  value,
  mono = false,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="space-y-0.5">
      <div className="text-zinc-500 text-xs">{label}</div>
      <div
        className={`text-zinc-300 text-xs break-all ${mono ? 'font-mono' : ''}`}
        title={value}
      >
        {value}
      </div>
    </div>
  )
}

export function OralsinMessages() {
  const [messages, setMessages] = useState<OralsinMessage[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [loading, setLoading] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const fetchMessages = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      params.set('limit', String(PAGE_SIZE))
      params.set('offset', String(offset))
      if (statusFilter !== 'all') {
        params.set('status', statusFilter)
      }

      const res = await fetch(
        `${CORE_URL}/api/v1/monitoring/oralsin/messages?${params.toString()}`,
        { headers: authHeaders() },
      )
      if (!res.ok) return

      const data: PaginatedResponse = await res.json()
      setMessages(data.data)
      setTotal(data.total)
    } catch {
      // silently fail
    } finally {
      setLoading(false)
    }
  }, [offset, statusFilter])

  useEffect(() => {
    fetchMessages()
    const interval = setInterval(fetchMessages, REFRESH_INTERVAL)
    return () => clearInterval(interval)
  }, [fetchMessages])

  const handleStatusChange = (status: StatusFilter) => {
    setStatusFilter(status)
    setOffset(0)
    setExpandedId(null)
  }

  const toggleExpand = (id: string) => {
    setExpandedId((prev) => (prev === id ? null : id))
  }

  const currentPage = Math.floor(offset / PAGE_SIZE) + 1
  const totalPages = Math.ceil(total / PAGE_SIZE)
  const rangeStart = total === 0 ? 0 : offset + 1
  const rangeEnd = Math.min(offset + PAGE_SIZE, total)

  return (
    <div className="space-y-3">
      {/* Status filter chips */}
      <div className="flex flex-wrap gap-1.5">
        {STATUS_FILTERS.map((status) => (
          <button
            key={status}
            onClick={() => handleStatusChange(status)}
            className={`rounded-full px-2.5 py-1 text-xs border transition ${
              statusFilter === status
                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                : 'bg-zinc-800/60 text-zinc-400 border-zinc-700/40 hover:bg-zinc-700/60'
            }`}
          >
            {status === 'all'
              ? 'Todos'
              : status === 'permanently_failed'
              ? 'Falha Perm.'
              : status.charAt(0).toUpperCase() + status.slice(1)}
          </button>
        ))}
      </div>

      {/* Table */}
      {loading && messages.length === 0 ? (
        <p className="text-zinc-500 text-sm">Carregando...</p>
      ) : messages.length === 0 ? (
        <p className="text-zinc-500 text-sm">Nenhuma mensagem encontrada.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-zinc-500 text-left text-xs uppercase">
                <th className="pb-2 pr-4 font-medium">Destino</th>
                <th className="pb-2 pr-4 font-medium hidden sm:table-cell">Texto</th>
                <th className="pb-2 pr-4 font-medium hidden md:table-cell">Sender</th>
                <th className="pb-2 pr-4 font-medium">Status</th>
                <th className="pb-2 pr-4 font-medium hidden lg:table-cell">Fallback</th>
                <th className="pb-2 pr-4 font-medium hidden lg:table-cell">Latencia</th>
                <th className="pb-2 font-medium">Criado</th>
              </tr>
            </thead>
            <tbody>
              {messages.map((msg) => (
                <Fragment key={msg.id}>
                  <tr
                    className={`border-t border-zinc-800/40 cursor-pointer transition-colors ${
                      expandedId === msg.id
                        ? 'bg-zinc-900/80'
                        : 'hover:bg-zinc-900/40'
                    }`}
                    onClick={() => toggleExpand(msg.id)}
                  >
                    <td className="py-2.5 pr-4 font-mono text-xs text-zinc-300">
                      {msg.toNumber}
                    </td>
                    <td className="py-2.5 pr-4 hidden sm:table-cell max-w-[200px]">
                      <span
                        className="block truncate text-zinc-400 text-xs"
                        title={msg.body}
                      >
                        {msg.body.length > 60 ? `${msg.body.slice(0, 60)}…` : msg.body}
                      </span>
                    </td>
                    <td className="py-2.5 pr-4 hidden md:table-cell">
                      <span className="font-mono text-xs text-zinc-500">
                        {msg.senderNumber ?? '-'}
                      </span>
                    </td>
                    <td className="py-2.5 pr-4">
                      <StatusBadge status={msg.status} />
                    </td>
                    <td className="py-2.5 pr-4 hidden lg:table-cell">
                      {msg.fallbackUsed ? (
                        <span
                          className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs bg-amber-950 text-amber-400"
                          title={msg.fallbackProvider ?? undefined}
                        >
                          fallback
                        </span>
                      ) : (
                        <span className="text-zinc-600 text-xs">-</span>
                      )}
                    </td>
                    <td className="py-2.5 pr-4 hidden lg:table-cell text-xs text-zinc-500">
                      {formatLatency(msg.createdAt, msg.updatedAt)}
                    </td>
                    <td
                      className="py-2.5 text-xs text-zinc-500"
                      title={new Date(msg.createdAt).toLocaleString('pt-BR')}
                    >
                      {formatRelativeTime(msg.createdAt)}
                    </td>
                  </tr>
                  {expandedId === msg.id && <ExpandedRow key={`${msg.id}-expanded`} msg={msg} />}
                </Fragment>
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
              onClick={() => {
                setOffset(Math.max(0, offset - PAGE_SIZE))
                setExpandedId(null)
              }}
              disabled={offset === 0}
              className="rounded-lg bg-zinc-800 border border-zinc-700/40 px-3 py-2 text-xs text-zinc-400 hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-xs text-zinc-400">
              {currentPage} / {totalPages}
            </span>
            <button
              onClick={() => {
                setOffset(offset + PAGE_SIZE)
                setExpandedId(null)
              }}
              disabled={offset + PAGE_SIZE >= total}
              className="rounded-lg bg-zinc-800 border border-zinc-700/40 px-3 py-2 text-xs text-zinc-400 hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
