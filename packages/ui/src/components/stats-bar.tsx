import { Smartphone, Send, Clock, AlertTriangle } from 'lucide-react'

interface StatsBarProps {
  deviceCount: number
  onlineCount: number
  sentToday: number
  pendingCount: number
  alertCount: number
}

export function StatsBar({ deviceCount, onlineCount, sentToday, pendingCount, alertCount }: StatsBarProps) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 px-6 py-4 border-b border-zinc-800/40">
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
        sub="nesta sessao"
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
