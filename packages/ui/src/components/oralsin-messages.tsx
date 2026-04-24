import { useState, useCallback, useEffect, Fragment } from 'react'
import { ChevronLeft, ChevronRight, Check, CheckCheck, AlertCircle, X, ZoomIn, ImageOff, Radio } from 'lucide-react'
import { CORE_URL, API_KEY, authHeaders } from '../config'
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
  toName: string | null
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

function ExpandedRow({ msg, onZoomScreenshot }: { msg: OralsinMessage; onZoomScreenshot: (url: string) => void }) {
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

          {/* Screenshot proof — click to zoom, with explicit empty states */}
          {(msg.status === 'sent' || msg.status === 'delivered' || msg.status === 'read') && (
            <div className="space-y-1">
              <div className="text-zinc-500 uppercase tracking-wider font-medium">Screenshot</div>
              <ScreenshotSlot msg={msg} onZoom={onZoomScreenshot} />
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

type ShotState = 'probing' | 'available' | 'missing' | 'via-fallback' | 'never-captured'

function ScreenshotSlot({ msg, onZoom }: { msg: OralsinMessage; onZoom: (url: string) => void }) {
  const [state, setState] = useState<ShotState>('probing')
  const url = `${CORE_URL}/api/v1/messages/${msg.id}/screenshot${API_KEY ? `?key=${API_KEY}` : ''}`

  useEffect(() => {
    let cancelled = false
    // If we know upfront the message was sent via WAHA fallback, ADB screenshot was never captured.
    if (msg.fallbackUsed && msg.fallbackProvider && msg.fallbackProvider !== 'adb') {
      setState('via-fallback')
      return
    }
    // Probe with HEAD first to decide between available/missing without flashing a broken <img>.
    fetch(url, { method: 'HEAD', headers: authHeaders() })
      .then((r) => {
        if (cancelled) return
        if (r.ok) setState('available')
        else setState('missing')
      })
      .catch(() => { if (!cancelled) setState('missing') })
    return () => { cancelled = true }
  }, [url, msg.fallbackUsed, msg.fallbackProvider])

  if (state === 'probing') {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-xs text-zinc-500 w-fit">
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-zinc-600" />
        verificando screenshot…
      </div>
    )
  }

  if (state === 'via-fallback') {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-sky-500/20 bg-sky-500/5 px-3 py-2 max-w-md">
        <Radio className="h-4 w-4 shrink-0 mt-0.5 text-sky-400" />
        <div className="text-xs">
          <div className="font-medium text-sky-300">Enviado via {msg.fallbackProvider?.toUpperCase() ?? 'fallback'}</div>
          <div className="mt-0.5 text-sky-300/70">Mensagens via WAHA fallback não geram screenshot ADB — o provider remoto não expõe a tela do device.</div>
        </div>
      </div>
    )
  }

  if (state === 'missing') {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 max-w-md">
        <ImageOff className="h-4 w-4 shrink-0 mt-0.5 text-amber-400" />
        <div className="text-xs">
          <div className="font-medium text-amber-300">Screenshot indisponível</div>
          <div className="mt-0.5 text-amber-300/70">Arquivo removido pela política de retenção ou nunca persistiu. Novas mensagens seguem a retenção atual (SCREENSHOT_RETENTION_DAYS).</div>
        </div>
      </div>
    )
  }

  return (
    <div
      className="relative group cursor-pointer w-fit"
      onClick={() => onZoom(url)}
    >
      <img
        src={url}
        alt="Screenshot do envio"
        className="rounded-lg border border-zinc-800 max-h-48 object-contain bg-zinc-900"
        onError={() => setState('missing')}
      />
      <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity rounded-lg">
        <ZoomIn className="h-6 w-6 text-white" />
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
  const [zoomedScreenshot, setZoomedScreenshot] = useState<string | null>(null)

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
                    <td className="py-2.5 pr-4">
                      {msg.toName ? (
                        <div className="flex flex-col">
                          <span className="text-xs text-zinc-200 font-medium truncate max-w-[220px]" title={msg.toName}>
                            {msg.toName}
                          </span>
                          <span className="font-mono text-[10px] text-zinc-500">{msg.toNumber}</span>
                        </div>
                      ) : (
                        <span className="font-mono text-xs text-zinc-300">{msg.toNumber}</span>
                      )}
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
                  {expandedId === msg.id && <ExpandedRow key={`${msg.id}-expanded`} msg={msg} onZoomScreenshot={setZoomedScreenshot} />}
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

      {/* Screenshot zoom modal */}
      {zoomedScreenshot && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
          onClick={() => setZoomedScreenshot(null)}
        >
          <button
            onClick={() => setZoomedScreenshot(null)}
            className="absolute top-4 right-4 rounded-full bg-zinc-800 border border-zinc-700 p-2 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700 transition z-10"
          >
            <X className="h-5 w-5" />
          </button>
          <img
            src={zoomedScreenshot}
            alt="Screenshot ampliado"
            className="max-h-[90vh] max-w-[90vw] object-contain rounded-lg shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  )
}
