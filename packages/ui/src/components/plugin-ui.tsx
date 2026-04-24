import type { ReactNode, ComponentType, SVGProps } from 'react'

export type Accent = 'emerald' | 'sky' | 'violet' | 'amber' | 'rose' | 'zinc'

const ACCENT_RING: Record<Accent, string> = {
  emerald: 'ring-emerald-500/40',
  sky: 'ring-sky-500/40',
  violet: 'ring-violet-500/40',
  amber: 'ring-amber-500/40',
  rose: 'ring-rose-500/40',
  zinc: 'ring-zinc-500/30',
}

const ACCENT_TEXT: Record<Accent, string> = {
  emerald: 'text-emerald-400',
  sky: 'text-sky-400',
  violet: 'text-violet-400',
  amber: 'text-amber-400',
  rose: 'text-rose-400',
  zinc: 'text-zinc-300',
}

const ACCENT_BG_SOFT: Record<Accent, string> = {
  emerald: 'bg-emerald-500/10 border-emerald-500/20',
  sky: 'bg-sky-500/10 border-sky-500/20',
  violet: 'bg-violet-500/10 border-violet-500/20',
  amber: 'bg-amber-500/10 border-amber-500/20',
  rose: 'bg-rose-500/10 border-rose-500/20',
  zinc: 'bg-zinc-500/10 border-zinc-500/20',
}

const ACCENT_BORDER: Record<Accent, string> = {
  emerald: 'border-emerald-500/30',
  sky: 'border-sky-500/30',
  violet: 'border-violet-500/30',
  amber: 'border-amber-500/30',
  rose: 'border-rose-500/30',
  zinc: 'border-zinc-700',
}

const ACCENT_SOLID_BG: Record<Accent, string> = {
  emerald: 'bg-emerald-500 hover:bg-emerald-400 text-emerald-950',
  sky: 'bg-sky-500 hover:bg-sky-400 text-sky-950',
  violet: 'bg-violet-500 hover:bg-violet-400 text-violet-950',
  amber: 'bg-amber-500 hover:bg-amber-400 text-amber-950',
  rose: 'bg-rose-500 hover:bg-rose-400 text-rose-950',
  zinc: 'bg-zinc-200 hover:bg-white text-zinc-900',
}

const ACCENT_BAR: Record<Accent, string> = {
  emerald: 'bg-emerald-400',
  sky: 'bg-sky-400',
  violet: 'bg-violet-400',
  amber: 'bg-amber-400',
  rose: 'bg-rose-400',
  zinc: 'bg-zinc-400',
}

type PluginStatus = 'active' | 'inactive' | 'checking' | 'error'

export function StatusDot({ status, pulse }: { status: PluginStatus; pulse?: boolean }) {
  const color =
    status === 'active' ? 'bg-emerald-400'
    : status === 'error' ? 'bg-rose-400'
    : status === 'checking' ? 'bg-amber-400'
    : 'bg-zinc-500'
  return (
    <span className="relative inline-flex h-2.5 w-2.5 items-center justify-center">
      {pulse && status === 'active' ? (
        <span className={`absolute inline-flex h-full w-full rounded-full ${color} opacity-50 animate-ping`} />
      ) : null}
      <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${color}`} />
    </span>
  )
}

export function StatusBadge({ status }: { status: PluginStatus }) {
  const label =
    status === 'active' ? 'ativo'
    : status === 'error' ? 'indisponivel'
    : status === 'checking' ? 'verificando'
    : 'inativo'
  const tone =
    status === 'active' ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300'
    : status === 'error' ? 'bg-rose-500/10 border-rose-500/20 text-rose-300'
    : status === 'checking' ? 'bg-amber-500/10 border-amber-500/20 text-amber-300'
    : 'bg-zinc-500/10 border-zinc-500/20 text-zinc-400'
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${tone}`}>
      <StatusDot status={status} pulse={status === 'active'} />
      {label}
    </span>
  )
}

export function PluginHeader({
  icon: Icon,
  title,
  subtitle,
  status,
  version,
  accent,
  actions,
}: {
  icon: ComponentType<SVGProps<SVGSVGElement>>
  title: string
  subtitle: string
  status: PluginStatus
  version?: string
  accent: Accent
  actions?: ReactNode
}) {
  return (
    <div className={`relative overflow-hidden rounded-xl border ${ACCENT_BORDER[accent]} bg-gradient-to-br from-zinc-900/80 to-zinc-950 p-5`}>
      <div className={`absolute inset-x-0 top-0 h-0.5 ${ACCENT_BAR[accent]}`} />
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border ${ACCENT_BORDER[accent]} ${ACCENT_BG_SOFT[accent]}`}>
            <Icon className={`h-5 w-5 ${ACCENT_TEXT[accent]}`} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-base font-semibold text-zinc-100">{title}</h3>
              {version ? <span className="text-xs text-zinc-500 font-mono">v{version}</span> : null}
            </div>
            <p className="mt-0.5 text-sm text-zinc-400">{subtitle}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={status} />
          {actions}
        </div>
      </div>
    </div>
  )
}

export function StatCard({
  label,
  value,
  hint,
  tone = 'zinc',
  icon: Icon,
  trend,
}: {
  label: string
  value: string | number
  hint?: string
  tone?: Accent
  icon?: ComponentType<SVGProps<SVGSVGElement>>
  trend?: { value: string; positive: boolean }
}) {
  return (
    <div className="group relative overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 transition-colors hover:border-zinc-700 hover:bg-zinc-900/60">
      <div className="flex items-start justify-between gap-2">
        <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
        {Icon ? <Icon className={`h-4 w-4 ${ACCENT_TEXT[tone]} opacity-70`} /> : null}
      </div>
      <div className={`mt-2 text-2xl font-semibold tabular-nums ${ACCENT_TEXT[tone]}`}>
        {typeof value === 'number' ? value.toLocaleString('pt-BR') : value}
      </div>
      <div className="mt-1 flex items-center gap-2 text-xs">
        {trend ? (
          <span className={trend.positive ? 'text-emerald-400' : 'text-rose-400'}>
            {trend.positive ? '↑' : '↓'} {trend.value}
          </span>
        ) : null}
        {hint ? <span className="text-zinc-500">{hint}</span> : null}
      </div>
    </div>
  )
}

export function ProgressBar({
  value,
  total,
  accent = 'sky',
  showLabel = true,
  label,
}: {
  value: number
  total: number
  accent?: Accent
  showLabel?: boolean
  label?: string
}) {
  const pct = total > 0 ? Math.min(100, Math.round((value / total) * 100)) : 0
  return (
    <div className="space-y-1">
      {showLabel ? (
        <div className="flex items-center justify-between text-xs">
          <span className="text-zinc-400">{label ?? 'Progresso'}</span>
          <span className="tabular-nums text-zinc-300">
            {value.toLocaleString('pt-BR')}
            {total > 0 ? ` / ${total.toLocaleString('pt-BR')}` : ''}
            {total > 0 ? ` · ${pct}%` : ''}
          </span>
        </div>
      ) : null}
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
        <div
          className={`h-full ${ACCENT_BAR[accent]} transition-all duration-500`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

export function Section({
  title,
  description,
  actions,
  children,
}: {
  title: string
  description?: string
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-zinc-200">{title}</h4>
          {description ? <p className="mt-0.5 text-xs text-zinc-500">{description}</p> : null}
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  )
}

export function Pill({ children, tone = 'zinc' }: { children: ReactNode; tone?: Accent }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${ACCENT_BG_SOFT[tone]} ${ACCENT_TEXT[tone]}`}>
      {children}
    </span>
  )
}

export function AccentButton({
  accent,
  variant = 'solid',
  disabled,
  onClick,
  children,
  icon: Icon,
}: {
  accent: Accent
  variant?: 'solid' | 'ghost'
  disabled?: boolean
  onClick?: () => void
  children: ReactNode
  icon?: ComponentType<SVGProps<SVGSVGElement>>
}) {
  const cls =
    variant === 'solid'
      ? `${ACCENT_SOLID_BG[accent]} disabled:opacity-40 disabled:cursor-not-allowed`
      : `bg-transparent border ${ACCENT_BORDER[accent]} ${ACCENT_TEXT[accent]} hover:bg-zinc-900 disabled:opacity-40`
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${cls}`}
    >
      {Icon ? <Icon className="h-4 w-4" /> : null}
      {children}
    </button>
  )
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: ComponentType<SVGProps<SVGSVGElement>>
  title: string
  description?: string
  action?: ReactNode
}) {
  return (
    <div className="rounded-lg border border-dashed border-zinc-800 bg-zinc-900/30 p-8 text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-zinc-800/60">
        <Icon className="h-6 w-6 text-zinc-500" />
      </div>
      <h5 className="mt-3 text-sm font-medium text-zinc-200">{title}</h5>
      {description ? <p className="mt-1 text-xs text-zinc-500">{description}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  )
}

export function SkeletonRow({ cols = 4 }: { cols?: number }) {
  return (
    <tr className="animate-pulse">
      {Array.from({ length: cols }).map((_, i) => (
        <td key={i} className="px-3 py-3">
          <div className="h-3 w-3/4 rounded bg-zinc-800" />
        </td>
      ))}
    </tr>
  )
}

export function InlineError({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-rose-500/20 bg-rose-500/5 px-3 py-2 text-sm text-rose-300">
      {message}
    </div>
  )
}

export function SubTabBar<T extends string>({
  tabs,
  active,
  onChange,
  accent = 'zinc',
}: {
  tabs: { id: T; label: string; count?: number }[]
  active: T
  onChange: (t: T) => void
  accent?: Accent
}) {
  return (
    <div className="inline-flex gap-0.5 rounded-lg border border-zinc-800 bg-zinc-950 p-0.5">
      {tabs.map((t) => {
        const isActive = active === t.id
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              isActive
                ? `${ACCENT_BG_SOFT[accent]} ${ACCENT_TEXT[accent]} ring-1 ${ACCENT_RING[accent]}`
                : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
            }`}
          >
            {t.label}
            {typeof t.count === 'number' && t.count > 0 ? (
              <span className={`rounded-full px-1.5 py-0.5 text-[10px] tabular-nums ${
                isActive ? 'bg-zinc-950/60' : 'bg-zinc-800 text-zinc-500'
              }`}>
                {t.count > 999 ? '999+' : t.count}
              </span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}
