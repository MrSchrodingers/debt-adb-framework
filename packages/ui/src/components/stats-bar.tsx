import { useState, useEffect, useCallback } from 'react'
import { Smartphone, Send, Clock, AlertTriangle, Users, Pause, ShieldAlert } from 'lucide-react'
import { CORE_URL, authHeaders } from '../config'

interface MetricsSummary {
  successRate: number
  avgLatencyMs: number
  totalToday: number
  totalFailed: number
}

interface StatusCounts {
  queued: number
  sending: number
  sent: number
  failed: number
}

interface StatsBarProps {
  deviceCount: number
  onlineCount: number
  alertCount: number
  queueDepth?: number
  sendersPaused?: number
  sendersQuarantined?: number
  sendersTotal?: number
}

const POLL_INTERVAL = 30_000

export function StatsBar({
  deviceCount, onlineCount, alertCount,
  queueDepth = 0, sendersPaused = 0, sendersQuarantined = 0, sendersTotal = 0,
}: StatsBarProps) {
  const [sentToday, setSentToday] = useState(0)
  const [pendingCount, setPendingCount] = useState(0)

  const fetchStats = useCallback(async () => {
    try {
      const [summaryRes, statusRes] = await Promise.all([
        fetch(`${CORE_URL}/api/v1/metrics/summary`, { headers: authHeaders() }),
        fetch(`${CORE_URL}/api/v1/metrics/by-status`, { headers: authHeaders() }),
      ])
      if (summaryRes.ok) {
        const summary: MetricsSummary = await summaryRes.json()
        setSentToday(summary.totalToday)
      }
      if (statusRes.ok) {
        const status: StatusCounts = await statusRes.json()
        setPendingCount(status.queued)
      }
    } catch {
      // silently fail
    }
  }, [])

  useEffect(() => {
    fetchStats()
    const interval = setInterval(fetchStats, POLL_INTERVAL)
    return () => clearInterval(interval)
  }, [fetchStats])

  const hasOperationalWarnings = sendersPaused > 0 || sendersQuarantined > 0 || queueDepth > 0

  return (
    <div className="border-b border-zinc-800/40">
      {/* Main stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 px-6 py-4">
        <StatCard
          icon={Smartphone}
          label="Dispositivos"
          value={`${onlineCount}/${deviceCount}`}
          sub="online"
          color="emerald"
        />
        <StatCard
          icon={Send}
          label="Enviadas"
          value={String(sentToday)}
          sub="hoje"
          color="blue"
        />
        <StatCard
          icon={Clock}
          label="Na fila"
          value={String(pendingCount)}
          sub="pendentes"
          color="amber"
        />
        <StatCard
          icon={AlertTriangle}
          label="Alertas"
          value={String(alertCount)}
          sub="ativos"
          color={alertCount > 0 ? 'red' : 'zinc'}
        />
      </div>

      {/* Operational status indicators */}
      {(sendersTotal > 0 || hasOperationalWarnings) && (
        <div className="flex flex-wrap items-center gap-3 px-6 pb-3 text-xs">
          {sendersTotal > 0 && (
            <Indicator
              icon={Users}
              color="zinc"
              label={`${sendersTotal} sender${sendersTotal !== 1 ? 's' : ''}`}
            />
          )}

          {queueDepth > 0 && (
            <Indicator
              icon={Clock}
              color="amber"
              label={`${queueDepth} na fila`}
            />
          )}

          {sendersPaused > 0 && (
            <Indicator
              icon={Pause}
              color="amber"
              label={`${sendersPaused} pausado${sendersPaused !== 1 ? 's' : ''}`}
            />
          )}

          {sendersQuarantined > 0 && (
            <Indicator
              icon={ShieldAlert}
              color="red"
              label={`${sendersQuarantined} quarentena`}
            />
          )}
        </div>
      )}
    </div>
  )
}

const colorMap: Record<string, { icon: string; bg: string; text: string }> = {
  emerald: { icon: 'text-emerald-400', bg: 'bg-emerald-500/10', text: 'text-emerald-400' },
  blue: { icon: 'text-blue-400', bg: 'bg-blue-500/10', text: 'text-blue-400' },
  amber: { icon: 'text-amber-400', bg: 'bg-amber-500/10', text: 'text-amber-400' },
  red: { icon: 'text-red-400', bg: 'bg-red-500/10', text: 'text-red-400' },
  zinc: { icon: 'text-zinc-500', bg: 'bg-zinc-800', text: 'text-zinc-400' },
}

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  color,
}: {
  icon: typeof Smartphone
  label: string
  value: string
  sub: string
  color: string
}) {
  const c = colorMap[color] ?? colorMap.zinc

  return (
    <div className="rounded-xl bg-zinc-900/80 border border-zinc-800/60 px-4 py-3 flex items-center gap-3">
      <div className={`rounded-lg p-2 ${c.bg}`}>
        <Icon className={`h-4 w-4 ${c.icon}`} />
      </div>
      <div>
        <p className="text-xs text-zinc-500">{label}</p>
        <div className="flex items-baseline gap-1.5">
          <span className={`text-lg font-semibold ${c.text}`}>{value}</span>
          <span className="text-xs text-zinc-600">{sub}</span>
        </div>
      </div>
    </div>
  )
}

const dotColors: Record<string, string> = {
  emerald: 'bg-emerald-400',
  amber: 'bg-amber-400',
  red: 'bg-red-400',
  zinc: 'bg-zinc-500',
}

function Indicator({
  icon: Icon,
  color,
  label,
}: {
  icon: typeof Smartphone
  color: 'emerald' | 'amber' | 'red' | 'zinc'
  label: string
}) {
  return (
    <div className="flex items-center gap-1.5">
      <div className={`h-1.5 w-1.5 rounded-full ${dotColors[color]}`} />
      <Icon className={`h-3 w-3 ${colorMap[color]?.icon ?? 'text-zinc-500'}`} />
      <span className="text-zinc-400">{label}</span>
    </div>
  )
}
