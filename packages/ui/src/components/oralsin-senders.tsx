import { useState, useEffect, useCallback } from 'react'
import { CORE_URL, authHeaders } from '../config'

interface SenderHealth {
  phoneNumber: string
  profileId: number
  deviceSerial: string
  wahaSession: string
  active: boolean
  total: number
  sent: number
  failed: number
  lastSentAt: string | null
  avgLatencyMs: number
}

const POLL_INTERVAL = 30_000

export function OralsinSenders() {
  const [senders, setSenders] = useState<SenderHealth[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  const fetchSenders = useCallback(async () => {
    try {
      const res = await fetch(`${CORE_URL}/api/v1/plugins/oralsin/senders`, {
        headers: authHeaders(),
      })
      if (res.ok) {
        setSenders(await res.json())
        setError(false)
      } else {
        setError(true)
      }
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchSenders()
    const interval = setInterval(fetchSenders, POLL_INTERVAL)
    return () => clearInterval(interval)
  }, [fetchSenders])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-zinc-500 text-sm">Carregando remetentes...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-zinc-500 text-sm">Falha ao carregar dados dos remetentes.</p>
      </div>
    )
  }

  if (senders.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-2">
        <p className="text-zinc-400 text-sm font-medium">Nenhum remetente configurado</p>
        <p className="text-zinc-600 text-xs">Configure senders no plugin Oralsin para visualizá-los aqui.</p>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {senders.map((sender) => (
        <SenderCard key={sender.phoneNumber} sender={sender} />
      ))}
    </div>
  )
}

function SenderCard({ sender }: { sender: SenderHealth }) {
  const successRate = sender.total > 0
    ? Math.round((sender.sent / sender.total) * 100)
    : 0
  const errorRate = sender.total > 0
    ? ((sender.failed / sender.total) * 100).toFixed(1)
    : '0.0'
  const failedWidth = sender.total > 0
    ? `${(sender.failed / sender.total) * 100}%`
    : '0%'

  return (
    <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/60 p-4 space-y-3">
      {/* Header: phone + profile badge */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-base font-bold text-zinc-100 truncate">{sender.phoneNumber}</p>
          <p className="text-xs text-zinc-500 truncate mt-0.5 font-mono">{sender.wahaSession}</p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <span className="rounded px-1.5 py-0.5 text-xs font-semibold bg-zinc-800 text-zinc-400">
            P{sender.profileId}
          </span>
          <span
            className={`rounded px-1.5 py-0.5 text-xs font-semibold ${
              sender.active
                ? 'bg-emerald-500/15 text-emerald-400'
                : 'bg-red-500/15 text-red-400'
            }`}
          >
            {sender.active ? 'Ativo' : 'Inativo'}
          </span>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-2">
        <StatCell label="Total" value={sender.total} />
        <StatCell label="Enviadas" value={sender.sent} accent="emerald" />
        <StatCell label="Falhadas" value={sender.failed} accent={sender.failed > 0 ? 'red' : undefined} />
      </div>

      {/* Progress bar */}
      <div className="space-y-1">
        <div className="h-2 rounded-full bg-zinc-800 overflow-hidden relative">
          {/* Sent portion */}
          <div
            className="absolute inset-y-0 left-0 bg-emerald-500 rounded-full transition-all duration-500"
            style={{ width: `${successRate}%` }}
          />
          {/* Failed portion stacked from right of sent */}
          <div
            className="absolute inset-y-0 bg-red-500 transition-all duration-500"
            style={{
              left: `${successRate}%`,
              width: failedWidth,
            }}
          />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-zinc-500">Taxa de erro</span>
          <span className={`text-xs font-semibold tabular-nums ${
            sender.failed > 0 ? 'text-red-400' : 'text-zinc-500'
          }`}>
            {errorRate}%
          </span>
        </div>
      </div>

      {/* Bottom row: latency + last sent */}
      <div className="flex items-center justify-between pt-1 border-t border-zinc-800/60">
        <div className="text-xs text-zinc-500">
          Latencia:{' '}
          <span className="text-zinc-300 font-medium tabular-nums">
            {formatLatency(sender.avgLatencyMs)}
          </span>
        </div>
        <div className="text-xs text-zinc-500 text-right">
          {sender.lastSentAt
            ? formatRelative(sender.lastSentAt)
            : 'Nunca enviou'}
        </div>
      </div>
    </div>
  )
}

function StatCell({
  label,
  value,
  accent,
}: {
  label: string
  value: number
  accent?: 'emerald' | 'red'
}) {
  const valueClass =
    accent === 'emerald'
      ? 'text-emerald-400'
      : accent === 'red'
      ? 'text-red-400'
      : 'text-zinc-100'

  return (
    <div className="rounded-lg bg-zinc-800/50 p-2 text-center">
      <div className="text-xs text-zinc-500 uppercase tracking-wider">{label}</div>
      <div className={`text-lg font-bold tabular-nums mt-0.5 ${valueClass}`}>
        {value.toLocaleString()}
      </div>
    </div>
  )
}

function formatLatency(ms: number): string {
  if (ms === 0) return '0ms'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatRelative(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const diffSec = Math.floor(diffMs / 1000)
  if (diffSec < 60) return `${diffSec}s atrás`
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m atrás`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h atrás`
  const diffDay = Math.floor(diffHr / 24)
  return `${diffDay}d atrás`
}
