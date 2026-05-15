import { useCallback, useEffect, useState } from 'react'
import { Smartphone, CheckCircle2, Lock, WifiOff } from 'lucide-react'
import { CORE_URL, authHeaders } from '../../config'

interface DeviceAvailability {
  serial: string
  available: boolean
  tenant?: string
  job_id?: string
  since?: string
}

/** Enrichment from the caller (NewScanPanel already fetched /monitor/devices). */
export interface DeviceEnrichment {
  serial: string
  status?: string
  brand?: string
  model?: string
  /** WAHA-mapped accounts (may be empty). NOT required for ADB precheck —
   *  the probe uses `am start wa.me/{phone}` which only needs WhatsApp
   *  installed + running, never a logged-in session. */
  accounts: Array<{ phoneNumber: string | null; packageName: string; profileId: number }>
}

const MODEL_FRIENDLY: Record<string, string> = {
  '25028PC03G': 'POCO C71',
  'SM-A032M': 'Samsung Galaxy A03',
}

function deviceLabel(info: DeviceEnrichment | undefined, fallbackSerial: string): string {
  if (!info) return shortSerial(fallbackSerial)
  const friendly = info.model ? MODEL_FRIENDLY[info.model] : undefined
  if (friendly) return friendly
  if (info.brand && info.model) return `${info.brand} ${info.model}`
  if (info.model) return info.model
  return shortSerial(fallbackSerial)
}

function primaryAccountPhone(info: DeviceEnrichment | undefined): string | null {
  if (!info?.accounts) return null
  const withPhone = info.accounts.find((a) => a.phoneNumber)
  return withPhone?.phoneNumber ?? null
}

const TENANT_TONE: Record<string, string> = {
  adb: 'text-sky-300',
  sicoob: 'text-violet-300',
  oralsin: 'text-amber-300',
}

function formatPhone(p: string): string {
  // Normalize 5543991234567 → +55 43 99123-4567 (best-effort, not strict).
  const digits = p.replace(/\D/g, '')
  if (digits.length === 13 && digits.startsWith('55')) {
    return `+55 ${digits.slice(2, 4)} ${digits.slice(4, 9)}-${digits.slice(9)}`
  }
  if (digits.length === 11) {
    return `${digits.slice(0, 2)} ${digits.slice(2, 7)}-${digits.slice(7)}`
  }
  return p
}

function shortSerial(s: string): string {
  if (s.length <= 12) return s
  return `${s.slice(0, 6)}…${s.slice(-4)}`
}

function relativeSince(iso?: string): string {
  if (!iso) return ''
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return ''
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}min`
  const h = Math.floor(m / 60)
  return `${h}h${m % 60}min`
}

export function DeviceAvailabilityCard({
  onSelect,
  selected,
  enrichment,
}: {
  onSelect: (serial: string) => void
  selected?: string | null
  /** Optional richer info from caller — phone numbers, status. Falls back to availability-only when omitted. */
  enrichment?: DeviceEnrichment[]
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

  // Merge availability poll (busy/free + tenant holder) with operator-side
  // enrichment (phoneNumber + status from /monitor/devices). Display order
  // follows availability poll (canonical truth for what the plugin sees).
  const enrichBySerial = new Map<string, DeviceEnrichment>(
    (enrichment ?? []).map((e) => [e.serial, e]),
  )

  return (
    <div className="space-y-2">
      {devices.length === 0 ? (
        <div className="text-xs text-zinc-500">Nenhum device conectado.</div>
      ) : null}
      {devices.map((d) => {
        const isSelected = selected === d.serial
        const tone = d.tenant ? TENANT_TONE[d.tenant] ?? 'text-rose-300' : 'text-rose-300'
        const info = enrichBySerial.get(d.serial)
        const label = deviceLabel(info, d.serial)
        const phone = primaryAccountPhone(info)
        const offline = info?.status && info.status !== 'online'
        const since = relativeSince(d.since)

        return (
          <button
            key={d.serial}
            type="button"
            onClick={() => onSelect(d.serial)}
            disabled={!d.available || offline === true}
            aria-pressed={isSelected}
            className={`w-full flex items-center justify-between gap-3 rounded-md border px-3 py-2.5 text-xs transition-colors ${
              isSelected
                ? 'border-sky-400 bg-sky-500/10'
                : d.available && !offline
                  ? 'border-zinc-800 hover:bg-zinc-900'
                  : 'border-zinc-800 bg-zinc-900/30 opacity-60 cursor-not-allowed'
            }`}
            title={
              !d.available && d.tenant
                ? `Ocupado por ${d.tenant} (job ${d.job_id}) há ${since}`
                : offline
                  ? `Device offline (${info?.status})`
                  : `${label} · serial ${d.serial}${phone ? ` · ${phone}` : ''}`
            }
          >
            <div className="flex items-center gap-2 min-w-0 flex-1 text-left">
              {offline ? (
                <WifiOff className="h-4 w-4 text-zinc-500 flex-shrink-0" />
              ) : (
                <Smartphone className="h-4 w-4 text-zinc-400 flex-shrink-0" />
              )}
              <div className="flex flex-col min-w-0">
                <span className="text-zinc-100 truncate font-semibold">{label}</span>
                {phone ? (
                  <span className="text-zinc-300 truncate">{formatPhone(phone)}</span>
                ) : !offline ? (
                  <span className="text-zinc-500 italic truncate">sem número logado · ADB ok</span>
                ) : null}
                <span className="font-mono text-[10px] text-zinc-600 truncate">
                  {shortSerial(d.serial)}
                  {offline ? ` · ${info?.status}` : ''}
                </span>
              </div>
            </div>
            {d.available && !offline ? (
              <span className="flex flex-col items-end gap-0.5 text-emerald-300 flex-shrink-0">
                <span className="flex items-center gap-1">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Pronto
                </span>
                <span className="text-[10px] opacity-60">probe ADB</span>
              </span>
            ) : !d.available ? (
              <span className={`flex flex-col items-end gap-0.5 ${tone} flex-shrink-0`}>
                <span className="flex items-center gap-1">
                  <Lock className="h-3.5 w-3.5" />
                  {d.tenant ?? 'busy'}
                </span>
                {since ? <span className="text-[10px] opacity-70">há {since}</span> : null}
              </span>
            ) : (
              <span className="text-zinc-500 text-[11px] flex-shrink-0">offline</span>
            )}
          </button>
        )
      })}
    </div>
  )
}
