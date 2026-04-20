import { useState, useCallback, useEffect } from 'react'
import { CheckCircle, RefreshCw } from 'lucide-react'
import { CORE_URL, authHeaders } from '../config'
import { formatRelativeTime } from '../utils/time'

const REFRESH_INTERVAL = 30_000

type CallbackType = 'result' | 'ack' | 'response'

interface FailedCallback {
  id: string
  messageId: string
  callbackType: CallbackType
  attempts: number
  lastError: string | null
  createdAt: string
  lastAttemptAt: string | null
}

function CallbackTypeBadge({ type }: { type: CallbackType }) {
  const base = 'inline-flex items-center rounded px-2 py-0.5 text-xs font-medium'

  switch (type) {
    case 'result':
      return <span className={`${base} bg-amber-950 text-amber-400`}>result</span>
    case 'ack':
      return <span className={`${base} bg-blue-950 text-blue-400`}>ack</span>
    case 'response':
      return <span className={`${base} bg-violet-950 text-violet-400`}>response</span>
    default:
      return <span className={`${base} bg-zinc-800 text-zinc-400`}>{type}</span>
  }
}

export function OralsinCallbacks() {
  const [callbacks, setCallbacks] = useState<FailedCallback[]>([])
  const [loading, setLoading] = useState(false)
  const [retrying, setRetrying] = useState<Set<string>>(new Set())

  const fetchCallbacks = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`${CORE_URL}/api/v1/monitoring/oralsin/callbacks`, {
        headers: authHeaders(),
      })
      if (res.ok) {
        const data: FailedCallback[] = await res.json()
        setCallbacks(data)
      }
    } catch {
      // silently fail
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchCallbacks()
    const interval = setInterval(fetchCallbacks, REFRESH_INTERVAL)
    return () => clearInterval(interval)
  }, [fetchCallbacks])

  const handleRetry = async (id: string) => {
    setRetrying((prev) => new Set(prev).add(id))
    try {
      await fetch(`${CORE_URL}/api/v1/admin/callbacks/${id}/retry`, {
        method: 'POST',
        headers: authHeaders(),
      })
      await fetchCallbacks()
    } catch {
      // silently fail
    } finally {
      setRetrying((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }

  if (!loading && callbacks.length === 0) {
    return (
      <div className="space-y-3">
        <div className="text-xs text-zinc-500 uppercase tracking-wider font-medium">
          Callbacks com falha: <span className="text-zinc-300 font-semibold">0</span>
        </div>
        <div className="flex flex-col items-center justify-center py-16 gap-3">
          <CheckCircle className="h-10 w-10 text-emerald-400" />
          <p className="text-sm text-zinc-400">Todos callbacks entregues com sucesso</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {/* Summary */}
      <div className="text-xs text-zinc-500 uppercase tracking-wider font-medium">
        Callbacks com falha:{' '}
        <span className={`font-semibold ${callbacks.length > 0 ? 'text-red-400' : 'text-zinc-300'}`}>
          {callbacks.length}
        </span>
      </div>

      {/* Table */}
      {loading && callbacks.length === 0 ? (
        <p className="text-zinc-500 text-sm">Carregando...</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-zinc-500 text-left text-xs uppercase">
                <th className="pb-2 pr-4 font-medium">Message ID</th>
                <th className="pb-2 pr-4 font-medium">Tipo</th>
                <th className="pb-2 pr-4 font-medium hidden sm:table-cell">Tentativas</th>
                <th className="pb-2 pr-4 font-medium hidden md:table-cell">Ultimo Erro</th>
                <th className="pb-2 pr-4 font-medium hidden lg:table-cell">Criado</th>
                <th className="pb-2 pr-4 font-medium hidden lg:table-cell">Ultima Tentativa</th>
                <th className="pb-2 font-medium">Acao</th>
              </tr>
            </thead>
            <tbody>
              {callbacks.map((cb) => (
                <tr
                  key={cb.id}
                  className="border-t border-zinc-800/40 hover:bg-zinc-900/40 transition-colors"
                >
                  <td className="py-2.5 pr-4">
                    <span
                      className="font-mono text-xs text-zinc-300"
                      title={cb.messageId}
                    >
                      {cb.messageId.slice(0, 8)}…
                    </span>
                  </td>
                  <td className="py-2.5 pr-4">
                    <CallbackTypeBadge type={cb.callbackType} />
                  </td>
                  <td className="py-2.5 pr-4 hidden sm:table-cell text-xs text-zinc-400">
                    {cb.attempts}
                  </td>
                  <td className="py-2.5 pr-4 hidden md:table-cell max-w-[200px]">
                    <span
                      className="block truncate text-xs text-red-400"
                      title={cb.lastError ?? undefined}
                    >
                      {cb.lastError ?? '-'}
                    </span>
                  </td>
                  <td
                    className="py-2.5 pr-4 hidden lg:table-cell text-xs text-zinc-500"
                    title={new Date(cb.createdAt).toLocaleString('pt-BR')}
                  >
                    {formatRelativeTime(cb.createdAt)}
                  </td>
                  <td
                    className="py-2.5 pr-4 hidden lg:table-cell text-xs text-zinc-500"
                    title={cb.lastAttemptAt ? new Date(cb.lastAttemptAt).toLocaleString('pt-BR') : undefined}
                  >
                    {cb.lastAttemptAt ? formatRelativeTime(cb.lastAttemptAt) : '-'}
                  </td>
                  <td className="py-2.5">
                    <button
                      onClick={() => handleRetry(cb.id)}
                      disabled={retrying.has(cb.id)}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-800 border border-zinc-700/40 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      <RefreshCw className={`h-3 w-3 ${retrying.has(cb.id) ? 'animate-spin' : ''}`} />
                      Retry
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
