import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  ExternalLink,
  Eye,
  Link2,
  Pencil,
  RefreshCw,
  Send,
  XCircle,
} from 'lucide-react'
import {
  Bar,
  BarChart,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { CORE_URL, authHeaders } from '../../config'

/**
 * Pipedrive operator view, scoped under the ADB Pre-check plugin.
 *
 * All endpoints live under `/api/v1/plugins/adb-precheck/pipedrive/*` —
 * plugin-namespaced so they auth through the same X-API-Key/Bearer gate as
 * every other adb-precheck route. The component is rendered inside
 * `adb-precheck-tab.tsx` as a sibling to Overview/Scan/Deals/Jobs.
 */

const PIPEDRIVE_BASE = `${CORE_URL}/api/v1/plugins/adb-precheck/pipedrive`

// ── Types ──────────────────────────────────────────────────────────────────

type Scenario = 'phone_fail' | 'deal_all_fail' | 'pasta_summary'
type Status = 'success' | 'failed' | 'retrying'

interface ActivityRow {
  id: string
  scenario: Scenario
  deal_id: number
  pasta: string | null
  phone_normalized: string | null
  job_id: string | null
  pipedrive_endpoint: string
  pipedrive_payload_json: string
  pipedrive_response_id: number | null
  pipedrive_response_status: Status
  http_status: number | null
  error_msg: string | null
  attempts: number
  created_at: string
  completed_at: string | null
  manual: number
  triggered_by: string | null
  dealUrl: string | null
  activityUrl: string | null
}

interface ListResponse {
  items: ActivityRow[]
  total: number
}

interface HealthResponse {
  tokenValid: boolean
  enabled?: boolean
  ownerName?: string | null
  ownerEmail?: string | null
  company?: string | null
  domain: string | null
  baseUrl?: string | null
  error?: string | null
}

interface StatsResponse {
  totalActivitiesCreated: number
  totalActivitiesCreated7d: number
  byScenario: { phone_fail: number; deal_all_fail: number; pasta_summary: number }
  byStatus: { success: number; failed: number; retrying: number }
  byPasta: Array<{ pasta: string; total: number; found: number; foundPct: number }>
  byStrategy: { adb: number; waha: number; cache: number }
  failureRate24h: number
  coveragePercent: number
  totalPhonesChecked: number
  totalPhonesFound: number
}

type Period = 'today' | '7d' | '30d' | 'all'

// ── Helpers ────────────────────────────────────────────────────────────────

const SCENARIO_BADGE: Record<Scenario, { label: string; cls: string }> = {
  phone_fail: { label: 'Phone fail', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
  deal_all_fail: { label: 'Deal all-fail', cls: 'bg-red-500/15 text-red-300 border-red-500/30' },
  pasta_summary: { label: 'Pasta summary', cls: 'bg-sky-500/15 text-sky-300 border-sky-500/30' },
}

const STATUS_BADGE: Record<Status, { label: string; cls: string }> = {
  success: { label: 'Success', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' },
  failed: { label: 'Failed', cls: 'bg-red-500/15 text-red-300 border-red-500/30' },
  retrying: { label: 'Retrying', cls: 'bg-zinc-700/40 text-zinc-300 border-zinc-600/40' },
}

function ScenarioBadge({ scenario }: { scenario: Scenario }) {
  const cfg = SCENARIO_BADGE[scenario]
  return (
    <span className={`rounded border px-2 py-0.5 text-[11px] font-medium ${cfg.cls}`}>
      {cfg.label}
    </span>
  )
}

function StatusBadge({ status }: { status: Status }) {
  const cfg = STATUS_BADGE[status]
  return (
    <span className={`rounded border px-2 py-0.5 text-[11px] font-medium ${cfg.cls}`}>
      {cfg.label}
    </span>
  )
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  try {
    const ms = iso.endsWith('Z') ? new Date(iso).getTime() : new Date(iso + 'Z').getTime()
    return new Date(ms).toLocaleString('pt-BR')
  } catch {
    return iso
  }
}

function MarkdownPreview({ text }: { text: string }) {
  return (
    <pre className="text-xs leading-relaxed text-zinc-200 whitespace-pre-wrap break-words font-mono bg-zinc-950/60 border border-zinc-800 rounded p-3 max-h-[60vh] overflow-auto">
      {text}
    </pre>
  )
}

// ── Filters bar ───────────────────────────────────────────────────────────

interface ActivitiesFilters {
  scenario: Scenario | ''
  status: Status | ''
  deal_id: string
  search: string
}

function FiltersBar({
  filters,
  onChange,
}: {
  filters: ActivitiesFilters
  onChange: (next: ActivitiesFilters) => void
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
      <select
        value={filters.scenario}
        onChange={(e) => onChange({ ...filters, scenario: e.target.value as ActivitiesFilters['scenario'] })}
        className="rounded-md bg-zinc-800 border border-zinc-700/40 px-2 py-1.5 text-xs text-zinc-200"
      >
        <option value="">Todas as cenas</option>
        <option value="phone_fail">Phone fail</option>
        <option value="deal_all_fail">Deal all-fail</option>
        <option value="pasta_summary">Pasta summary</option>
      </select>
      <select
        value={filters.status}
        onChange={(e) => onChange({ ...filters, status: e.target.value as ActivitiesFilters['status'] })}
        className="rounded-md bg-zinc-800 border border-zinc-700/40 px-2 py-1.5 text-xs text-zinc-200"
      >
        <option value="">Todos os status</option>
        <option value="success">Sucesso</option>
        <option value="failed">Falhou</option>
        <option value="retrying">Retrying</option>
      </select>
      <input
        type="number"
        min={1}
        placeholder="Deal ID"
        value={filters.deal_id}
        onChange={(e) => onChange({ ...filters, deal_id: e.target.value })}
        className="rounded-md bg-zinc-800 border border-zinc-700/40 px-2 py-1.5 text-xs text-zinc-200"
      />
      <input
        type="text"
        placeholder="Buscar pasta..."
        value={filters.search}
        onChange={(e) => onChange({ ...filters, search: e.target.value })}
        className="rounded-md bg-zinc-800 border border-zinc-700/40 px-2 py-1.5 text-xs text-zinc-200"
      />
    </div>
  )
}

// ── Preview modal ─────────────────────────────────────────────────────────

function PreviewModal({
  row,
  onClose,
}: {
  row: ActivityRow
  onClose: () => void
}) {
  const payload = useMemo(() => {
    try {
      return JSON.parse(row.pipedrive_payload_json) as { note?: string; content?: string; subject?: string }
    } catch {
      return null
    }
  }, [row.pipedrive_payload_json])
  const md = payload?.note ?? payload?.content ?? '(payload sem corpo Markdown)'
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div className="max-w-3xl w-full rounded-lg border border-zinc-700 bg-zinc-900 p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Eye className="h-4 w-4 text-zinc-400" />
            <h4 className="text-sm font-semibold text-zinc-100">Preview Markdown — Deal #{row.deal_id}</h4>
            <ScenarioBadge scenario={row.scenario} />
          </div>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-200 text-xs">Fechar</button>
        </div>
        {payload?.subject && (
          <p className="text-xs text-zinc-400 mb-2"><span className="text-zinc-500">Subject:</span> <span className="text-zinc-200">{payload.subject}</span></p>
        )}
        <MarkdownPreview text={md} />
        {row.dealUrl && (
          <div className="mt-3 flex justify-end">
            <a
              href={row.dealUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 rounded-md bg-emerald-500/10 border border-emerald-500/30 px-3 py-1.5 text-xs text-emerald-300 hover:bg-emerald-500/20"
            >
              <ExternalLink className="h-3.5 w-3.5" /> Abrir deal no Pipedrive
            </a>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Activities table ──────────────────────────────────────────────────────

function ActivitiesView() {
  const [items, setItems] = useState<ActivityRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(0)
  const [pageSize] = useState(50)
  const [filters, setFilters] = useState<ActivitiesFilters>({ scenario: '', status: '', deal_id: '', search: '' })
  const [preview, setPreview] = useState<ActivityRow | null>(null)
  const [retrying, setRetrying] = useState<Set<string>>(new Set())

  const fetchActivities = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const params = new URLSearchParams()
      if (filters.scenario) params.set('scenario', filters.scenario)
      if (filters.status) params.set('status', filters.status)
      if (filters.deal_id) params.set('deal_id', filters.deal_id)
      if (filters.search) params.set('pasta', filters.search)
      params.set('limit', String(pageSize))
      params.set('offset', String(page * pageSize))
      const res = await fetch(`${PIPEDRIVE_BASE}/activities?${params.toString()}`, {
        headers: authHeaders(),
      })
      if (!res.ok) {
        if (res.status === 503) {
          setError('Integração Pipedrive desativada (PIPEDRIVE_API_TOKEN não configurada).')
          setItems([]); setTotal(0)
          return
        }
        throw new Error(`HTTP ${res.status}`)
      }
      const body = (await res.json()) as ListResponse
      setItems(body.items); setTotal(body.total)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro')
    } finally { setLoading(false) }
  }, [filters, page, pageSize])

  useEffect(() => { void fetchActivities() }, [fetchActivities])

  const handleRetry = async (row: ActivityRow) => {
    setRetrying((prev) => new Set(prev).add(row.id))
    try {
      const res = await fetch(`${PIPEDRIVE_BASE}/activities/${row.id}/retry`, {
        method: 'POST', headers: authHeaders(),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
      await fetchActivities()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Retry falhou')
    } finally {
      setRetrying((prev) => { const s = new Set(prev); s.delete(row.id); return s })
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-zinc-400" />
          <h3 className="text-sm font-medium text-zinc-200">Atividades enviadas</h3>
          <span className="text-xs text-zinc-500">({total})</span>
        </div>
        <button
          onClick={fetchActivities}
          className="flex items-center gap-1.5 rounded-md bg-zinc-800 border border-zinc-700/40 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-700"
        >
          <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
          Atualizar
        </button>
      </div>
      <FiltersBar filters={filters} onChange={(f) => { setFilters(f); setPage(0) }} />
      {error && <p className="text-xs text-amber-300">{error}</p>}
      {!loading && items.length === 0 && !error && (
        <p className="text-xs text-zinc-500 italic">Nenhuma atividade no intervalo selecionado.</p>
      )}
      {items.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full text-xs">
            <thead className="bg-zinc-900/60">
              <tr className="text-zinc-400 [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-medium">
                <th>Deal ID</th>
                <th>Cenário</th>
                <th>Pasta</th>
                <th>Status</th>
                <th>HTTP</th>
                <th>Tentativas</th>
                <th>Pipedrive ID</th>
                <th>Criado</th>
                <th>Manual</th>
                <th></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60">
              {items.map((row) => (
                <tr key={row.id} className="text-zinc-200 [&_td]:px-3 [&_td]:py-2">
                  <td>
                    {row.dealUrl ? (
                      <a
                        href={row.dealUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-mono text-emerald-300 hover:underline inline-flex items-center gap-1"
                      >
                        #{row.deal_id} <Link2 className="h-3 w-3" />
                      </a>
                    ) : (
                      <span className="font-mono text-zinc-300">#{row.deal_id}</span>
                    )}
                  </td>
                  <td><ScenarioBadge scenario={row.scenario} /></td>
                  <td className="font-mono text-zinc-300 truncate max-w-[160px]">{row.pasta ?? '—'}</td>
                  <td><StatusBadge status={row.pipedrive_response_status} /></td>
                  <td className="font-mono text-zinc-400">{row.http_status ?? '—'}</td>
                  <td className="font-mono">{row.attempts}</td>
                  <td>
                    {row.pipedrive_response_id ? (
                      row.activityUrl ? (
                        <a href={row.activityUrl} target="_blank" rel="noopener noreferrer" className="font-mono text-emerald-300 hover:underline inline-flex items-center gap-1">
                          {row.pipedrive_response_id} <ExternalLink className="h-3 w-3" />
                        </a>
                      ) : (
                        <span className="font-mono text-zinc-300">{row.pipedrive_response_id}</span>
                      )
                    ) : (
                      <span className="text-zinc-500">—</span>
                    )}
                  </td>
                  <td className="text-zinc-400">{fmtDate(row.created_at)}</td>
                  <td>{row.manual ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" /> : <span className="text-zinc-600">—</span>}</td>
                  <td className="text-right">
                    <div className="flex items-center gap-1 justify-end">
                      <button
                        onClick={() => setPreview(row)}
                        className="rounded-md bg-zinc-800 border border-zinc-700/40 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-700 inline-flex items-center gap-1"
                      >
                        <Eye className="h-3 w-3" /> Preview
                      </button>
                      {row.pipedrive_response_status === 'failed' && (
                        <button
                          onClick={() => handleRetry(row)}
                          disabled={retrying.has(row.id)}
                          className="rounded-md bg-emerald-500/10 border border-emerald-500/30 px-2 py-1 text-[11px] text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50 inline-flex items-center gap-1"
                        >
                          <RefreshCw className={`h-3 w-3 ${retrying.has(row.id) ? 'animate-spin' : ''}`} />
                          Retry
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {/* Pagination */}
      {total > pageSize && (
        <div className="flex items-center justify-between text-xs text-zinc-400">
          <span>Página {page + 1} / {totalPages}</span>
          <div className="flex gap-1">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="rounded-md bg-zinc-800 border border-zinc-700/40 px-2.5 py-1 text-zinc-300 hover:bg-zinc-700 disabled:opacity-50"
            >
              ←
            </button>
            <button
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              className="rounded-md bg-zinc-800 border border-zinc-700/40 px-2.5 py-1 text-zinc-300 hover:bg-zinc-700 disabled:opacity-50"
            >
              →
            </button>
          </div>
        </div>
      )}
      {preview && <PreviewModal row={preview} onClose={() => setPreview(null)} />}
    </section>
  )
}

// ── Stats view ────────────────────────────────────────────────────────────

const STRATEGY_COLORS = ['#34d399', '#60a5fa', '#a78bfa']

function StatsView() {
  const [period, setPeriod] = useState<Period>('today')
  const [stats, setStats] = useState<StatsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const fetchStats = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res = await fetch(`${PIPEDRIVE_BASE}/stats?period=${period}`, {
        headers: authHeaders(),
      })
      if (!res.ok) {
        if (res.status === 503) {
          setError('Integração Pipedrive desativada.')
          setStats(null); return
        }
        throw new Error(`HTTP ${res.status}`)
      }
      setStats((await res.json()) as StatsResponse)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro')
    } finally { setLoading(false) }
  }, [period])

  useEffect(() => { void fetchStats() }, [fetchStats])

  const scenarioData = useMemo(() => {
    if (!stats) return []
    return [
      { name: 'Phone fail', value: stats.byScenario.phone_fail },
      { name: 'Deal all-fail', value: stats.byScenario.deal_all_fail },
      { name: 'Pasta summary', value: stats.byScenario.pasta_summary },
    ]
  }, [stats])

  const strategyData = useMemo(() => {
    if (!stats) return []
    return [
      { name: 'ADB', value: stats.byStrategy.adb },
      { name: 'WAHA', value: stats.byStrategy.waha },
      { name: 'Cache', value: stats.byStrategy.cache },
    ]
  }, [stats])

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-zinc-400" />
          <h3 className="text-sm font-medium text-zinc-200">Métricas</h3>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={period}
            onChange={(e) => setPeriod(e.target.value as Period)}
            className="rounded-md bg-zinc-800 border border-zinc-700/40 px-2 py-1 text-xs text-zinc-200"
          >
            <option value="today">Hoje</option>
            <option value="7d">Últimos 7 dias</option>
            <option value="30d">Últimos 30 dias</option>
            <option value="all">Tudo</option>
          </select>
          <button
            onClick={fetchStats}
            className="flex items-center gap-1.5 rounded-md bg-zinc-800 border border-zinc-700/40 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-700"
          >
            <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
            Atualizar
          </button>
        </div>
      </div>
      {error && <p className="text-xs text-amber-300">{error}</p>}
      {stats && (
        <>
          {/* KPI cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <KpiCard label={`Atividades no período (${period})`} value={stats.totalActivitiesCreated.toLocaleString('pt-BR')} />
            <KpiCard label="% telefones encontrados" value={`${stats.coveragePercent.toFixed(1)}%`} hint={`${stats.totalPhonesFound}/${stats.totalPhonesChecked}`} />
            <KpiCard label="Falhas (24h)" value={`${(stats.failureRate24h * 100).toFixed(1)}%`} hint={`(${stats.byStatus.failed} falhas)`} accent={stats.failureRate24h > 0.1 ? 'red' : 'emerald'} />
            <KpiCard label="Atividades (7d)" value={stats.totalActivitiesCreated7d.toLocaleString('pt-BR')} />
          </div>

          {/* Charts row */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
              <div className="text-xs text-zinc-400 mb-2">Atividades por cenário</div>
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={scenarioData}>
                  <XAxis dataKey="name" tick={{ fill: '#a1a1aa', fontSize: 11 }} axisLine={{ stroke: '#3f3f46' }} tickLine={false} />
                  <YAxis tick={{ fill: '#a1a1aa', fontSize: 11 }} axisLine={{ stroke: '#3f3f46' }} tickLine={false} allowDecimals={false} />
                  <Tooltip contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', fontSize: 11, borderRadius: 6 }} />
                  <Bar dataKey="value" fill="#34d399" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
              <div className="text-xs text-zinc-400 mb-2">Estratégia de validação</div>
              <ResponsiveContainer width="100%" height={180}>
                <PieChart>
                  <Pie data={strategyData} dataKey="value" nameKey="name" innerRadius={45} outerRadius={70} paddingAngle={2}>
                    {strategyData.map((_, i) => (<Cell key={i} fill={STRATEGY_COLORS[i % STRATEGY_COLORS.length]} />))}
                  </Pie>
                  <Tooltip contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', fontSize: 11, borderRadius: 6 }} />
                </PieChart>
              </ResponsiveContainer>
              <div className="flex justify-around text-[10px] text-zinc-500 mt-1">
                <span>ADB · {stats.byStrategy.adb}</span>
                <span>WAHA · {stats.byStrategy.waha}</span>
                <span>Cache · {stats.byStrategy.cache}</span>
              </div>
            </div>
          </div>

          {/* Top pastas */}
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
            <div className="text-xs text-zinc-400 mb-2">Top pastas — cobertura % (encontrados / verificados)</div>
            {stats.byPasta.length === 0 ? (
              <p className="text-xs text-zinc-500 italic">Sem dados de pasta no período.</p>
            ) : (
              <ResponsiveContainer width="100%" height={Math.max(120, stats.byPasta.slice(0, 10).length * 22)}>
                <BarChart data={stats.byPasta.slice(0, 10)} layout="vertical" margin={{ left: 60 }}>
                  <XAxis type="number" tick={{ fill: '#a1a1aa', fontSize: 11 }} domain={[0, 100]} />
                  <YAxis type="category" dataKey="pasta" tick={{ fill: '#a1a1aa', fontSize: 11 }} width={120} />
                  <Tooltip
                    contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', fontSize: 11, borderRadius: 6 }}
                    formatter={(_v, _n, p) => {
                      const item = (p.payload as { found: number; total: number; foundPct: number })
                      return [`${item.foundPct.toFixed(1)}% (${item.found}/${item.total})`, 'cobertura']
                    }}
                  />
                  <Bar dataKey="foundPct" fill="#60a5fa" radius={[0, 3, 3, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </>
      )}
    </section>
  )
}

function KpiCard({
  label, value, hint, accent,
}: {
  label: string
  value: string
  hint?: string
  accent?: 'emerald' | 'red' | 'amber'
}) {
  const valueCls = accent === 'red' ? 'text-red-300' : accent === 'amber' ? 'text-amber-300' : 'text-emerald-300'
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="text-[11px] text-zinc-500 uppercase tracking-wide">{label}</div>
      <div className={`text-xl font-semibold mt-1 ${valueCls}`}>{value}</div>
      {hint && <div className="text-[10px] text-zinc-500 mt-0.5">{hint}</div>}
    </div>
  )
}

// ── Manual trigger view ───────────────────────────────────────────────────

interface PhoneRow { column: string; phone: string; outcome: 'invalid' | 'valid' | 'error'; strategy: string }

function ManualTriggerView() {
  const [scenario, setScenario] = useState<Scenario>('phone_fail')
  const [dealId, setDealId] = useState('')
  const [pasta, setPasta] = useState('')
  const [phone, setPhone] = useState('')
  const [column, setColumn] = useState('telefone_1')
  const [strategy, setStrategy] = useState('adb')
  const [phones, setPhones] = useState<PhoneRow[]>([{ column: 'telefone_1', phone: '', outcome: 'invalid', strategy: 'adb' }])
  const [firstDealId, setFirstDealId] = useState('')
  const [previewMd, setPreviewMd] = useState<{ subject: string | null; body: string; dealUrl: string | null } | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const buildBody = useCallback(() => {
    if (scenario === 'phone_fail') {
      return {
        scenario,
        deal_id: Number(dealId),
        pasta, phone, column, strategy,
      }
    }
    if (scenario === 'deal_all_fail') {
      return {
        scenario,
        deal_id: Number(dealId),
        pasta,
        motivo: 'todos_telefones_invalidos',
        phones: phones.filter((p) => p.phone.trim()).map((p) => ({
          column: p.column, phone: p.phone, outcome: p.outcome, strategy: p.strategy,
        })),
      }
    }
    return {
      scenario,
      pasta,
      first_deal_id: Number(firstDealId || dealId),
      total_deals: 0, ok_deals: 0, archived_deals: 0,
      total_phones_checked: 0, ok_phones: 0,
      strategy_counts: { adb: 0, waha: 0, cache: 0 },
    }
  }, [scenario, dealId, pasta, phone, column, strategy, phones, firstDealId])

  const handlePreview = async () => {
    setError(null); setResult(null)
    try {
      const res = await fetch(`${PIPEDRIVE_BASE}/preview`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(buildBody()),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
      const body = (await res.json()) as { subject: string | null; markdownBody: string; dealUrl: string | null }
      setPreviewMd({ subject: body.subject, body: body.markdownBody, dealUrl: body.dealUrl })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro')
    }
  }

  const handleSend = async () => {
    setSubmitting(true); setError(null); setResult(null)
    try {
      const res = await fetch(`${PIPEDRIVE_BASE}/manual-trigger`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(buildBody()),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
      const body = (await res.json()) as { activityId: string; triggered_by: string }
      setResult(`Atividade #${body.activityId} enfileirada por ${body.triggered_by}.`)
      setConfirm(false)
      setPreviewMd(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro')
    } finally { setSubmitting(false) }
  }

  const COLUMNS = ['telefone_1', 'telefone_2', 'telefone_3', 'telefone_4', 'telefone_5', 'telefone_6', 'telefone_hot_1', 'telefone_hot_2', 'whatsapp_hot']

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2">
        <Send className="h-4 w-4 text-zinc-400" />
        <h3 className="text-sm font-medium text-zinc-200">Disparo manual</h3>
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 space-y-3">
        {/* Scenario selector */}
        <div className="flex gap-3 flex-wrap">
          {(['phone_fail', 'deal_all_fail', 'pasta_summary'] as Scenario[]).map((s) => (
            <label key={s} className="flex items-center gap-1.5 text-xs text-zinc-300 cursor-pointer">
              <input
                type="radio"
                name="scenario"
                value={s}
                checked={scenario === s}
                onChange={() => setScenario(s)}
                className="accent-emerald-500"
              />
              {SCENARIO_BADGE[s].label}
            </label>
          ))}
        </div>

        {/* Common: deal_id + pasta */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {scenario !== 'pasta_summary' && (
            <div className="space-y-1">
              <label className="text-[11px] text-zinc-500">Deal ID</label>
              <input
                type="number" min={1} value={dealId}
                onChange={(e) => setDealId(e.target.value)}
                className="w-full rounded-md bg-zinc-800 border border-zinc-700/40 px-2 py-1.5 text-xs text-zinc-200"
                placeholder="143611"
              />
            </div>
          )}
          {scenario === 'pasta_summary' && (
            <div className="space-y-1">
              <label className="text-[11px] text-zinc-500">First deal ID</label>
              <input
                type="number" min={1} value={firstDealId}
                onChange={(e) => setFirstDealId(e.target.value)}
                className="w-full rounded-md bg-zinc-800 border border-zinc-700/40 px-2 py-1.5 text-xs text-zinc-200"
                placeholder="143611"
              />
            </div>
          )}
          <div className="space-y-1">
            <label className="text-[11px] text-zinc-500">Pasta</label>
            <input
              type="text" value={pasta}
              onChange={(e) => setPasta(e.target.value)}
              className="w-full rounded-md bg-zinc-800 border border-zinc-700/40 px-2 py-1.5 text-xs text-zinc-200"
              placeholder="P-001"
            />
          </div>
        </div>

        {/* Phone fail specific */}
        {scenario === 'phone_fail' && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <div className="space-y-1">
              <label className="text-[11px] text-zinc-500">Telefone</label>
              <input
                type="text" value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="w-full rounded-md bg-zinc-800 border border-zinc-700/40 px-2 py-1.5 text-xs font-mono text-zinc-200"
                placeholder="5543991938235"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[11px] text-zinc-500">Coluna</label>
              <select
                value={column}
                onChange={(e) => setColumn(e.target.value)}
                className="w-full rounded-md bg-zinc-800 border border-zinc-700/40 px-2 py-1.5 text-xs text-zinc-200"
              >
                {COLUMNS.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-[11px] text-zinc-500">Estratégia</label>
              <select
                value={strategy}
                onChange={(e) => setStrategy(e.target.value)}
                className="w-full rounded-md bg-zinc-800 border border-zinc-700/40 px-2 py-1.5 text-xs text-zinc-200"
              >
                <option value="adb">ADB</option>
                <option value="waha">WAHA</option>
                <option value="cache">Cache</option>
              </select>
            </div>
          </div>
        )}

        {/* Deal all-fail dynamic phones */}
        {scenario === 'deal_all_fail' && (
          <div className="space-y-2">
            <label className="text-[11px] text-zinc-500">Telefones avaliados</label>
            {phones.map((p, i) => (
              <div key={i} className="grid grid-cols-12 gap-2 items-center">
                <select
                  value={p.column}
                  onChange={(e) => setPhones((arr) => arr.map((x, j) => j === i ? { ...x, column: e.target.value } : x))}
                  className="col-span-3 rounded-md bg-zinc-800 border border-zinc-700/40 px-2 py-1 text-xs text-zinc-200"
                >
                  {COLUMNS.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
                <input
                  type="text" value={p.phone}
                  onChange={(e) => setPhones((arr) => arr.map((x, j) => j === i ? { ...x, phone: e.target.value } : x))}
                  className="col-span-4 rounded-md bg-zinc-800 border border-zinc-700/40 px-2 py-1 text-xs font-mono text-zinc-200"
                  placeholder="5543..."
                />
                <select
                  value={p.outcome}
                  onChange={(e) => setPhones((arr) => arr.map((x, j) => j === i ? { ...x, outcome: e.target.value as PhoneRow['outcome'] } : x))}
                  className="col-span-2 rounded-md bg-zinc-800 border border-zinc-700/40 px-2 py-1 text-xs text-zinc-200"
                >
                  <option value="invalid">invalid</option>
                  <option value="valid">valid</option>
                  <option value="error">error</option>
                </select>
                <select
                  value={p.strategy}
                  onChange={(e) => setPhones((arr) => arr.map((x, j) => j === i ? { ...x, strategy: e.target.value } : x))}
                  className="col-span-2 rounded-md bg-zinc-800 border border-zinc-700/40 px-2 py-1 text-xs text-zinc-200"
                >
                  <option value="adb">adb</option>
                  <option value="waha">waha</option>
                  <option value="cache">cache</option>
                </select>
                <button
                  onClick={() => setPhones((arr) => arr.filter((_, j) => j !== i))}
                  className="col-span-1 rounded-md bg-red-500/10 border border-red-500/30 px-2 py-1 text-[11px] text-red-300 hover:bg-red-500/20"
                  disabled={phones.length === 1}
                >
                  <XCircle className="h-3 w-3" />
                </button>
              </div>
            ))}
            <button
              onClick={() => setPhones((arr) => [...arr, { column: 'telefone_1', phone: '', outcome: 'invalid', strategy: 'adb' }])}
              className="rounded-md bg-zinc-800 border border-zinc-700/40 px-2.5 py-1 text-[11px] text-zinc-300 hover:bg-zinc-700"
            >
              + adicionar telefone
            </button>
          </div>
        )}

        <div className="flex gap-2 justify-end pt-2 border-t border-zinc-800">
          <button
            onClick={handlePreview}
            className="flex items-center gap-1.5 rounded-md bg-zinc-800 border border-zinc-700/40 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700"
          >
            <Pencil className="h-3.5 w-3.5" /> Preview
          </button>
          <button
            onClick={() => { void handlePreview(); setConfirm(true) }}
            disabled={submitting}
            className="flex items-center gap-1.5 rounded-md bg-emerald-500/15 border border-emerald-500/40 px-3 py-1.5 text-xs text-emerald-200 hover:bg-emerald-500/25"
          >
            <Send className="h-3.5 w-3.5" /> Enviar para Pipedrive
          </button>
        </div>
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}
      {result && <p className="text-xs text-emerald-400">{result}</p>}

      {previewMd && !confirm && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 space-y-2">
          <div className="flex items-center gap-2">
            <Eye className="h-4 w-4 text-zinc-400" />
            <h4 className="text-xs font-medium text-zinc-200">Preview</h4>
          </div>
          {previewMd.subject && <p className="text-xs text-zinc-400">Subject: <span className="text-zinc-200">{previewMd.subject}</span></p>}
          <MarkdownPreview text={previewMd.body} />
        </div>
      )}

      {confirm && previewMd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="max-w-2xl w-full rounded-lg border border-zinc-700 bg-zinc-900 p-5 shadow-xl">
            <div className="flex items-center gap-2 mb-3">
              <AlertTriangle className="h-5 w-5 text-amber-400" />
              <h4 className="text-sm font-semibold text-zinc-100">Confirmação</h4>
            </div>
            <p className="text-xs text-zinc-300 mb-3">
              Esta ação cria uma atividade real no Pipedrive deal <strong>#{dealId || firstDealId}</strong>. Confirma?
            </p>
            <MarkdownPreview text={previewMd.body} />
            <div className="flex gap-2 justify-end mt-3">
              <button
                onClick={() => setConfirm(false)}
                disabled={submitting}
                className="rounded-md bg-zinc-800 border border-zinc-700/40 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700 disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                onClick={handleSend}
                disabled={submitting}
                className="rounded-md bg-emerald-500/15 border border-emerald-500/40 px-3 py-1.5 text-xs text-emerald-200 hover:bg-emerald-500/25 disabled:opacity-50"
              >
                {submitting ? 'Enviando...' : 'Confirmar e enviar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

// ── Health banner ─────────────────────────────────────────────────────────

function HealthBanner() {
  const [health, setHealth] = useState<HealthResponse | null>(null)
  useEffect(() => {
    void fetch(`${PIPEDRIVE_BASE}/health`, { headers: authHeaders() })
      .then((r) => r.json())
      .then((b) => setHealth(b as HealthResponse))
      .catch(() => setHealth(null))
  }, [])
  if (!health) return null
  if (!health.tokenValid) {
    return (
      <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2.5 text-xs text-amber-300 flex items-center gap-2">
        <AlertTriangle className="h-3.5 w-3.5" />
        Pipedrive {health.enabled === false ? 'desativado (sem PIPEDRIVE_API_TOKEN).' : 'token inválido — verifique o .env.'}
      </div>
    )
  }
  return (
    <div className="rounded-md border border-emerald-500/20 bg-emerald-500/5 p-2.5 text-xs text-emerald-300 flex items-center gap-2 flex-wrap">
      <CheckCircle2 className="h-3.5 w-3.5" />
      <span>Pipedrive ativo</span>
      {health.ownerName && <span className="text-zinc-400">· {health.ownerName}</span>}
      {health.company && <span className="text-zinc-400">· {health.company}</span>}
      {health.domain && <span className="text-zinc-400">· domínio <code className="text-zinc-300">{health.domain}</code></span>}
      {!health.domain && <span className="text-amber-300">· defina PIPEDRIVE_COMPANY_DOMAIN para gerar links</span>}
    </div>
  )
}

// ── Main view ─────────────────────────────────────────────────────────────

type SubTab = 'activities' | 'stats' | 'manual'

export function PipedriveView() {
  const [tab, setTab] = useState<SubTab>('activities')

  return (
    <div className="space-y-4">
      <HealthBanner />
      <div className="flex gap-2 border-b border-zinc-800 flex-wrap">
        {(['activities', 'stats', 'manual'] as SubTab[]).map((id) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 transition ${
              tab === id
                ? 'border-sky-400 text-zinc-100'
                : 'border-transparent text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {id === 'activities' && <Activity className="h-3.5 w-3.5" />}
            {id === 'stats' && <BarChart3 className="h-3.5 w-3.5" />}
            {id === 'manual' && <Send className="h-3.5 w-3.5" />}
            {id === 'activities' ? 'Atividades' : id === 'stats' ? 'Métricas' : 'Disparo manual'}
          </button>
        ))}
      </div>
      {tab === 'activities' && <ActivitiesView />}
      {tab === 'stats' && <StatsView />}
      {tab === 'manual' && <ManualTriggerView />}
    </div>
  )
}
