import { useState, useEffect } from 'react'
import { Clock, AlertTriangle, RefreshCw } from 'lucide-react'
import { CORE_URL, authHeaders } from '../config'
import { ScreenshotViewer } from './screenshot-viewer'

// ── Types ──

interface MessageRecord {
  id: string
  to: string
  body: string
  status: string
  createdAt: string
  sentAt: string | null
  attempts: number
  senderNumber: string | null
  pluginName: string | null
  screenshotPath: string | null
}

interface TimelineEvent {
  id: number
  timestamp: string
  type: string
  metadata: Record<string, unknown> | null
}

interface FailedCallback {
  id: number
  callbackType: string
  targetUrl: string
  statusCode: number | null
  lastAttemptAt: string
  createdAt: string
}

interface TimelineData {
  message: MessageRecord
  events: TimelineEvent[]
  failedCallbacks: FailedCallback[]
}

// ── Helpers ──

const eventColors: Record<string, string> = {
  queued:             'bg-zinc-500',
  locked:             'bg-blue-500',
  sending:            'bg-yellow-500',
  sent:               'bg-emerald-500',
  failed:             'bg-red-500',
  permanently_failed: 'bg-red-600',
  screenshot_saved:   'bg-violet-500',
  screenshot_skipped: 'bg-zinc-600',
  screenshot_failed:  'bg-red-400',
  wa_health_check:    'bg-blue-400',
  screen_ready:       'bg-zinc-400',
  clean_state:        'bg-zinc-400',
  contact_resolved:   'bg-cyan-500',
  chat_opened:        'bg-teal-500',
  send_tapped:        'bg-green-500',
  post_send_validation: 'bg-indigo-500',
}

const errorEventTypes = new Set([
  'failed', 'permanently_failed', 'screenshot_failed',
  'contact_insert_failed', 'send_failed',
])

function formatDelta(a: string, b: string): string {
  const ms = new Date(b).getTime() - new Date(a).getTime()
  if (ms < 0) return ''
  if (ms < 1000) return `+${ms}ms`
  return `+${(ms / 1000).toFixed(1)}s`
}

// ── Hook ──

export function useMessageTimeline(messageId: string | null) {
  const [data, setData] = useState<TimelineData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!messageId) {
      setData(null)
      setError(null)
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)

    fetch(`${CORE_URL}/api/v1/messages/${messageId}/timeline`, {
      headers: authHeaders(),
    })
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json() as Promise<TimelineData>
      })
      .then(json => {
        if (!cancelled) setData(json)
      })
      .catch(err => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Erro ao carregar')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => { cancelled = true }
  }, [messageId])

  return { data, loading, error }
}

// ── Main Component ──

interface MessageTimelineProps {
  messageId: string
}

export function MessageTimeline({ messageId }: MessageTimelineProps) {
  const { data, loading, error } = useMessageTimeline(messageId)

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-6 text-zinc-500">
        <RefreshCw className="h-4 w-4 animate-spin" />
        <span className="text-sm">Carregando timeline...</span>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="p-6 text-sm text-red-400">
        {error ?? 'Timeline indisponivel'}
      </div>
    )
  }

  const { message, events, failedCallbacks } = data

  const baseTime = message.createdAt

  return (
    <div className="space-y-6 p-4">
      {/* Message summary */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-mono text-zinc-500">{message.id}</span>
          <span className={`rounded px-2 py-0.5 text-xs ${
            message.status === 'sent' ? 'bg-emerald-500/10 text-emerald-400' :
            message.status.includes('fail') ? 'bg-red-500/10 text-red-400' :
            'bg-zinc-800 text-zinc-400'
          }`}>
            {message.status}
          </span>
        </div>
        <p className="text-sm text-zinc-200">
          Para: <span className="font-mono">{message.to}</span>
        </p>
        <p className="text-sm text-zinc-400 line-clamp-2">{message.body}</p>
        <div className="flex gap-4 text-xs text-zinc-500">
          {message.senderNumber && <span>Sender: {message.senderNumber.slice(-4)}</span>}
          {message.pluginName && <span>Plugin: {message.pluginName}</span>}
          <span>Tentativas: {message.attempts}</span>
        </div>
      </div>

      {/* Timeline */}
      {events.length > 0 ? (
        <div>
          <h4 className="text-xs font-medium text-zinc-400 mb-3">Eventos</h4>
          <div className="relative space-y-3 pl-4">
            {/* Vertical line */}
            <div className="absolute left-[7px] top-2 bottom-2 w-px bg-zinc-700" />

            {events.map((ev, idx) => {
              const isError = errorEventTypes.has(ev.type)
              const delta = idx > 0 ? formatDelta(baseTime, ev.timestamp) : null
              const dotColor = isError ? 'bg-red-500' : (eventColors[ev.type] ?? 'bg-zinc-600')

              return (
                <div key={ev.id} className="relative flex items-start gap-3">
                  <div className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ring-2 ring-zinc-900 ${dotColor}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`text-xs font-medium ${isError ? 'text-red-400' : 'text-zinc-200'}`}>
                        {ev.type}
                      </span>
                      {delta && (
                        <span className="text-xs text-zinc-600">{delta}</span>
                      )}
                      <span className="text-xs text-zinc-500">
                        {new Date(ev.timestamp).toLocaleTimeString('pt-BR')}
                      </span>
                    </div>
                    {ev.metadata && Object.keys(ev.metadata).length > 0 && (
                      <details className="mt-1">
                        <summary className="cursor-pointer text-xs text-zinc-600 hover:text-zinc-400">
                          metadata
                        </summary>
                        <pre className="mt-1 text-xs text-zinc-500 bg-zinc-950 rounded p-2 overflow-x-auto">
                          {JSON.stringify(ev.metadata, null, 2)}
                        </pre>
                      </details>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-zinc-500 text-sm">
          <Clock className="h-4 w-4" />
          <span>Nenhum evento registrado ainda</span>
        </div>
      )}

      {/* Screenshot */}
      <div>
        <h4 className="text-xs font-medium text-zinc-400 mb-3">Screenshot</h4>
        <ScreenshotViewer messageId={messageId} />
      </div>

      {/* Failed callbacks */}
      {failedCallbacks.length > 0 && (
        <div>
          <h4 className="text-xs font-medium text-zinc-400 mb-3">
            Callbacks com falha ({failedCallbacks.length})
          </h4>
          <div className="space-y-2">
            {failedCallbacks.map(cb => (
              <div key={cb.id} className="rounded-lg border border-red-900/40 bg-red-950/20 p-3">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="h-3.5 w-3.5 text-red-400 shrink-0" />
                  <span className="text-xs font-medium text-red-300">{cb.callbackType}</span>
                  {cb.statusCode && (
                    <span className="text-xs text-red-400">HTTP {cb.statusCode}</span>
                  )}
                </div>
                <p className="text-xs text-zinc-500 mt-1 truncate">{cb.targetUrl}</p>
                <p className="text-xs text-zinc-600 mt-0.5">
                  Ultima tentativa: {new Date(cb.lastAttemptAt).toLocaleString('pt-BR')}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

