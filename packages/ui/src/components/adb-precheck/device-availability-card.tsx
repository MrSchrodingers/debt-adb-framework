import { useCallback, useEffect, useState } from 'react'
import { Smartphone, CheckCircle2, Lock } from 'lucide-react'
import { CORE_URL, authHeaders } from '../../config'

interface DeviceAvailability {
  serial: string
  available: boolean
  tenant?: string
  job_id?: string
  since?: string
}

const TENANT_TONE: Record<string, string> = {
  adb: 'text-sky-300',
  sicoob: 'text-violet-300',
  oralsin: 'text-amber-300',
}

export function DeviceAvailabilityCard({
  onSelect,
  selected,
}: {
  onSelect: (serial: string) => void
  selected?: string | null
}) {
  const [devices, setDevices] = useState<DeviceAvailability[]>([])

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${CORE_URL}/api/v1/plugins/adb-precheck/devices/availability`, {
        headers: authHeaders(),
      })
      if (!r.ok) return
      const d = (await r.json()) as { devices: DeviceAvailability[] }
      setDevices(d.devices ?? [])
    } catch {
      // ignore — transient network errors are handled by 5s poll
    }
  }, [])

  useEffect(() => {
    void load()
    const t = setInterval(load, 5_000)
    return () => clearInterval(t)
  }, [load])

  return (
    <div className="space-y-2">
      {devices.length === 0 ? (
        <div className="text-xs text-zinc-500">Nenhum device conectado.</div>
      ) : null}
      {devices.map((d) => {
        const isSelected = selected === d.serial
        const tone = d.tenant ? TENANT_TONE[d.tenant] ?? 'text-rose-300' : 'text-rose-300'
        return (
          <button
            key={d.serial}
            type="button"
            onClick={() => onSelect(d.serial)}
            disabled={!d.available}
            className={`w-full flex items-center justify-between rounded-md border px-3 py-2 text-xs ${
              isSelected
                ? 'border-sky-400 bg-sky-500/10'
                : d.available
                  ? 'border-zinc-800 hover:bg-zinc-900'
                  : 'border-zinc-800 bg-zinc-900/30 opacity-60 cursor-not-allowed'
            }`}
            title={!d.available && d.tenant ? `Ocupado por ${d.tenant} (job ${d.job_id})` : ''}
          >
            <div className="flex items-center gap-2">
              <Smartphone className="h-3.5 w-3.5 text-zinc-400" />
              <span className="font-mono text-zinc-200">{d.serial}</span>
            </div>
            {d.available ? (
              <span className="flex items-center gap-1 text-emerald-300">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Livre
              </span>
            ) : (
              <span className={`flex items-center gap-1 ${tone}`}>
                <Lock className="h-3.5 w-3.5" />
                {d.tenant ?? 'busy'}
                {d.job_id ? ` · job ${d.job_id.slice(0, 6)}` : ''}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
