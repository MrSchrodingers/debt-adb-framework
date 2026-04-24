import { useEffect, useState } from 'react'
import { Stethoscope, Package } from 'lucide-react'
import type { ComponentType, SVGProps } from 'react'
import { CORE_URL, authHeaders } from '../config'
import { OralsinTab } from './oralsin-tab'
import { AdbPrecheckTab } from './adb-precheck-tab'
import { StatusDot, type Accent } from './plugin-ui'

type Plugin = 'oralsin' | 'adb-precheck'

type PluginStatus = 'active' | 'inactive' | 'checking' | 'error'

interface PluginDescriptor {
  id: Plugin
  label: string
  subtitle: string
  icon: ComponentType<SVGProps<SVGSVGElement>>
  accent: Accent
  probeUrl: string
  metricLabel: string
  metricFetch: () => Promise<string>
}

const PLUGINS: PluginDescriptor[] = [
  {
    id: 'oralsin',
    label: 'Oralsin',
    subtitle: 'NotificationBilling · dental debt outreach',
    icon: Package,
    accent: 'emerald',
    probeUrl: `${CORE_URL}/healthz`,
    metricLabel: 'enviadas hoje',
    metricFetch: async () => {
      const r = await fetch(`${CORE_URL}/api/v1/monitoring/oralsin/overview`, { headers: authHeaders() })
      if (!r.ok) return '—'
      const d = await r.json() as { sentToday?: number }
      return (d.sentToday ?? 0).toLocaleString('pt-BR')
    },
  },
  {
    id: 'adb-precheck',
    label: 'ADB Pre-check',
    subtitle: 'Pipeboard tenant_adb · WhatsApp validity scan',
    icon: Stethoscope,
    accent: 'sky',
    probeUrl: `${CORE_URL}/api/v1/plugins/adb-precheck/health`,
    metricLabel: 'leads scanned',
    metricFetch: async () => {
      const r = await fetch(`${CORE_URL}/api/v1/plugins/adb-precheck/stats`, { headers: authHeaders() })
      if (!r.ok) return '—'
      const d = await r.json() as { deals_scanned?: number }
      return (d.deals_scanned ?? 0).toLocaleString('pt-BR')
    },
  },
]

export function PluginTabs() {
  const [active, setActive] = useState<Plugin>('oralsin')
  const [statuses, setStatuses] = useState<Record<Plugin, PluginStatus>>({
    oralsin: 'checking',
    'adb-precheck': 'checking',
  })
  const [metrics, setMetrics] = useState<Record<Plugin, string>>({
    oralsin: '—',
    'adb-precheck': '—',
  })

  useEffect(() => {
    let cancelled = false
    const probe = async () => {
      for (const p of PLUGINS) {
        try {
          const r = await fetch(p.probeUrl, { headers: authHeaders() })
          const status: PluginStatus = r.ok ? 'active' : r.status === 404 ? 'inactive' : 'error'
          if (!cancelled) setStatuses((s) => ({ ...s, [p.id]: status }))
          if (status === 'active') {
            try {
              const m = await p.metricFetch()
              if (!cancelled) setMetrics((x) => ({ ...x, [p.id]: m }))
            } catch { /* leave em-dash */ }
          }
        } catch {
          if (!cancelled) setStatuses((s) => ({ ...s, [p.id]: 'error' }))
        }
      }
    }
    probe()
    const t = setInterval(probe, 15_000)
    return () => { cancelled = true; clearInterval(t) }
  }, [])

  const ActiveComponent = active === 'oralsin' ? OralsinTab : AdbPrecheckTab

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-zinc-100">Plugins</h2>
        <p className="text-xs text-zinc-500">Hub-and-spoke · cada plugin roda isolado, compartilhando apenas o registro de contatos WhatsApp.</p>
      </div>

      {/* Rich plugin selector */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {PLUGINS.map((p) => (
          <PluginCard
            key={p.id}
            descriptor={p}
            status={statuses[p.id]}
            metric={metrics[p.id]}
            active={active === p.id}
            onSelect={() => setActive(p.id)}
          />
        ))}
      </div>

      <div className="pt-1">
        <ActiveComponent />
      </div>
    </div>
  )
}

const ACCENT_ACTIVE_BG: Record<Accent, string> = {
  emerald: 'from-emerald-500/10 to-transparent border-emerald-500/40',
  sky: 'from-sky-500/10 to-transparent border-sky-500/40',
  violet: 'from-violet-500/10 to-transparent border-violet-500/40',
  amber: 'from-amber-500/10 to-transparent border-amber-500/40',
  rose: 'from-rose-500/10 to-transparent border-rose-500/40',
  zinc: 'from-zinc-500/10 to-transparent border-zinc-500/30',
}

const ACCENT_ICON_BG: Record<Accent, string> = {
  emerald: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
  sky: 'bg-sky-500/10 text-sky-300 border-sky-500/30',
  violet: 'bg-violet-500/10 text-violet-300 border-violet-500/30',
  amber: 'bg-amber-500/10 text-amber-300 border-amber-500/30',
  rose: 'bg-rose-500/10 text-rose-300 border-rose-500/30',
  zinc: 'bg-zinc-800 text-zinc-300 border-zinc-700',
}

function PluginCard({
  descriptor: p,
  status,
  metric,
  active,
  onSelect,
}: {
  descriptor: PluginDescriptor
  status: PluginStatus
  metric: string
  active: boolean
  onSelect: () => void
}) {
  const Icon = p.icon
  return (
    <button
      onClick={onSelect}
      className={`group relative overflow-hidden rounded-xl border bg-gradient-to-br p-4 text-left transition-all ${
        active
          ? `${ACCENT_ACTIVE_BG[p.accent]} shadow-lg shadow-black/20`
          : 'border-zinc-800 bg-zinc-900/40 from-zinc-900/40 to-transparent hover:border-zinc-700 hover:bg-zinc-900/60'
      }`}
    >
      <div className="flex items-start gap-3">
        <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border ${ACCENT_ICON_BG[p.accent]}`}>
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-zinc-100">{p.label}</h3>
            <StatusDot status={status} pulse={status === 'active'} />
          </div>
          <p className="mt-0.5 truncate text-xs text-zinc-500">{p.subtitle}</p>
          <div className="mt-2 flex items-baseline gap-1.5">
            <span className="text-lg font-semibold tabular-nums text-zinc-100">{metric}</span>
            <span className="text-xs text-zinc-500">{p.metricLabel}</span>
          </div>
        </div>
      </div>
      {active ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-gradient-to-r from-transparent via-current to-transparent opacity-40" />
      ) : null}
    </button>
  )
}
