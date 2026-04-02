import type { DeviceRecord, Alert } from '../types'

const statusColors: Record<string, string> = {
  online: 'bg-emerald-500',
  offline: 'bg-zinc-500',
  unauthorized: 'bg-amber-500',
}

interface DeviceGridProps {
  devices: DeviceRecord[]
  alerts: Alert[]
  selectedSerial: string | null
  onSelect: (serial: string) => void
}

export function DeviceGrid({ devices, alerts, selectedSerial, onSelect }: DeviceGridProps) {
  if (devices.length === 0) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-6 text-center">
        <p className="text-zinc-500">No devices detected</p>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {devices.map((device) => {
        const deviceAlerts = alerts.filter((a) => a.deviceSerial === device.serial)
        const hasCritical = deviceAlerts.some((a) => a.severity === 'critical')
        const hasAlerts = deviceAlerts.length > 0
        const isSelected = selectedSerial === device.serial

        return (
          <button
            key={device.serial}
            onClick={() => onSelect(device.serial)}
            className={`rounded-lg border p-3 text-left transition-colors ${
              isSelected
                ? 'border-blue-500 bg-zinc-800'
                : 'border-zinc-800 bg-zinc-900 hover:border-zinc-700'
            }`}
          >
            <div className="flex items-center gap-2 mb-1">
              <div className={`h-2 w-2 rounded-full ${statusColors[device.status] ?? 'bg-zinc-500'}`} />
              <span className="text-xs font-medium truncate">
                {device.brand ?? 'Unknown'} {device.model ?? ''}
              </span>
            </div>
            <p className="text-xs text-zinc-500 truncate font-mono">{device.serial.slice(0, 12)}</p>
            <div className="flex items-center gap-1 mt-2">
              <span
                className={`rounded px-1.5 py-0.5 text-xs ${
                  device.status === 'online'
                    ? 'bg-emerald-500/10 text-emerald-400'
                    : device.status === 'unauthorized'
                      ? 'bg-amber-500/10 text-amber-400'
                      : 'bg-zinc-800 text-zinc-500'
                }`}
              >
                {device.status}
              </span>
              {hasAlerts && (
                <span
                  className={`rounded px-1.5 py-0.5 text-xs ${
                    hasCritical ? 'bg-red-500/10 text-red-400' : 'bg-amber-500/10 text-amber-400'
                  }`}
                >
                  {deviceAlerts.length} alert{deviceAlerts.length > 1 ? 's' : ''}
                </span>
              )}
            </div>
          </button>
        )
      })}
    </div>
  )
}
