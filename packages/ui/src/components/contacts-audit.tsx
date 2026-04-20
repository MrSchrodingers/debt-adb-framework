import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Clock,
  ChevronDown,
  ChevronRight,
  Smartphone,
  Globe,
  Database,
  Send,
  RotateCw,
  Search,
  FileJson,
  Loader2,
} from 'lucide-react'
import { CORE_URL, authHeaders } from '../config'

// ────────────────────────────────────────────────────────────────────
// Types — espelham o schema do backend (packages/core/src/contacts/types.ts)
// ────────────────────────────────────────────────────────────────────

type CheckSource =
  | 'adb_probe'
  | 'waha'
  | 'send_success'
  | 'send_failure'
  | 'send_success_backfill'
  | 'manual_recheck'
  | 'cache'

type CheckResult = 'exists' | 'not_exists' | 'error' | 'inconclusive'

interface WaContactRecord {
  phone_normalized: string
  phone_input_last: string
  wa_chat_id: string | null
  exists_on_wa: 0 | 1 | null
  last_check_source: CheckSource | null
  last_check_confidence: number | null
  last_check_id: string | null
  last_checked_at: string | null
  recheck_due_at: string | null
  check_count: number
  send_attempts: number
  send_successes: number
  first_seen_at: string
  ddd: string | null
  country_code: string
  name: string | null
}

interface WaContactCheck {
  id: string
  phone_normalized: string
  phone_variant_tried: string
  source: CheckSource
  result: CheckResult
  confidence: number | null
  evidence: string | null
  device_serial: string | null
  waha_session: string | null
  triggered_by: string
  latency_ms: number | null
  checked_at: string
}

interface ListResponse {
  data: WaContactRecord[]
  total: number
}

interface HistoryResponse {
  phone_normalized: string
  entries: WaContactCheck[]
}

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function formatPhoneBR(e164: string): string {
  if (!e164) return ''
  if (e164.length === 13) return `+${e164.slice(0, 2)} (${e164.slice(2, 4)}) ${e164.slice(4, 9)}-${e164.slice(9)}`
  if (e164.length === 12) return `+${e164.slice(0, 2)} (${e164.slice(2, 4)}) ${e164.slice(4, 8)}-${e164.slice(8)}`
  return e164
}

function relTime(iso: string | null): string {
  if (!iso) return '—'
  const now = Date.now()
  const then = new Date(iso).getTime()
  const diffMs = now - then
  const m = Math.floor(diffMs / 60_000)
  if (m < 1) return 'agora'
  if (m < 60) return `${m}m atrás`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h atrás`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d atrás`
  const mo = Math.floor(d / 30)
  return `${mo}mo atrás`
}

const SOURCE_META: Record<CheckSource, { label: string; icon: typeof Smartphone; color: string; bg: string }> = {
  adb_probe: { label: 'ADB probe', icon: Smartphone, color: 'text-emerald-300', bg: 'bg-emerald-500/10 border-emerald-500/30' },
  waha: { label: 'WAHA', icon: Globe, color: 'text-sky-300', bg: 'bg-sky-500/10 border-sky-500/30' },
  send_success: { label: 'Send success', icon: Send, color: 'text-violet-300', bg: 'bg-violet-500/10 border-violet-500/30' },
  send_failure: { label: 'Send failure', icon: Send, color: 'text-rose-300', bg: 'bg-rose-500/10 border-rose-500/30' },
  send_success_backfill: { label: 'Backfill', icon: Database, color: 'text-zinc-400', bg: 'bg-zinc-500/10 border-zinc-500/30' },
  manual_recheck: { label: 'Manual', icon: RotateCw, color: 'text-amber-300', bg: 'bg-amber-500/10 border-amber-500/30' },
  cache: { label: 'Cache', icon: Database, color: 'text-zinc-400', bg: 'bg-zinc-500/10 border-zinc-500/30' },
}

const RESULT_META: Record<CheckResult, { label: string; icon: typeof CheckCircle2; color: string }> = {
  exists: { label: 'existe', icon: CheckCircle2, color: 'text-emerald-400' },
  not_exists: { label: 'não existe', icon: XCircle, color: 'text-rose-400' },
  error: { label: 'erro', icon: AlertTriangle, color: 'text-amber-400' },
  inconclusive: { label: 'inconclusivo', icon: Clock, color: 'text-zinc-400' },
}

// ────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────

export function ContactsAudit() {
  const [contacts, setContacts] = useState<WaContactRecord[]>([])
  const [total, setTotal] = useState(0)
  const [selectedPhone, setSelectedPhone] = useState<string | null>(null)
  const [selectedContact, setSelectedContact] = useState<WaContactRecord | null>(null)
  const [history, setHistory] = useState<WaContactCheck[]>([])
  const [expandedChecks, setExpandedChecks] = useState<Set<string>>(new Set())
  const [searchQuery, setSearchQuery] = useState('')
  const [existsFilter, setExistsFilter] = useState<'all' | '1' | '0' | 'null'>('all')
  const [loading, setLoading] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchList = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      if (existsFilter !== 'all') params.set('exists', existsFilter)
      if (searchQuery) params.set('search', searchQuery)
      params.set('limit', '200')
      const res = await fetch(`${CORE_URL}/api/v1/contacts?${params.toString()}`, { headers: authHeaders() })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = (await res.json()) as ListResponse
      setContacts(body.data ?? [])
      setTotal(body.total ?? 0)
      if (body.data?.length && !selectedPhone) {
        setSelectedPhone(body.data[0].phone_normalized)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setContacts([])
    } finally {
      setLoading(false)
    }
  }, [searchQuery, existsFilter, selectedPhone])

  const fetchDetail = useCallback(async (phone: string) => {
    setDetailLoading(true)
    try {
      const [contactRes, historyRes] = await Promise.all([
        fetch(`${CORE_URL}/api/v1/contacts/${phone}`, { headers: authHeaders() }),
        fetch(`${CORE_URL}/api/v1/contacts/${phone}/history`, { headers: authHeaders() }),
      ])
      if (contactRes.ok) {
        setSelectedContact((await contactRes.json()) as WaContactRecord)
      } else {
        setSelectedContact(null)
      }
      if (historyRes.ok) {
        const body = (await historyRes.json()) as HistoryResponse
        setHistory(body.entries ?? [])
      } else {
        setHistory([])
      }
    } finally {
      setDetailLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchList()
  }, [fetchList])

  useEffect(() => {
    if (selectedPhone) fetchDetail(selectedPhone)
  }, [selectedPhone, fetchDetail])

  const handleRecheck = async () => {
    if (!selectedContact) return
    const reason = prompt(
      'Motivo da recheck manual (obrigatório, 3-500 caracteres):',
      'operador viu número ativo em outra fonte',
    )
    if (!reason || reason.length < 3) return
    const res = await fetch(
      `${CORE_URL}/api/v1/contacts/${selectedContact.phone_normalized}/recheck`,
      {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ reason }),
      },
    )
    if (res.ok) {
      await fetchDetail(selectedContact.phone_normalized)
    } else {
      const body = (await res.json()) as { error: string }
      alert(`Falhou: ${body.error}`)
    }
  }

  const toggleCheck = (id: string) => {
    setExpandedChecks((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const filteredContacts = useMemo(() => contacts, [contacts])

  return (
    <div className="grid grid-cols-12 gap-6">
      <aside className="col-span-12 lg:col-span-4 xl:col-span-3">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 sticky top-4">
          <div className="flex items-center gap-2 mb-3">
            <h3 className="text-sm font-semibold text-zinc-200">Contatos</h3>
            <span className="text-xs text-zinc-600 font-mono">{filteredContacts.length}/{total}</span>
            {loading && <Loader2 className="h-3.5 w-3.5 text-zinc-500 animate-spin" />}
          </div>

          <div className="relative mb-3">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-zinc-600" />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Buscar número…"
              className="w-full rounded-lg bg-zinc-950 border border-zinc-800 pl-9 pr-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-600 focus:outline-none"
            />
          </div>

          <select
            value={existsFilter}
            onChange={(e) => setExistsFilter(e.target.value as 'all' | '1' | '0' | 'null')}
            className="w-full mb-3 rounded-lg bg-zinc-950 border border-zinc-800 px-3 py-2 text-sm text-zinc-200"
          >
            <option value="all">Todos os status</option>
            <option value="1">Válidos no WhatsApp</option>
            <option value="0">Inválidos (permanente)</option>
            <option value="null">Desconhecidos</option>
          </select>

          {error && (
            <div className="mb-3 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-300">
              {error}
            </div>
          )}

          <ul className="space-y-1 max-h-[60vh] overflow-y-auto">
            {!loading && filteredContacts.length === 0 && (
              <li className="text-xs text-zinc-500 px-3 py-4">
                Registry vazio. Envie uma mensagem ou rode um job de higienização para popular.
              </li>
            )}
            {filteredContacts.map((c) => {
              const isActive = c.phone_normalized === selectedPhone
              const StatusIcon =
                c.exists_on_wa === 1 ? CheckCircle2 : c.exists_on_wa === 0 ? XCircle : AlertTriangle
              const statusColor =
                c.exists_on_wa === 1 ? 'text-emerald-400' : c.exists_on_wa === 0 ? 'text-rose-400' : 'text-amber-400'
              return (
                <li key={c.phone_normalized}>
                  <button
                    onClick={() => setSelectedPhone(c.phone_normalized)}
                    className={`w-full text-left rounded-lg px-3 py-2.5 transition ${
                      isActive ? 'bg-zinc-800 border border-zinc-700' : 'hover:bg-zinc-800/60 border border-transparent'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <StatusIcon className={`h-4 w-4 shrink-0 ${statusColor}`} />
                      <span className="text-sm text-zinc-200 truncate font-medium">
                        {c.name ?? formatPhoneBR(c.phone_normalized)}
                      </span>
                    </div>
                    {c.name && (
                      <p className="mt-0.5 text-[11px] font-mono text-zinc-500 line-clamp-1">
                        {formatPhoneBR(c.phone_normalized)}
                      </p>
                    )}
                    <p className="mt-0.5 text-[11px] text-zinc-500 line-clamp-1">
                      {c.last_check_source ?? 'sem checks'} · conf {c.last_check_confidence?.toFixed(2) ?? '—'}
                    </p>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      </aside>

      <section className="col-span-12 lg:col-span-8 xl:col-span-9 space-y-5">
        {selectedContact ? (
          <>
            <ContactHeaderCard contact={selectedContact} onRecheck={handleRecheck} loading={detailLoading} />
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 overflow-hidden">
              <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-800">
                <div>
                  <h3 className="text-sm font-semibold text-zinc-200">Timeline de verificações</h3>
                  <p className="text-[11px] text-zinc-500 mt-0.5">Append-only. Cada linha é evidência imutável.</p>
                </div>
              </div>
              <ul className="divide-y divide-zinc-800/70">
                {history.map((check, idx) => (
                  <TimelineEntry
                    key={check.id}
                    check={check}
                    isLatest={idx === 0}
                    expanded={expandedChecks.has(check.id)}
                    onToggle={() => toggleCheck(check.id)}
                  />
                ))}
                {history.length === 0 && !detailLoading && (
                  <li className="px-5 py-6 text-center text-xs text-zinc-500">Sem histórico para este contato</li>
                )}
              </ul>
            </div>
          </>
        ) : (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-12 text-center">
            <p className="text-sm text-zinc-400">Selecione um contato à esquerda para ver auditoria completa.</p>
          </div>
        )}
      </section>
    </div>
  )
}

function ContactHeaderCard({
  contact,
  onRecheck,
  loading,
}: {
  contact: WaContactRecord
  onRecheck: () => void
  loading: boolean
}) {
  const statusBadge =
    contact.exists_on_wa === 1
      ? { label: 'Válido no WhatsApp', cls: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30', Icon: CheckCircle2 }
      : contact.exists_on_wa === 0
        ? { label: 'Não está no WhatsApp', cls: 'text-rose-300 bg-rose-500/10 border-rose-500/30', Icon: XCircle }
        : { label: 'Estado desconhecido', cls: 'text-amber-300 bg-amber-500/10 border-amber-500/30', Icon: AlertTriangle }
  const StatusIcon = statusBadge.Icon

  return (
    <div className="rounded-xl border border-zinc-800 bg-gradient-to-br from-zinc-900 to-zinc-950 p-5">
      <div className="flex flex-wrap items-start justify-between gap-4 mb-4">
        <div>
          {contact.name ? (
            <>
              <p className="text-[11px] uppercase tracking-wider text-zinc-500 mb-1">contato</p>
              <h2 className="text-2xl font-semibold text-zinc-100 tracking-tight">{contact.name}</h2>
              <p className="mt-1 text-sm font-mono text-zinc-400">
                {formatPhoneBR(contact.phone_normalized)}
              </p>
            </>
          ) : (
            <>
              <p className="text-[11px] uppercase tracking-wider text-zinc-500 mb-1">phone_normalized</p>
              <h2 className="text-2xl font-mono font-semibold text-zinc-100 tracking-tight">
                {formatPhoneBR(contact.phone_normalized)}
              </h2>
            </>
          )}
          <p className="mt-1 text-xs text-zinc-500 font-mono">
            DDD {contact.ddd ?? '—'} · submetido como <span className="text-zinc-400">{contact.phone_input_last}</span>
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div className={`flex items-center gap-2 rounded-full border px-3 py-1.5 ${statusBadge.cls}`}>
            <StatusIcon className="h-4 w-4" />
            <span className="text-sm font-semibold">{statusBadge.label}</span>
          </div>
          <button
            onClick={onRecheck}
            disabled={loading}
            className="flex items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-300 hover:bg-amber-500/20 transition disabled:opacity-50"
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCw className="h-3.5 w-3.5" />}
            Forçar recheck
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <Stat label="wa_chat_id" value={contact.wa_chat_id ?? '—'} mono />
        <Stat
          label="confidence"
          value={contact.last_check_confidence !== null ? contact.last_check_confidence.toFixed(2) : '—'}
        />
        <Stat label="checks" value={String(contact.check_count)} />
        <Stat label="send sucessos" value={`${contact.send_successes}/${contact.send_attempts}`} />
        <Stat label="primeiro visto" value={relTime(contact.first_seen_at)} tooltip={contact.first_seen_at} />
        <Stat
          label="recheck_due_at"
          value={contact.recheck_due_at ?? 'NULL'}
          mono
          hint={contact.exists_on_wa === 0 ? 'Permanente — D1' : undefined}
        />
      </div>
    </div>
  )
}

function Stat({
  label,
  value,
  mono,
  tooltip,
  hint,
}: {
  label: string
  value: string
  mono?: boolean
  tooltip?: string
  hint?: string
}) {
  return (
    <div title={tooltip}>
      <p className="text-[10px] uppercase tracking-wider text-zinc-600 mb-1">{label}</p>
      <p className={`text-sm text-zinc-200 ${mono ? 'font-mono' : ''} truncate`} title={value}>
        {value}
      </p>
      {hint && <p className="text-[10px] text-zinc-500 mt-0.5">{hint}</p>}
    </div>
  )
}

function TimelineEntry({
  check,
  isLatest,
  expanded,
  onToggle,
}: {
  check: WaContactCheck
  isLatest: boolean
  expanded: boolean
  onToggle: () => void
}) {
  const sm = SOURCE_META[check.source]
  const rm = RESULT_META[check.result]
  const SourceIcon = sm.icon
  const ResultIcon = rm.icon

  let parsedEvidence: unknown = null
  try {
    if (check.evidence) parsedEvidence = JSON.parse(check.evidence)
  } catch {
    parsedEvidence = check.evidence
  }

  return (
    <li className={`${expanded ? 'bg-zinc-900/40' : ''} transition-colors`}>
      <button onClick={onToggle} className="w-full text-left px-5 py-3.5 hover:bg-zinc-800/30 transition-colors">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 text-zinc-600">
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium ${sm.bg} ${sm.color}`}>
                <SourceIcon className="h-3 w-3" />
                {sm.label}
              </span>
              <span className={`inline-flex items-center gap-1 text-xs font-medium ${rm.color}`}>
                <ResultIcon className="h-3.5 w-3.5" />
                {rm.label}
              </span>
              {check.confidence !== null && (
                <span className="text-[11px] text-zinc-500 font-mono">conf {check.confidence.toFixed(2)}</span>
              )}
              {isLatest && (
                <span className="text-[10px] uppercase tracking-wider text-zinc-500 border border-zinc-700 rounded px-1.5 py-0.5">
                  mais recente
                </span>
              )}
              <div className="flex-1" />
              <span className="text-[11px] text-zinc-500 font-mono" title={check.checked_at}>
                {relTime(check.checked_at)}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-zinc-500">
              <span>variant: <span className="font-mono text-zinc-400">{check.phone_variant_tried}</span></span>
              {check.device_serial && <span>device: <span className="font-mono text-zinc-400">{check.device_serial}</span></span>}
              {check.waha_session && <span>session: <span className="font-mono text-zinc-400">{check.waha_session}</span></span>}
              <span>trigger: <span className="font-mono text-zinc-400">{check.triggered_by}</span></span>
              {check.latency_ms !== null && <span>lat: <span className="font-mono text-zinc-400">{check.latency_ms}ms</span></span>}
            </div>
          </div>
        </div>
      </button>
      {expanded && (
        <div className="px-5 pb-4 pl-12 animate-in">
          <div className="rounded-lg border border-zinc-800 bg-zinc-950 overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800 bg-zinc-900/60">
              <FileJson className="h-3.5 w-3.5 text-zinc-500" />
              <span className="text-[11px] uppercase tracking-wider text-zinc-500 font-semibold">
                Evidência bruta (contact_checks.evidence)
              </span>
              <span className="ml-auto text-[10px] font-mono text-zinc-600">check_id {check.id.slice(0, 8)}…</span>
            </div>
            <pre className="text-[11px] leading-relaxed text-zinc-300 font-mono p-3 overflow-x-auto whitespace-pre">
              {parsedEvidence ? JSON.stringify(parsedEvidence, null, 2) : '(sem evidência)'}
            </pre>
          </div>
        </div>
      )}
    </li>
  )
}
