import { useEffect, useState } from 'react'
import { AlertTriangle, AlertCircle, Info, CheckCircle } from 'lucide-react'
import type { Alert } from '../types'
import { formatRelativeTime } from '../utils/time'

interface AlertPanelProps {
  alerts: Alert[]
}

const severityOrder: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
}

const severityConfig: Record<string, { icon: typeof AlertTriangle; color: string; bg: string; border: string }> = {
  critical: { icon: AlertCircle, color: 'text-red-400', bg: 'bg-red-500/10', border: 'border-red-500/20' },
  high: { icon: AlertTriangle, color: 'text-amber-400', bg: 'bg-amber-500/10', border: 'border-amber-500/20' },
  medium: { icon: Info, color: 'text-blue-400', bg: 'bg-blue-500/10', border: 'border-blue-500/20' },
  low: { icon: CheckCircle, color: 'text-zinc-400', bg: 'bg-zinc-800', border: 'border-zinc-700' },
}

export function AlertPanel({ alerts }: AlertPanelProps) {
  // Tick counter to force re-render every 30s for relative timestamps
  const [, setTick] = useState(0)

  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 30_000)
    return () => clearInterval(interval)
  }, [])

  if (alerts.length === 0) return null

  const sorted = [...alerts].sort(
    (a, b) => (severityOrder[a.severity] ?? 4) - (severityOrder[b.severity] ?? 4),
  )

  return (
    <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/60 overflow-hidden">
      <div className="px-4 py-3 border-b border-zinc-800/40 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-400" />
          <h3 className="text-sm font-medium text-zinc-300">Alertas</h3>
        </div>
        <span className="text-xs text-zinc-600">{alerts.length} ativo{alerts.length !== 1 ? 's' : ''}</span>
      </div>
      <div className="divide-y divide-zinc-800/40">
        {sorted.map((alert) => {
          const cfg = severityConfig[alert.severity] ?? severityConfig.low
          const Icon = cfg.icon

          return (
            <div key={alert.id} className="px-4 py-3 flex items-start gap-3">
              <div className={`rounded-lg p-1.5 ${cfg.bg} mt-0.5`}>
                <Icon className={`h-3.5 w-3.5 ${cfg.color}`} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-zinc-200">{alert.message}</p>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-xs text-zinc-600 font-mono">{alert.deviceSerial.slice(0, 12)}</span>
                  <span className="text-xs text-zinc-700">&middot;</span>
                  <span className="text-xs text-zinc-600" title={new Date(alert.createdAt).toLocaleString()}>
                    {formatRelativeTime(alert.createdAt)}
                  </span>
                </div>
              </div>
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${cfg.bg} ${cfg.color} border ${cfg.border}`}>
                {alert.severity}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
