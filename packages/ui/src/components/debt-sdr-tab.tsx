import { useState, useEffect, useCallback } from 'react'
import {
  Megaphone,
  LayoutDashboard,
  Users,
  AlertTriangle,
  FileText,
  RefreshCw,
  CheckCircle,
  XCircle,
  PlayCircle,
} from 'lucide-react'
import { CORE_URL, authHeaders } from '../config'
import { PluginHeader, SubTabBar, type Accent } from './plugin-ui'

// ── Types (mirror the backend admin/operator routes contracts) ────────────

interface Lead {
  id: string
  tenant: string
  pipedrive_deal_id: number
  contact_phone: string
  contact_name: string
  state: string
  stop_reason: string | null
  pulled_at: string
  updated_at: string
}

interface SequenceState {
  lead_id: string
  sequence_id: string
  sender_phone: string
  current_step: number
  status: string
  next_action_at: string
  last_message_id: string | null
  last_message_sent_at: string | null
  last_response_at: string | null
  last_response_classification: string | null
  attempts_total: number
  stop_reason: string | null
  updated_at: string
}

interface Alert {
  id: string
  tenant: string
  lead_id: string
  message_id: string
  response_text: string
  reason: string
  llm_reason: string | null
  raised_at: string
  resolved_at: string | null
  resolution: string | null
}

interface ClassifierLogEntry {
  id: string
  lead_id: string
  message_id: string
  response_text: string
  category: string
  confidence: number
  source: string
  llm_reason: string | null
  latency_ms: number
  classified_at: string
}

interface HealthResponse {
  crons_enabled: boolean
  llm_provider: string
  tenants: Array<{ name: string; pipedrive_token_present: boolean }>
}

interface StatsResponse {
  tenants: Array<{
    name: string
    leads_by_state: Record<string, number>
    sequences_by_status: Record<string, number>
    alerts_unresolved: number
  }>
}

// ── SDR API helper ────────────────────────────────────────────────────────

const SDR_API = `${CORE_URL}/api/v1/plugins/debt-sdr`
const ACCENT: Accent = 'violet'

async function sdrFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${SDR_API}${path}`, {
    ...init,
    headers: {
      ...authHeaders(),
      ...(init?.headers ?? {}),
      ...(init?.body && !(init.body instanceof FormData)
        ? { 'Content-Type': 'application/json' }
        : {}),
    },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`${res.status} ${res.statusText}${text ? `: ${text}` : ''}`)
  }
  return res.json() as Promise<T>
}

// ── Main tab orchestrator ─────────────────────────────────────────────────

type SubTab = 'overview' | 'leads' | 'alerts' | 'classifier'

export function DebtSdrTab() {
  const [activeSubTab, setActiveSubTab] = useState<SubTab>('overview')

  const SUB_TABS = [
    { id: 'overview' as const, label: 'Visão Geral', icon: LayoutDashboard },
    { id: 'leads' as const, label: 'Leads', icon: Users },
    { id: 'alerts' as const, label: 'Alertas', icon: AlertTriangle },
    { id: 'classifier' as const, label: 'Classifier Log', icon: FileText },
  ]

  return (
    <div className="space-y-4">
      <PluginHeader
        icon={Megaphone}
        title="DEBT SDR"
        subtitle="Multi-tenant SDR · Pipedrive lead pull + cold sequence"
        status="active"
        accent={ACCENT}
        version="0.1.0"
      />

      <SubTabBar tabs={SUB_TABS} active={activeSubTab} onChange={setActiveSubTab} accent={ACCENT} />

      {activeSubTab === 'overview' ? (
        <DebtSdrOverview />
      ) : activeSubTab === 'leads' ? (
        <DebtSdrLeads />
      ) : activeSubTab === 'alerts' ? (
        <DebtSdrAlerts />
      ) : (
        <DebtSdrClassifierLog />
      )}
    </div>
  )
}

// ── Overview sub-view ─────────────────────────────────────────────────────

function DebtSdrOverview() {
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [stats, setStats] = useState<StatsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [h, s] = await Promise.all([
        sdrFetch<HealthResponse>('/health'),
        sdrFetch<StatsResponse>('/stats'),
      ])
      setHealth(h)
      setStats(s)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 15_000)
    return () => clearInterval(t)
  }, [refresh])

  if (error) {
    return <PluginUnavailable message={error} onRetry={refresh} />
  }

  return (
    <div className="space-y-6">
      {/* Health KPIs */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <KpiCard
          label="Crons (auto-send)"
          value={health ? (health.crons_enabled ? 'ON' : 'OFF') : '—'}
          accent={health?.crons_enabled ? 'emerald' : 'amber'}
        />
        <KpiCard
          label="Provider LLM"
          value={health?.llm_provider ?? '—'}
          accent={health?.llm_provider === 'stub' ? 'amber' : 'emerald'}
        />
        <KpiCard
          label="Tenants configurados"
          value={health ? String(health.tenants.length) : '—'}
        />
      </div>

      {/* Per-tenant stats */}
      {stats?.tenants.map((t) => (
        <div key={t.name} className="rounded-xl border border-zinc-800/60 bg-zinc-900/60 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-zinc-100">{t.name}</h3>
            <span className="text-xs text-zinc-500">
              {health?.tenants.find((th) => th.name === t.name)?.pipedrive_token_present
                ? 'token Pipedrive ✓'
                : 'token Pipedrive ✗'}
            </span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <SmallStat label="Alertas pendentes" value={String(t.alerts_unresolved)} accent={t.alerts_unresolved > 0 ? 'rose' : 'zinc'} />
            <SmallStat
              label="Leads (pulled)"
              value={String(t.leads_by_state.pulled ?? 0)}
            />
            <SmallStat
              label="Leads (sequencing)"
              value={String(t.leads_by_state.sequencing ?? 0)}
              accent="violet"
            />
            <SmallStat
              label="Sequências ativas"
              value={String(t.sequences_by_status.active ?? 0)}
              accent="emerald"
            />
          </div>
          <details className="text-xs text-zinc-400">
            <summary className="cursor-pointer hover:text-zinc-200">
              Distribuição completa por estado / status
            </summary>
            <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <div className="text-zinc-500 mb-1">Leads por estado</div>
                <pre className="text-[11px] bg-zinc-950/60 p-2 rounded">
                  {JSON.stringify(t.leads_by_state, null, 2)}
                </pre>
              </div>
              <div>
                <div className="text-zinc-500 mb-1">Sequências por status</div>
                <pre className="text-[11px] bg-zinc-950/60 p-2 rounded">
                  {JSON.stringify(t.sequences_by_status, null, 2)}
                </pre>
              </div>
            </div>
          </details>
        </div>
      ))}

      {stats && stats.tenants.length === 0 ? (
        <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/40 p-6 text-center">
          <p className="text-sm text-zinc-500">
            Nenhum tenant configurado. Plugin pode estar desligado
            (DISPATCH_PLUGINS não inclui debt-sdr).
          </p>
        </div>
      ) : null}
    </div>
  )
}

// ── Leads sub-view ────────────────────────────────────────────────────────

function DebtSdrLeads() {
  const [leads, setLeads] = useState<Lead[]>([])
  const [error, setError] = useState<string | null>(null)
  const [filterState, setFilterState] = useState<string>('')
  const [actionMsg, setActionMsg] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [sequenceState, setSequenceState] = useState<Record<string, SequenceState | null>>({})

  const refresh = useCallback(async () => {
    try {
      const params = new URLSearchParams()
      if (filterState) params.set('state', filterState)
      params.set('limit', '100')
      const data = await sdrFetch<{ leads: Lead[]; next_cursor: string | null }>(
        `/leads?${params.toString()}`,
      )
      setLeads(data.leads)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [filterState])

  useEffect(() => {
    refresh()
  }, [refresh])

  const loadSequence = useCallback(async (leadId: string) => {
    try {
      const data = await sdrFetch<{ state: SequenceState | null }>(`/sequences/${leadId}`)
      setSequenceState((m) => ({ ...m, [leadId]: data.state }))
    } catch {
      /* ignore */
    }
  }, [])

  const abortSequence = useCallback(
    async (leadId: string) => {
      const reason = prompt('Razão do abort:')
      if (!reason) return
      try {
        await sdrFetch(`/sequence/${leadId}/abort`, {
          method: 'PATCH',
          body: JSON.stringify({ reason }),
        })
        setActionMsg(`Sequence ${leadId.slice(0, 8)} aborted`)
        refresh()
      } catch (err) {
        setActionMsg(`Falha abort: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
    [refresh],
  )

  const resumeSequence = useCallback(
    async (leadId: string) => {
      try {
        await sdrFetch(`/sequence/${leadId}/resume`, {
          method: 'PATCH',
          body: JSON.stringify({}),
        })
        setActionMsg(`Sequence ${leadId.slice(0, 8)} resumed`)
        refresh()
      } catch (err) {
        setActionMsg(`Falha resume: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
    [refresh],
  )

  const forceRecheck = useCallback(
    async (leadId: string) => {
      if (!confirm('Force-recheck vai resetar a sequence e marcar lead.state="pulled". Confirma?')) return
      try {
        await sdrFetch(`/leads/${leadId}/force-recheck`, {
          method: 'POST',
          body: JSON.stringify({}),
        })
        setActionMsg(`Lead ${leadId.slice(0, 8)} reset → pulled`)
        refresh()
      } catch (err) {
        setActionMsg(`Falha recheck: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
    [refresh],
  )

  if (error) {
    return <PluginUnavailable message={error} onRetry={refresh} />
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs text-zinc-500">Filtrar por estado:</label>
        <select
          value={filterState}
          onChange={(e) => setFilterState(e.target.value)}
          className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs text-zinc-200"
        >
          <option value="">todos</option>
          <option value="pulled">pulled</option>
          <option value="gating">gating</option>
          <option value="sequencing">sequencing</option>
          <option value="completed">completed</option>
          <option value="aborted">aborted</option>
        </select>
        <button
          onClick={refresh}
          className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-xs text-zinc-200 hover:bg-zinc-800"
        >
          <RefreshCw className="h-3 w-3" />
          Atualizar
        </button>
      </div>

      {actionMsg ? (
        <div className="rounded-md border border-violet-500/30 bg-violet-500/10 px-3 py-2 text-xs text-violet-300">
          {actionMsg}
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-xl border border-zinc-800/60">
        <table className="w-full text-xs">
          <thead className="bg-zinc-900/80 text-zinc-400">
            <tr>
              <th className="px-3 py-2 text-left">Lead ID</th>
              <th className="px-3 py-2 text-left">Tenant</th>
              <th className="px-3 py-2 text-left">Deal</th>
              <th className="px-3 py-2 text-left">Contato</th>
              <th className="px-3 py-2 text-left">Estado</th>
              <th className="px-3 py-2 text-left">Atualizado</th>
              <th className="px-3 py-2 text-right">Ações</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-900">
            {leads.map((lead) => {
              const isOpen = expanded === lead.id
              const seq = sequenceState[lead.id]
              return (
                <>
                  <tr key={lead.id} className="hover:bg-zinc-900/40">
                    <td className="px-3 py-2 font-mono text-zinc-300">{lead.id.slice(0, 10)}</td>
                    <td className="px-3 py-2 text-zinc-300">{lead.tenant}</td>
                    <td className="px-3 py-2 text-zinc-500">{lead.pipedrive_deal_id}</td>
                    <td className="px-3 py-2 text-zinc-300">
                      <div className="font-medium">{lead.contact_name}</div>
                      <div className="text-[11px] text-zinc-500">{lead.contact_phone}</div>
                    </td>
                    <td className="px-3 py-2">
                      <StatePill state={lead.state} />
                    </td>
                    <td className="px-3 py-2 text-zinc-500">{formatTime(lead.updated_at)}</td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <button
                        onClick={() => {
                          setExpanded(isOpen ? null : lead.id)
                          if (!isOpen) loadSequence(lead.id)
                        }}
                        className="text-zinc-400 hover:text-zinc-100 mr-2"
                        title="Ver sequence state"
                      >
                        {isOpen ? '−' : '+'}
                      </button>
                      <button
                        onClick={() => abortSequence(lead.id)}
                        className="text-rose-400 hover:text-rose-300 mr-2"
                        title="Abort sequence"
                      >
                        <XCircle className="inline h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => resumeSequence(lead.id)}
                        className="text-emerald-400 hover:text-emerald-300 mr-2"
                        title="Resume sequence (aborted/no_response)"
                      >
                        <PlayCircle className="inline h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => forceRecheck(lead.id)}
                        className="text-amber-400 hover:text-amber-300"
                        title="Force-recheck (reset to pulled)"
                      >
                        <RefreshCw className="inline h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                  {isOpen ? (
                    <tr key={`${lead.id}-expand`} className="bg-zinc-950/60">
                      <td colSpan={7} className="px-4 py-3 text-[11px] text-zinc-400">
                        {seq === undefined ? (
                          <span className="text-zinc-500">Carregando sequence state…</span>
                        ) : seq === null ? (
                          <span className="text-zinc-500">Sem sequence state (lead ainda não kickado).</span>
                        ) : (
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                            <div><span className="text-zinc-600">status:</span> {seq.status}</div>
                            <div><span className="text-zinc-600">step:</span> {seq.current_step}</div>
                            <div><span className="text-zinc-600">attempts:</span> {seq.attempts_total}</div>
                            <div><span className="text-zinc-600">next_action:</span> {formatTime(seq.next_action_at)}</div>
                            <div><span className="text-zinc-600">sender:</span> {seq.sender_phone}</div>
                            <div><span className="text-zinc-600">last_msg:</span> {seq.last_message_id?.slice(0, 10) ?? '-'}</div>
                            <div><span className="text-zinc-600">last_resp:</span> {seq.last_response_at ? formatTime(seq.last_response_at) : '-'}</div>
                            <div><span className="text-zinc-600">classification:</span> {seq.last_response_classification ?? '-'}</div>
                            {seq.stop_reason ? (
                              <div className="col-span-full"><span className="text-zinc-600">stop_reason:</span> {seq.stop_reason}</div>
                            ) : null}
                          </div>
                        )}
                      </td>
                    </tr>
                  ) : null}
                </>
              )
            })}
            {leads.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-zinc-500">
                  Nenhum lead encontrado.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Alerts sub-view ───────────────────────────────────────────────────────

function DebtSdrAlerts() {
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [error, setError] = useState<string | null>(null)
  const [unresolved, setUnresolved] = useState(true)
  const [actionMsg, setActionMsg] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const params = new URLSearchParams()
      params.set('unresolved', unresolved ? 'true' : 'false')
      params.set('limit', '200')
      const data = await sdrFetch<{ alerts: Alert[] }>(`/alerts?${params.toString()}`)
      setAlerts(data.alerts)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [unresolved])

  useEffect(() => {
    refresh()
  }, [refresh])

  const resolveAlert = useCallback(
    async (id: string) => {
      const resolution = prompt('Resolução (texto livre):')
      if (!resolution) return
      try {
        await sdrFetch(`/alerts/${id}/resolve`, {
          method: 'PATCH',
          body: JSON.stringify({ resolution }),
        })
        setActionMsg(`Alert ${id.slice(0, 8)} resolved`)
        refresh()
      } catch (err) {
        setActionMsg(`Falha resolve: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
    [refresh],
  )

  if (error) {
    return <PluginUnavailable message={error} onRetry={refresh} />
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <label className="inline-flex items-center gap-2 text-xs text-zinc-400">
          <input
            type="checkbox"
            checked={unresolved}
            onChange={(e) => setUnresolved(e.target.checked)}
            className="accent-violet-500"
          />
          Só não-resolvidos
        </label>
        <button
          onClick={refresh}
          className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-xs text-zinc-200 hover:bg-zinc-800"
        >
          <RefreshCw className="h-3 w-3" />
          Atualizar
        </button>
      </div>

      {actionMsg ? (
        <div className="rounded-md border border-violet-500/30 bg-violet-500/10 px-3 py-2 text-xs text-violet-300">
          {actionMsg}
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-xl border border-zinc-800/60">
        <table className="w-full text-xs">
          <thead className="bg-zinc-900/80 text-zinc-400">
            <tr>
              <th className="px-3 py-2 text-left">Quando</th>
              <th className="px-3 py-2 text-left">Tenant</th>
              <th className="px-3 py-2 text-left">Lead</th>
              <th className="px-3 py-2 text-left">Razão</th>
              <th className="px-3 py-2 text-left">Resposta</th>
              <th className="px-3 py-2 text-left">Status</th>
              <th className="px-3 py-2 text-right">Ações</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-900">
            {alerts.map((a) => (
              <tr key={a.id} className="hover:bg-zinc-900/40">
                <td className="px-3 py-2 text-zinc-500">{formatTime(a.raised_at)}</td>
                <td className="px-3 py-2 text-zinc-300">{a.tenant}</td>
                <td className="px-3 py-2 font-mono text-zinc-400">{a.lead_id.slice(0, 8)}</td>
                <td className="px-3 py-2 text-zinc-300">{a.reason}</td>
                <td className="px-3 py-2 text-zinc-400 max-w-xs truncate" title={a.response_text}>
                  {a.response_text}
                </td>
                <td className="px-3 py-2">
                  {a.resolved_at ? (
                    <span className="inline-flex items-center gap-1 text-emerald-400">
                      <CheckCircle className="h-3 w-3" />
                      resolvido
                    </span>
                  ) : (
                    <span className="text-amber-400">pendente</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right">
                  {!a.resolved_at ? (
                    <button
                      onClick={() => resolveAlert(a.id)}
                      className="rounded-md bg-violet-500/20 px-2 py-1 text-violet-300 hover:bg-violet-500/30"
                    >
                      Resolver
                    </button>
                  ) : (
                    <span className="text-[11px] text-zinc-500">{a.resolution ?? '-'}</span>
                  )}
                </td>
              </tr>
            ))}
            {alerts.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-zinc-500">
                  Nenhum alerta {unresolved ? 'pendente' : ''} no momento.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Classifier Log sub-view ───────────────────────────────────────────────

function DebtSdrClassifierLog() {
  const [entries, setEntries] = useState<ClassifierLogEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [leadFilter, setLeadFilter] = useState('')

  const refresh = useCallback(async () => {
    try {
      const params = new URLSearchParams()
      if (leadFilter) params.set('lead_id', leadFilter)
      params.set('limit', '200')
      const data = await sdrFetch<{ entries: ClassifierLogEntry[] }>(
        `/classifier/log?${params.toString()}`,
      )
      setEntries(data.entries)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [leadFilter])

  useEffect(() => {
    refresh()
  }, [refresh])

  if (error) {
    return <PluginUnavailable message={error} onRetry={refresh} />
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <input
          type="text"
          placeholder="Filtrar por lead_id"
          value={leadFilter}
          onChange={(e) => setLeadFilter(e.target.value)}
          className="flex-1 rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-200"
        />
        <button
          onClick={refresh}
          className="inline-flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-xs text-zinc-200 hover:bg-zinc-800"
        >
          <RefreshCw className="h-3 w-3" />
          Atualizar
        </button>
      </div>

      <div className="overflow-x-auto rounded-xl border border-zinc-800/60">
        <table className="w-full text-xs">
          <thead className="bg-zinc-900/80 text-zinc-400">
            <tr>
              <th className="px-3 py-2 text-left">Quando</th>
              <th className="px-3 py-2 text-left">Lead</th>
              <th className="px-3 py-2 text-left">Categoria</th>
              <th className="px-3 py-2 text-left">Conf.</th>
              <th className="px-3 py-2 text-left">Source</th>
              <th className="px-3 py-2 text-left">Latência</th>
              <th className="px-3 py-2 text-left">Resposta</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-900">
            {entries.map((e) => (
              <tr key={e.id} className="hover:bg-zinc-900/40">
                <td className="px-3 py-2 text-zinc-500">{formatTime(e.classified_at)}</td>
                <td className="px-3 py-2 font-mono text-zinc-400">{e.lead_id.slice(0, 8)}</td>
                <td className="px-3 py-2 text-zinc-300">{e.category}</td>
                <td className="px-3 py-2 text-zinc-500">{e.confidence.toFixed(2)}</td>
                <td className="px-3 py-2">
                  <SourcePill source={e.source} />
                </td>
                <td className="px-3 py-2 text-zinc-500">{e.latency_ms}ms</td>
                <td className="px-3 py-2 text-zinc-400 max-w-md truncate" title={e.response_text}>
                  {e.response_text}
                </td>
              </tr>
            ))}
            {entries.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-zinc-500">
                  Nenhuma entrada de classificação.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Shared mini components ────────────────────────────────────────────────

function PluginUnavailable({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/40 p-6 text-center space-y-3">
      <p className="text-sm text-zinc-400">
        Plugin debt-sdr indisponível.
      </p>
      <p className="text-xs text-zinc-500 font-mono break-all">{message}</p>
      <p className="text-xs text-zinc-600">
        Verifique se <code>DISPATCH_PLUGINS</code> inclui <code>debt-sdr</code> no .env do dispatch-core.
      </p>
      <button
        onClick={onRetry}
        className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
      >
        Tentar novamente
      </button>
    </div>
  )
}

function KpiCard({
  label,
  value,
  accent = 'zinc',
}: {
  label: string
  value: string
  accent?: Accent
}) {
  const cls =
    accent === 'emerald'
      ? 'text-emerald-300'
      : accent === 'rose'
        ? 'text-rose-300'
        : accent === 'amber'
          ? 'text-amber-300'
          : accent === 'violet'
            ? 'text-violet-300'
            : 'text-zinc-100'
  return (
    <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/60 p-4">
      <div className="text-[11px] uppercase tracking-wider text-zinc-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${cls}`}>{value}</div>
    </div>
  )
}

function SmallStat({ label, value, accent = 'zinc' }: { label: string; value: string; accent?: Accent }) {
  const color =
    accent === 'emerald'
      ? 'text-emerald-300'
      : accent === 'rose'
        ? 'text-rose-300'
        : accent === 'violet'
          ? 'text-violet-300'
          : 'text-zinc-200'
  return (
    <div className="rounded-md border border-zinc-800/60 bg-zinc-950/40 p-2.5">
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
      <div className={`text-base font-semibold tabular-nums ${color}`}>{value}</div>
    </div>
  )
}

function StatePill({ state }: { state: string }) {
  const palette: Record<string, string> = {
    pulled: 'bg-amber-500/10 text-amber-300 border-amber-500/30',
    gating: 'bg-violet-500/10 text-violet-300 border-violet-500/30',
    sequencing: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
    completed: 'bg-sky-500/10 text-sky-300 border-sky-500/30',
    aborted: 'bg-rose-500/10 text-rose-300 border-rose-500/30',
  }
  const cls = palette[state] ?? 'bg-zinc-500/10 text-zinc-300 border-zinc-500/30'
  return (
    <span className={`inline-flex rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${cls}`}>
      {state}
    </span>
  )
}

function SourcePill({ source }: { source: string }) {
  const palette: Record<string, string> = {
    regex: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
    llm: 'bg-sky-500/10 text-sky-300 border-sky-500/30',
    llm_low_conf: 'bg-amber-500/10 text-amber-300 border-amber-500/30',
    llm_error: 'bg-rose-500/10 text-rose-300 border-rose-500/30',
    phase_gate: 'bg-violet-500/10 text-violet-300 border-violet-500/30',
  }
  const cls = palette[source] ?? 'bg-zinc-500/10 text-zinc-300 border-zinc-500/30'
  return (
    <span className={`inline-flex rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${cls}`}>
      {source}
    </span>
  )
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}
