import { useCallback, useEffect, useState } from 'react'
import { Activity, AlertTriangle, CheckCircle2, Gauge, History, RefreshCw } from 'lucide-react'
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { CORE_URL, authHeaders } from '../config'

// ── Types ──────────────────────────────────────────────────────────────────

interface SummarySender {
  senderPhone: string
  totalSent: number
  totalDelivered: number
  totalRead: number
  deliveryRatio: number
  readRatio: number
  recommendedThreshold: number
  sampleWindows: number
  confidence: number
  warnings: string[]
  appliedThreshold: number | null
  appliedAt: string | null
  appliedBy: string | null
}

interface SummaryResponse {
  perSender: SummarySender[]
  globalWarnings: string[]
  dataSufficiency: 'SUFFICIENT' | 'SPARSE' | 'INSUFFICIENT'
}

interface SparklinePoint {
  ts: string
  deliveryRatio: number
  readRatio: number
  sentTotal: number
}

interface SparklineResponse {
  data: SparklinePoint[]
}

interface PersistFailure {
  wahaMessageId: string
  ackLevel: number
  error: string
  ts: string
}

interface PersistFailuresResponse {
  count: number
  recent: PersistFailure[]
}

// ── Helpers ────────────────────────────────────────────────────────────────

function fmtPct(x: number): string {
  return (x * 100).toFixed(1) + '%'
}

function sufficiencyBadge(s: SummaryResponse['dataSufficiency']) {
  if (s === 'SUFFICIENT') {
    return (
      <span className="rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 px-2 py-0.5 text-[11px] uppercase tracking-wide">
        Sufficient
      </span>
    )
  }
  if (s === 'SPARSE') {
    return (
      <span className="rounded bg-amber-500/15 text-amber-300 border border-amber-500/30 px-2 py-0.5 text-[11px] uppercase tracking-wide">
        Sparse
      </span>
    )
  }
  return (
    <span className="rounded bg-zinc-700/40 text-zinc-300 border border-zinc-600/40 px-2 py-0.5 text-[11px] uppercase tracking-wide">
      Insufficient
    </span>
  )
}

// ── Sparkline ──────────────────────────────────────────────────────────────

function Sparkline({ senderPhone, days }: { senderPhone: string; days: number }) {
  const [data, setData] = useState<SparklinePoint[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res = await fetch(
        `${CORE_URL}/api/v1/ack-rate/sparkline/${encodeURIComponent(senderPhone)}?days=${days}`,
        { headers: authHeaders() },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = (await res.json()) as SparklineResponse
      setData(body.data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro')
    } finally {
      setLoading(false)
    }
  }, [senderPhone, days])

  useEffect(() => { void fetchData() }, [fetchData])

  if (loading && !data) {
    return <p className="text-xs text-zinc-500 italic">Carregando…</p>
  }
  if (error) {
    return <p className="text-xs text-red-400">Erro: {error}</p>
  }
  if (!data || data.length === 0) {
    return <p className="text-xs text-zinc-500 italic">Sem dados nas últimas {days}d.</p>
  }

  return (
    <ResponsiveContainer width="100%" height={60}>
      <LineChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
        <Line type="monotone" dataKey="readRatio" stroke="#34d399" strokeWidth={1.5} dot={false} isAnimationActive={false} />
        <Line type="monotone" dataKey="deliveryRatio" stroke="#60a5fa" strokeWidth={1.5} dot={false} isAnimationActive={false} />
        <XAxis dataKey="ts" hide />
        <YAxis domain={[0, 1]} hide />
        <Tooltip
          contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', fontSize: 11, borderRadius: 6 }}
          labelStyle={{ color: '#a1a1aa' }}
          formatter={(value, name) => {
            const numeric = typeof value === 'number' ? value : Number(value)
            const label = String(name) === 'readRatio' ? 'lido' : 'entregue'
            return [Number.isFinite(numeric) ? (numeric * 100).toFixed(1) + '%' : '—', label]
          }}
          labelFormatter={(label) => {
            if (typeof label !== 'string' && typeof label !== 'number') return ''
            return new Date(label).toLocaleString('pt-BR')
          }}
        />
      </LineChart>
    </ResponsiveContainer>
  )
}

// ── Apply confirm dialog ───────────────────────────────────────────────────

interface ApplyConfirmProps {
  sender: SummarySender
  windowMs: number
  onCancel: () => void
  onApplied: () => void
}

function ApplyConfirm({ sender, windowMs, onCancel, onApplied }: ApplyConfirmProps) {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const handleApply = async () => {
    setSubmitting(true); setError(null)
    try {
      const res = await fetch(`${CORE_URL}/api/v1/ack-rate/apply`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          senderPhone: sender.senderPhone,
          threshold: Number(sender.recommendedThreshold.toFixed(4)),
          windowMs,
        }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
      onApplied()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao aplicar')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="max-w-md w-full rounded-lg border border-zinc-700 bg-zinc-900 p-5 shadow-xl">
        <div className="flex items-center gap-2 mb-3">
          <AlertTriangle className="h-5 w-5 text-amber-400" />
          <h4 className="text-sm font-semibold text-zinc-100">Confirmar aplicação de threshold</h4>
        </div>
        <p className="text-xs text-zinc-400 mb-3">
          Esta é uma mudança real de configuração de produção. O daemon de
          ban-prediction passará a usar este threshold para o sender abaixo
          até que você aplique outro valor.
        </p>
        <dl className="text-xs space-y-1 mb-4 rounded bg-zinc-800/60 p-3">
          <div className="flex justify-between"><dt className="text-zinc-500">Sender</dt><dd className="font-mono text-zinc-200">{sender.senderPhone}</dd></div>
          <div className="flex justify-between"><dt className="text-zinc-500">Threshold recomendado</dt><dd className="font-mono text-emerald-300">{sender.recommendedThreshold.toFixed(4)}</dd></div>
          <div className="flex justify-between"><dt className="text-zinc-500">Window (ms)</dt><dd className="font-mono text-zinc-200">{windowMs.toLocaleString('pt-BR')}</dd></div>
          <div className="flex justify-between"><dt className="text-zinc-500">Confiança</dt><dd className="font-mono text-zinc-200">{sender.confidence.toFixed(2)}</dd></div>
          <div className="flex justify-between"><dt className="text-zinc-500">Sample windows</dt><dd className="font-mono text-zinc-200">{sender.sampleWindows}</dd></div>
        </dl>
        {error && <p className="text-xs text-red-400 mb-2">{error}</p>}
        <div className="flex gap-2 justify-end">
          <button
            onClick={onCancel}
            disabled={submitting}
            className="rounded-md bg-zinc-800 border border-zinc-700/40 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700 disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            onClick={handleApply}
            disabled={submitting}
            className="rounded-md bg-emerald-500/15 border border-emerald-500/40 px-3 py-1.5 text-xs text-emerald-200 hover:bg-emerald-500/25 disabled:opacity-50"
          >
            {submitting ? 'Aplicando…' : 'Aplicar threshold'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Sender table ───────────────────────────────────────────────────────────

interface SenderTableProps {
  rows: SummarySender[]
  windowMs: number
  onApplied: () => void
}

function SenderTable({ rows, windowMs, onApplied }: SenderTableProps) {
  const [confirm, setConfirm] = useState<SummarySender | null>(null)

  if (rows.length === 0) {
    return (
      <p className="text-xs text-zinc-500 italic">
        Nenhum sender com acks atribuíveis no intervalo selecionado.
      </p>
    )
  }

  return (
    <>
      <div className="overflow-x-auto rounded-lg border border-zinc-800">
        <table className="w-full text-xs">
          <thead className="bg-zinc-900/60">
            <tr className="text-zinc-400 [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-medium">
              <th>Sender</th>
              <th>Sent</th>
              <th>Deliv</th>
              <th>Read</th>
              <th>Deliv %</th>
              <th>Read %</th>
              <th>Conf.</th>
              <th>Reco.</th>
              <th>Aplicado</th>
              <th></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/60">
            {rows.map((r) => (
              <tr key={r.senderPhone} className="text-zinc-200 [&_td]:px-3 [&_td]:py-2">
                <td className="font-mono">{r.senderPhone}</td>
                <td>{r.totalSent}</td>
                <td>{r.totalDelivered}</td>
                <td>{r.totalRead}</td>
                <td>{fmtPct(r.deliveryRatio)}</td>
                <td>{fmtPct(r.readRatio)}</td>
                <td>{r.confidence.toFixed(2)}</td>
                <td className="font-mono text-emerald-300">{r.recommendedThreshold.toFixed(3)}</td>
                <td>
                  {r.appliedThreshold !== null ? (
                    <span className="text-emerald-300 font-mono">
                      {r.appliedThreshold.toFixed(3)}
                      {r.appliedAt && (
                        <span className="block text-[10px] text-zinc-500">
                          {new Date(r.appliedAt + 'Z').toLocaleString('pt-BR')}
                          {r.appliedBy ? ` · ${r.appliedBy}` : ''}
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className="text-zinc-500">—</span>
                  )}
                </td>
                <td className="text-right">
                  <button
                    onClick={() => setConfirm(r)}
                    className="rounded-md bg-emerald-500/10 border border-emerald-500/30 px-2 py-1 text-[11px] text-emerald-300 hover:bg-emerald-500/20"
                  >
                    Aplicar
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Sparklines */}
      <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3">
        {rows.map((r) => (
          <div key={r.senderPhone} className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-mono text-zinc-300">{r.senderPhone}</span>
              <span className="text-[10px] text-zinc-500">7d · entregue / lido</span>
            </div>
            <Sparkline senderPhone={r.senderPhone} days={7} />
            {r.warnings.length > 0 && (
              <ul className="mt-2 space-y-0.5">
                {r.warnings.map((w, i) => (
                  <li key={i} className="text-[10px] text-amber-400 leading-snug">⚠ {w}</li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>

      {confirm && (
        <ApplyConfirm
          sender={confirm}
          windowMs={windowMs}
          onCancel={() => setConfirm(null)}
          onApplied={() => { setConfirm(null); onApplied() }}
        />
      )}
    </>
  )
}

// ── Persist failures panel ─────────────────────────────────────────────────

function PersistFailuresPanel() {
  const [data, setData] = useState<PersistFailuresResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res = await fetch(`${CORE_URL}/api/v1/ack-rate/persist-failures?hours=24`, {
        headers: authHeaders(),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setData((await res.json()) as PersistFailuresResponse)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void fetchData() }, [fetchData])

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <History className="h-4 w-4 text-zinc-400" />
          <h3 className="text-sm font-medium text-zinc-200">Falhas de persistência (últimas 24h)</h3>
          <span className="text-xs text-zinc-500">({data?.count ?? 0})</span>
        </div>
        <button
          onClick={fetchData}
          className="flex items-center gap-1.5 rounded-md bg-zinc-800 border border-zinc-700/40 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-700"
        >
          <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
          Atualizar
        </button>
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {!loading && data && data.count === 0 && (
        <p className="text-xs text-emerald-400 italic flex items-center gap-1.5">
          <CheckCircle2 className="h-3.5 w-3.5" /> Nenhuma falha de persistência no intervalo.
        </p>
      )}
      {data && data.recent.length > 0 && (
        <div className="space-y-1.5">
          {data.recent.map((f) => (
            <div
              key={`${f.wahaMessageId}-${f.ackLevel}-${f.ts}`}
              className="rounded-lg border border-red-500/30 bg-red-500/5 p-2.5"
            >
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-mono text-zinc-200 truncate">{f.wahaMessageId}</span>
                <span className="rounded bg-red-500/15 text-red-300 px-1.5 py-0.5 text-[10px]">ack={f.ackLevel}</span>
                <span className="text-[11px] text-zinc-500">{new Date(f.ts + 'Z').toLocaleString('pt-BR')}</span>
              </div>
              <code className="block mt-1 text-[11px] text-red-300 break-all">{f.error}</code>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────

export function AckRatePage() {
  const [summary, setSummary] = useState<SummaryResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hours, setHours] = useState(24)
  const [windowMs] = useState(3_600_000)

  const fetchSummary = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const url = `${CORE_URL}/api/v1/ack-rate/summary?hours=${hours}&windowMs=${windowMs}`
      const res = await fetch(url, { headers: authHeaders() })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setSummary((await res.json()) as SummaryResponse)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro')
    } finally {
      setLoading(false)
    }
  }, [hours, windowMs])

  useEffect(() => { void fetchSummary() }, [fetchSummary])

  return (
    <div className="space-y-5 p-4">
      <header className="flex items-center justify-between border-b border-zinc-800 pb-3">
        <div className="flex items-center gap-2">
          <Gauge className="h-5 w-5 text-emerald-400" />
          <h2 className="text-base font-semibold text-zinc-100">Calibração ack-rate</h2>
          {summary && sufficiencyBadge(summary.dataSufficiency)}
        </div>
        <div className="flex items-center gap-2">
          <select
            value={hours}
            onChange={(e) => setHours(parseInt(e.target.value, 10))}
            className="rounded-md bg-zinc-800 border border-zinc-700/40 px-2 py-1 text-xs text-zinc-200"
          >
            <option value={1}>Última hora</option>
            <option value={6}>Últimas 6h</option>
            <option value={24}>Últimas 24h</option>
            <option value={24 * 7}>Últimos 7 dias</option>
          </select>
          <button
            onClick={fetchSummary}
            className="flex items-center gap-1.5 rounded-md bg-zinc-800 border border-zinc-700/40 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-700"
          >
            <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
            Atualizar
          </button>
        </div>
      </header>

      {error && <p className="text-xs text-red-400">{error}</p>}

      {summary && summary.globalWarnings.length > 0 && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5 text-xs text-amber-300 space-y-1">
          <div className="flex items-center gap-1.5 font-medium">
            <Activity className="h-3.5 w-3.5" /> Avisos globais
          </div>
          {summary.globalWarnings.map((w, i) => (<p key={i} className="leading-snug">{w}</p>))}
        </div>
      )}

      <section className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-200 flex items-center gap-1.5">
          <Activity className="h-4 w-4 text-zinc-400" />
          Senders ({summary?.perSender.length ?? 0})
        </h3>
        {summary && (
          <SenderTable
            rows={summary.perSender}
            windowMs={windowMs}
            onApplied={() => void fetchSummary()}
          />
        )}
      </section>

      <PersistFailuresPanel />
    </div>
  )
}
