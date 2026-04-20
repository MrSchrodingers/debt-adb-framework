import type { DeviceInfo } from '../types'

const statusColors: Record<string, string> = {
  device: 'bg-emerald-500',
  offline: 'bg-zinc-500',
  unauthorized: 'bg-amber-500',
  unknown: 'bg-zinc-500',
}

export function DeviceCard({ device }: { device: DeviceInfo | null }) {
  if (!device) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
        <p className="text-zinc-500">No device connected</p>
      </div>
    )
  }

  const color = statusColors[device.type] ?? 'bg-zinc-500'

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <div className="flex items-center gap-3">
        <div className={`h-3 w-3 rounded-full ${color}`} />
        <div>
          <p className="font-medium">
            {device.brand} {device.model}
          </p>
          <p className="text-sm text-zinc-500">{device.serial}</p>
        </div>
        <span className="ml-auto rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">
          {device.type}
        </span>
      </div>
      {device.type === 'unauthorized' && (
        <p className="mt-2 text-sm text-amber-400">
          Authorize USB debugging on the device to continue.
        </p>
      )}
    </div>
  )
}
