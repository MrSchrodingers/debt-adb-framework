import { useCallback, useEffect, useMemo, useState } from 'react'
import { Activity, AlertTriangle, RefreshCw, ShieldCheck, ShieldAlert, ShieldOff } from 'lucide-react'
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { CORE_URL, authHeaders } from '../config'

interface QualityComponents {
  ackRate: number
  banHistory: number
  age: number
  warmupCompletion: number
  volumeFit: number
  fingerprintFreshness: number
  recipientResponse: number
}

interface QualitySummaryRow {
  senderPhone: string
  total: number
  components: QualityComponents
  computedAt: string
}

interface SummaryResponse {
  rows: QualitySummaryRow[]
  total: number
  weights: Record<keyof QualityComponents, number>
}

interface TrendSample {
  ts: string
  total: number
}

interface TrendResponse {
  senderPhone: string
  days: number
  samples: TrendSample[]
}

interface ComponentsResponse {
  senderPhone: string
  live: {
    total: number
    components: QualityComponents
    warmupTier: number
    warmupTierMax: number
    volumeToday: number
    volumeDailyCap: number
    accountAgeDays: number
    daysSinceLastBan: number | null
  }
  lastPersisted: { total: number; components: QualityComponents; computedAt: string } | null
  weights: Record<keyof QualityComponents, number>
}

interface CohortRow {
  cohortMonth: string
  carrier: string
  ddd: string
  total: number
  banned: number
  banRate: number
}

interface CohortResponse {
  sinceMonths: number
  rows: CohortRow[]
}

const POLL_INTERVAL_MS = 60_000

function scoreBadge(score: number) {
  if (score >= 70) {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 px-2 py-0.5 text-[11px] uppercase tracking-wide">
        <ShieldCheck className="h-3 w-3" /> Saudável
      </span>
    )
  }
  if (score >= 40) {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30 px-2 py-0.5 text-[11px] uppercase tracking-wide">
        <ShieldAlert className="h-3 w-3" /> Atenção
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 rounded bg-red-500/15 text-red-300 border border-red-500/30 px-2 py-0.5 text-[11px] uppercase tracking-wide">
      <ShieldOff className="h-3 w-3" /> Crítico
    </span>
  )
}

function fmtPct(x: number): string {
  return Math.round(x * 100) + '%'
}

function fmtTime(iso: string): string {
  const d = new Date(iso.replace(' ', 'T') + (iso.endsWith('Z') ? '' : 'Z'))
  return d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
}

const COMPONENT_LABELS: Array<[keyof QualityComponents, string]> = [
  ['ackRate', 'Ack rate'],
  ['banHistory', 'Histórico ban'],
  ['age', 'Idade conta'],
  ['warmupCompletion', 'Warmup'],
  ['volumeFit', 'Vol. ajuste'],
  ['fingerprintFreshness', 'Fingerprint'],
  ['recipientResponse', 'Resposta'],
]

export function QualityDashboard() {
  const [summary, setSummary] = useState<QualitySummaryRow[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [trend, setTrend] = useState<TrendSample[]>([])
  const [components, setComponents] = useState<ComponentsResponse | null>(null)
  const [cohort, setCohort] = useState<CohortRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastFetched, setLastFetched] = useState<Date | null>(null)

  const fetchSummary = useCallback(async () => {
    try {
      const res = await fetch(`${CORE_URL}/api/v1/quality/summary`, { headers: authHeaders() })
      if (!res.ok) throw new Error(`summary ${res.status}`)
      const json = (await res.json()) as SummaryResponse
      setSummary(json.rows)
      setError(null)
      setLastFetched(new Date())
      if (!selected && json.rows.length > 0) setSelected(json.rows[0].senderPhone)
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }, [selected])

  const fetchCohort = useCallback(async () => {
    try {
      const res = await fetch(`${CORE_URL}/api/v1/quality/cohort?sinceMonths=12`, { headers: authHeaders() })
      if (!res.ok) return
      const json = (await res.json()) as CohortResponse
      setCohort(json.rows)
    } catch {
      // non-fatal
    }
  }, [])

  const fetchSelectedDetail = useCallback(async (phone: string) => {
    try {
      const [trendRes, componentsRes] = await Promise.all([
        fetch(`${CORE_URL}/api/v1/quality/trend/${phone}?days=30`, { headers: authHeaders() }),
        fetch(`${CORE_URL}/api/v1/quality/components/${phone}`, { headers: authHeaders() }),
      ])
      if (trendRes.ok) {
        const t = (await trendRes.json()) as TrendResponse
        setTrend(t.samples)
      }
      if (componentsRes.ok) {
        const c = (await componentsRes.json()) as ComponentsResponse
        setComponents(c)
      }
    } catch (err) {
      console.warn('quality detail fetch failed', err)
    }
  }, [])

  useEffect(() => {
    fetchSummary()
    fetchCohort()
    const id = setInterval(() => {
      fetchSummary()
      fetchCohort()
    }, POLL_INTERVAL_MS)
    return () => clearInterval(id)
  }, [fetchSummary, fetchCohort])

  useEffect(() => {
    if (selected) fetchSelectedDetail(selected)
  }, [selected, fetchSelectedDetail])

  const ranking = useMemo(() => [...summary].sort((a, b) => a.total - b.total), [summary])

  const criticalCount = summary.filter((r) => r.total < 40).length
  const warningCount = summary.filter((r) => r.total >= 40 && r.total < 70).length
  const healthyCount = summary.filter((r) => r.total >= 70).length

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Activity className="h-5 w-5 text-emerald-400" />
          <h3 className="text-sm font-semibold text-zinc-100">Quality Dashboard</h3>
          {lastFetched && (
            <span className="text-[11px] text-zinc-500">
              atualizado em {lastFetched.toLocaleTimeString('pt-BR')}
            </span>
          )}
        </div>
        <button
          onClick={() => { fetchSummary(); fetchCohort(); if (selected) fetchSelectedDetail(selected) }}
          className="inline-flex items-center gap-1 rounded border border-zinc-700 bg-zinc-900/60 px-2 py-1 text-[11px] text-zinc-200 hover:bg-zinc-800"
        >
          <RefreshCw className="h-3 w-3" /> Atualizar
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded border border-red-500/30 bg-red-950/30 px-3 py-2 text-xs text-red-300">
          <AlertTriangle className="h-4 w-4" /> {error}
        </div>
      )}

      <div className="grid grid-cols-3 gap-3">
        <div className="rounded border border-emerald-500/30 bg-emerald-950/30 px-3 py-2">
          <div className="text-[11px] uppercase tracking-wide text-emerald-300">Saudáveis</div>
          <div className="text-2xl font-semibold text-emerald-100">{healthyCount}</div>
        </div>
        <div className="rounded border border-amber-500/30 bg-amber-950/30 px-3 py-2">
          <div className="text-[11px] uppercase tracking-wide text-amber-300">Atenção</div>
          <div className="text-2xl font-semibold text-amber-100">{warningCount}</div>
        </div>
        <div className="rounded border border-red-500/30 bg-red-950/30 px-3 py-2">
          <div className="text-[11px] uppercase tracking-wide text-red-300">Críticos</div>
          <div className="text-2xl font-semibold text-red-100">{criticalCount}</div>
        </div>
      </div>

      <div className="grid grid-cols-12 gap-4">
        <div className="col-span-5 rounded border border-zinc-800 bg-zinc-950/40 p-3">
          <div className="mb-2 text-xs font-medium text-zinc-300">Ranking — pior → melhor</div>
          <div className="max-h-[420px] overflow-y-auto">
            {loading && <div className="text-xs text-zinc-500">Carregando...</div>}
            {!loading && ranking.length === 0 && (
              <div className="text-xs text-zinc-500">Nenhum sample ainda. Watcher escreve a cada hora.</div>
            )}
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-zinc-950/90 text-zinc-400">
                <tr>
                  <th className="text-left px-2 py-1">Sender</th>
                  <th className="text-right px-2 py-1">Score</th>
                  <th className="text-right px-2 py-1">Status</th>
                </tr>
              </thead>
              <tbody>
                {ranking.map((row) => (
                  <tr
                    key={row.senderPhone}
                    onClick={() => setSelected(row.senderPhone)}
                    className={`cursor-pointer hover:bg-zinc-800/50 ${selected === row.senderPhone ? 'bg-zinc-800/70' : ''}`}
                  >
                    <td className="px-2 py-1 font-mono text-zinc-200">{row.senderPhone}</td>
                    <td className="px-2 py-1 text-right tabular-nums">
                      <span className={row.total < 40 ? 'text-red-300' : row.total < 70 ? 'text-amber-300' : 'text-emerald-300'}>
                        {row.total}
                      </span>
                    </td>
                    <td className="px-2 py-1 text-right">{scoreBadge(row.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="col-span-7 rounded border border-zinc-800 bg-zinc-950/40 p-3">
          {selected ? (
            <>
              <div className="mb-2 flex items-center justify-between">
                <div className="text-xs font-medium text-zinc-300">
                  Detalhes — <span className="font-mono text-zinc-100">{selected}</span>
                </div>
                {components && (
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-zinc-500">live:</span>
                    <span className="text-sm font-semibold text-zinc-100">{components.live.total}</span>
                    {scoreBadge(components.live.total)}
                  </div>
                )}
              </div>

              {trend.length > 1 && (
                <div className="h-32 mb-3">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={trend.map((s) => ({ ts: fmtTime(s.ts), total: s.total }))}>
                      <XAxis dataKey="ts" tick={{ fontSize: 9 }} stroke="#71717a" />
                      <YAxis domain={[0, 100]} tick={{ fontSize: 9 }} stroke="#71717a" />
                      <Tooltip
                        contentStyle={{ backgroundColor: '#18181b', border: '1px solid #3f3f46', fontSize: 11 }}
                        labelStyle={{ color: '#a1a1aa' }}
                      />
                      <Line type="monotone" dataKey="total" stroke="#34d399" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}

              {components && (
                <div className="space-y-1">
                  <div className="text-[11px] uppercase tracking-wide text-zinc-400 mb-1">Componentes</div>
                  {COMPONENT_LABELS.map(([key, label]) => {
                    const v = components.live.components[key]
                    const weight = components.weights?.[key] ?? 0
                    return (
                      <div key={key} className="flex items-center gap-2 text-xs">
                        <span className="w-28 text-zinc-300">{label}</span>
                        <span className="w-12 text-right tabular-nums text-zinc-400">{Math.round(weight * 100)}%</span>
                        <div className="flex-1 h-2 rounded-full bg-zinc-800 overflow-hidden">
                          <div
                            className={`h-full ${v >= 0.7 ? 'bg-emerald-500' : v >= 0.4 ? 'bg-amber-500' : 'bg-red-500'}`}
                            style={{ width: `${Math.round(v * 100)}%` }}
                          />
                        </div>
                        <span className="w-12 text-right tabular-nums text-zinc-200">{fmtPct(v)}</span>
                      </div>
                    )
                  })}
                </div>
              )}

              {components?.lastPersisted && (
                <div className="mt-3 text-[11px] text-zinc-500">
                  Último persistido: <span className="text-zinc-300">{components.lastPersisted.total}</span>
                  {' '}em {fmtTime(components.lastPersisted.computedAt)}
                </div>
              )}
            </>
          ) : (
            <div className="text-xs text-zinc-500">Selecione um sender no ranking.</div>
          )}
        </div>
      </div>

      <div className="rounded border border-zinc-800 bg-zinc-950/40 p-3">
        <div className="mb-2 text-xs font-medium text-zinc-300">Cohort — ban-rate por aquisição × carrier × DDD (12m)</div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-zinc-400">
              <tr>
                <th className="text-left px-2 py-1">Aquisição</th>
                <th className="text-left px-2 py-1">Carrier</th>
                <th className="text-left px-2 py-1">DDD</th>
                <th className="text-right px-2 py-1">Total</th>
                <th className="text-right px-2 py-1">Banidos</th>
                <th className="text-right px-2 py-1">Ban rate</th>
              </tr>
            </thead>
            <tbody>
              {cohort.length === 0 && (
                <tr><td colSpan={6} className="px-2 py-3 text-center text-zinc-500">Sem chips cadastrados em 12m</td></tr>
              )}
              {cohort.map((c, i) => (
                <tr key={i} className="border-t border-zinc-800/50">
                  <td className="px-2 py-1 text-zinc-200">{c.cohortMonth}</td>
                  <td className="px-2 py-1 text-zinc-300">{c.carrier}</td>
                  <td className="px-2 py-1 text-zinc-300">{c.ddd}</td>
                  <td className="px-2 py-1 text-right tabular-nums text-zinc-200">{c.total}</td>
                  <td className="px-2 py-1 text-right tabular-nums text-red-300">{c.banned}</td>
                  <td className="px-2 py-1 text-right tabular-nums">
                    <span className={c.banRate >= 0.3 ? 'text-red-300' : c.banRate >= 0.1 ? 'text-amber-300' : 'text-emerald-300'}>
                      {fmtPct(c.banRate)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
