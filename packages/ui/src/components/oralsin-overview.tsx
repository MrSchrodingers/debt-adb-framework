import { useState, useEffect, useCallback } from 'react'
import { io } from 'socket.io-client'
import { CORE_URL, authHeaders } from '../config'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'

interface OralsinOverview {
  totalToday: number
  sentToday: number
  failedToday: number
  pendingNow: number
  deliveredToday: number
  readToday: number
  avgLatencyMs: number
  fallbackRate: number
  failedCallbacks: number
  hourly: Array<{ hour: number; sent: number; failed: number }>
}

const POLL_INTERVAL = 10_000

export function OralsinOverview() {
  const [data, setData] = useState<OralsinOverview | null>(null)
  const [error, setError] = useState(false)

  const fetchOverview = useCallback(async () => {
    try {
      const res = await fetch(`${CORE_URL}/api/v1/plugins/oralsin/overview`, {
        headers: authHeaders(),
      })
      if (res.ok) {
        setData(await res.json())
        setError(false)
      } else {
        setError(true)
      }
    } catch {
      setError(true)
    }
  }, [])

  useEffect(() => {
    fetchOverview()
    const interval = setInterval(fetchOverview, POLL_INTERVAL)
    return () => clearInterval(interval)
  }, [fetchOverview])

  useEffect(() => {
    const socket = io(CORE_URL)
    const refresh = () => fetchOverview()
    socket.on('message:sent', refresh)
    socket.on('message:failed', refresh)
    socket.on('message:delivered', refresh)
    socket.on('message:read', refresh)
    return () => { socket.disconnect() }
  }, [fetchOverview])

  const hourlyFormatted = (data?.hourly ?? []).map((h) => ({
    ...h,
    label: `${String(h.hour).padStart(2, '0')}h`,
  }))

  if (error) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-zinc-500 text-sm">Falha ao carregar dados do plugin Oralsin.</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* KPI Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        <KpiCard label="Total Hoje" value={data ? String(data.totalToday) : '-'} />
        <KpiCard label="Enviadas" value={data ? String(data.sentToday) : '-'} accent="emerald" />
        <KpiCard label="Falhadas" value={data ? String(data.failedToday) : '-'} accent={data && data.failedToday > 0 ? 'red' : undefined} />
        <KpiCard label="Pendentes" value={data ? String(data.pendingNow) : '-'} accent="amber" />
        <KpiCard label="Entregues" value={data ? String(data.deliveredToday) : '-'} accent="emerald" />
        <KpiCard label="Lidas" value={data ? String(data.readToday) : '-'} accent="emerald" />
        <KpiCard label="Latencia Media (ms)" value={data ? formatLatency(data.avgLatencyMs) : '-'} />
        <KpiCard label="Taxa Fallback (%)" value={data ? `${data.fallbackRate.toFixed(1)}%` : '-'} accent={data && data.fallbackRate > 10 ? 'amber' : undefined} />
        <KpiCard label="Callbacks Falhados" value={data ? String(data.failedCallbacks) : '-'} accent={data && data.failedCallbacks > 0 ? 'red' : undefined} />
      </div>

      {/* Hourly Bar Chart */}
      <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/60 p-4">
        <h3 className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-4">
          Mensagens por Hora (Hoje)
        </h3>
        {hourlyFormatted.length > 0 ? (
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={hourlyFormatted}>
              <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
              <XAxis
                dataKey="label"
                tick={{ fill: '#71717a', fontSize: 11 }}
                axisLine={{ stroke: '#3f3f46' }}
                tickLine={false}
              />
              <YAxis
                tick={{ fill: '#71717a', fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                width={30}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#18181b',
                  border: '1px solid #27272a',
                  borderRadius: '8px',
                  fontSize: 12,
                }}
                labelStyle={{ color: '#a1a1aa' }}
              />
              <Bar dataKey="sent" fill="#34d399" radius={[4, 4, 0, 0]} name="Enviadas" />
              <Bar dataKey="failed" fill="#f87171" radius={[4, 4, 0, 0]} name="Falhadas" />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <p className="text-zinc-500 text-sm text-center py-10">Sem dados para hoje</p>
        )}
      </div>

      {/* Delivery Funnel */}
      {data && (
        <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/60 p-4">
          <h3 className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-4">
            Funil de Entrega
          </h3>
          <DeliveryFunnel
            sent={data.sentToday}
            delivered={data.deliveredToday}
            read={data.readToday}
          />
        </div>
      )}
    </div>
  )
}

function KpiCard({
  label,
  value,
  accent,
}: {
  label: string
  value: string
  accent?: 'emerald' | 'amber' | 'red'
}) {
  const accentClass =
    accent === 'emerald'
      ? 'text-emerald-400'
      : accent === 'amber'
      ? 'text-amber-400'
      : accent === 'red'
      ? 'text-red-400'
      : 'text-zinc-100'

  return (
    <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/60 p-4">
      <div className="text-xs text-zinc-500 uppercase tracking-wider">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${accentClass}`}>{value}</div>
    </div>
  )
}

function DeliveryFunnel({
  sent,
  delivered,
  read,
}: {
  sent: number
  delivered: number
  read: number
}) {
  const deliveryRate = sent > 0 ? ((delivered / sent) * 100).toFixed(1) : '0.0'
  const readRate = delivered > 0 ? ((read / delivered) * 100).toFixed(1) : '0.0'

  const stages = [
    { label: 'Enviadas', value: sent, color: 'bg-emerald-500', width: '100%' },
    {
      label: 'Entregues',
      value: delivered,
      color: 'bg-blue-500',
      width: sent > 0 ? `${(delivered / sent) * 100}%` : '0%',
      rate: `${deliveryRate}% de entregues`,
    },
    {
      label: 'Lidas',
      value: read,
      color: 'bg-violet-500',
      width: sent > 0 ? `${(read / sent) * 100}%` : '0%',
      rate: `${readRate}% de lidas (sobre entregues)`,
    },
  ]

  return (
    <div className="space-y-3">
      {stages.map((stage) => (
        <div key={stage.label} className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="text-zinc-400 font-medium">{stage.label}</span>
            <div className="flex items-center gap-3">
              {'rate' in stage && (
                <span className="text-zinc-500">{stage.rate}</span>
              )}
              <span className="text-zinc-200 font-semibold tabular-nums">{stage.value.toLocaleString()}</span>
            </div>
          </div>
          <div className="h-2 w-full rounded-full bg-zinc-800">
            <div
              className={`h-2 rounded-full ${stage.color} transition-all duration-500`}
              style={{ width: stage.width }}
            />
          </div>
        </div>
      ))}
    </div>
  )
}

function formatLatency(ms: number): string {
  if (ms === 0) return '0ms'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}
