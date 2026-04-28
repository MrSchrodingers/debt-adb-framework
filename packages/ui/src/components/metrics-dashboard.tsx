import { useState, useEffect, useCallback } from 'react'
import { authHeaders } from '../config'
import {
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  XAxis,
  YAxis,
  Tooltip,
} from 'recharts'
import { CORE_URL } from '../config'
import { SendsHeatmap, ErrorHeatmap } from './heatmap'
import { Changed24hCard } from './changed-24h-card'

interface MetricsSummary {
  successRate: number
  avgLatencyMs: number
  totalToday: number
  totalFailed: number
}

interface HourlyBucket {
  hour: number
  sent: number
  failed: number
  queued: number
}

interface StatusCounts {
  queued: number
  sending: number
  sent: number
  failed: number
}

const STATUS_COLORS: Record<string, string> = {
  sent: '#10b981',     // emerald
  failed: '#ef4444',   // red
  sending: '#f59e0b',  // amber
  queued: '#71717a',   // zinc
}

const POLL_INTERVAL = 30_000

interface MetricsDashboardProps {
  senderNumber?: string | null
}

export function MetricsDashboard({ senderNumber }: MetricsDashboardProps = {}) {
  const [activeView, setActiveView] = useState<'overview' | 'grafana'>('overview')
  const [summary, setSummary] = useState<MetricsSummary | null>(null)
  const [hourly, setHourly] = useState<HourlyBucket[]>([])
  const [byStatus, setByStatus] = useState<StatusCounts | null>(null)

  const grafanaUrl = import.meta.env.VITE_GRAFANA_URL as string | undefined

  const fetchAll = useCallback(async () => {
    try {
      const qs = senderNumber ? `?senderNumber=${encodeURIComponent(senderNumber)}` : ''
      const [summaryRes, hourlyRes, statusRes] = await Promise.all([
        fetch(`${CORE_URL}/api/v1/metrics/summary${qs}`, { headers: authHeaders() }),
        fetch(`${CORE_URL}/api/v1/metrics/hourly${qs}`, { headers: authHeaders() }),
        fetch(`${CORE_URL}/api/v1/metrics/by-status${qs}`, { headers: authHeaders() }),
      ])
      if (summaryRes.ok) setSummary(await summaryRes.json())
      if (hourlyRes.ok) setHourly(await hourlyRes.json())
      if (statusRes.ok) setByStatus(await statusRes.json())
    } catch {
      // silently fail
    }
  }, [senderNumber])

  useEffect(() => {
    fetchAll()
    const interval = setInterval(fetchAll, POLL_INTERVAL)
    return () => clearInterval(interval)
  }, [fetchAll])

  const pieData = byStatus
    ? [
        { name: 'Enviadas', value: byStatus.sent, color: STATUS_COLORS.sent },
        { name: 'Falhadas', value: byStatus.failed, color: STATUS_COLORS.failed },
        { name: 'Enviando', value: byStatus.sending, color: STATUS_COLORS.sending },
        { name: 'Na fila', value: byStatus.queued, color: STATUS_COLORS.queued },
      ].filter((d) => d.value > 0)
    : []

  const hourlyFormatted = hourly.map((h) => ({
    ...h,
    label: `${String(h.hour).padStart(2, '0')}h`,
  }))

  return (
    <div className="space-y-6">
      {/* Tab switcher — only show if Grafana is configured */}
      {grafanaUrl && (
        <div className="flex gap-1 bg-zinc-900 rounded-lg p-1 border border-zinc-800 w-fit">
          <button
            onClick={() => setActiveView('overview')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition ${
              activeView === 'overview'
                ? 'bg-zinc-800 text-zinc-100'
                : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            Visao Geral
          </button>
          <button
            onClick={() => setActiveView('grafana')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition ${
              activeView === 'grafana'
                ? 'bg-zinc-800 text-zinc-100'
                : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            Grafana
          </button>
        </div>
      )}

      {activeView === 'grafana' && grafanaUrl ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 overflow-hidden">
          <iframe
            src={`${grafanaUrl}?orgId=1&kiosk`}
            className="w-full border-0"
            style={{ height: 'calc(100vh - 200px)', minHeight: '600px' }}
            title="Grafana Dashboard"
          />
        </div>
      ) : (
        <>
      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          label="Taxa de Sucesso"
          value={summary ? `${summary.successRate.toFixed(1)}%` : '-'}
          accent={summary && summary.successRate >= 90 ? 'emerald' : 'amber'}
        />
        <StatCard
          label="Latencia Media"
          value={summary ? `${formatLatency(summary.avgLatencyMs)}` : '-'}
          accent="zinc"
        />
        <StatCard
          label="Total Hoje"
          value={summary ? String(summary.totalToday) : '-'}
          accent="zinc"
        />
        <StatCard
          label="Falhadas Hoje"
          value={summary ? String(summary.totalFailed) : '-'}
          accent={summary && summary.totalFailed > 0 ? 'red' : 'zinc'}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Bar chart: messages per hour */}
        <div className="lg:col-span-2 rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
          <h3 className="text-xs font-medium text-zinc-400 mb-3">Mensagens por Hora (24h)</h3>
          {hourlyFormatted.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={hourlyFormatted} barGap={1}>
                <XAxis
                  dataKey="label"
                  tick={{ fill: '#71717a', fontSize: 10 }}
                  axisLine={{ stroke: '#3f3f46' }}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: '#71717a', fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  width={30}
                />
                <Tooltip
                  contentStyle={{
                    background: '#18181b',
                    border: '1px solid #3f3f46',
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  labelStyle={{ color: '#a1a1aa' }}
                />
                <Bar dataKey="sent" stackId="a" fill={STATUS_COLORS.sent} radius={[0, 0, 0, 0]} name="Enviadas" />
                <Bar dataKey="failed" stackId="a" fill={STATUS_COLORS.failed} radius={[0, 0, 0, 0]} name="Falhadas" />
                <Bar dataKey="queued" stackId="a" fill={STATUS_COLORS.queued} radius={[2, 2, 0, 0]} name="Na fila" />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-zinc-500 text-sm text-center py-10">Sem dados nas ultimas 24h</p>
          )}
        </div>

        {/* Donut chart: by status */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
          <h3 className="text-xs font-medium text-zinc-400 mb-3">Por Status</h3>
          {pieData.length > 0 ? (
            <>
              <ResponsiveContainer width="100%" height={180}>
                <PieChart>
                  <Pie
                    data={pieData}
                    cx="50%"
                    cy="50%"
                    innerRadius={50}
                    outerRadius={75}
                    paddingAngle={2}
                    dataKey="value"
                  >
                    {pieData.map((entry, i) => (
                      <Cell key={i} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{
                      background: '#18181b',
                      border: '1px solid #3f3f46',
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
              <div className="flex flex-wrap gap-3 mt-2 justify-center">
                {pieData.map((entry) => (
                  <div key={entry.name} className="flex items-center gap-1.5">
                    <div
                      className="h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: entry.color }}
                    />
                    <span className="text-xs text-zinc-400">
                      {entry.name} ({entry.value})
                    </span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p className="text-zinc-500 text-sm text-center py-10">Sem dados</p>
          )}
        </div>
      </div>

      {/* Phase 9: Heatmaps + Changed-24h */}
      <SendsHeatmap />
      <ErrorHeatmap />
      <Changed24hCard />
        </>
      )}
    </div>
  )
}

function StatCard({
  label,
  value,
  accent,
}: {
  label: string
  value: string
  accent: 'emerald' | 'amber' | 'red' | 'zinc'
}) {
  const accentClasses: Record<string, string> = {
    emerald: 'text-emerald-400',
    amber: 'text-amber-400',
    red: 'text-red-400',
    zinc: 'text-zinc-200',
  }

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
      <p className="text-xs text-zinc-500 mb-1">{label}</p>
      <p className={`text-xl font-semibold ${accentClasses[accent]}`}>{value}</p>
    </div>
  )
}

function formatLatency(ms: number): string {
  if (ms === 0) return '0ms'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}
