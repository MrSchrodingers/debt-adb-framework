import { Smartphone, Wifi, WifiOff, ShieldAlert } from 'lucide-react'
import type { DeviceRecord, Alert } from '../types'

interface DeviceGridProps {
  devices: DeviceRecord[]
  alerts: Alert[]
  selectedSerial: string | null
  onSelect: (serial: string) => void
}

export function DeviceGrid({ devices, alerts, selectedSerial, onSelect }: DeviceGridProps) {
  if (devices.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/50 p-12 text-center">
        <Smartphone className="h-10 w-10 text-zinc-700 mx-auto mb-3" />
        <p className="text-sm text-zinc-500">Nenhum dispositivo detectado</p>
        <p className="text-xs text-zinc-600 mt-1">Conecte um dispositivo via USB com depuracao ativada</p>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
      {devices.map((device) => {
        const deviceAlerts = alerts.filter((a) => a.deviceSerial === device.serial && !a.resolved)
        const hasCritical = deviceAlerts.some((a) => a.severity === 'critical')
        const isSelected = selectedSerial === device.serial
        const isOnline = device.status === 'online'

        return (
          <button
            key={device.serial}
            onClick={() => onSelect(device.serial)}
            className={`group relative rounded-xl border p-4 text-left transition-all duration-200 ${
              isSelected
                ? 'border-blue-500/60 bg-blue-500/5 shadow-[0_0_15px_rgba(59,130,246,0.1)]'
                : 'border-zinc-800/60 bg-zinc-900/60 hover:border-zinc-700 hover:bg-zinc-900'
            }`}
          >
            <div className="flex items-start justify-between mb-3">
              <div className="flex items-center gap-2.5">
                <div className={`rounded-lg p-2 ${isOnline ? 'bg-emerald-500/10' : 'bg-zinc-800'}`}>
                  <Smartphone className={`h-4 w-4 ${isOnline ? 'text-emerald-400' : 'text-zinc-600'}`} />
                </div>
                <div>
                  <p className="text-sm font-medium text-zinc-200 leading-tight">
                    {device.brand ?? 'Unknown'} {device.model ?? ''}
                  </p>
                  <p className="text-xs text-zinc-600 font-mono mt-0.5">{device.serial.slice(0, 16)}</p>
                </div>
              </div>
              {isOnline ? (
                <Wifi className="h-3.5 w-3.5 text-emerald-500" />
              ) : (
                <WifiOff className="h-3.5 w-3.5 text-zinc-600" />
              )}
            </div>

            <div className="flex items-center gap-2">
              <span
                className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                  isOnline
                    ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                    : device.status === 'unauthorized'
                      ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                      : 'bg-zinc-800 text-zinc-500 border border-zinc-700'
                }`}
              >
                {device.status}
              </span>
              {deviceAlerts.length > 0 && (
                <span
                  className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
                    hasCritical
                      ? 'bg-red-500/10 text-red-400 border border-red-500/20'
                      : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                  }`}
                >
                  <ShieldAlert className="h-3 w-3" />
                  {deviceAlerts.length}
                </span>
              )}
            </div>
          </button>
        )
      })}
    </div>
  )
}
