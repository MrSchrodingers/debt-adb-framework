import { useEffect, useState } from 'react'
import { Line, LineChart, ResponsiveContainer, YAxis } from 'recharts'
import { CORE_URL, authHeaders } from '../config'

interface HealthPoint {
  battery_percent: number
  temperature_celsius: number
  ram_available_mb: number
  collected_at: string
}

const MAX_POINTS = 24

/**
 * Compact 2-line sparkline (RAM + temp) for a single device card. Reads from
 * the existing /api/v1/monitor/devices/:serial/health endpoint (returns last
 * N hours of health_snapshots). Polls every 60s while mounted. Renders a
 * tiny inline chart — no axes, no legend, just visual trend.
 */
export function DeviceHealthSparkline({ serial }: { serial: string }) {
  const [points, setPoints] = useState<HealthPoint[]>([])
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const res = await fetch(
          `${CORE_URL}/api/v1/monitor/devices/${encodeURIComponent(serial)}/health?hours=2`,
          { headers: authHeaders() },
        )
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const raw = (await res.json()) as HealthPoint[]
        if (!cancelled) {
          setPoints(raw.slice(-MAX_POINTS))
          setError(false)
        }
      } catch {
        if (!cancelled) setError(true)
      }
    }
    void load()
    const t = setInterval(load, 60_000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [serial])

  if (error || points.length < 2) return null

  // Normalize: RAM goes up=good (free MB), temp goes up=bad (degrees C).
  // Both rendered on the same compact chart with separate Y axes.
  const data = points.map((p) => ({
    ts: p.collected_at,
    ram: p.ram_available_mb,
    temp: p.temperature_celsius,
  }))

  const latestRam = points[points.length - 1]!.ram_available_mb
  const latestTemp = points[points.length - 1]!.temperature_celsius

  return (
    <div className="mt-2 rounded bg-zinc-950/40 border border-zinc-800/40 px-2 py-1.5">
      <div className="flex items-center justify-between text-[10px] text-zinc-500 mb-0.5">
        <span title="RAM disponível">
          RAM <span className="font-mono text-zinc-300">{Math.round(latestRam / 1024 * 10) / 10}G</span>
        </span>
        <span title="Temperatura">
          T <span className={`font-mono ${latestTemp > 40 ? 'text-red-400' : latestTemp > 35 ? 'text-amber-400' : 'text-zinc-300'}`}>
            {Math.round(latestTemp)}°
          </span>
        </span>
      </div>
      <ResponsiveContainer width="100%" height={28}>
        <LineChart data={data} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
          <YAxis yAxisId="ram" hide domain={['dataMin', 'dataMax']} />
          <YAxis yAxisId="temp" hide orientation="right" domain={['dataMin - 1', 'dataMax + 1']} />
          <Line
            yAxisId="ram"
            type="monotone"
            dataKey="ram"
            stroke="#34d399"
            strokeWidth={1.2}
            dot={false}
            isAnimationActive={false}
          />
          <Line
            yAxisId="temp"
            type="monotone"
            dataKey="temp"
            stroke="#fb923c"
            strokeWidth={1.2}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
