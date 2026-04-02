import type { Alert } from '../types'

interface AlertPanelProps {
  alerts: Alert[]
}

const severityOrder: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
}

export function AlertPanel({ alerts }: AlertPanelProps) {
  if (alerts.length === 0) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
        <p className="text-sm text-zinc-500">No active alerts</p>
      </div>
    )
  }

  const sorted = [...alerts].sort(
    (a, b) => (severityOrder[a.severity] ?? 4) - (severityOrder[b.severity] ?? 4),
  )

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 divide-y divide-zinc-800">
      {sorted.map((alert) => (
        <div key={alert.id} className="flex items-center gap-3 px-4 py-2">
          <SeverityBadge severity={alert.severity} />
          <div className="min-w-0 flex-1">
            <p className="text-sm text-zinc-200 truncate">{alert.message}</p>
            <p className="text-xs text-zinc-500">
              {alert.deviceSerial.slice(0, 12)} &middot;{' '}
              {new Date(alert.createdAt).toLocaleTimeString()}
            </p>
          </div>
        </div>
      ))}
    </div>
  )
}

function SeverityBadge({ severity }: { severity: string }) {
  const styles: Record<string, string> = {
    critical: 'bg-red-500/20 text-red-400',
    high: 'bg-amber-500/20 text-amber-400',
    medium: 'bg-blue-500/20 text-blue-400',
    low: 'bg-zinc-700 text-zinc-400',
  }

  return (
    <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${styles[severity] ?? styles.low}`}>
      {severity}
    </span>
  )
}
