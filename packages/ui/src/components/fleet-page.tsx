import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  CreditCard,
  Plus,
  Smartphone,
  Calendar,
  Mail,
  BarChart3,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  Ban,
  Search,
  X,
  FileSpreadsheet,
  ChevronRight,
  Pencil,
  ScanLine,
  Wrench,
} from 'lucide-react'
import { CORE_URL, authHeaders } from '../config'
import {
  PluginHeader,
  StatCard,
  Section,
  AccentButton,
  EmptyState,
  InlineError,
  SubTabBar,
} from './plugin-ui'

const FLEET_BASE = `${CORE_URL}/api/v1/fleet`
const ACCENT = 'emerald' as const

type SubTab = 'chips' | 'pagamentos' | 'calendario' | 'mensagens' | 'relatorios'

interface Chip {
  id: string
  phone_number: string
  carrier: string
  plan_name: string
  plan_type: string
  acquisition_date: string
  acquisition_cost_brl: number
  monthly_cost_brl: number
  payment_due_day: number
  payment_method: string | null
  paid_by_operator: string
  device_serial: string | null
  status: 'active' | 'inactive' | 'banned' | 'retired'
  acquired_for_purpose: string | null
  retirement_date: string | null
  notes: string | null
  created_at: string
}

interface ChipPayment {
  id: string
  chip_id: string
  period: string
  amount_brl: number
  paid_at: string
  paid_by_operator: string
  payment_method: string | null
  notes: string | null
}

interface ChipEvent {
  id: string
  chip_id: string
  event_type: string
  occurred_at: string
  operator: string | null
  metadata_json: string | null
  notes: string | null
}

interface ChipMessage {
  id: string
  chip_id: string
  from_number: string
  message_text: string
  received_at: string
  category: string | null
  source: string
}

interface RenewalCalendarEntry {
  chip_id: string
  phone_number: string
  carrier: string
  plan_name: string
  monthly_cost_brl: number
  payment_due_day: number
  next_due_date: string
  days_until_due: number
  status: 'overdue' | 'due_today' | 'upcoming' | 'paid'
}

interface MonthlySpendSummary {
  period: string
  total_brl: number
  paid_brl: number
  outstanding_brl: number
  by_carrier: Record<string, { count: number; total_brl: number; paid_brl: number }>
  by_operator: Record<string, { count: number; total_brl: number }>
  active_chips: number
}

const fmtBrl = (n: number): string =>
  n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

const fmtDate = (s: string): string => {
  try {
    return new Date(s).toLocaleDateString('pt-BR')
  } catch {
    return s
  }
}

/**
 * Compute the next occurrence of a recurring monthly due day (1..31).
 *
 * Mirrors `nextDueDate()` in `chip-registry.ts` (UTC, clamps short months
 * Feb 30 → Feb 28/29, Apr 31 → Apr 30). Returns the date together with the
 * whole-day delta from `now`.
 */
function computeNextDue(dueDay: number, now: Date = new Date()): { dueDate: Date; daysUntil: number } {
  const year = now.getUTCFullYear()
  const month = now.getUTCMonth()
  const today = now.getUTCDate()
  const tryMonth = (y: number, m: number): Date => {
    const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
    const day = Math.min(dueDay, lastDay)
    return new Date(Date.UTC(y, m, day))
  }
  const thisMonth = tryMonth(year, month)
  let dueDate: Date
  if (thisMonth.getUTCDate() >= today) {
    dueDate = thisMonth
  } else {
    const nm = month === 11 ? 0 : month + 1
    const ny = month === 11 ? year + 1 : year
    dueDate = tryMonth(ny, nm)
  }
  const a = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const b = Date.UTC(dueDate.getUTCFullYear(), dueDate.getUTCMonth(), dueDate.getUTCDate())
  const daysUntil = Math.round((b - a) / 86_400_000)
  return { dueDate, daysUntil }
}

/** Format the next due date for display in card/calendar contexts. */
function formatDueLabel(dueDay: number, now: Date = new Date()): {
  text: string
  tone: 'emerald' | 'amber' | 'rose'
} {
  const { dueDate, daysUntil } = computeNextDue(dueDay, now)
  const ds = dueDate.toLocaleDateString('pt-BR')
  if (daysUntil === 0) return { text: `vence hoje (${ds})`, tone: 'amber' }
  if (daysUntil < 0) return { text: `atrasado ${Math.abs(daysUntil)}d (${ds})`, tone: 'rose' }
  if (daysUntil <= 7) return { text: `em ${daysUntil}d (${ds})`, tone: 'amber' }
  return { text: `em ${daysUntil}d (${ds})`, tone: 'emerald' }
}

export function FleetPage() {
  const [activeTab, setActiveTab] = useState<SubTab>('chips')
  const [reloadKey, setReloadKey] = useState(0)
  const reload = useCallback(() => setReloadKey((k) => k + 1), [])

  return (
    <div className="space-y-4">
      <PluginHeader
        icon={CreditCard}
        title="Frota / Gestão de Planos"
        subtitle="Cadastro interno de chips, custos mensais, calendário de vencimentos e mensagens das operadoras."
        status="active"
        accent={ACCENT}
        version="0.1.0"
        actions={
          <AccentButton accent={ACCENT} variant="ghost" onClick={reload} icon={RefreshCw}>
            Atualizar
          </AccentButton>
        }
      />

      <SubTabBar
        accent={ACCENT}
        active={activeTab}
        onChange={setActiveTab}
        tabs={[
          { id: 'chips', label: 'Chips' },
          { id: 'pagamentos', label: 'Pagamentos' },
          { id: 'calendario', label: 'Calendário' },
          { id: 'mensagens', label: 'Mensagens' },
          { id: 'relatorios', label: 'Relatórios' },
        ]}
      />

      {activeTab === 'chips' ? <ChipsPanel key={`chips-${reloadKey}`} /> :
        activeTab === 'pagamentos' ? <PaymentsPanel key={`pay-${reloadKey}`} /> :
        activeTab === 'calendario' ? <CalendarPanel key={`cal-${reloadKey}`} /> :
        activeTab === 'mensagens' ? <MessagesPanel key={`msg-${reloadKey}`} /> :
        <ReportsPanel key={`rep-${reloadKey}`} />}
    </div>
  )
}

// ── Chips Panel ───────────────────────────────────────────────────────────

function ChipsPanel() {
  const [chips, setChips] = useState<Chip[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [filterCarrier, setFilterCarrier] = useState('')
  const [filterStatus, setFilterStatus] = useState<string>('')
  const [search, setSearch] = useState('')
  const [creating, setCreating] = useState(false)
  const [importing, setImporting] = useState(false)
  const [autoImporting, setAutoImporting] = useState(false)
  const [autoImportMsg, setAutoImportMsg] = useState<string | null>(null)
  const [scanAllOpen, setScanAllOpen] = useState(false)
  const [rootExtracting, setRootExtracting] = useState(false)
  const [rootExtractMsg, setRootExtractMsg] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editingChip, setEditingChip] = useState<Chip | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const params = new URLSearchParams()
      if (filterCarrier) params.set('carrier', filterCarrier)
      if (filterStatus) params.set('status', filterStatus)
      const r = await fetch(`${FLEET_BASE}/chips?${params}`, { headers: authHeaders() })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const data = (await r.json()) as { items: Chip[] }
      setChips(data.items)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [filterCarrier, filterStatus])

  useEffect(() => { void load() }, [load])

  const filtered = useMemo(() => {
    const base = !search.trim()
      ? chips
      : (() => {
          const term = search.trim().toLowerCase()
          return chips.filter(
            (c) =>
              c.phone_number.includes(term) ||
              c.plan_name.toLowerCase().includes(term) ||
              c.carrier.toLowerCase().includes(term) ||
              (c.notes && c.notes.toLowerCase().includes(term)),
          )
        })()
    // Surface incomplete chips first so the operator notices them.
    // A chip is "incomplete" when its carrier is the placeholder used by
    // the device auto-import (`unknown`) — Edit modal lets the operator
    // promote it to a real carrier/plan/cost.
    const isIncomplete = (c: Chip): boolean =>
      c.carrier === 'unknown' || c.plan_name === 'A definir'
    return [...base].sort((a, b) => {
      const ai = isIncomplete(a) ? 0 : 1
      const bi = isIncomplete(b) ? 0 : 1
      return ai - bi
    })
  }, [chips, search])

  const incompleteCount = useMemo(
    () => chips.filter((c) => c.carrier === 'unknown' || c.plan_name === 'A definir').length,
    [chips],
  )

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-zinc-500" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por telefone, plano, operadora…"
            className="w-full rounded-md bg-zinc-950 border border-zinc-800 px-8 py-1.5 text-sm text-zinc-100 focus:outline-none focus:border-emerald-500/40"
          />
        </div>
        <select
          value={filterCarrier}
          onChange={(e) => setFilterCarrier(e.target.value)}
          className="rounded-md bg-zinc-950 border border-zinc-800 px-2.5 py-1.5 text-sm text-zinc-100"
        >
          <option value="">Todas operadoras</option>
          <option value="vivo">Vivo</option>
          <option value="claro">Claro</option>
          <option value="tim">TIM</option>
          <option value="oi">Oi</option>
          <option value="surf">Surf</option>
        </select>
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          className="rounded-md bg-zinc-950 border border-zinc-800 px-2.5 py-1.5 text-sm text-zinc-100"
        >
          <option value="">Qualquer status</option>
          <option value="active">Ativos</option>
          <option value="inactive">Inativos</option>
          <option value="banned">Banidos</option>
          <option value="retired">Retirados</option>
        </select>
        <AccentButton
          accent={ACCENT}
          onClick={async () => {
            setAutoImporting(true)
            setAutoImportMsg(null)
            try {
              const r = await fetch(`${FLEET_BASE}/chips/import-from-devices`, {
                method: 'POST',
                headers: authHeaders(),
              })
              if (!r.ok) throw new Error(`HTTP ${r.status}`)
              const data = (await r.json()) as {
                total_inserted: number
                // New shape (preferred). Fall back to legacy fields when the
                // backend hasn't been redeployed yet.
                total_already_exists?: number
                total_awaiting_phone?: number
                total_skipped?: number
              }
              const inserted = data.total_inserted
              const alreadyExists = data.total_already_exists ?? data.total_skipped ?? 0
              const awaiting = data.total_awaiting_phone ?? 0
              const parts = [
                `${inserted} chip(s) criado(s)`,
                `${alreadyExists} já existia(m)`,
              ]
              if (awaiting > 0) {
                parts.push(`${awaiting} aguardando phone (rodar Auto-detectar números)`)
              }
              setAutoImportMsg(parts.join(' · '))
              void load()
            } catch (e) {
              setAutoImportMsg(`Falhou: ${e instanceof Error ? e.message : String(e)}`)
            } finally {
              setAutoImporting(false)
            }
          }}
          icon={Smartphone}
          variant="ghost"
        >
          {autoImporting ? 'Importando…' : 'Importar de devices'}
        </AccentButton>
        <AccentButton
          accent={ACCENT}
          disabled={rootExtracting}
          onClick={async () => {
            setRootExtracting(true)
            setRootExtractMsg(null)
            try {
              const dr = await fetch(`${CORE_URL}/api/v1/devices`, { headers: authHeaders() })
              const list = (dr.ok ? ((await dr.json()) as Array<{ serial: string; type: string }>) : [])
                .filter((d) => d.type === 'device')
                .map((d) => d.serial)
              if (list.length === 0) {
                setRootExtractMsg('Nenhum device online encontrado')
                return
              }
              let totalPersisted = 0
              let totalChips = 0
              let totalIncomplete = 0
              for (const serial of list) {
                try {
                  const r = await fetch(
                    `${CORE_URL}/api/v1/devices/${serial}/extract-phones-root`,
                    { method: 'POST', headers: authHeaders() },
                  )
                  if (!r.ok) continue
                  const data = (await r.json()) as {
                    counts: {
                      with_phone: number
                      persisted: number
                      wa_not_initialized: number
                      chips_created: number
                    }
                  }
                  totalPersisted += data.counts.persisted
                  totalChips += data.counts.chips_created
                  totalIncomplete += data.counts.wa_not_initialized
                } catch {
                  // continue with next device
                }
              }
              setRootExtractMsg(
                `Extraídos ${totalPersisted} número(s), ${totalChips} chip(s) novo(s)` +
                  (totalIncomplete > 0
                    ? ` · ${totalIncomplete} profile(s) com WA não inicializado (Setup Wizard pendente).`
                    : '.'),
              )
              void load()
            } catch (e) {
              setRootExtractMsg(`Falhou: ${e instanceof Error ? e.message : String(e)}`)
            } finally {
              setRootExtracting(false)
            }
          }}
          icon={Wrench}
          variant="ghost"
        >
          {rootExtracting ? 'Extraindo…' : 'Extrair via root (rápido)'}
        </AccentButton>
        <AccentButton
          accent={ACCENT}
          onClick={() => setScanAllOpen(true)}
          icon={ScanLine}
          variant="ghost"
        >
          Auto-detectar números
        </AccentButton>
        <AccentButton accent={ACCENT} onClick={() => setImporting(true)} icon={FileSpreadsheet} variant="ghost">
          Importar CSV
        </AccentButton>
        <AccentButton accent={ACCENT} onClick={() => setCreating(true)} icon={Plus}>
          Cadastrar chip
        </AccentButton>
      </div>

      {autoImportMsg ? (
        <div className="rounded-md border border-emerald-700/40 bg-emerald-950/30 px-3 py-2 text-sm text-emerald-200">
          {autoImportMsg}
        </div>
      ) : null}

      {rootExtractMsg ? (
        <div className="rounded-md border border-emerald-700/40 bg-emerald-950/30 px-3 py-2 text-sm text-emerald-200">
          {rootExtractMsg}
        </div>
      ) : null}

      {incompleteCount > 0 ? (
        <div className="rounded-md border border-amber-700/40 bg-amber-950/30 px-3 py-2 text-sm text-amber-200 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>
            {incompleteCount} chip(s) com dados incompletos (carrier=unknown / plano "A definir").
            Clique no lápis em cada card para preencher operadora, custo e vencimento reais.
          </span>
        </div>
      ) : null}

      {err ? <InlineError message={err} /> : null}

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="animate-pulse rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 h-32" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={CreditCard}
          title="Nenhum chip cadastrado"
          description="Cadastre o primeiro chip para começar a registrar custos e vencimentos."
          action={
            <AccentButton accent={ACCENT} onClick={() => setCreating(true)} icon={Plus}>
              Cadastrar chip
            </AccentButton>
          }
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {filtered.map((c) => (
            <ChipCard
              key={c.id}
              chip={c}
              onClick={() => setSelectedId(c.id)}
              onEdit={() => setEditingChip(c)}
            />
          ))}
        </div>
      )}

      {editingChip ? (
        <EditChipModal
          chip={editingChip}
          onClose={() => setEditingChip(null)}
          onSaved={() => {
            setEditingChip(null)
            void load()
          }}
        />
      ) : null}

      {creating ? (
        <CreateChipModal
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false)
            void load()
          }}
        />
      ) : null}

      {importing ? (
        <ImportCsvModal
          onClose={() => setImporting(false)}
          onDone={() => {
            setImporting(false)
            void load()
          }}
        />
      ) : null}

      {scanAllOpen ? (
        <ScanAllNumbersModal
          onClose={() => setScanAllOpen(false)}
          onDone={(msg) => {
            setScanAllOpen(false)
            setAutoImportMsg(msg)
            void load()
          }}
        />
      ) : null}

      {selectedId ? (
        <ChipDetailModal
          chipId={selectedId}
          onClose={() => setSelectedId(null)}
          onChange={() => void load()}
        />
      ) : null}
    </div>
  )
}

const STATUS_BADGE: Record<Chip['status'], string> = {
  active: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20',
  banned: 'bg-rose-500/10 text-rose-300 border-rose-500/20',
  retired: 'bg-zinc-500/10 text-zinc-300 border-zinc-500/20',
  inactive: 'bg-amber-500/10 text-amber-300 border-amber-500/20',
}

const DUE_BADGE: Record<'emerald' | 'amber' | 'rose', string> = {
  emerald: 'text-emerald-300',
  amber: 'text-amber-300',
  rose: 'text-rose-300',
}

function ChipCard({
  chip,
  onClick,
  onEdit,
}: {
  chip: Chip
  onClick: () => void
  onEdit: () => void
}) {
  const due = formatDueLabel(chip.payment_due_day)
  const isIncomplete = chip.carrier === 'unknown' || chip.plan_name === 'A definir'
  return (
    <div
      className={`relative rounded-lg border bg-zinc-900/40 p-4 transition ${
        isIncomplete
          ? 'border-amber-600/40 hover:border-amber-500/60'
          : 'border-zinc-800 hover:border-emerald-500/30'
      }`}
    >
      {isIncomplete ? (
        <div className="mb-2 -mt-1 rounded-md bg-amber-900/30 border border-amber-700/40 px-2 py-1 text-[11px] text-amber-200 flex items-center gap-1.5">
          <AlertTriangle className="h-3 w-3" />
          <span>Dados incompletos — clique em Editar</span>
        </div>
      ) : null}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onEdit()
        }}
        title="Editar chip"
        className={`absolute top-2 right-2 rounded-md p-1 transition ${
          isIncomplete
            ? 'text-amber-300 hover:text-amber-200 hover:bg-amber-500/10'
            : 'text-zinc-500 hover:text-emerald-300 hover:bg-emerald-500/10'
        }`}
      >
        <Pencil className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={onClick}
        className="text-left w-full"
      >
        <div className="flex items-start justify-between gap-2 pr-6">
          <div className="min-w-0">
            <div className="text-sm font-mono text-zinc-100 truncate">{chip.phone_number}</div>
            <div className="text-xs text-zinc-500 mt-0.5 truncate">
              {chip.carrier.toUpperCase()} · {chip.plan_name}
            </div>
          </div>
          <span
            className={`shrink-0 rounded-full text-[10px] uppercase tracking-wider px-2 py-0.5 border ${STATUS_BADGE[chip.status]}`}
          >
            {chip.status}
          </span>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
          <div>
            <div className="text-zinc-500">Mensal</div>
            <div className="text-zinc-200 font-medium">{fmtBrl(chip.monthly_cost_brl)}</div>
          </div>
          <div>
            <div className="text-zinc-500">Próximo venc.</div>
            <div className={`font-medium ${DUE_BADGE[due.tone]}`} title={`Recorrente todo dia ${chip.payment_due_day}`}>
              {due.text}
            </div>
          </div>
        </div>
        {chip.device_serial ? (
          <div className="mt-2 text-xs text-zinc-500 flex items-center gap-1">
            <Smartphone className="h-3 w-3" />
            <span className="truncate font-mono">{chip.device_serial}</span>
          </div>
        ) : null}
        {chip.acquired_for_purpose ? (
          <div className="mt-1 text-xs text-zinc-500 truncate">{chip.acquired_for_purpose}</div>
        ) : null}
        <div className="mt-2 text-xs text-zinc-600 flex items-center justify-end gap-1">
          Detalhes <ChevronRight className="h-3 w-3" />
        </div>
      </button>
    </div>
  )
}

// ── Create Chip Modal ─────────────────────────────────────────────────────

function CreateChipModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({
    phone_number: '',
    carrier: 'vivo',
    plan_name: '',
    plan_type: 'postpago',
    acquisition_date: new Date().toISOString().slice(0, 10),
    acquisition_cost_brl: '0',
    monthly_cost_brl: '',
    payment_due_day: '15',
    payment_method: '',
    paid_by_operator: '',
    invoice_ref: '',
    device_serial: '',
    acquired_for_purpose: '',
    notes: '',
  })
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async () => {
    setSubmitting(true); setErr(null)
    try {
      const body = {
        phone_number: form.phone_number.trim(),
        carrier: form.carrier,
        plan_name: form.plan_name.trim(),
        plan_type: form.plan_type,
        acquisition_date: form.acquisition_date,
        acquisition_cost_brl: Number(form.acquisition_cost_brl) || 0,
        monthly_cost_brl: Number(form.monthly_cost_brl) || 0,
        payment_due_day: Number(form.payment_due_day) || 1,
        payment_method: form.payment_method || null,
        paid_by_operator: form.paid_by_operator.trim(),
        invoice_ref: form.invoice_ref || null,
        device_serial: form.device_serial || null,
        acquired_for_purpose: form.acquired_for_purpose || null,
        notes: form.notes || null,
      }
      const r = await fetch(`${FLEET_BASE}/chips`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
      })
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string }
        throw new Error(j.error || `HTTP ${r.status}`)
      }
      onCreated()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-2xl rounded-xl border border-emerald-500/30 bg-zinc-950 p-5 shadow-xl shadow-black/50 max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between mb-4">
          <h3 className="text-base font-semibold text-zinc-100">Cadastrar chip</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <FormField label="Telefone *" hint="DDI+DDD+número (ex: 5543991938235)">
            <input
              type="tel"
              value={form.phone_number}
              onChange={(e) => setForm({ ...form, phone_number: e.target.value.replace(/\D/g, '') })}
              maxLength={15}
              className="w-full rounded-md bg-zinc-900 border border-zinc-800 px-2 py-1.5 text-sm text-zinc-100"
            />
          </FormField>
          <FormField label="Operadora *">
            <select
              value={form.carrier}
              onChange={(e) => setForm({ ...form, carrier: e.target.value })}
              className="w-full rounded-md bg-zinc-900 border border-zinc-800 px-2 py-1.5 text-sm text-zinc-100"
            >
              {['vivo', 'claro', 'tim', 'oi', 'surf'].map((c) => (
                <option key={c} value={c}>{c.toUpperCase()}</option>
              ))}
            </select>
          </FormField>
          <FormField label="Nome do plano *">
            <input
              type="text"
              value={form.plan_name}
              onChange={(e) => setForm({ ...form, plan_name: e.target.value })}
              maxLength={120}
              placeholder="Vivo Controle 30GB"
              className="w-full rounded-md bg-zinc-900 border border-zinc-800 px-2 py-1.5 text-sm text-zinc-100"
            />
          </FormField>
          <FormField label="Tipo de plano">
            <select
              value={form.plan_type}
              onChange={(e) => setForm({ ...form, plan_type: e.target.value })}
              className="w-full rounded-md bg-zinc-900 border border-zinc-800 px-2 py-1.5 text-sm text-zinc-100"
            >
              <option value="postpago">Pós-pago</option>
              <option value="controle">Controle</option>
              <option value="prepago">Pré-pago</option>
            </select>
          </FormField>
          <FormField label="Data de aquisição *">
            <input
              type="date"
              value={form.acquisition_date}
              onChange={(e) => setForm({ ...form, acquisition_date: e.target.value })}
              className="w-full rounded-md bg-zinc-900 border border-zinc-800 px-2 py-1.5 text-sm text-zinc-100"
            />
          </FormField>
          <FormField label="Custo de aquisição (R$)">
            <input
              type="number"
              step="0.01"
              value={form.acquisition_cost_brl}
              onChange={(e) => setForm({ ...form, acquisition_cost_brl: e.target.value })}
              className="w-full rounded-md bg-zinc-900 border border-zinc-800 px-2 py-1.5 text-sm text-zinc-100"
            />
          </FormField>
          <FormField label="Custo mensal (R$) *">
            <input
              type="number"
              step="0.01"
              value={form.monthly_cost_brl}
              onChange={(e) => setForm({ ...form, monthly_cost_brl: e.target.value })}
              className="w-full rounded-md bg-zinc-900 border border-zinc-800 px-2 py-1.5 text-sm text-zinc-100"
            />
          </FormField>
          <FormField label="Dia de vencimento *" hint="1–31">
            <input
              type="number"
              min={1}
              max={31}
              value={form.payment_due_day}
              onChange={(e) => setForm({ ...form, payment_due_day: e.target.value })}
              className="w-full rounded-md bg-zinc-900 border border-zinc-800 px-2 py-1.5 text-sm text-zinc-100"
            />
          </FormField>
          <FormField label="Método de pagamento" hint="Cartão, Pix, boleto…">
            <input
              type="text"
              value={form.payment_method}
              onChange={(e) => setForm({ ...form, payment_method: e.target.value })}
              maxLength={120}
              placeholder="Cartão Inter 1234"
              className="w-full rounded-md bg-zinc-900 border border-zinc-800 px-2 py-1.5 text-sm text-zinc-100"
            />
          </FormField>
          <FormField label="Pago por *" hint="operador responsável">
            <input
              type="text"
              value={form.paid_by_operator}
              onChange={(e) => setForm({ ...form, paid_by_operator: e.target.value })}
              maxLength={80}
              className="w-full rounded-md bg-zinc-900 border border-zinc-800 px-2 py-1.5 text-sm text-zinc-100"
            />
          </FormField>
          <FormField label="Device serial" hint="opcional">
            <input
              type="text"
              value={form.device_serial}
              onChange={(e) => setForm({ ...form, device_serial: e.target.value })}
              maxLength={80}
              placeholder="POCO_C71_001"
              className="w-full rounded-md bg-zinc-900 border border-zinc-800 px-2 py-1.5 text-sm text-zinc-100"
            />
          </FormField>
          <FormField label="Finalidade">
            <input
              type="text"
              value={form.acquired_for_purpose}
              onChange={(e) => setForm({ ...form, acquired_for_purpose: e.target.value })}
              maxLength={200}
              placeholder="Oralsin SP / frota geral"
              className="w-full rounded-md bg-zinc-900 border border-zinc-800 px-2 py-1.5 text-sm text-zinc-100"
            />
          </FormField>
          <div className="md:col-span-2">
            <FormField label="Observações" hint={`max 2000 caracteres`}>
              <textarea
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                maxLength={2000}
                rows={2}
                className="w-full rounded-md bg-zinc-900 border border-zinc-800 px-2 py-1.5 text-sm text-zinc-100"
              />
            </FormField>
          </div>
        </div>

        {err ? <div className="mt-3 text-xs text-rose-300">Erro: {err}</div> : null}

        <div className="mt-5 flex items-center justify-end gap-2">
          <button onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800">
            Cancelar
          </button>
          <AccentButton accent={ACCENT} onClick={submit} disabled={submitting || !form.phone_number || !form.plan_name || !form.paid_by_operator || !form.monthly_cost_brl}>
            {submitting ? 'Salvando…' : 'Cadastrar'}
          </AccentButton>
        </div>
      </div>
    </div>
  )
}

// ── Edit Chip Modal ───────────────────────────────────────────────────────
//
// Allows full edit of an existing chip. Mutable fields match the server-side
// `updateChipSchema` (Zod) — phone_number, acquisition_date and
// acquisition_cost_brl are immutable in PATCH so we render them read-only.
//
// The modal is intentionally a stand-alone component (not a CreateChipModal
// fork) so the user can never accidentally hit the unique constraint by
// renaming the phone, and so optimistic updates can be re-fetched per-chip.

function EditChipModal({
  chip,
  onClose,
  onSaved,
}: {
  chip: Chip
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState({
    carrier: chip.carrier,
    plan_name: chip.plan_name,
    plan_type: chip.plan_type,
    monthly_cost_brl: String(chip.monthly_cost_brl),
    payment_due_day: String(chip.payment_due_day),
    payment_method: chip.payment_method ?? '',
    paid_by_operator: chip.paid_by_operator,
    device_serial: chip.device_serial ?? '',
    status: chip.status,
    acquired_for_purpose: chip.acquired_for_purpose ?? '',
    notes: chip.notes ?? '',
  })
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async () => {
    setSubmitting(true); setErr(null)
    try {
      // Build PATCH body — only fields the user changed (mirrors updateChipSchema).
      const body: Record<string, unknown> = {
        carrier: form.carrier.trim().toLowerCase(),
        plan_name: form.plan_name.trim(),
        plan_type: form.plan_type,
        monthly_cost_brl: Number(form.monthly_cost_brl) || 0,
        payment_due_day: Number(form.payment_due_day) || 1,
        payment_method: form.payment_method.trim() || null,
        paid_by_operator: form.paid_by_operator.trim(),
        device_serial: form.device_serial.trim() || null,
        status: form.status,
        acquired_for_purpose: form.acquired_for_purpose.trim() || null,
        notes: form.notes.trim() || null,
      }
      const r = await fetch(`${FLEET_BASE}/chips/${chip.id}`, {
        method: 'PATCH',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
      })
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string }
        throw new Error(j.error || `HTTP ${r.status}`)
      }
      onSaved()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4">
      <div className="w-full max-w-2xl rounded-xl border border-emerald-500/30 bg-zinc-950 p-5 shadow-xl shadow-black/50 max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between mb-4">
          <h3 className="text-base font-semibold text-zinc-100">
            Editar chip <span className="font-mono text-emerald-300">{chip.phone_number}</span>
          </h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <FormField label="Telefone" hint="imutável">
            <input
              value={chip.phone_number}
              readOnly
              className="w-full rounded-md bg-zinc-900/60 border border-zinc-800 px-2 py-1.5 text-sm text-zinc-400 font-mono"
            />
          </FormField>
          <FormField label="Operadora *">
            <select
              value={form.carrier}
              onChange={(e) => setForm({ ...form, carrier: e.target.value })}
              className="w-full rounded-md bg-zinc-900 border border-zinc-800 px-2 py-1.5 text-sm text-zinc-100"
            >
              {['vivo', 'claro', 'tim', 'oi', 'surf', 'outro'].map((c) => (
                <option key={c} value={c}>{c.toUpperCase()}</option>
              ))}
            </select>
          </FormField>
          <FormField label="Nome do plano *">
            <input
              type="text"
              value={form.plan_name}
              onChange={(e) => setForm({ ...form, plan_name: e.target.value })}
              maxLength={120}
              className="w-full rounded-md bg-zinc-900 border border-zinc-800 px-2 py-1.5 text-sm text-zinc-100"
            />
          </FormField>
          <FormField label="Tipo de plano">
            <select
              value={form.plan_type}
              onChange={(e) => setForm({ ...form, plan_type: e.target.value })}
              className="w-full rounded-md bg-zinc-900 border border-zinc-800 px-2 py-1.5 text-sm text-zinc-100"
            >
              <option value="postpago">Pós-pago</option>
              <option value="controle">Controle</option>
              <option value="prepago">Pré-pago</option>
            </select>
          </FormField>
          <FormField label="Aquisição" hint="imutável">
            <input
              value={fmtDate(chip.acquisition_date)}
              readOnly
              className="w-full rounded-md bg-zinc-900/60 border border-zinc-800 px-2 py-1.5 text-sm text-zinc-400"
            />
          </FormField>
          <FormField label="Custo aquisição" hint="imutável">
            <input
              value={fmtBrl(chip.acquisition_cost_brl)}
              readOnly
              className="w-full rounded-md bg-zinc-900/60 border border-zinc-800 px-2 py-1.5 text-sm text-zinc-400"
            />
          </FormField>
          <FormField label="Custo mensal (R$) *">
            <input
              type="number"
              step="0.01"
              value={form.monthly_cost_brl}
              onChange={(e) => setForm({ ...form, monthly_cost_brl: e.target.value })}
              className="w-full rounded-md bg-zinc-900 border border-zinc-800 px-2 py-1.5 text-sm text-zinc-100"
            />
          </FormField>
          <FormField label="Dia de vencimento *" hint="1–31, recorrente">
            <input
              type="number"
              min={1}
              max={31}
              value={form.payment_due_day}
              onChange={(e) => setForm({ ...form, payment_due_day: e.target.value })}
              className="w-full rounded-md bg-zinc-900 border border-zinc-800 px-2 py-1.5 text-sm text-zinc-100"
            />
          </FormField>
          <FormField label="Método de pagamento">
            <input
              type="text"
              value={form.payment_method}
              onChange={(e) => setForm({ ...form, payment_method: e.target.value })}
              maxLength={120}
              placeholder="Cartão Inter / Pix / Boleto…"
              className="w-full rounded-md bg-zinc-900 border border-zinc-800 px-2 py-1.5 text-sm text-zinc-100"
            />
          </FormField>
          <FormField label="Pago por *">
            <input
              type="text"
              value={form.paid_by_operator}
              onChange={(e) => setForm({ ...form, paid_by_operator: e.target.value })}
              maxLength={80}
              className="w-full rounded-md bg-zinc-900 border border-zinc-800 px-2 py-1.5 text-sm text-zinc-100"
            />
          </FormField>
          <FormField label="Device serial">
            <input
              type="text"
              value={form.device_serial}
              onChange={(e) => setForm({ ...form, device_serial: e.target.value })}
              maxLength={80}
              placeholder="POCO_C71_001"
              className="w-full rounded-md bg-zinc-900 border border-zinc-800 px-2 py-1.5 text-sm text-zinc-100 font-mono"
            />
          </FormField>
          <FormField label="Status *">
            <select
              value={form.status}
              onChange={(e) => setForm({ ...form, status: e.target.value as Chip['status'] })}
              className="w-full rounded-md bg-zinc-900 border border-zinc-800 px-2 py-1.5 text-sm text-zinc-100"
            >
              <option value="active">Ativo</option>
              <option value="inactive">Inativo</option>
              <option value="banned">Banido</option>
              <option value="retired">Retirado</option>
            </select>
          </FormField>
          <div className="md:col-span-2">
            <FormField label="Finalidade">
              <input
                type="text"
                value={form.acquired_for_purpose}
                onChange={(e) => setForm({ ...form, acquired_for_purpose: e.target.value })}
                maxLength={200}
                placeholder="Oralsin SP / frota geral"
                className="w-full rounded-md bg-zinc-900 border border-zinc-800 px-2 py-1.5 text-sm text-zinc-100"
              />
            </FormField>
          </div>
          <div className="md:col-span-2">
            <FormField label="Observações" hint="max 2000 caracteres">
              <textarea
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                maxLength={2000}
                rows={3}
                className="w-full rounded-md bg-zinc-900 border border-zinc-800 px-2 py-1.5 text-sm text-zinc-100"
              />
            </FormField>
          </div>
        </div>

        {err ? <div className="mt-3 text-xs text-rose-300">Erro: {err}</div> : null}

        <div className="mt-5 flex items-center justify-end gap-2">
          <button onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800">
            Cancelar
          </button>
          <AccentButton
            accent={ACCENT}
            onClick={submit}
            disabled={
              submitting ||
              !form.plan_name ||
              !form.paid_by_operator ||
              !form.monthly_cost_brl ||
              Number(form.payment_due_day) < 1 ||
              Number(form.payment_due_day) > 31
            }
          >
            {submitting ? 'Salvando…' : 'Salvar'}
          </AccentButton>
        </div>
      </div>
    </div>
  )
}

function FormField({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <label className="block">
      <div className="text-xs text-zinc-300 mb-1">
        {label}
        {hint ? <span className="ml-1 text-zinc-500">— {hint}</span> : null}
      </div>
      {children}
    </label>
  )
}

// ── Import CSV Modal ──────────────────────────────────────────────────────

function ImportCsvModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [csvText, setCsvText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<{ inserted: number; skipped: number; errors: string[] } | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const onFile = async (f: File) => {
    const text = await f.text()
    setCsvText(text)
  }

  const submit = async () => {
    setSubmitting(true); setErr(null); setResult(null)
    try {
      // Parse CSV. Header: phone_number,carrier,plan_name,acquisition_date,acquisition_cost_brl,monthly_cost_brl,payment_due_day,payment_method,paid_by_operator,acquired_for_purpose,notes
      const lines = csvText.trim().split(/\r?\n/).filter(Boolean)
      if (lines.length < 2) throw new Error('CSV precisa de header + ao menos 1 linha')
      const header = (lines[0] || '').split(',').map((h) => h.trim().toLowerCase())
      const required = ['phone_number', 'carrier', 'plan_name', 'acquisition_date', 'monthly_cost_brl', 'payment_due_day', 'paid_by_operator']
      for (const col of required) {
        if (!header.includes(col)) throw new Error(`Coluna obrigatória ausente: ${col}`)
      }
      const idx = (col: string) => header.indexOf(col)
      const chips = lines.slice(1).map((line) => {
        const cells = parseCsvRow(line)
        return {
          phone_number: cells[idx('phone_number')]?.replace(/\D/g, '') || '',
          carrier: cells[idx('carrier')] || 'vivo',
          plan_name: cells[idx('plan_name')] || '',
          acquisition_date: cells[idx('acquisition_date')] || new Date().toISOString().slice(0, 10),
          acquisition_cost_brl: Number(cells[idx('acquisition_cost_brl')] || 0),
          monthly_cost_brl: Number(cells[idx('monthly_cost_brl')] || 0),
          payment_due_day: Number(cells[idx('payment_due_day')] || 1),
          payment_method: cells[idx('payment_method')] || null,
          paid_by_operator: cells[idx('paid_by_operator')] || '',
          acquired_for_purpose: cells[idx('acquired_for_purpose')] || null,
          notes: cells[idx('notes')] || null,
        }
      })
      const r = await fetch(`${FLEET_BASE}/chips/import`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ chips }),
      })
      const j = (await r.json()) as {
        inserted: number
        skipped: number
        results: Array<{ phone_number: string; ok: boolean; error?: string }>
      }
      setResult({
        inserted: j.inserted,
        skipped: j.skipped,
        errors: j.results.filter((x) => !x.ok).map((x) => `${x.phone_number}: ${x.error}`),
      })
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-2xl rounded-xl border border-emerald-500/30 bg-zinc-950 p-5 shadow-xl shadow-black/50 max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between mb-3">
          <h3 className="text-base font-semibold text-zinc-100">Importar chips (CSV)</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200">
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="text-xs text-zinc-400 mb-2">
          Cabeçalho aceito: <code className="text-zinc-200">phone_number,carrier,plan_name,acquisition_date,acquisition_cost_brl,monthly_cost_brl,payment_due_day,payment_method,paid_by_operator,acquired_for_purpose,notes</code>
        </p>
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void onFile(f)
          }}
          className="block w-full text-xs text-zinc-300"
        />
        <textarea
          value={csvText}
          onChange={(e) => setCsvText(e.target.value)}
          rows={10}
          placeholder="ou cole CSV aqui…"
          className="mt-2 w-full rounded-md bg-zinc-900 border border-zinc-800 px-2 py-1.5 text-xs text-zinc-100 font-mono"
        />
        {err ? <div className="mt-2 text-xs text-rose-300">{err}</div> : null}
        {result ? (
          <div className="mt-3 rounded-md border border-emerald-500/20 bg-emerald-500/5 p-3 text-xs text-emerald-200">
            <div>Inseridos: {result.inserted}</div>
            <div>Ignorados: {result.skipped}</div>
            {result.errors.length > 0 ? (
              <details className="mt-1">
                <summary className="cursor-pointer">Erros ({result.errors.length})</summary>
                <ul className="list-disc ml-5 mt-1 text-amber-200">
                  {result.errors.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        ) : null}
        <div className="mt-4 flex items-center justify-end gap-2">
          <button onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800">
            Fechar
          </button>
          {result ? (
            <AccentButton accent={ACCENT} onClick={onDone}>Concluir</AccentButton>
          ) : (
            <AccentButton accent={ACCENT} onClick={submit} disabled={submitting || !csvText.trim()}>
              {submitting ? 'Importando…' : 'Importar'}
            </AccentButton>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Scan All Numbers Modal ────────────────────────────────────────────────
//
// Iterates one or more devices and for each profile that doesn't yet have a
// phone in `whatsapp_accounts` runs the UIAutomator scrape (~30s each).
// 4 profiles per device = ~2min. We sequence devices to avoid contention.

interface ScanDeviceOption {
  serial: string
  status: string
}

interface ScanResult {
  serial: string
  results: Array<{
    profile_id: number
    phone: string | null
    persisted: boolean
    skipped?: 'already_mapped'
    error?: string
  }>
  chips_created: number
  elapsed_ms: number
}

function ScanAllNumbersModal({
  onClose,
  onDone,
}: {
  onClose: () => void
  onDone: (msg: string) => void
}) {
  const [devices, setDevices] = useState<ScanDeviceOption[]>([])
  const [selected, setSelected] = useState<string>('all')
  const [scanning, setScanning] = useState(false)
  const [progress, setProgress] = useState<string | null>(null)
  const [results, setResults] = useState<ScanResult[]>([])
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    fetch(`${CORE_URL}/api/v1/devices`, { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : []))
      .then((data: Array<{ serial: string; type: string }>) => {
        setDevices(
          data
            .filter((d) => d.type === 'device')
            .map((d) => ({ serial: d.serial, status: d.type })),
        )
      })
      .catch(() => setDevices([]))
  }, [])

  const start = async (): Promise<void> => {
    setScanning(true)
    setErr(null)
    setResults([])
    const targets =
      selected === 'all' ? devices.map((d) => d.serial) : [selected]
    if (targets.length === 0) {
      setErr('Nenhum device online encontrado')
      setScanning(false)
      return
    }
    const collected: ScanResult[] = []
    let totalPhones = 0
    let totalChips = 0
    try {
      for (let i = 0; i < targets.length; i++) {
        const serial = targets[i]
        setProgress(
          `Escaneando ${serial.slice(0, 8)}… (${i + 1}/${targets.length}) — pode levar até 2min`,
        )
        try {
          const r = await fetch(
            `${CORE_URL}/api/v1/devices/${serial}/scan-all-numbers`,
            { method: 'POST', headers: authHeaders() },
          )
          if (!r.ok) {
            collected.push({
              serial,
              results: [],
              chips_created: 0,
              elapsed_ms: 0,
            })
            continue
          }
          const data = (await r.json()) as ScanResult
          collected.push(data)
          totalPhones += data.results.filter((res) => res.phone).length
          totalChips += data.chips_created
          setResults([...collected])
        } catch (e) {
          setErr(`Falhou em ${serial}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      setProgress(null)
      onDone(
        `Auto-detectar concluído: ${totalPhones} número(s) encontrado(s), ${totalChips} chip(s) novo(s).`,
      )
    } finally {
      setScanning(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-2xl rounded-lg border border-zinc-800 bg-zinc-950 p-5">
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className="text-base font-medium text-zinc-100">
              Auto-detectar números (UIAutomator)
            </div>
            <div className="text-xs text-zinc-500 mt-0.5">
              Itera cada profile do device e abre WhatsApp → Configurações →
              Avatar para extrair o número. Ignora profiles que já têm phone
              salvo. ~30s por profile (até 2min por device).
            </div>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300" disabled={scanning}>
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-xs text-zinc-400 mb-1">Device</label>
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              disabled={scanning}
              className="w-full rounded-md bg-zinc-900 border border-zinc-800 px-2.5 py-2 text-sm text-zinc-100"
            >
              <option value="all">Todos os devices online ({devices.length})</option>
              {devices.map((d) => (
                <option key={d.serial} value={d.serial}>
                  {d.serial}
                </option>
              ))}
            </select>
          </div>

          {progress ? (
            <div className="rounded-md border border-emerald-700/40 bg-emerald-950/30 px-3 py-2 text-sm text-emerald-200 flex items-center gap-2">
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              {progress}
            </div>
          ) : null}

          {err ? <InlineError message={err} /> : null}

          {results.length > 0 ? (
            <div className="rounded-md border border-zinc-800 bg-zinc-900/40 p-3 max-h-80 overflow-y-auto text-xs">
              {results.map((r) => (
                <div key={r.serial} className="mb-2">
                  <div className="font-mono text-zinc-300">{r.serial}</div>
                  <div className="pl-3 text-zinc-500">
                    {r.results.map((res) => (
                      <div key={res.profile_id}>
                        P{res.profile_id}: {res.skipped === 'already_mapped' ? (
                          <span className="text-zinc-500">já mapeado ({res.phone})</span>
                        ) : res.phone ? (
                          <span className="text-emerald-400 font-mono">{res.phone}</span>
                        ) : (
                          <span className="text-rose-300">{res.error ?? 'não encontrado'}</span>
                        )}
                      </div>
                    ))}
                    <div className="text-emerald-400 mt-1">
                      → {r.chips_created} chip(s) novo(s) · {Math.round(r.elapsed_ms / 1000)}s
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            disabled={scanning}
            className="rounded-md px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
          >
            {scanning ? 'Aguarde…' : 'Fechar'}
          </button>
          <AccentButton accent={ACCENT} onClick={start} disabled={scanning || devices.length === 0}>
            {scanning ? 'Escaneando…' : 'Iniciar scan'}
          </AccentButton>
        </div>
      </div>
    </div>
  )
}

function parseCsvRow(line: string): string[] {
  // Minimal RFC-4180 csv parser: handles double-quoted cells with embedded commas.
  const out: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; continue }
        inQuotes = false
      } else {
        cur += ch
      }
    } else {
      if (ch === ',') { out.push(cur.trim()); cur = ''; continue }
      if (ch === '"') { inQuotes = true; continue }
      cur += ch
    }
  }
  out.push(cur.trim())
  return out
}

// ── Chip Detail Modal ─────────────────────────────────────────────────────

function ChipDetailModal({
  chipId,
  onClose,
  onChange,
}: {
  chipId: string
  onClose: () => void
  onChange: () => void
}) {
  const [data, setData] = useState<{
    chip: Chip
    payments: ChipPayment[]
    events: ChipEvent[]
    messages: ChipMessage[]
  } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [recordingPayment, setRecordingPayment] = useState(false)
  const [recordingMessage, setRecordingMessage] = useState(false)
  const [editing, setEditing] = useState(false)

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${FLEET_BASE}/chips/${chipId}`, { headers: authHeaders() })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const j = (await r.json()) as typeof data
      setData(j)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [chipId])

  useEffect(() => { void load() }, [load])

  const retire = async () => {
    if (!confirm('Aposentar este chip? (status → retired, dados preservados)')) return
    const r = await fetch(`${FLEET_BASE}/chips/${chipId}`, {
      method: 'DELETE',
      headers: authHeaders({ 'X-Operator': data?.chip.paid_by_operator ?? 'unknown' }),
    })
    if (r.ok) {
      onChange()
      void load()
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-3xl rounded-xl border border-emerald-500/30 bg-zinc-950 p-5 shadow-xl shadow-black/50 max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between mb-4">
          <h3 className="text-base font-semibold text-zinc-100">Detalhe do chip</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200">
            <X className="h-4 w-4" />
          </button>
        </div>
        {err ? <InlineError message={err} /> : null}
        {!data ? (
          <div className="text-xs text-zinc-500">Carregando…</div>
        ) : (
          <>
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
              <div className="text-sm font-mono text-zinc-100">{data.chip.phone_number}</div>
              <div className="text-xs text-zinc-500 mt-0.5">
                {data.chip.carrier.toUpperCase()} · {data.chip.plan_name} ({data.chip.plan_type})
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3 text-xs">
                <DetailField label="Aquisição" value={fmtDate(data.chip.acquisition_date)} />
                <DetailField label="Custo aquis." value={fmtBrl(data.chip.acquisition_cost_brl)} />
                <DetailField label="Mensal" value={fmtBrl(data.chip.monthly_cost_brl)} />
                <DetailField
                  label={`Vence dia ${data.chip.payment_due_day}`}
                  value={formatDueLabel(data.chip.payment_due_day).text}
                />
                <DetailField label="Pago por" value={data.chip.paid_by_operator} />
                <DetailField label="Pagamento" value={data.chip.payment_method ?? '—'} />
                <DetailField label="Device" value={data.chip.device_serial ?? '—'} />
                <DetailField label="Status" value={data.chip.status} />
              </div>
              {data.chip.notes ? (
                <div className="mt-3 rounded-md bg-zinc-950 p-2 text-xs text-zinc-400 whitespace-pre-wrap">{data.chip.notes}</div>
              ) : null}
              {data.chip.status !== 'retired' ? (
                <div className="mt-3 flex justify-end items-center gap-3">
                  <button
                    onClick={() => setEditing(true)}
                    className="flex items-center gap-1.5 text-xs text-emerald-300 hover:text-emerald-200"
                  >
                    <Pencil className="h-3 w-3" /> Editar
                  </button>
                  <button onClick={retire} className="text-xs text-rose-300 hover:text-rose-200 underline">
                    Aposentar chip
                  </button>
                </div>
              ) : null}
            </div>

            <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3">
              <Section
                title="Pagamentos"
                actions={
                  <button onClick={() => setRecordingPayment(true)} className="text-xs text-emerald-300 hover:text-emerald-200">
                    + Registrar
                  </button>
                }
              >
                {data.payments.length === 0 ? (
                  <div className="text-xs text-zinc-500">Sem pagamentos.</div>
                ) : (
                  <ul className="space-y-1.5 text-xs">
                    {data.payments.map((p) => (
                      <li key={p.id} className="flex items-center justify-between gap-2 rounded-md bg-zinc-900/40 px-2 py-1.5">
                        <span className="text-zinc-200">{p.period}</span>
                        <span className="text-emerald-300 font-medium">{fmtBrl(p.amount_brl)}</span>
                        <span className="text-zinc-500 text-[10px] truncate">{p.payment_method ?? ''}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>

              <Section
                title="Mensagens recebidas"
                actions={
                  <button onClick={() => setRecordingMessage(true)} className="text-xs text-emerald-300 hover:text-emerald-200">
                    + Registrar
                  </button>
                }
              >
                {data.messages.length === 0 ? (
                  <div className="text-xs text-zinc-500">Nenhuma SMS registrada.</div>
                ) : (
                  <ul className="space-y-1.5 text-xs">
                    {data.messages.map((m) => (
                      <li key={m.id} className="rounded-md bg-zinc-900/40 px-2 py-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-zinc-300 font-mono text-[10px]">{m.from_number}</span>
                          <span className="text-zinc-500 text-[10px]">{fmtDate(m.received_at)}</span>
                        </div>
                        <div className="mt-1 text-zinc-300 whitespace-pre-wrap">{m.message_text}</div>
                        {m.category ? (
                          <div className="mt-1 text-[10px] text-zinc-500">{m.category}</div>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
            </div>

            <Section title="Linha do tempo" description={`${data.events.length} eventos`}>
              <ol className="relative border-l border-zinc-800 ml-2 space-y-2 text-xs">
                {data.events.slice(0, 30).map((ev) => (
                  <li key={ev.id} className="ml-4">
                    <div className="absolute -left-1.5 mt-1 w-3 h-3 rounded-full bg-emerald-500/50 border border-emerald-500" />
                    <span className="text-zinc-200 font-medium">{ev.event_type}</span>
                    <span className="text-zinc-500 ml-2">· {fmtDate(ev.occurred_at)}</span>
                    {ev.notes ? <div className="text-zinc-400">{ev.notes}</div> : null}
                  </li>
                ))}
              </ol>
            </Section>
          </>
        )}

        {recordingPayment && data ? (
          <RecordPaymentModal
            chip={data.chip}
            onClose={() => setRecordingPayment(false)}
            onSaved={() => {
              setRecordingPayment(false)
              void load()
              onChange()
            }}
          />
        ) : null}
        {recordingMessage && data ? (
          <RecordMessageModal
            chip={data.chip}
            onClose={() => setRecordingMessage(false)}
            onSaved={() => {
              setRecordingMessage(false)
              void load()
              onChange()
            }}
          />
        ) : null}
        {editing && data ? (
          <EditChipModal
            chip={data.chip}
            onClose={() => setEditing(false)}
            onSaved={() => {
              setEditing(false)
              void load()
              onChange()
            }}
          />
        ) : null}
      </div>
    </div>
  )
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-zinc-500">{label}</div>
      <div className="text-zinc-200 font-medium truncate">{value}</div>
    </div>
  )
}

function RecordPaymentModal({
  chip,
  onClose,
  onSaved,
}: {
  chip: Chip
  onClose: () => void
  onSaved: () => void
}) {
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7))
  const [amount, setAmount] = useState(String(chip.monthly_cost_brl))
  const [paidAt, setPaidAt] = useState(new Date().toISOString().slice(0, 10))
  const [method, setMethod] = useState(chip.payment_method ?? '')
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async () => {
    setSubmitting(true); setErr(null)
    try {
      const r = await fetch(`${FLEET_BASE}/chips/${chip.id}/payments`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          period,
          amount_brl: Number(amount),
          paid_at: new Date(paidAt).toISOString(),
          paid_by_operator: chip.paid_by_operator,
          payment_method: method || null,
          notes: notes || null,
        }),
      })
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string }
        throw new Error(j.error || `HTTP ${r.status}`)
      }
      onSaved()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4">
      <div className="w-full max-w-md rounded-xl border border-emerald-500/30 bg-zinc-950 p-5">
        <h4 className="text-sm font-semibold text-zinc-100 mb-3">Registrar pagamento</h4>
        <div className="space-y-2 text-xs">
          <FormField label="Período (YYYY-MM) *">
            <input value={period} onChange={(e) => setPeriod(e.target.value)} className="w-full rounded-md bg-zinc-900 border border-zinc-800 px-2 py-1.5 text-zinc-100" />
          </FormField>
          <FormField label="Valor (R$) *">
            <input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className="w-full rounded-md bg-zinc-900 border border-zinc-800 px-2 py-1.5 text-zinc-100" />
          </FormField>
          <FormField label="Pago em *">
            <input type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} className="w-full rounded-md bg-zinc-900 border border-zinc-800 px-2 py-1.5 text-zinc-100" />
          </FormField>
          <FormField label="Método">
            <input value={method} onChange={(e) => setMethod(e.target.value)} maxLength={120} className="w-full rounded-md bg-zinc-900 border border-zinc-800 px-2 py-1.5 text-zinc-100" />
          </FormField>
          <FormField label="Observações">
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={2000} className="w-full rounded-md bg-zinc-900 border border-zinc-800 px-2 py-1.5 text-zinc-100" />
          </FormField>
        </div>
        {err ? <div className="mt-2 text-xs text-rose-300">{err}</div> : null}
        <div className="mt-3 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800">Cancelar</button>
          <AccentButton accent={ACCENT} onClick={submit} disabled={submitting}>
            {submitting ? 'Salvando…' : 'Salvar'}
          </AccentButton>
        </div>
      </div>
    </div>
  )
}

function RecordMessageModal({
  chip,
  onClose,
  onSaved,
}: {
  chip: Chip
  onClose: () => void
  onSaved: () => void
}) {
  const [from, setFrom] = useState('')
  const [text, setText] = useState('')
  const [category, setCategory] = useState('recharge_confirmation')
  const [receivedAt, setReceivedAt] = useState(new Date().toISOString().slice(0, 16))
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async () => {
    setSubmitting(true); setErr(null)
    try {
      const r = await fetch(`${FLEET_BASE}/chips/${chip.id}/messages`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          from_number: from,
          message_text: text,
          received_at: new Date(receivedAt).toISOString(),
          category,
          source: 'manual',
        }),
      })
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string }
        throw new Error(j.error || `HTTP ${r.status}`)
      }
      onSaved()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4">
      <div className="w-full max-w-md rounded-xl border border-emerald-500/30 bg-zinc-950 p-5">
        <h4 className="text-sm font-semibold text-zinc-100 mb-1">Registrar mensagem da operadora</h4>
        <p className="text-[11px] text-zinc-500 mb-3">
          v1: entrada manual. (TODO: integração ADB SMS dump no futuro.)
        </p>
        <div className="space-y-2 text-xs">
          <FormField label="Remetente *" hint="código curto da operadora">
            <input value={from} onChange={(e) => setFrom(e.target.value)} maxLength={40} placeholder="1058" className="w-full rounded-md bg-zinc-900 border border-zinc-800 px-2 py-1.5 text-zinc-100" />
          </FormField>
          <FormField label="Texto *">
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={4000} className="w-full rounded-md bg-zinc-900 border border-zinc-800 px-2 py-1.5 text-zinc-100" />
          </FormField>
          <FormField label="Categoria">
            <select value={category} onChange={(e) => setCategory(e.target.value)} className="w-full rounded-md bg-zinc-900 border border-zinc-800 px-2 py-1.5 text-zinc-100">
              <option value="recharge_confirmation">Confirmação de recarga</option>
              <option value="expiry_warning">Aviso de vencimento</option>
              <option value="balance">Saldo</option>
              <option value="promo">Promoção</option>
              <option value="fraud_alert">Alerta de fraude</option>
              <option value="other">Outra</option>
            </select>
          </FormField>
          <FormField label="Recebida em">
            <input type="datetime-local" value={receivedAt} onChange={(e) => setReceivedAt(e.target.value)} className="w-full rounded-md bg-zinc-900 border border-zinc-800 px-2 py-1.5 text-zinc-100" />
          </FormField>
        </div>
        {err ? <div className="mt-2 text-xs text-rose-300">{err}</div> : null}
        <div className="mt-3 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800">Cancelar</button>
          <AccentButton accent={ACCENT} onClick={submit} disabled={submitting || !from || !text}>
            {submitting ? 'Salvando…' : 'Salvar'}
          </AccentButton>
        </div>
      </div>
    </div>
  )
}

// ── Payments Panel (cross-chip view) ──────────────────────────────────────

function PaymentsPanel() {
  const [chips, setChips] = useState<Chip[]>([])
  const [payments, setPayments] = useState<Array<ChipPayment & { phone_number: string; carrier: string }>>([])
  const [loading, setLoading] = useState(true)
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7))

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoading(true)
      try {
        const r = await fetch(`${FLEET_BASE}/chips`, { headers: authHeaders() })
        const data = (await r.json()) as { items: Chip[] }
        if (cancelled) return
        setChips(data.items)
        const all: typeof payments = []
        for (const c of data.items) {
          const r2 = await fetch(`${FLEET_BASE}/chips/${c.id}/payments`, { headers: authHeaders() })
          if (r2.ok) {
            const j = (await r2.json()) as { items: ChipPayment[] }
            for (const p of j.items) {
              all.push({ ...p, phone_number: c.phone_number, carrier: c.carrier })
            }
          }
        }
        if (cancelled) return
        setPayments(all)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  const filtered = useMemo(
    () => payments.filter((p) => p.period === period).sort((a, b) => a.phone_number.localeCompare(b.phone_number)),
    [payments, period],
  )

  const total = filtered.reduce((s, p) => s + p.amount_brl, 0)

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Calendar className="h-4 w-4 text-zinc-400" />
        <input
          type="month"
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
          className="rounded-md bg-zinc-900 border border-zinc-800 px-2 py-1.5 text-sm text-zinc-100"
        />
        <div className="text-xs text-zinc-500 ml-auto">
          {filtered.length} pagamentos · Total {fmtBrl(total)}
        </div>
      </div>
      {loading ? (
        <div className="text-xs text-zinc-500">Carregando…</div>
      ) : filtered.length === 0 ? (
        <EmptyState icon={CreditCard} title="Sem pagamentos" description={`Nenhum pagamento em ${period}.`} />
      ) : (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-zinc-400 text-left">
              <tr>
                <th className="px-3 py-2">Telefone</th>
                <th className="px-3 py-2">Operadora</th>
                <th className="px-3 py-2">Valor</th>
                <th className="px-3 py-2">Pago em</th>
                <th className="px-3 py-2">Método</th>
                <th className="px-3 py-2">Pago por</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => (
                <tr key={p.id} className="border-t border-zinc-800/60 text-zinc-300">
                  <td className="px-3 py-1.5 font-mono">{p.phone_number}</td>
                  <td className="px-3 py-1.5">{p.carrier.toUpperCase()}</td>
                  <td className="px-3 py-1.5">{fmtBrl(p.amount_brl)}</td>
                  <td className="px-3 py-1.5">{fmtDate(p.paid_at)}</td>
                  <td className="px-3 py-1.5">{p.payment_method ?? '—'}</td>
                  <td className="px-3 py-1.5">{p.paid_by_operator}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-[11px] text-zinc-500">
        Para registrar um pagamento, abra o detalhe de um chip na aba "Chips".
      </p>
    </div>
  )
}

// ── Calendar Panel ────────────────────────────────────────────────────────

function CalendarPanel() {
  const [items, setItems] = useState<RenewalCalendarEntry[]>([])
  const [days, setDays] = useState(30)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const r = await fetch(`${FLEET_BASE}/chips/reports/renewal-calendar?days=${days}`, { headers: authHeaders() })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const j = (await r.json()) as { items: RenewalCalendarEntry[] }
      setItems(j.items)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [days])

  useEffect(() => { void load() }, [load])

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-xs text-zinc-400">Janela</span>
        {[15, 30, 60].map((d) => (
          <button
            key={d}
            onClick={() => setDays(d)}
            className={`rounded-md border px-2.5 py-1 text-xs ${
              days === d
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
                : 'border-zinc-800 bg-zinc-900/40 text-zinc-400 hover:text-zinc-200'
            }`}
          >
            {d} dias
          </button>
        ))}
      </div>
      {err ? <InlineError message={err} /> : null}
      {loading ? (
        <div className="text-xs text-zinc-500">Carregando…</div>
      ) : items.length === 0 ? (
        <EmptyState icon={Calendar} title="Tudo em dia" description="Nenhum vencimento na janela selecionada." />
      ) : (
        <ul className="space-y-2">
          {items.map((it) => (
            <CalendarRow key={it.chip_id} entry={it} />
          ))}
        </ul>
      )}
    </div>
  )
}

const CAL_TONE: Record<'rose' | 'amber' | 'emerald', { row: string; circle: string; icon: string; label: string }> = {
  rose: {
    row: 'border-rose-500/20',
    circle: 'bg-rose-500/10 border-rose-500/30',
    icon: 'text-rose-300',
    label: 'text-rose-300',
  },
  amber: {
    row: 'border-amber-500/20',
    circle: 'bg-amber-500/10 border-amber-500/30',
    icon: 'text-amber-300',
    label: 'text-amber-300',
  },
  emerald: {
    row: 'border-emerald-500/20',
    circle: 'bg-emerald-500/10 border-emerald-500/30',
    icon: 'text-emerald-300',
    label: 'text-emerald-300',
  },
}

function CalendarRow({ entry }: { entry: RenewalCalendarEntry }) {
  const tone: 'rose' | 'amber' | 'emerald' =
    entry.status === 'overdue' ? 'rose' :
    entry.status === 'due_today' ? 'amber' :
    'emerald'
  const t = CAL_TONE[tone]
  return (
    <li className={`flex items-center gap-3 rounded-lg border bg-zinc-900/40 px-3 py-2 ${t.row}`}>
      <div className={`h-8 w-8 shrink-0 rounded-full border flex items-center justify-center ${t.circle}`}>
        {entry.status === 'overdue' ? <AlertTriangle className={`h-4 w-4 ${t.icon}`} /> :
         entry.status === 'due_today' ? <Calendar className={`h-4 w-4 ${t.icon}`} /> :
         <CheckCircle2 className={`h-4 w-4 ${t.icon}`} />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-mono text-zinc-100">{entry.phone_number}</div>
        <div className="text-xs text-zinc-500">{entry.carrier.toUpperCase()} · {entry.plan_name}</div>
      </div>
      <div className="text-right text-xs">
        <div className="text-zinc-200">{fmtDate(entry.next_due_date)}</div>
        <div className={`font-medium ${t.label}`} title={`Recorrente todo dia ${entry.payment_due_day}`}>
          {entry.days_until_due === 0
            ? 'vence hoje'
            : entry.days_until_due > 0
              ? `em ${entry.days_until_due}d`
              : `${Math.abs(entry.days_until_due)}d atrasado`}
        </div>
      </div>
      <div className="text-right text-xs w-24">
        <div className="text-zinc-200 font-medium">{fmtBrl(entry.monthly_cost_brl)}</div>
      </div>
    </li>
  )
}

// ── Messages Panel ────────────────────────────────────────────────────────

function MessagesPanel() {
  const [chips, setChips] = useState<Chip[]>([])
  const [messages, setMessages] = useState<Array<ChipMessage & { phone_number: string }>>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoading(true)
      try {
        const r = await fetch(`${FLEET_BASE}/chips`, { headers: authHeaders() })
        const data = (await r.json()) as { items: Chip[] }
        if (cancelled) return
        setChips(data.items)
        const all: typeof messages = []
        for (const c of data.items) {
          const r2 = await fetch(`${FLEET_BASE}/chips/${c.id}/messages`, { headers: authHeaders() })
          if (r2.ok) {
            const j = (await r2.json()) as { items: ChipMessage[] }
            for (const m of j.items) all.push({ ...m, phone_number: c.phone_number })
          }
        }
        if (cancelled) return
        setMessages(all.sort((a, b) => b.received_at.localeCompare(a.received_at)))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  if (loading) return <div className="text-xs text-zinc-500">Carregando…</div>
  if (messages.length === 0) {
    return (
      <EmptyState
        icon={Mail}
        title="Sem mensagens"
        description="Nenhuma SMS de operadora registrada. Use a aba 'Chips' para registrar manualmente."
      />
    )
  }
  return (
    <div className="space-y-2">
      <p className="text-[11px] text-zinc-500">
        v1: entrada manual. TODO: importação automática via ADB SMS dump.
      </p>
      <ul className="space-y-2">
        {messages.map((m) => (
          <li key={m.id} className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
            <div className="flex items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-2">
                <span className="font-mono text-zinc-300">{m.phone_number}</span>
                <span className="text-zinc-500">←</span>
                <span className="font-mono text-zinc-200">{m.from_number}</span>
              </div>
              <div className="text-zinc-500">{fmtDate(m.received_at)}</div>
            </div>
            <div className="mt-1 text-sm text-zinc-200 whitespace-pre-wrap">{m.message_text}</div>
            {m.category ? (
              <div className="mt-1 text-[10px] text-emerald-300">{m.category}</div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  )
}

// ── Reports Panel ─────────────────────────────────────────────────────────

function ReportsPanel() {
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7))
  const [data, setData] = useState<MonthlySpendSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const r = await fetch(`${FLEET_BASE}/chips/reports/monthly-spend?period=${period}`, { headers: authHeaders() })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      setData((await r.json()) as MonthlySpendSummary)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [period])

  useEffect(() => { void load() }, [load])

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-xs text-zinc-400">Período</span>
        <input
          type="month"
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
          className="rounded-md bg-zinc-900 border border-zinc-800 px-2 py-1.5 text-sm text-zinc-100"
        />
      </div>
      {err ? <InlineError message={err} /> : null}
      {loading || !data ? (
        <div className="text-xs text-zinc-500">Carregando…</div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard label="Chips ativos" value={data.active_chips} icon={CreditCard} />
            <StatCard label="Total previsto" value={fmtBrl(data.total_brl)} icon={BarChart3} tone="sky" />
            <StatCard label="Pago" value={fmtBrl(data.paid_brl)} icon={CheckCircle2} tone="emerald" />
            <StatCard label="Em aberto" value={fmtBrl(data.outstanding_brl)} icon={AlertTriangle} tone={data.outstanding_brl > 0 ? 'rose' : 'zinc'} />
          </div>
          <Section title="Por operadora">
            <ul className="space-y-1.5 text-xs">
              {Object.entries(data.by_carrier).map(([c, v]) => (
                <li key={c} className="flex items-center justify-between gap-2 rounded-md bg-zinc-900/40 px-3 py-1.5">
                  <span className="text-zinc-200 uppercase">{c}</span>
                  <span className="text-zinc-500">{v.count} chips</span>
                  <span className="text-zinc-300">{fmtBrl(v.total_brl)}</span>
                  <span className="text-emerald-300">{fmtBrl(v.paid_brl)} pago</span>
                </li>
              ))}
            </ul>
          </Section>
          <Section title="Por operador (responsável pelo pagamento)">
            <ul className="space-y-1.5 text-xs">
              {Object.entries(data.by_operator).map(([op, v]) => (
                <li key={op} className="flex items-center justify-between gap-2 rounded-md bg-zinc-900/40 px-3 py-1.5">
                  <span className="text-zinc-200">{op}</span>
                  <span className="text-zinc-500">{v.count} chips</span>
                  <span className="text-zinc-300">{fmtBrl(v.total_brl)}</span>
                </li>
              ))}
            </ul>
          </Section>
        </>
      )}
    </div>
  )
}
