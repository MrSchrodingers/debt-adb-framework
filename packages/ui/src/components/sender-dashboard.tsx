import { useState, useEffect, useCallback } from 'react'
import { CORE_URL, authHeaders } from '../config'

interface SenderStatus {
  phone: string
  deviceSerial: string
  profileId: number
  appPackage: string
  active: boolean
  paused: boolean
  pausedReason: string | null
  warmupTier: number
  dailyCap: number
  dailyCount: number
  quarantined: boolean
  quarantinedUntil: string | null
  consecutiveFailures: number
  totalSent: number
  totalFailed: number
}

const POLL_INTERVAL = 30_000

export function SenderDashboard() {
  const [senders, setSenders] = useState<SenderStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  const fetchSenders = useCallback(async () => {
    try {
      const res = await fetch(`${CORE_URL}/api/v1/senders/status`, {
        headers: authHeaders(),
      })
      if (res.ok) {
        const data = await res.json()
        setSenders(data.senders ?? [])
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

  const handlePause = useCallback(async (phone: string) => {
    try {
      await fetch(`${CORE_URL}/api/v1/senders/${phone}/pause`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ reason: 'Paused via dashboard' }),
      })
      fetchSenders()
    } catch { /* ignore */ }
  }, [fetchSenders])

  const handleResume = useCallback(async (phone: string) => {
    try {
      await fetch(`${CORE_URL}/api/v1/senders/${phone}/resume`, {
        method: 'POST',
        headers: authHeaders(),
      })
      fetchSenders()
    } catch { /* ignore */ }
  }, [fetchSenders])

  const handleSkipWarmup = useCallback(async (phone: string) => {
    try {
      await fetch(`${CORE_URL}/api/v1/senders/${phone}/skip-warmup`, {
        method: 'POST',
        headers: authHeaders(),
      })
      fetchSenders()
    } catch { /* ignore */ }
  }, [fetchSenders])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-zinc-500 text-sm">Carregando senders...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-zinc-500 text-sm">Falha ao carregar dados dos senders.</p>
      </div>
    )
  }

  if (senders.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-2">
        <p className="text-zinc-400 text-sm font-medium">Nenhum sender registrado</p>
        <p className="text-zinc-600 text-xs">Senders aparecem automaticamente quando dispositivos com WhatsApp sao detectados.</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-300">
          {senders.length} sender{senders.length !== 1 ? 's' : ''}
        </h2>
        <SummaryBadges senders={senders} />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {senders.map((sender) => (
          <SenderCard
            key={sender.phone}
            sender={sender}
            onPause={handlePause}
            onResume={handleResume}
            onSkipWarmup={handleSkipWarmup}
          />
        ))}
      </div>
    </div>
  )
}

function SummaryBadges({ senders }: { senders: SenderStatus[] }) {
  const active = senders.filter((s) => s.active && !s.paused && !s.quarantined).length
  const paused = senders.filter((s) => s.paused).length
  const quarantined = senders.filter((s) => s.quarantined).length

  return (
    <div className="flex items-center gap-2">
      {active > 0 && (
        <span className="rounded-full px-2 py-0.5 text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
          {active} ativo{active !== 1 ? 's' : ''}
        </span>
      )}
      {paused > 0 && (
        <span className="rounded-full px-2 py-0.5 text-xs font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20">
          {paused} pausado{paused !== 1 ? 's' : ''}
        </span>
      )}
      {quarantined > 0 && (
        <span className="rounded-full px-2 py-0.5 text-xs font-medium bg-red-500/10 text-red-400 border border-red-500/20">
          {quarantined} quarentena
        </span>
      )}
    </div>
  )
}

function SenderCard({
  sender,
  onPause,
  onResume,
  onSkipWarmup,
}: {
  sender: SenderStatus
  onPause: (phone: string) => void
  onResume: (phone: string) => void
  onSkipWarmup: (phone: string) => void
}) {
  const dailyRatio = sender.dailyCap > 0 ? sender.dailyCount / sender.dailyCap : 0

  return (
    <div className="bg-zinc-900 rounded-xl border border-zinc-800 p-4 space-y-3">
      {/* Header: phone + status badge */}
      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <span className="font-mono text-sm text-zinc-200 truncate block">{sender.phone}</span>
          <div className="text-xs text-zinc-500 mt-0.5 truncate">
            {sender.appPackage} · Profile {sender.profileId}
          </div>
        </div>
        <StatusBadge sender={sender} />
      </div>

      {/* Daily progress bar */}
      <div>
        <div className="flex justify-between text-xs text-zinc-500 mb-1">
          <span>Hoje</span>
          <span className="tabular-nums">{sender.dailyCount}/{sender.dailyCap}</span>
        </div>
        <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${getProgressColor(dailyRatio)}`}
            style={{ width: `${Math.min(100, dailyRatio * 100)}%` }}
          />
        </div>
      </div>

      {/* Warmup tier + stats */}
      <div className="flex items-center gap-3 text-xs">
        <TierBadge tier={sender.warmupTier} />
        <span className="text-zinc-500">{sender.totalSent.toLocaleString()} enviadas</span>
        {sender.totalFailed > 0 && (
          <span className="text-red-400">{sender.totalFailed.toLocaleString()} falhas</span>
        )}
        {sender.consecutiveFailures > 0 && (
          <span className="text-amber-400">{sender.consecutiveFailures} consec.</span>
        )}
      </div>

      {/* Quarantine info */}
      {sender.quarantined && sender.quarantinedUntil && (
        <div className="text-xs text-red-400/80 bg-red-500/5 border border-red-500/10 rounded px-2 py-1">
          Quarentena ate {formatQuarantineEnd(sender.quarantinedUntil)}
        </div>
      )}

      {/* Paused reason */}
      {sender.paused && sender.pausedReason && (
        <div className="text-xs text-amber-400/80 bg-amber-500/5 border border-amber-500/10 rounded px-2 py-1">
          {sender.pausedReason}
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2 pt-1">
        {sender.paused ? (
          <button
            onClick={() => onResume(sender.phone)}
            className="text-xs bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded px-2 py-1 hover:bg-emerald-500/20 transition-colors"
          >
            Retomar
          </button>
        ) : (
          <button
            onClick={() => onPause(sender.phone)}
            className="text-xs bg-amber-500/10 text-amber-400 border border-amber-500/20 rounded px-2 py-1 hover:bg-amber-500/20 transition-colors"
          >
            Pausar
          </button>
        )}
        {sender.warmupTier < 4 && (
          <button
            onClick={() => onSkipWarmup(sender.phone)}
            className="text-xs bg-zinc-700/50 text-zinc-400 border border-zinc-600/30 rounded px-2 py-1 hover:bg-zinc-700 transition-colors"
          >
            Skip Warmup
          </button>
        )}
      </div>
    </div>
  )
}

function StatusBadge({ sender }: { sender: SenderStatus }) {
  if (sender.quarantined) {
    return (
      <span className="rounded-full px-2 py-0.5 text-xs font-semibold bg-red-500/15 text-red-400 shrink-0">
        Quarentena
      </span>
    )
  }
  if (sender.paused) {
    return (
      <span className="rounded-full px-2 py-0.5 text-xs font-semibold bg-amber-500/15 text-amber-400 shrink-0">
        Pausado
      </span>
    )
  }
  if (sender.active) {
    return (
      <span className="rounded-full px-2 py-0.5 text-xs font-semibold bg-emerald-500/15 text-emerald-400 shrink-0">
        Ativo
      </span>
    )
  }
  return (
    <span className="rounded-full px-2 py-0.5 text-xs font-semibold bg-zinc-700 text-zinc-400 shrink-0">
      Inativo
    </span>
  )
}

function TierBadge({ tier }: { tier: number }) {
  const styles: Record<number, string> = {
    1: 'bg-blue-500/15 text-blue-400 border-blue-500/20',
    2: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/20',
    3: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/20',
    4: 'bg-zinc-700 text-zinc-300 border-zinc-600/30',
  }
  const label = tier >= 4 ? 'Full' : `Tier ${tier}`
  const cls = styles[tier] ?? styles[1]

  return (
    <span className={`rounded px-1.5 py-0.5 text-xs font-semibold border ${cls}`}>
      {label}
    </span>
  )
}

function getProgressColor(ratio: number): string {
  if (ratio > 0.8) return 'bg-red-500'
  if (ratio > 0.5) return 'bg-amber-500'
  return 'bg-emerald-500'
}

function formatQuarantineEnd(iso: string): string {
  const date = new Date(iso)
  const now = new Date()
  const diffMs = date.getTime() - now.getTime()
  if (diffMs <= 0) return 'expirando...'
  const diffMin = Math.floor(diffMs / 60_000)
  if (diffMin < 60) return `${diffMin}min`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ${diffMin % 60}min`
  return date.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}
