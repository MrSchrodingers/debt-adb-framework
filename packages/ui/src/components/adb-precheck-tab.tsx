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
  phones_checked_total: number
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
        <InlineError message="Plugin indisponivel (404). Verifique se adb-precheck esta em DISPATCH_PLUGINS e se PLUGIN_ADB_PRECHECK_PG_URL esta configurado." />
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
  const [latestJobs, setLatestJobs] = useState<PrecheckJob[]>([])
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [s, j] = await Promise.all([
        fetch(`${PLUGIN_BASE}/stats`, { headers: authHeaders() }).then(r => r.ok ? r.json() : Promise.reject(new Error(`stats HTTP ${r.status}`))),
        fetch(`${PLUGIN_BASE}/jobs?limit=5`, { headers: authHeaders() }).then(r => r.ok ? r.json() : []),
      ])
      setStats(s); setLatestJobs(Array.isArray(j) ? j : []); setErr(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, 10_000)
    return () => clearInterval(t)
  }, [load])

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
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          label="Leads scanned"
          value={stats.deals_scanned}
          hint="distinct (pasta, deal, contato)"
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
          <AccentButton accent={ACCENT} onClick={onStartScan} icon={Play}>
            Novo Scan
          </AccentButton>
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

// ── New Scan ───────────────────────────────────────────────────────────────

function NewScanPanel({ onDone }: { onDone: () => void }) {
  const [limit, setLimit] = useState('100')
  const [pastaPrefix, setPastaPrefix] = useState('')
  const [pipelineNome, setPipelineNome] = useState('')
  const [writebackInvalid, setWritebackInvalid] = useState(false)
  const [writebackLocalizado, setWritebackLocalizado] = useState(false)
  // Per-job Pipedrive opt-in. Default ON — operators can flip it OFF for
  // dry-run scans that should not pollute the CRM.
  const [pipedriveEnabled, setPipedriveEnabled] = useState(true)
  const [confirming, setConfirming] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const hasWriteback = writebackInvalid || writebackLocalizado

  const submit = async () => {
    setSubmitting(true); setErr(null)
    try {
      const body = {
        limit: Number(limit) || undefined,
        pasta_prefix: pastaPrefix || undefined,
        pipeline_nome: pipelineNome || undefined,
        writeback_invalid: writebackInvalid,
        writeback_localizado: writebackLocalizado,
        pipedrive_enabled: pipedriveEnabled,
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
      setSubmitting(false); setConfirming(false)
    }
  }

  const handleStart = () => {
    if (hasWriteback) setConfirming(true)
    else submit()
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <div className="lg:col-span-2 space-y-4">
        <Section title="Filtro" description="Restringe o pool de leads a escanear.">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
            <Field label="Limite de leads" hint="1–100000">
              <input
                type="number"
                value={limit}
                onChange={(e) => setLimit(e.target.value)}
                className="w-full rounded-md bg-zinc-950 border border-zinc-800 px-3 py-1.5 text-sm text-zinc-100 focus:outline-none focus:border-sky-500/40"
              />
            </Field>
            <Field label="Prefixo de pasta" hint="opcional">
              <input
                type="text"
                value={pastaPrefix}
                onChange={(e) => setPastaPrefix(e.target.value)}
                placeholder="ex: 1857"
                className="w-full rounded-md bg-zinc-950 border border-zinc-800 px-3 py-1.5 text-sm text-zinc-100 focus:outline-none focus:border-sky-500/40"
              />
            </Field>
            <Field label="Pipeline" hint="pipeline_nome exato">
              <input
                type="text"
                value={pipelineNome}
                onChange={(e) => setPipelineNome(e.target.value)}
                placeholder="ex: Localizacao"
                className="w-full rounded-md bg-zinc-950 border border-zinc-800 px-3 py-1.5 text-sm text-zinc-100 focus:outline-none focus:border-sky-500/40"
              />
            </Field>
          </div>
        </Section>

        <Section title="Writeback no Pipeboard" description="O plugin só escreve de volta no pg quando explicitamente habilitado.">
          <div className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
            <Toggle
              checked={writebackInvalid}
              onChange={setWritebackInvalid}
              label="Limpar telefones invalidos em prov_consultas"
              hint="cada telefone invalido vira NULL na sua coluna de origem; deals sem nenhum valido recebem marca em prov_invalidos (motivo='whatsapp_nao_existe')"
              icon={<Ban className="h-4 w-4 text-rose-400" />}
            />
            <Toggle
              checked={writebackLocalizado}
              onChange={setWritebackLocalizado}
              label="Escrever telefone valido em prov_consultas.telefone_localizado"
              hint="encontrado_por='dispatch_adb_precheck' · so atualiza se mudou"
              icon={<BadgeCheck className="h-4 w-4 text-emerald-400" />}
            />
            {hasWriteback ? (
              <div className="mt-3 rounded-md border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-amber-300 flex items-start gap-2">
                <CircleAlert className="h-4 w-4 shrink-0 mt-0.5" />
                <div>
                  <div className="font-medium">Writeback habilitado</div>
                  <p className="mt-0.5 text-amber-300/80">
                    Este scan vai alterar dados em <code className="text-amber-200">tenant_adb</code> no Pipeboard. Uma confirmacao adicional sera pedida antes de enfileirar.
                  </p>
                </div>
              </div>
            ) : null}
          </div>
        </Section>

        <Section title="Pipedrive" description="Atividades / notas no CRM por scan. Quando o token nao esta configurado o flag eh ignorado silenciosamente.">
          <div className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
            <Toggle
              checked={pipedriveEnabled}
              onChange={setPipedriveEnabled}
              label="Criar atividades no Pipedrive"
              hint="cobre os 3 cenarios — phone fail, deal all-fail, pasta summary; desligue para scans dry-run"
              icon={<svg className="h-4 w-4 text-sky-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>}
            />
          </div>
        </Section>

        {err ? <InlineError message={`Erro: ${err}`} /> : null}

        <div className="flex items-center gap-3">
          <AccentButton accent={ACCENT} onClick={handleStart} disabled={submitting} icon={Play}>
            {submitting ? 'Enfileirando…' : 'Iniciar Scan'}
          </AccentButton>
          <p className="text-xs text-zinc-500">
            Pool-based · idempotente por external_ref · cache compartilhado com Oralsin
          </p>
        </div>
      </div>

      <aside className="space-y-3">
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
          <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-zinc-500">
            <Zap className="h-3.5 w-3.5" /> Como funciona
          </div>
          <ol className="mt-3 space-y-2 text-xs text-zinc-300 list-decimal list-inside">
            <li>Itera <code className="text-zinc-100">tenant_adb.prov_consultas</code> em paginas keyset.</li>
            <li>Extrai ate 9 telefones por lead, normaliza para E.164 BR e dedup.</li>
            <li>Valida via L1 cache · L3 ADB probe · L2 WAHA tiebreaker.</li>
            <li>Salva per-deal em SQLite + reaproveita via <code className="text-zinc-100">wa_contacts</code>.</li>
            <li>Opcionalmente grava em <code className="text-zinc-100">prov_invalidos</code> / <code className="text-zinc-100">prov_consultas</code>.</li>
            <li>Callback HMAC para <code className="text-zinc-100">PLUGIN_ADB_PRECHECK_WEBHOOK_URL</code> ao fim.</li>
          </ol>
        </div>

        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
          <div className="text-xs uppercase tracking-wide text-zinc-500">Isolamento</div>
          <ul className="mt-2 space-y-1 text-xs text-zinc-400">
            <li className="flex items-start gap-2"><CheckCircle2 className="h-3.5 w-3.5 mt-0.5 text-emerald-400" />Pool pg proprio</li>
            <li className="flex items-start gap-2"><CheckCircle2 className="h-3.5 w-3.5 mt-0.5 text-emerald-400" />Tabelas <code>adb_precheck_*</code></li>
            <li className="flex items-start gap-2"><CheckCircle2 className="h-3.5 w-3.5 mt-0.5 text-emerald-400" />Rotas namespaced</li>
            <li className="flex items-start gap-2"><CheckCircle2 className="h-3.5 w-3.5 mt-0.5 text-emerald-400" />Env prefix <code>PLUGIN_ADB_PRECHECK_*</code></li>
          </ul>
        </div>
      </aside>

      {confirming ? (
        <ConfirmModal
          onCancel={() => setConfirming(false)}
          onConfirm={submit}
          submitting={submitting}
          writebackInvalid={writebackInvalid}
          writebackLocalizado={writebackLocalizado}
        />
      ) : null}
    </div>
  )
}

function ConfirmModal({
  onCancel,
  onConfirm,
  submitting,
  writebackInvalid,
  writebackLocalizado,
}: {
  onCancel: () => void
  onConfirm: () => void
  submitting: boolean
  writebackInvalid: boolean
  writebackLocalizado: boolean
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
                <li className="flex items-start gap-2"><Ban className="h-3.5 w-3.5 mt-0.5 text-rose-400" /><span>INSERT em <code>prov_invalidos</code> com motivo=whatsapp_nao_existe</span></li>
              ) : null}
              {writebackLocalizado ? (
                <li className="flex items-start gap-2"><BadgeCheck className="h-3.5 w-3.5 mt-0.5 text-emerald-400" /><span>UPDATE em <code>prov_consultas</code> marcando telefone_localizado</span></li>
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
  const total = job.total_deals ?? 0
  const progressPct = total > 0 ? Math.round((job.scanned_deals / total) * 100) : 0
  const elapsedMs = useMemo(() => {
    const s = job.started_at ?? job.created_at
    const e = job.finished_at ?? new Date().toISOString()
    return Math.max(0, new Date(e).getTime() - new Date(s).getTime())
  }, [job.started_at, job.finished_at, job.created_at])

  const rate = elapsedMs > 0 && job.scanned_deals > 0
    ? job.scanned_deals / (elapsedMs / 1000)
    : 0
  const eta = rate > 0 && total > 0 && job.status === 'running'
    ? Math.round((total - job.scanned_deals) / rate)
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
          {!compact ? <div className="mt-2"><ProgressBar accent={jobAccent(job.status)} value={job.scanned_deals} total={total} label="Leads scanned" /></div> : null}
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
  return (
    <div className="border-t border-zinc-800 bg-zinc-950/50 p-4 space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Taxa de validade" value={`${successRate}%`} tone="sky" />
        <StatCard label="Cache hits" value={job.cache_hits} tone="violet" hint={job.total_phones > 0 ? `${Math.round(job.cache_hits / job.total_phones * 100)}% do total` : undefined} />
        <StatCard label="Erros" value={job.error_phones} tone={job.error_phones > 0 ? 'amber' : 'zinc'} />
        <StatCard label="Cancel requested" value={job.cancel_requested ? 'sim' : 'nao'} tone={job.cancel_requested ? 'amber' : 'zinc'} />
      </div>
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
  const [filter, setFilter] = useState<'all' | 'valid' | 'invalid'>('all')
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
          {(['all', 'valid', 'invalid'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                filter === f ? 'bg-sky-500/10 text-sky-300 ring-1 ring-sky-500/40' : 'text-zinc-400 hover:bg-zinc-900'
              }`}
            >
              {f === 'all' ? 'Todos' : f === 'valid' ? 'Com valido' : 'Todos invalidos'}
            </button>
          ))}
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
        <EmptyState icon={FolderSearch} title="Nenhuma consulta encontrada" description="Ajuste o filtro ou rode um novo scan." />
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

  const tone: 'emerald' | 'rose' | 'amber' =
    deal.valid_count > 0 ? 'emerald' : deal.invalid_count > 0 ? 'rose' : 'amber'

  return (
    <>
      <tr className="cursor-pointer hover:bg-zinc-900/40" onClick={onToggle}>
        <td className="px-3 py-2">
          {expanded ? <ChevronDown className="h-4 w-4 text-zinc-500" /> : <ChevronRight className="h-4 w-4 text-zinc-500" />}
        </td>
        <td className="px-3 py-2 font-mono text-xs text-zinc-300">{deal.pasta}</td>
        <td className="px-3 py-2">{deal.deal_id}</td>
        <td className="px-3 py-2 text-zinc-400">{deal.contato_tipo}:{deal.contato_id}</td>
        <td className="px-3 py-2 font-mono text-xs">
          {deal.primary_valid_phone ? (
            <span className="text-emerald-300">{deal.primary_valid_phone}</span>
          ) : (
            <span className="text-zinc-500">—</span>
          )}
        </td>
        <td className="px-3 py-2 text-center">
          <Pill tone={tone}>
            {deal.valid_count > 0 ? `${deal.valid_count} valido${deal.valid_count > 1 ? 's' : ''}` : 'nenhum valido'}
            {deal.invalid_count > 0 ? ` · ${deal.invalid_count} invalido${deal.invalid_count > 1 ? 's' : ''}` : ''}
          </Pill>
        </td>
        <td className="px-3 py-2 text-right text-xs text-zinc-500">{fmtWhen(deal.scanned_at)}</td>
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
