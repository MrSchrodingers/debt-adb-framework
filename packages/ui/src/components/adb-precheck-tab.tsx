import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Stethoscope,
  LayoutDashboard,
  PlayCircle,
  ListOrdered,
  FolderSearch,
  Play,
  CheckCircle2,
  XCircle,
  Database,
  Zap,
  RefreshCw,
  Phone,
  AlertCircle,
  PhoneCall,
  Search,
  ChevronDown,
  ChevronRight,
  BadgeCheck,
  Ban,
  CircleAlert,
  Archive,
} from 'lucide-react'
import { CORE_URL, authHeaders } from '../config'
import {
  PluginHeader,
  StatCard,
  ProgressBar,
  Section,
  Pill,
  AccentButton,
  EmptyState,
  SkeletonRow,
  InlineError,
  SubTabBar,
} from './plugin-ui'
import { PipedriveView } from './adb-precheck/pipedrive-view'

const PLUGIN_BASE = `${CORE_URL}/api/v1/plugins/adb-precheck`
const ACCENT = 'sky' as const

type SubTab = 'overview' | 'scan' | 'deals' | 'jobs' | 'pipedrive'
type PluginStatus = 'active' | 'inactive' | 'checking' | 'error'

interface AggregateStats {
  deals_scanned: number
  deals_with_valid: number
  deals_all_invalid: number
  deals_tombstoned: number
  phones_checked_total: number
  last_scan_at: string | null
}

interface GlobalStats {
  recheck_after_days: number
  threshold_iso: string
  pool: {
    deals_total: number | null
    unsupported: boolean
    error: string | null
  }
  deals: {
    scanned: number
    fresh: number
    stale: number
    pending: number | null
    coverage_percent: number | null
    with_valid: number
    all_invalid: number
    tombstoned: number
  }
  phones: {
    checked: number
    valid: number
    invalid: number
    error: number
    per_deal_avg: number | null
    estimated_in_pool: number | null
    estimated_remaining: number | null
  }
  cache: {
    fresh: number
    total: number
    stale: number
  }
  last_scan_at: string | null
}

interface PrecheckJob {
  id: string
  external_ref: string | null
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  started_at: string | null
  finished_at: string | null
  cancel_requested: number
  total_deals: number | null
  scanned_deals: number
  total_phones: number
  valid_phones: number
  invalid_phones: number
  error_phones: number
  cache_hits: number
  last_error: string | null
  created_at: string
  // Fields added by backend after initial release — absent on older rows
  retry_stats?: {
    level_1_resolves: number
    level_2_resolves: number
    remaining_errors: number
  }
  ui_state_distribution?: Record<string, number>
  snapshots_captured?: number
}

interface ActiveLock {
  key: string
  fenceToken: number
  acquiredAt: string
  expiresAt: string
  context?: Record<string, unknown> | null
}

function fmtLockContext(ctx: ActiveLock['context']): string | null {
  if (!ctx || typeof ctx !== 'object') return null
  const jobId = typeof ctx.job_id === 'string' ? ctx.job_id : null
  const pasta = typeof ctx.pasta === 'string' ? ctx.pasta : null
  const parts: string[] = []
  if (pasta && pasta !== 'all') parts.push(`pasta=${pasta}`)
  if (jobId) parts.push(`job=${jobId.slice(0, 8)}`)
  return parts.length > 0 ? parts.join(' · ') : null
}

interface DealRow {
  pasta: string
  deal_id: number
  contato_tipo: string
  contato_id: number
  valid_count: number
  invalid_count: number
  primary_valid_phone: string | null
  scanned_at: string
  last_job_id: string
  /**
   * Set when Pipeboard's `/precheck/deals/lookup` confirmed the row was
   * removed upstream. Local `phones_json` is kept as audit trail; the
   * UI dims the row + shows a tombstone badge to make the state obvious.
   */
  deleted_at: string | null
}

interface PhoneResult {
  column: string
  raw: string
  normalized: string
  outcome: 'valid' | 'invalid' | 'error'
  source: string
  confidence: number | null
  variant_tried: string | null
  error: string | null
}

// ── Root component ─────────────────────────────────────────────────────────

export function AdbPrecheckTab() {
  const [activeSubTab, setActiveSubTab] = useState<SubTab>('overview')
  const [status, setStatus] = useState<PluginStatus>('checking')
  const [activeJobs, setActiveJobs] = useState(0)
  const [totalDeals, setTotalDeals] = useState(0)

  const fetchStatus = useCallback(async () => {
    try {
      const h = await fetch(`${PLUGIN_BASE}/health`, { headers: authHeaders() })
      if (!h.ok) { setStatus(h.status === 404 ? 'inactive' : 'error'); return }
      const body = await h.json() as { ok?: boolean }
      setStatus(body.ok ? 'active' : 'error')
      const [jobs, stats] = await Promise.all([
        fetch(`${PLUGIN_BASE}/jobs?limit=30`, { headers: authHeaders() }).then((r) => r.ok ? r.json() : []),
        fetch(`${PLUGIN_BASE}/stats`, { headers: authHeaders() }).then((r) => r.ok ? r.json() : null),
      ])
      const arr = Array.isArray(jobs) ? jobs as PrecheckJob[] : []
      setActiveJobs(arr.filter((j) => j.status === 'running' || j.status === 'queued').length)
      setTotalDeals((stats as AggregateStats | null)?.deals_scanned ?? 0)
    } catch {
      setStatus('error')
    }
  }, [])

  useEffect(() => {
    fetchStatus()
    const t = setInterval(fetchStatus, 10_000)
    return () => clearInterval(t)
  }, [fetchStatus])

  return (
    <div className="space-y-4">
      <PluginHeader
        icon={Stethoscope}
        title="ADB Pre-check"
        subtitle="Pipeboard tenant_adb · pre-validacao WhatsApp dos leads de localizacao"
        status={status}
        accent={ACCENT}
        version="0.1.0"
        actions={
          <AccentButton accent={ACCENT} variant="ghost" onClick={fetchStatus} icon={RefreshCw}>
            Atualizar
          </AccentButton>
        }
      />

      <SubTabBar
        accent={ACCENT}
        active={activeSubTab}
        onChange={setActiveSubTab}
        tabs={[
          { id: 'overview', label: 'Visao Geral' },
          { id: 'scan', label: 'Novo Scan' },
          { id: 'deals', label: 'Consultas', count: totalDeals },
          { id: 'jobs', label: 'Jobs', count: activeJobs },
          { id: 'pipedrive', label: 'Pipedrive' },
        ]}
      />

      {status === 'inactive' ? (
        <InlineError message="Plugin indisponivel (404). Verifique se adb-precheck esta em DISPATCH_PLUGINS e se PLUGIN_ADB_PRECHECK_BACKEND esta configurado (sql exige PLUGIN_ADB_PRECHECK_PG_URL; rest exige PLUGIN_ADB_PRECHECK_REST_BASE_URL + PLUGIN_ADB_PRECHECK_REST_API_KEY)." />
      ) : null}

      {activeSubTab === 'overview' ? <OverviewPanel onStartScan={() => setActiveSubTab('scan')} />
      : activeSubTab === 'scan' ? <NewScanPanel onDone={() => setActiveSubTab('jobs')} />
      : activeSubTab === 'deals' ? <DealsPanel />
      : activeSubTab === 'jobs' ? <JobsPanel />
      : <PipedriveView />}
    </div>
  )
}

// ── Overview ───────────────────────────────────────────────────────────────

function OverviewPanel({ onStartScan }: { onStartScan: () => void }) {
  const [stats, setStats] = useState<AggregateStats | null>(null)
  const [global, setGlobal] = useState<GlobalStats | null>(null)
  const [latestJobs, setLatestJobs] = useState<PrecheckJob[]>([])
  const [err, setErr] = useState<string | null>(null)
  // Sweep state
  const [sweepConfirming, setSweepConfirming] = useState(false)
  const [sweepSubmitting, setSweepSubmitting] = useState(false)
  const [sweepToast, setSweepToast] = useState<string | null>(null)
  const [sweepError, setSweepError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [s, g, j] = await Promise.all([
        fetch(`${PLUGIN_BASE}/stats`, { headers: authHeaders() }).then(r => r.ok ? r.json() : Promise.reject(new Error(`stats HTTP ${r.status}`))),
        fetch(`${PLUGIN_BASE}/stats/global`, { headers: authHeaders() }).then(r => r.ok ? r.json() : null),
        fetch(`${PLUGIN_BASE}/jobs?limit=5`, { headers: authHeaders() }).then(r => r.ok ? r.json() : []),
      ])
      setStats(s); setGlobal(g as GlobalStats | null); setLatestJobs(Array.isArray(j) ? j : []); setErr(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, 10_000)
    return () => clearInterval(t)
  }, [load])

  const handleSweep = async () => {
    setSweepSubmitting(true); setSweepError(null)
    try {
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
      const r = await fetch(`${PLUGIN_BASE}/retry-errors`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ since_iso: since, max_deals: 200 }),
      })
      if (r.status === 409) {
        setSweepError('Pasta já em scan. Tente novamente em alguns minutos.')
        return
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const data = await r.json() as { job_id?: string }
      setSweepToast(`Sweep iniciado: ${data.job_id ?? ''}`)
      setSweepConfirming(false)
      void load()
    } catch (e) {
      setSweepError(e instanceof Error ? e.message : String(e))
    } finally {
      setSweepSubmitting(false)
    }
  }

  if (err) return <InlineError message={err} />
  if (!stats) return <OverviewSkeleton />

  const validityRate = stats.deals_scanned > 0
    ? Math.round((stats.deals_with_valid / stats.deals_scanned) * 100)
    : null

  if (stats.deals_scanned === 0) {
    return (
      <EmptyState
        icon={FolderSearch}
        title="Nenhuma consulta scanned ainda"
        description="Rode seu primeiro scan para validar telefones WhatsApp contra o pool de leads do tenant_adb."
        action={
          <AccentButton accent={ACCENT} onClick={onStartScan} icon={Play}>
            Iniciar primeiro scan
          </AccentButton>
        }
      />
    )
  }

  return (
    <div className="space-y-4">
      {global ? <CoveragePanel data={global} /> : null}

      {/* Sweep toast */}
      {sweepToast ? (
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-xs text-emerald-300 flex items-center justify-between">
          <span>{sweepToast}</span>
          <button onClick={() => setSweepToast(null)} className="text-emerald-400 hover:text-emerald-200 ml-4">✕</button>
        </div>
      ) : null}
      {sweepError ? (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-2 text-xs text-amber-300 flex items-center justify-between">
          <span>{sweepError}</span>
          <button onClick={() => setSweepError(null)} className="text-amber-400 hover:text-amber-200 ml-4">✕</button>
        </div>
      ) : null}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          label="Leads scanned"
          value={stats.deals_scanned}
          hint={
            stats.deals_tombstoned > 0
              ? `${stats.deals_tombstoned} removidos do pool (tombstoned)`
              : 'distinct (pasta, deal, contato)'
          }
          icon={Database}
        />
        <StatCard
          label="Com valido"
          value={stats.deals_with_valid}
          tone="emerald"
          icon={BadgeCheck}
          hint={validityRate != null ? `taxa de validade ${validityRate}%` : undefined}
        />
        <StatCard
          label="Todos invalidos"
          value={stats.deals_all_invalid}
          tone="rose"
          icon={Ban}
          hint="nenhum telefone WhatsApp"
        />
        <StatCard
          label="Telefones checados"
          value={stats.phones_checked_total}
          tone="sky"
          icon={Phone}
          hint={stats.last_scan_at ? `ultimo: ${fmtWhen(stats.last_scan_at)}` : undefined}
        />
      </div>

      <Section
        title="Jobs recentes"
        description="Ultimos 5 scans executados"
        actions={
          <div className="flex items-center gap-2">
            <AccentButton accent="amber" variant="ghost" onClick={() => setSweepConfirming(true)} icon={RefreshCw}>
              Reprocessar erros
            </AccentButton>
            <AccentButton accent={ACCENT} onClick={onStartScan} icon={Play}>
              Novo Scan
            </AccentButton>
          </div>
        }
      >
        {latestJobs.length === 0 ? (
          <EmptyState icon={ListOrdered} title="Sem jobs" description="Nenhum scan registrado ainda." />
        ) : (
          <div className="space-y-2">
            {latestJobs.map((j) => <JobCard key={j.id} job={j} compact />)}
          </div>
        )}
      </Section>

      <LocksPanel />

      {sweepConfirming ? (
        <SweepConfirmModal
          onCancel={() => { setSweepConfirming(false); setSweepError(null) }}
          onConfirm={handleSweep}
          submitting={sweepSubmitting}
        />
      ) : null}
    </div>
  )
}

function SweepConfirmModal({
  onCancel,
  onConfirm,
  submitting,
}: {
  onCancel: () => void
  onConfirm: () => void
  submitting: boolean
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-md rounded-xl border border-amber-500/30 bg-zinc-950 p-5 shadow-xl shadow-black/50">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-500/10 border border-amber-500/30">
            <RefreshCw className="h-5 w-5 text-amber-300" />
          </div>
          <div className="flex-1">
            <h5 className="text-sm font-semibold text-zinc-100">Reprocessar erros de scan</h5>
            <p className="mt-1 text-xs text-zinc-400">
              Um novo job de sweep será enfileirado para retentar todos os telefones com erro nos últimos 7 dias.
            </p>
            <ul className="mt-3 space-y-1 text-xs text-zinc-300 list-disc list-inside">
              <li>Limite: 200 deals por sweep</li>
              <li>Janela: últimos 7 dias</li>
              <li>Acompanhe o progresso na aba Jobs</li>
            </ul>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onCancel} className="rounded-md border border-zinc-800 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-900">
            Cancelar
          </button>
          <AccentButton accent="amber" onClick={onConfirm} disabled={submitting} icon={RefreshCw}>
            {submitting ? 'Iniciando…' : 'Confirmar sweep'}
          </AccentButton>
        </div>
      </div>
    </div>
  )
}

function LocksPanel() {
  const [locks, setLocks] = useState<ActiveLock[]>([])
  const [loading, setLoading] = useState(true)

  const fetchLocks = useCallback(async () => {
    try {
      const r = await fetch(`${PLUGIN_BASE}/admin/locks`, { headers: authHeaders() })
      if (!r.ok) return
      const data = await r.json() as { locks?: ActiveLock[] }
      setLocks(Array.isArray(data.locks) ? data.locks : [])
    } catch {
      // Non-fatal — locks panel is best-effort
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchLocks()
    const t = setInterval(fetchLocks, 10_000)
    return () => clearInterval(t)
  }, [fetchLocks])

  const fmtRemaining = (expiresAt: string): string => {
    const ms = new Date(expiresAt).getTime() - Date.now()
    if (ms <= 0) return 'expirado'
    return `expira em ${fmtDuration(ms)}`
  }

  const lockTone = (key: string): 'sky' | 'violet' =>
    key.startsWith('note.') ? 'violet' : 'sky'

  const toneClasses: Record<'sky' | 'violet', string> = {
    sky: 'text-sky-400',
    violet: 'text-violet-400',
  }

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <Database className="h-3.5 w-3.5 text-zinc-500" />
        <span className="text-[11px] uppercase tracking-wider text-zinc-500">Locks ativos</span>
      </div>
      {loading ? (
        <div className="text-xs text-zinc-600">Carregando…</div>
      ) : locks.length === 0 ? (
        <div className="text-xs text-zinc-600">Sem locks ativos.</div>
      ) : (
        <div className="space-y-1">
          {locks.map((lock) => {
            const tone = lockTone(lock.key)
            return (
              <div key={lock.key} className="flex items-center gap-3 text-xs font-mono">
                <span className={`shrink-0 ${toneClasses[tone]}`}>■</span>
                <span className="text-zinc-300 min-w-0 flex-1 truncate">{lock.key}</span>
                {(() => {
                  const ctxLabel = fmtLockContext(lock.context)
                  return ctxLabel ? (
                    <span className="text-zinc-500 shrink-0 truncate max-w-[180px]">{ctxLabel}</span>
                  ) : null
                })()}
                <span className="text-zinc-600 shrink-0">{fmtRemaining(lock.expiresAt)}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function OverviewSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="animate-pulse rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 h-24" />
        ))}
      </div>
      <div className="animate-pulse rounded-lg border border-zinc-800 bg-zinc-900/40 h-32" />
    </div>
  )
}

/**
 * Top-of-page coverage panel. Aggregates the lifetime view across
 * Pipeboard pool size, Dispatch's per-deal scan history, the per-phone
 * cache (wa_contact_checks), and a phones-per-deal multiplier observed
 * from completed jobs.
 *
 * The pool denominator can be `null` — the Pipeboard REST contract
 * intentionally omits COUNT for performance (ADR 0002). When that
 * happens we render the absolute counts and skip the percentage bar
 * instead of faking a denominator.
 *
 * The "lote sugerido" hints help operators size next batches without
 * mental math: at the observed rate, `limit=N` will validate ≈X phones
 * in ≈Y minutes.
 */
function CoveragePanel({ data }: { data: GlobalStats }) {
  const dealsCov = data.deals.coverage_percent
  const phonesEstPool = data.phones.estimated_in_pool
  const phonesEstRemaining = data.phones.estimated_remaining
  const perDealAvg = data.phones.per_deal_avg ?? 0
  const phonesCheckedPct =
    phonesEstPool && phonesEstPool > 0 && data.phones.checked > 0
      ? Math.min(100, Math.round((data.phones.checked / phonesEstPool) * 100))
      : null

  // Rough rate model: each phone ≈ 6s of L3 ADB probing on average
  // (pre-cache hit ratio). Operators only need an order-of-magnitude;
  // exact ETA comes from the running job's bar.
  const estimateMinutes = (phones: number): number => Math.max(1, Math.round((phones * 6) / 60))

  const batchSizes = [50, 100, 250, 500].filter(
    (n) => phonesEstRemaining == null || n * perDealAvg <= phonesEstRemaining * 1.5,
  )

  return (
    <div className="rounded-xl border border-sky-800/40 bg-gradient-to-br from-zinc-900/80 to-sky-950/20 p-4 space-y-4">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-sm font-medium text-zinc-200">Cobertura global</h3>
          <p className="text-xs text-zinc-500">
            janela de re-scan: {data.recheck_after_days} dias · pool Pipeboard ↔ scans Dispatch
          </p>
        </div>
        {dealsCov != null ? (
          <div className="text-right">
            <div className="text-2xl font-mono font-semibold text-sky-300">{dealsCov.toFixed(1)}%</div>
            <div className="text-[10px] text-zinc-500 uppercase tracking-wider">deals frescos no pool</div>
          </div>
        ) : null}
      </div>

      {/* Coverage bar — only when pool size is known. */}
      {dealsCov != null && data.pool.deals_total != null ? (
        <div className="space-y-1">
          <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-800">
            <div
              className="h-full bg-gradient-to-r from-sky-600 to-emerald-500 transition-all duration-700"
              style={{ width: `${Math.min(100, dealsCov)}%` }}
            />
          </div>
          <div className="flex items-center justify-between text-[11px] text-zinc-400 tabular-nums">
            <span>{data.deals.fresh.toLocaleString('pt-BR')} fresh</span>
            <span>
              {data.deals.scanned.toLocaleString('pt-BR')} / {data.pool.deals_total.toLocaleString('pt-BR')} deals
            </span>
          </div>
        </div>
      ) : null}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <CoverageMetric
          label="Pool de deals"
          value={data.pool.deals_total != null ? data.pool.deals_total.toLocaleString('pt-BR') : '—'}
          sub={
            data.pool.unsupported
              ? 'Pipeboard COUNT desativado'
              : data.pool.error
                ? 'erro ao consultar pool'
                : 'distintos no upstream'
          }
          tone="sky"
        />
        <CoverageMetric
          label="Já varridos"
          value={data.deals.scanned.toLocaleString('pt-BR')}
          sub={
            data.deals.tombstoned > 0
              ? `${data.deals.fresh.toLocaleString('pt-BR')} fresh · ${data.deals.stale.toLocaleString('pt-BR')} stale · ${data.deals.tombstoned.toLocaleString('pt-BR')} tombstoned`
              : `${data.deals.fresh.toLocaleString('pt-BR')} fresh · ${data.deals.stale.toLocaleString('pt-BR')} stale`
          }
          tone="emerald"
        />
        <CoverageMetric
          label="Pendentes"
          value={data.deals.pending != null ? data.deals.pending.toLocaleString('pt-BR') : '—'}
          sub={
            data.deals.pending != null
              ? `${data.deals.stale} stale + ${Math.max(0, data.deals.pending - data.deals.stale)} novos`
              : 'pool desconhecido'
          }
          tone="amber"
        />
        <CoverageMetric
          label="Telefones testados"
          value={data.phones.checked.toLocaleString('pt-BR')}
          sub={
            phonesCheckedPct != null
              ? `≈${phonesCheckedPct}% do pool estimado`
              : `${data.phones.valid} válidos · ${data.phones.invalid} inválidos`
          }
          tone="violet"
        />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 pt-2 border-t border-zinc-800/60">
        <CoverageMetric
          label="Phones / deal (média)"
          value={data.phones.per_deal_avg != null ? data.phones.per_deal_avg.toFixed(2) : '—'}
          sub="observado nos jobs completados"
          tone="zinc"
        />
        <CoverageMetric
          label="Phones estimados no pool"
          value={phonesEstPool != null ? `~${phonesEstPool.toLocaleString('pt-BR')}` : '—'}
          sub={phonesEstRemaining != null ? `~${phonesEstRemaining.toLocaleString('pt-BR')} pendentes` : 'pool desconhecido'}
          tone="zinc"
        />
        <CoverageMetric
          label="Cache wa_contact_checks"
          value={`${data.cache.fresh.toLocaleString('pt-BR')} fresh`}
          sub={`${data.cache.total.toLocaleString('pt-BR')} total · ${data.cache.stale.toLocaleString('pt-BR')} stale`}
          tone="zinc"
        />
      </div>

      {/* Batch sizing hints — only when we have enough info to be useful. */}
      {perDealAvg > 0 && phonesEstRemaining != null && phonesEstRemaining > 0 ? (
        <div className="rounded-md border border-zinc-800/60 bg-zinc-950/50 p-3">
          <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-2">
            Lotes sugeridos · {perDealAvg.toFixed(1)} phones/deal · ~6s/phone
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {batchSizes.length > 0
              ? batchSizes.map((limit) => {
                  const phonesEst = Math.round(limit * perDealAvg)
                  const minutesEst = estimateMinutes(phonesEst)
                  const pctOfRemaining =
                    phonesEstRemaining > 0
                      ? Math.min(100, Math.round((phonesEst / phonesEstRemaining) * 100))
                      : null
                  return (
                    <div key={limit} className="rounded bg-zinc-900/70 border border-zinc-800 px-2 py-1.5">
                      <div className="text-xs font-mono text-zinc-200">limit={limit}</div>
                      <div className="text-[10px] text-zinc-500">
                        ~{phonesEst.toLocaleString('pt-BR')} phones · ~{minutesEst} min
                        {pctOfRemaining != null ? ` · ${pctOfRemaining}% do pendente` : ''}
                      </div>
                    </div>
                  )
                })
              : (
                <div className="col-span-full text-xs text-zinc-500">Pool quase coberto — qualquer tamanho de lote serve.</div>
              )}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function CoverageMetric({
  label,
  value,
  sub,
  tone,
}: {
  label: string
  value: string | number
  sub?: string
  tone: 'sky' | 'emerald' | 'amber' | 'violet' | 'zinc'
}) {
  const toneClasses: Record<typeof tone, string> = {
    sky: 'text-sky-300',
    emerald: 'text-emerald-300',
    amber: 'text-amber-300',
    violet: 'text-violet-300',
    zinc: 'text-zinc-200',
  }
  return (
    <div className="rounded-md border border-zinc-800/50 bg-zinc-900/40 p-3">
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
      <div className={`mt-1 text-lg font-mono font-semibold tabular-nums ${toneClasses[tone]}`}>{value}</div>
      {sub ? <div className="mt-0.5 text-[10px] text-zinc-500">{sub}</div> : null}
    </div>
  )
}

// ── New Scan ───────────────────────────────────────────────────────────────

interface DeviceAccount {
  phoneNumber: string
  packageName: string
  profileId: number
}

interface DeviceOption {
  serial: string
  status?: string
  /** Mapped accounts (phoneNumber !== null). Primary account is the first one. */
  accounts: DeviceAccount[]
}

function NewScanPanel({ onDone }: { onDone: () => void }) {
  const [limit, setLimit] = useState('100')
  const [pastaPrefix, setPastaPrefix] = useState('')
  const [pipelineNome, setPipelineNome] = useState('')
  const [writebackInvalid, setWritebackInvalid] = useState(false)
  const [deviceSerial, setDeviceSerial] = useState('')
  const [wahaSession, setWahaSession] = useState('')
  const [devices, setDevices] = useState<DeviceOption[]>([])
  const [devicesLoading, setDevicesLoading] = useState(false)

  // Load connected devices + their mapped WA accounts in one shot so
  // the WAHA-session picker can react instantly when the operator
  // changes the device.
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setDevicesLoading(true)
      try {
        const r = await fetch(`${CORE_URL}/api/v1/monitor/devices`, { headers: authHeaders() })
        if (!r.ok) return
        const list = (await r.json()) as Array<{ serial: string; status?: string }>
        const opts: DeviceOption[] = await Promise.all(
          list.map(async (d) => {
            try {
              const a = await fetch(
                `${CORE_URL}/api/v1/monitor/devices/${encodeURIComponent(d.serial)}/accounts`,
                { headers: authHeaders() },
              )
              if (!a.ok) return { serial: d.serial, status: d.status, accounts: [] }
              const raw = (await a.json()) as Array<{
                phoneNumber: string | null
                packageName: string
                profileId: number
                stale?: boolean
              }>
              // Only keep entries with a real number AND fresh data —
              // empty phoneNumber = WA present but unmapped; stale =
              // older than 7 days, likely outdated since the previous
              // scan. Either way, we can't route a probe through them.
              const accounts: DeviceAccount[] = raw
                .filter(
                  (x): x is { phoneNumber: string; packageName: string; profileId: number; stale?: boolean } =>
                    Boolean(x.phoneNumber) && !x.stale,
                )
                .map((x) => ({
                  phoneNumber: x.phoneNumber,
                  packageName: x.packageName,
                  profileId: x.profileId,
                }))
              return { serial: d.serial, status: d.status, accounts }
            } catch {
              return { serial: d.serial, status: d.status, accounts: [] }
            }
          }),
        )
        if (!cancelled) setDevices(opts)
      } finally {
        if (!cancelled) setDevicesLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [])

  // When the operator switches device, the previously-selected WAHA
  // session may not exist on the new device — clear it.
  useEffect(() => {
    if (!deviceSerial) return
    const dev = devices.find((d) => d.serial === deviceSerial)
    if (!dev) return
    if (wahaSession && !dev.accounts.some((a) => a.phoneNumber === wahaSession)) {
      setWahaSession('')
    }
  }, [deviceSerial, devices, wahaSession])

  const selectedDevice = devices.find((d) => d.serial === deviceSerial) ?? null
  const availableAccounts = selectedDevice?.accounts ?? []
  // Per-job Pipedrive opt-in. Default ON — operators can flip it OFF for
  // dry-run scans that should not pollute the CRM.
  const [pipedriveEnabled, setPipedriveEnabled] = useState(true)
  // Modo Higienização (Part 2): pauses global production sends server-side
  // for the lifetime of the scan and floors recheck_after_days at 30. Strong
  // confirmation required because it freezes ALL outgoing messages.
  const [hygienizationMode, setHygienizationMode] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [confirmingHygienization, setConfirmingHygienization] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const hasWriteback = writebackInvalid

  const submit = async () => {
    setSubmitting(true); setErr(null)
    try {
      const body = {
        limit: Number(limit) || undefined,
        pasta_prefix: pastaPrefix || undefined,
        pipeline_nome: pipelineNome || undefined,
        writeback_invalid: writebackInvalid,
        pipedrive_enabled: pipedriveEnabled,
        hygienization_mode: hygienizationMode,
        device_serial: deviceSerial || undefined,
        waha_session: wahaSession || undefined,
      }
      const r = await fetch(`${PLUGIN_BASE}/scan`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      onDone()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false); setConfirming(false); setConfirmingHygienization(false)
    }
  }

  const handleStart = () => {
    // Hygienization confirmation supersedes the writeback confirmation:
    // the operator MUST acknowledge the global pause before anything else.
    if (hygienizationMode) setConfirmingHygienization(true)
    else if (hasWriteback) setConfirming(true)
    else submit()
  }

  const inputCls =
    'w-full rounded-md bg-zinc-950 border border-zinc-800 px-3 py-1.5 text-sm text-zinc-100 focus:outline-none focus:border-sky-500/40'

  return (
    <div className="space-y-4">
      <Section title="Filtro" description="Restringe o pool de leads a escanear.">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
          <Field label="Limite de leads" hint="1–100000">
            <input
              type="number"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="Prefixo de pasta" hint="opcional">
            <input
              type="text"
              value={pastaPrefix}
              onChange={(e) => setPastaPrefix(e.target.value)}
              placeholder="ex: 1857"
              className={inputCls}
            />
          </Field>
          <Field label="Pipeline" hint="pipeline_nome exato">
            <input
              type="text"
              value={pipelineNome}
              onChange={(e) => setPipelineNome(e.target.value)}
              placeholder="ex: Localizacao"
              className={inputCls}
            />
          </Field>
        </div>
      </Section>

      <Section
        title="Device de probe"
        description="Escolha qual telefone (de qual device conectado) executa a verificação ADB. Vazio = usa o default do plugin."
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
          <Field
            label="Device (ADB serial)"
            hint={devicesLoading ? 'carregando...' : `${devices.length} conectados`}
          >
            <select
              value={deviceSerial}
              onChange={(e) => setDeviceSerial(e.target.value)}
              disabled={devicesLoading}
              className={`${inputCls} disabled:opacity-60`}
            >
              <option value="">— usar default do plugin —</option>
              {devices.map((d) => {
                const primary = d.accounts[0]?.phoneNumber
                const offline = d.status && d.status !== 'online'
                return (
                  <option key={d.serial} value={d.serial}>
                    {d.serial}
                    {primary ? ` · ${primary}` : ''}
                    {d.accounts.length > 1 ? ` (+${d.accounts.length - 1})` : ''}
                    {offline ? ` [${d.status}]` : ''}
                  </option>
                )
              })}
            </select>
          </Field>
          <Field
            label="Número do sender (WAHA session)"
            hint={
              !deviceSerial
                ? 'escolha um device primeiro'
                : availableAccounts.length === 0
                ? 'nenhum número mapeado neste device'
                : `${availableAccounts.length} mapeado${availableAccounts.length > 1 ? 's' : ''}`
            }
          >
            <select
              value={wahaSession}
              onChange={(e) => setWahaSession(e.target.value)}
              disabled={!deviceSerial || availableAccounts.length === 0}
              className={`${inputCls} disabled:opacity-60`}
            >
              <option value="">— usar default do plugin —</option>
              {availableAccounts.map((a) => (
                <option
                  key={`${a.profileId}|${a.packageName}|${a.phoneNumber}`}
                  value={a.phoneNumber}
                >
                  {a.phoneNumber}
                  {a.packageName === 'com.whatsapp.w4b' ? ' · WA Business' : ''}
                  {a.profileId > 0 ? ` · profile ${a.profileId}` : ''}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </Section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Section
          title="Writeback no Pipeboard"
          description="O plugin só escreve de volta no Pipeboard quando explicitamente habilitado."
        >
          <div className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
            <Toggle
              checked={writebackInvalid}
              onChange={setWritebackInvalid}
              label="Limpar telefones invalidos em prov_consultas"
              hint="cada telefone invalido vira NULL na sua coluna de origem; deals sem nenhum valido recebem marca em prov_invalidos (motivo='whatsapp_nao_existe'). A decisão de qual telefone é o 'localizado' é do provedor — não do precheck."
              icon={<Ban className="h-4 w-4 text-rose-400" />}
            />
            {hasWriteback ? (
              <div className="mt-3 rounded-md border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-amber-300 flex items-start gap-2">
                <CircleAlert className="h-4 w-4 shrink-0 mt-0.5" />
                <div>
                  <div className="font-medium">Writeback habilitado</div>
                  <p className="mt-0.5 text-amber-300/80">
                    Este scan vai alterar dados em <code className="text-amber-200">tenant_adb</code> no Pipeboard. Confirmação adicional será pedida antes de enfileirar.
                  </p>
                </div>
              </div>
            ) : null}
          </div>
        </Section>

        <Section
          title="Pipedrive"
          description="Atividades / notas no CRM por scan. Quando o token não está configurado o flag é ignorado silenciosamente."
        >
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
            <Toggle
              checked={pipedriveEnabled}
              onChange={setPipedriveEnabled}
              label="Criar atividades no Pipedrive"
              hint="cobre os cenários — phone fail, deal all-fail, pasta summary; desligue para scans dry-run"
              icon={<BadgeCheck className="h-4 w-4 text-sky-400" />}
            />
          </div>
        </Section>
      </div>

      <Section
        title="Modo Higienização (segurança)"
        description="Para varreduras grandes (>100 deals). Pausa o envio em produção pelo tempo do scan e usa rate conservador."
      >
        <div className="space-y-2 rounded-lg border border-amber-500/20 bg-amber-500/5 p-4">
          <Toggle
            checked={hygienizationMode}
            onChange={setHygienizationMode}
            label="Pausar envio prod e usar rate conservador"
            hint="recheck_after_days será forçado para no mínimo 30; durante o scan, NENHUMA mensagem prod sai. Auto-resume ao terminar."
            icon={<CircleAlert className="h-4 w-4 text-amber-300" />}
          />
          {hygienizationMode ? (
            <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200 flex items-start gap-2">
              <CircleAlert className="h-4 w-4 shrink-0 mt-0.5" />
              <div>
                <div className="font-medium">Pausa global será aplicada</div>
                <p className="mt-0.5 text-amber-200/80">
                  Recomendado para scans de varredura ampla. Confirmação adicional será pedida antes de iniciar.
                </p>
              </div>
            </div>
          ) : null}
        </div>
      </Section>

      {err ? <InlineError message={`Erro: ${err}`} /> : null}

      <div className="flex items-center gap-3 pt-2">
        <AccentButton accent={ACCENT} onClick={handleStart} disabled={submitting} icon={Play}>
          {submitting ? 'Enfileirando…' : 'Iniciar Scan'}
        </AccentButton>
        <p className="text-xs text-zinc-500">
          Pool-based · idempotente por external_ref · cache compartilhado com Oralsin
        </p>
      </div>

      {confirming ? (
        <ConfirmModal
          onCancel={() => setConfirming(false)}
          onConfirm={submit}
          submitting={submitting}
          writebackInvalid={writebackInvalid}
        />
      ) : null}

      {confirmingHygienization ? (
        <HygienizationConfirmModal
          onCancel={() => setConfirmingHygienization(false)}
          onConfirm={() => {
            // Chain into the writeback confirmation if writeback is also on,
            // otherwise submit immediately. Operator already acknowledged the
            // global pause at this point.
            setConfirmingHygienization(false)
            if (hasWriteback) setConfirming(true)
            else void submit()
          }}
          submitting={submitting}
        />
      ) : null}
    </div>
  )
}

function HygienizationConfirmModal({
  onCancel,
  onConfirm,
  submitting,
}: {
  onCancel: () => void
  onConfirm: () => void
  submitting: boolean
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
      <div className="w-full max-w-md rounded-xl border border-amber-500/40 bg-zinc-950 p-5 shadow-xl shadow-black/50">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-500/10 border border-amber-500/30">
            <CircleAlert className="h-5 w-5 text-amber-300" />
          </div>
          <div className="flex-1">
            <h5 className="text-sm font-semibold text-zinc-100">Confirmar Modo Higienização</h5>
            <p className="mt-1 text-xs text-zinc-400">
              Esta ação <strong className="text-amber-200">pausará TODO o envio em produção</strong> enquanto o scan rodar.
            </p>
            <ul className="mt-3 space-y-1 text-xs text-zinc-300 list-disc list-inside">
              <li>Recheck após N dias forçado para ≥ 30</li>
              <li>Rate limit conservador (~1 req/min)</li>
              <li>Auto-resume quando o scan terminar (sucesso, erro ou cancelamento)</li>
            </ul>
          </div>
        </div>
        <div className="mt-5 flex items-center justify-end gap-2">
          <button onClick={onCancel} className="rounded-md px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800">
            Cancelar
          </button>
          <button
            onClick={onConfirm}
            disabled={submitting}
            className="rounded-md bg-amber-500/20 border border-amber-500/40 px-3 py-1.5 text-sm text-amber-100 hover:bg-amber-500/30 disabled:opacity-50"
          >
            {submitting ? 'Iniciando…' : 'Confirmar e pausar prod'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ConfirmModal({
  onCancel,
  onConfirm,
  submitting,
  writebackInvalid,
}: {
  onCancel: () => void
  onConfirm: () => void
  submitting: boolean
  writebackInvalid: boolean
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-md rounded-xl border border-amber-500/30 bg-zinc-950 p-5 shadow-xl shadow-black/50">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-500/10 border border-amber-500/30">
            <CircleAlert className="h-5 w-5 text-amber-300" />
          </div>
          <div className="flex-1">
            <h5 className="text-sm font-semibold text-zinc-100">Confirmar writeback no Pipeboard</h5>
            <p className="mt-1 text-xs text-zinc-400">
              Este scan vai alterar dados em <code className="text-zinc-200">tenant_adb</code>. Verifique:
            </p>
            <ul className="mt-3 space-y-1 text-xs text-zinc-300">
              {writebackInvalid ? (
                <>
                  <li className="flex items-start gap-2"><Ban className="h-3.5 w-3.5 mt-0.5 text-rose-400" /><span>UPSERT em <code>prov_telefones_invalidos</code> (blocklist autoritativa)</span></li>
                  <li className="flex items-start gap-2"><Ban className="h-3.5 w-3.5 mt-0.5 text-rose-400" /><span>UPDATE em <code>prov_consultas</code> NULLificando colunas dos invalidos</span></li>
                  <li className="flex items-start gap-2"><Ban className="h-3.5 w-3.5 mt-0.5 text-rose-400" /><span>INSERT em <code>prov_invalidos</code> + archive p/ snapshot quando deal fica vazio</span></li>
                </>
              ) : null}
            </ul>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onCancel} className="rounded-md border border-zinc-800 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-900">Cancelar</button>
          <AccentButton accent="amber" onClick={onConfirm} disabled={submitting} icon={Play}>
            {submitting ? 'Iniciando…' : 'Confirmar e rodar'}
          </AccentButton>
        </div>
      </div>
    </div>
  )
}

// ── Jobs ───────────────────────────────────────────────────────────────────

function JobsPanel() {
  const [jobs, setJobs] = useState<PrecheckJob[] | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const refresh = useCallback(() => {
    fetch(`${PLUGIN_BASE}/jobs?limit=30`, { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => setJobs(Array.isArray(d) ? d : []))
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
  }, [])

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 3_000)
    return () => clearInterval(t)
  }, [refresh])

  if (err) return <InlineError message={err} />
  if (jobs === null) return <div className="h-40 animate-pulse rounded-lg border border-zinc-800 bg-zinc-900/40" />
  if (jobs.length === 0) {
    return <EmptyState icon={ListOrdered} title="Nenhum job ainda" description="Rode um scan em Novo Scan para ver o progresso aqui." />
  }

  return (
    <div className="space-y-2">
      {jobs.map((j) => <JobCard key={j.id} job={j} />)}
    </div>
  )
}

function JobCard({ job, compact = false }: { job: PrecheckJob; compact?: boolean }) {
  const [expanded, setExpanded] = useState(false)
  // Backend reports total_deals=-1 when the scan is streaming and the
  // upstream pool size is not knowable upfront. That left the bar
  // pinned at 0% even on completed jobs (operator sees an empty track
  // and assumes the UI broke). Two derived values fix it:
  //   • `reportedTotal`: raw value from the API, may be -1 / 0 / N
  //   • `effectiveTotal`: what the bar actually divides by — when the
  //     job is in a terminal status (completed/failed/cancelled) and
  //     the reported total is missing, scanned_deals IS the final
  //     count, so use it (bar pegs at 100%).
  //   • `indeterminate`: only true while running with no known total —
  //     ProgressBar then renders an animated thumb instead of a static
  //     0% fill.
  const reportedTotal = job.total_deals ?? 0
  const isTerminal =
    job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled'
  const effectiveTotal = reportedTotal > 0
    ? reportedTotal
    : isTerminal
      ? job.scanned_deals
      : 0
  const indeterminate = !isTerminal && effectiveTotal <= 0

  const elapsedMs = useMemo(() => {
    const s = job.started_at ?? job.created_at
    const e = job.finished_at ?? new Date().toISOString()
    return Math.max(0, new Date(e).getTime() - new Date(s).getTime())
  }, [job.started_at, job.finished_at, job.created_at])

  const rate = elapsedMs > 0 && job.scanned_deals > 0
    ? job.scanned_deals / (elapsedMs / 1000)
    : 0
  const eta = rate > 0 && effectiveTotal > 0 && job.status === 'running'
    ? Math.round((effectiveTotal - job.scanned_deals) / rate)
    : null

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 overflow-hidden">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-zinc-900/70"
      >
        {expanded ? <ChevronDown className="h-4 w-4 text-zinc-500 shrink-0" /> : <ChevronRight className="h-4 w-4 text-zinc-500 shrink-0" />}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <JobStatusPill status={job.status} />
            <code className="font-mono text-xs text-zinc-400">{job.id.slice(0, 10)}</code>
            {job.external_ref ? <Pill tone="zinc">{job.external_ref}</Pill> : null}
            <span className="text-xs text-zinc-500">{fmtWhen(job.started_at ?? job.created_at)}</span>
            {eta != null ? <Pill tone="sky">ETA {fmtDuration(eta * 1000)}</Pill> : null}
          </div>
          {!compact ? <div className="mt-2"><ProgressBar accent={jobAccent(job.status)} value={job.scanned_deals} total={effectiveTotal} indeterminate={indeterminate} label="Leads scanned" /></div> : null}
          <div className={`mt-${compact ? 1 : 2} flex items-center gap-3 text-xs text-zinc-500 flex-wrap`}>
            <span className="flex items-center gap-1"><PhoneCall className="h-3 w-3" />{job.total_phones.toLocaleString('pt-BR')} checados</span>
            <span className="flex items-center gap-1 text-emerald-400"><BadgeCheck className="h-3 w-3" />{job.valid_phones}</span>
            <span className="flex items-center gap-1 text-rose-400"><Ban className="h-3 w-3" />{job.invalid_phones}</span>
            {job.error_phones > 0 ? <span className="flex items-center gap-1 text-amber-400"><AlertCircle className="h-3 w-3" />{job.error_phones}</span> : null}
            <span className="flex items-center gap-1"><Zap className="h-3 w-3" />{job.cache_hits} cache hits</span>
            <span>· {fmtDuration(elapsedMs)}</span>
          </div>
        </div>
      </button>
      {expanded ? <JobDetail job={job} /> : null}
    </div>
  )
}

function JobDetail({ job }: { job: PrecheckJob }) {
  const successRate = job.total_phones > 0
    ? Math.round((job.valid_phones / job.total_phones) * 100)
    : 0

  // ui_state_distribution: entries sorted by count descending
  const uiStateEntries = job.ui_state_distribution
    ? Object.entries(job.ui_state_distribution).sort((a, b) => b[1] - a[1])
    : null

  const uiStateTone = (state: string): 'emerald' | 'sky' | 'amber' | 'rose' => {
    if (state === 'chat_open' || state === 'invite_modal') return 'emerald'
    if (state === 'searching') return 'sky'
    if (state === 'chat_list' || state === 'contact_picker' || state === 'disappearing_msg_dialog') return 'amber'
    return 'rose'
  }

  return (
    <div className="border-t border-zinc-800 bg-zinc-950/50 p-4 space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Taxa de validade" value={`${successRate}%`} tone="sky" />
        <StatCard label="Cache hits" value={job.cache_hits} tone="violet" hint={job.total_phones > 0 ? `${Math.round(job.cache_hits / job.total_phones * 100)}% do total` : undefined} />
        <StatCard label="Erros" value={job.error_phones} tone={job.error_phones > 0 ? 'amber' : 'zinc'} />
        <StatCard label="Cancel requested" value={job.cancel_requested ? 'sim' : 'nao'} tone={job.cancel_requested ? 'amber' : 'zinc'} />
      </div>

      {/* Retry stats — only present on jobs with the new backend */}
      {job.retry_stats ? (
        <div className="space-y-1">
          <div className="text-[11px] uppercase tracking-wider text-zinc-500">Estatisticas de retry</div>
          <div className="grid grid-cols-3 gap-3">
            <StatCard
              label="Recovery (probe)"
              value={job.retry_stats.level_1_resolves}
              tone="violet"
              hint="Level 1 saves"
            />
            <StatCard
              label="Retry final (scan)"
              value={job.retry_stats.level_2_resolves}
              tone="sky"
              hint="Level 2 saves"
            />
            <StatCard
              label="Erros pendentes"
              value={job.retry_stats.remaining_errors}
              tone={job.retry_stats.remaining_errors > 0 ? 'amber' : 'zinc'}
            />
          </div>
        </div>
      ) : null}

      {/* UI state distribution — only when backend populates it */}
      {uiStateEntries && uiStateEntries.length > 0 ? (
        <div className="space-y-1">
          <div className="text-[11px] uppercase tracking-wider text-zinc-500">Distribuicao de estados UI</div>
          <div className="flex flex-wrap gap-2">
            {uiStateEntries.map(([state, count]) => (
              <div key={state} className="flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900/50 px-2 py-1 text-xs">
                <Pill tone={uiStateTone(state)}>{state}</Pill>
                <span className="font-mono text-zinc-300">{count}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* Snapshots captured — only when field is present */}
      {job.snapshots_captured != null ? (
        <div className="grid grid-cols-1 gap-3">
          <StatCard
            label="Snapshots capturados"
            value={job.snapshots_captured}
            tone={job.snapshots_captured > 0 ? 'amber' : 'zinc'}
            hint="Telas desconhecidas salvas em disco para calibracao"
          />
        </div>
      ) : null}

      {job.last_error ? (
        <div className="rounded-md border border-rose-500/20 bg-rose-500/5 p-3 text-xs text-rose-300 whitespace-pre-wrap">
          <div className="font-medium mb-1">Ultimo erro</div>
          <code className="font-mono">{job.last_error}</code>
        </div>
      ) : null}
      <div className="text-xs text-zinc-500">
        created: {job.created_at} · started: {job.started_at ?? '—'} · finished: {job.finished_at ?? '—'}
      </div>
    </div>
  )
}

function jobAccent(s: PrecheckJob['status']) {
  return s === 'running' ? 'sky'
    : s === 'completed' ? 'emerald'
    : s === 'failed' ? 'rose'
    : s === 'cancelled' ? 'amber'
    : 'zinc'
}

function JobStatusPill({ status }: { status: PrecheckJob['status'] }) {
  if (status === 'running') return <Pill tone="sky">running</Pill>
  if (status === 'completed') return <Pill tone="emerald">completed</Pill>
  if (status === 'failed') return <Pill tone="rose">failed</Pill>
  if (status === 'cancelled') return <Pill tone="amber">cancelled</Pill>
  return <Pill tone="zinc">queued</Pill>
}

// ── Deals ──────────────────────────────────────────────────────────────────

function DealsPanel() {
  const [filter, setFilter] = useState<'all' | 'valid' | 'invalid' | 'tombstoned'>('all')
  const [search, setSearch] = useState('')
  const [deals, setDeals] = useState<DealRow[] | null>(null)
  const [total, setTotal] = useState(0)
  const [err, setErr] = useState<string | null>(null)
  const [expandedKey, setExpandedKey] = useState<string | null>(null)

  useEffect(() => {
    setDeals(null)
    fetch(`${PLUGIN_BASE}/deals?limit=100&filter=${filter}`, { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => { setDeals(d.data ?? []); setTotal(d.total ?? 0) })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
  }, [filter])

  const visibleDeals = useMemo(() => {
    if (!deals) return []
    const q = search.replace(/\D/g, '').trim()
    if (!q) return deals
    return deals.filter((d) => (d.primary_valid_phone ?? '').includes(q) || String(d.deal_id).includes(q) || d.pasta.includes(q))
  }, [deals, search])

  if (err) return <InlineError message={err} />

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex gap-0.5 rounded-lg border border-zinc-800 bg-zinc-950 p-0.5">
          {(['all', 'valid', 'invalid', 'tombstoned'] as const).map((f) => {
            const label = f === 'all' ? 'Todos'
              : f === 'valid' ? 'Com valido'
              : f === 'invalid' ? 'Todos invalidos'
              : 'Tombstoned'
            // Tombstone tone is amber (warning, archival) — distinguishes
            // from the regular sky-blue selection used for outcome filters.
            const active = filter === f
            const activeClass = f === 'tombstoned'
              ? 'bg-amber-500/10 text-amber-300 ring-1 ring-amber-500/40'
              : 'bg-sky-500/10 text-sky-300 ring-1 ring-sky-500/40'
            return (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  active ? activeClass : 'text-zinc-400 hover:bg-zinc-900'
                }`}
              >
                {f === 'tombstoned' ? <Archive className="h-3.5 w-3.5" /> : null}
                {label}
              </button>
            )
          })}
        </div>
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-zinc-500" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar telefone, pasta ou deal..."
            className="w-full rounded-md bg-zinc-950 border border-zinc-800 pl-8 pr-3 py-1.5 text-xs text-zinc-100 focus:outline-none focus:border-sky-500/40"
          />
        </div>
        <div className="ml-auto text-xs text-zinc-500">{total.toLocaleString('pt-BR')} total · exibindo {visibleDeals.length}</div>
      </div>

      {deals === null ? (
        <div className="rounded-lg border border-zinc-800 overflow-hidden">
          <table className="w-full text-sm">
            <tbody>
              {Array.from({ length: 5 }).map((_, i) => <SkeletonRow key={i} cols={6} />)}
            </tbody>
          </table>
        </div>
      ) : visibleDeals.length === 0 ? (
        filter === 'tombstoned' ? (
          <EmptyState
            icon={Archive}
            title="Nenhum lead tombstoned"
            description="Bom sinal — nenhum lead foi removido upstream após scan. Tombstones aparecem quando o Pipeboard confirma via lookupDeals que a row sumiu."
          />
        ) : (
          <EmptyState icon={FolderSearch} title="Nenhuma consulta encontrada" description="Ajuste o filtro ou rode um novo scan." />
        )
      ) : (
        <div className="rounded-lg border border-zinc-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-zinc-900/60 text-zinc-400 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left px-3 py-2 w-8"></th>
                <th className="text-left px-3 py-2">Pasta</th>
                <th className="text-left px-3 py-2">Deal</th>
                <th className="text-left px-3 py-2">Contato</th>
                <th className="text-left px-3 py-2">Telefone primario</th>
                <th className="text-center px-3 py-2">Resultado</th>
                <th className="text-right px-3 py-2">Scan</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {visibleDeals.map((d) => {
                const key = `${d.pasta}|${d.deal_id}|${d.contato_tipo}|${d.contato_id}`
                const isExp = expandedKey === key
                return (
                  <DealRowView
                    key={key}
                    deal={d}
                    expanded={isExp}
                    onToggle={() => setExpandedKey((k) => (k === key ? null : key))}
                  />
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function DealRowView({ deal, expanded, onToggle }: { deal: DealRow; expanded: boolean; onToggle: () => void }) {
  const [detail, setDetail] = useState<{ phones_json?: string } | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!expanded || detail) return
    setLoading(true)
    fetch(
      `${PLUGIN_BASE}/deals/${encodeURIComponent(deal.pasta)}/${deal.deal_id}/${encodeURIComponent(deal.contato_tipo)}/${deal.contato_id}`,
      { headers: authHeaders() },
    )
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setDetail)
      .catch(() => setDetail(null))
      .finally(() => setLoading(false))
  }, [expanded, detail, deal])

  const isTombstoned = deal.deleted_at != null
  const tone: 'emerald' | 'rose' | 'amber' =
    isTombstoned ? 'amber'
      : deal.valid_count > 0 ? 'emerald'
      : deal.invalid_count > 0 ? 'rose'
      : 'amber'
  // Tombstoned rows get a left-border tint + slightly dimmed text so the
  // archival state reads at a glance without hiding the data (operator
  // still needs to inspect phones_json for audit).
  const rowClass = isTombstoned
    ? 'cursor-pointer hover:bg-zinc-900/40 bg-amber-950/10 border-l-2 border-l-amber-500/40 opacity-80'
    : 'cursor-pointer hover:bg-zinc-900/40'

  return (
    <>
      <tr className={rowClass} onClick={onToggle}>
        <td className="px-3 py-2">
          {expanded ? <ChevronDown className="h-4 w-4 text-zinc-500" /> : <ChevronRight className="h-4 w-4 text-zinc-500" />}
        </td>
        <td className="px-3 py-2 font-mono text-xs">
          <span className={isTombstoned ? 'text-zinc-400 line-through decoration-zinc-600' : 'text-zinc-300'}>
            {deal.pasta}
          </span>
        </td>
        <td className="px-3 py-2">{deal.deal_id}</td>
        <td className="px-3 py-2 text-zinc-400">{deal.contato_tipo}:{deal.contato_id}</td>
        <td className="px-3 py-2 font-mono text-xs">
          {deal.primary_valid_phone ? (
            <span className={isTombstoned ? 'text-zinc-500 line-through decoration-zinc-600' : 'text-emerald-300'}>
              {deal.primary_valid_phone}
            </span>
          ) : (
            <span className="text-zinc-500">—</span>
          )}
        </td>
        <td className="px-3 py-2 text-center">
          {isTombstoned ? (
            <span className="inline-flex items-center gap-1.5">
              <Pill tone="amber">
                <Archive className="h-3 w-3 mr-0.5 inline" />
                tombstoned
              </Pill>
            </span>
          ) : (
            <Pill tone={tone}>
              {deal.valid_count > 0 ? `${deal.valid_count} valido${deal.valid_count > 1 ? 's' : ''}` : 'nenhum valido'}
              {deal.invalid_count > 0 ? ` · ${deal.invalid_count} invalido${deal.invalid_count > 1 ? 's' : ''}` : ''}
            </Pill>
          )}
        </td>
        <td className="px-3 py-2 text-right text-xs text-zinc-500">
          {isTombstoned ? (
            <span title={`scan: ${fmtWhen(deal.scanned_at)}\nremovido: ${fmtWhen(deal.deleted_at!)}`}>
              removido {fmtWhen(deal.deleted_at!)}
            </span>
          ) : (
            fmtWhen(deal.scanned_at)
          )}
        </td>
      </tr>
      {expanded ? (
        <tr>
          <td colSpan={7} className="bg-zinc-950/50 px-6 py-3 border-t border-zinc-800">
            {loading ? (
              <div className="text-xs text-zinc-500">Carregando telefones…</div>
            ) : !detail?.phones_json ? (
              <div className="text-xs text-zinc-500">Sem detalhes.</div>
            ) : (
              <PhonesBreakdown raw={detail.phones_json} />
            )}
          </td>
        </tr>
      ) : null}
    </>
  )
}

function PhonesBreakdown({ raw }: { raw: string }) {
  let phones: PhoneResult[] = []
  try { phones = JSON.parse(raw) as PhoneResult[] } catch { /* ignore */ }
  if (phones.length === 0) return <div className="text-xs text-zinc-500">Nenhum telefone extraido.</div>
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
      {phones.map((p, i) => {
        const tone: 'emerald' | 'rose' | 'amber' = p.outcome === 'valid' ? 'emerald' : p.outcome === 'invalid' ? 'rose' : 'amber'
        const Icon = p.outcome === 'valid' ? CheckCircle2 : p.outcome === 'invalid' ? XCircle : AlertCircle
        const colorClass = p.outcome === 'valid' ? 'text-emerald-400' : p.outcome === 'invalid' ? 'text-rose-400' : 'text-amber-400'
        return (
          <div key={i} className="flex items-center gap-3 rounded-md border border-zinc-800 bg-zinc-900/40 px-3 py-2">
            <Icon className={`h-4 w-4 shrink-0 ${colorClass}`} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <code className="font-mono text-sm text-zinc-100">{p.normalized}</code>
                <Pill tone="zinc">{p.column}</Pill>
              </div>
              <div className="mt-0.5 flex items-center gap-2 text-[11px] text-zinc-500">
                <span>via {p.source}</span>
                {p.confidence != null ? <span>· conf {Math.round(p.confidence * 100)}%</span> : null}
                {p.raw !== p.normalized ? <span className="text-zinc-600">· raw {p.raw}</span> : null}
              </div>
            </div>
            <Pill tone={tone}>{p.outcome}</Pill>
          </div>
        )
      })}
    </div>
  )
}

// ── Helpers ────────────────────────────────────────────────────────────────

function fmtWhen(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const diffMs = Date.now() - d.getTime()
  const absMs = Math.abs(diffMs)
  const fmt = (n: number, u: string) => `${Math.round(n)}${u}`
  if (absMs < 60_000) return diffMs >= 0 ? 'agora' : 'em instantes'
  if (absMs < 3600_000) return diffMs >= 0 ? `${fmt(absMs / 60_000, 'min')} atras` : `em ${fmt(absMs / 60_000, 'min')}`
  if (absMs < 86_400_000) return diffMs >= 0 ? `${fmt(absMs / 3600_000, 'h')} atras` : `em ${fmt(absMs / 3600_000, 'h')}`
  return d.toLocaleString('pt-BR')
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return '<1s'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-zinc-400">{label}</span>
        {hint ? <span className="text-[10px] text-zinc-600">{hint}</span> : null}
      </div>
      {children}
    </label>
  )
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
  icon,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  hint?: string
  icon?: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`w-full flex items-start gap-3 rounded-md border p-3 text-left transition-colors ${
        checked ? 'border-sky-500/30 bg-sky-500/5' : 'border-zinc-800 bg-zinc-950 hover:border-zinc-700'
      }`}
    >
      <div className="mt-0.5">{icon}</div>
      <div className="flex-1 min-w-0">
        <div className="text-sm text-zinc-100">{label}</div>
        {hint ? <div className="mt-0.5 text-[11px] text-zinc-500">{hint}</div> : null}
      </div>
      <div className={`mt-1 h-4 w-7 rounded-full p-0.5 transition-colors ${checked ? 'bg-sky-500' : 'bg-zinc-700'}`}>
        <div className={`h-3 w-3 rounded-full bg-white transition-transform ${checked ? 'translate-x-3' : ''}`} />
      </div>
    </button>
  )
}
