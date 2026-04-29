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
  const [selectedId, setSelectedId] = useState<string | null>(null)

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
    if (!search.trim()) return chips
    const term = search.trim().toLowerCase()
    return chips.filter(
      (c) =>
        c.phone_number.includes(term) ||
        c.plan_name.toLowerCase().includes(term) ||
        c.carrier.toLowerCase().includes(term) ||
        (c.notes && c.notes.toLowerCase().includes(term)),
    )
  }, [chips, search])

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
                total_skipped: number
              }
              setAutoImportMsg(
                `Importado ${data.total_inserted} chip(s) de devices. ` +
                  `${data.total_skipped} já existia(m).`,
              )
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
            <ChipCard key={c.id} chip={c} onClick={() => setSelectedId(c.id)} />
          ))}
        </div>
      )}

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

function ChipCard({ chip, onClick }: { chip: Chip; onClick: () => void }) {
  const statusColor =
    chip.status === 'active' ? 'emerald' :
    chip.status === 'banned' ? 'rose' :
    chip.status === 'retired' ? 'zinc' :
    'amber'
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-left rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 hover:border-emerald-500/30 transition"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-mono text-zinc-100 truncate">{chip.phone_number}</div>
          <div className="text-xs text-zinc-500 mt-0.5 truncate">
            {chip.carrier.toUpperCase()} · {chip.plan_name}
          </div>
        </div>
        <span className={`shrink-0 rounded-full text-[10px] uppercase tracking-wider px-2 py-0.5 bg-${statusColor}-500/10 text-${statusColor}-300 border border-${statusColor}-500/20`}>
          {chip.status}
        </span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <div>
          <div className="text-zinc-500">Mensal</div>
          <div className="text-zinc-200 font-medium">{fmtBrl(chip.monthly_cost_brl)}</div>
        </div>
        <div>
          <div className="text-zinc-500">Vence dia</div>
          <div className="text-zinc-200 font-medium">{chip.payment_due_day}</div>
        </div>
      </div>
      {chip.device_serial ? (
        <div className="mt-2 text-xs text-zinc-500 flex items-center gap-1">
          <Smartphone className="h-3 w-3" />
          <span className="truncate font-mono">{chip.device_serial}</span>
        </div>
      ) : null}
      {chip.acquired_for_purpose ? (
        <div className="mt-1 text-xs text-zinc-500 truncate">📌 {chip.acquired_for_purpose}</div>
      ) : null}
      <div className="mt-2 text-xs text-zinc-600 flex items-center justify-end gap-1">
        Detalhes <ChevronRight className="h-3 w-3" />
      </div>
    </button>
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
                <DetailField label="Vence dia" value={String(data.chip.payment_due_day)} />
                <DetailField label="Pago por" value={data.chip.paid_by_operator} />
                <DetailField label="Pagamento" value={data.chip.payment_method ?? '—'} />
                <DetailField label="Device" value={data.chip.device_serial ?? '—'} />
                <DetailField label="Status" value={data.chip.status} />
              </div>
              {data.chip.notes ? (
                <div className="mt-3 rounded-md bg-zinc-950 p-2 text-xs text-zinc-400 whitespace-pre-wrap">{data.chip.notes}</div>
              ) : null}
              {data.chip.status !== 'retired' ? (
                <div className="mt-3 flex justify-end">
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

function CalendarRow({ entry }: { entry: RenewalCalendarEntry }) {
  const tone =
    entry.status === 'overdue' ? 'rose' :
    entry.status === 'due_today' ? 'amber' :
    'emerald'
  return (
    <li className={`flex items-center gap-3 rounded-lg border bg-zinc-900/40 px-3 py-2 border-${tone}-500/20`}>
      <div className={`h-8 w-8 shrink-0 rounded-full bg-${tone}-500/10 border border-${tone}-500/30 flex items-center justify-center`}>
        {entry.status === 'overdue' ? <AlertTriangle className={`h-4 w-4 text-${tone}-300`} /> :
         entry.status === 'due_today' ? <Calendar className={`h-4 w-4 text-${tone}-300`} /> :
         <CheckCircle2 className={`h-4 w-4 text-${tone}-300`} />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-mono text-zinc-100">{entry.phone_number}</div>
        <div className="text-xs text-zinc-500">{entry.carrier.toUpperCase()} · {entry.plan_name}</div>
      </div>
      <div className="text-right text-xs">
        <div className="text-zinc-200">{fmtDate(entry.next_due_date)}</div>
        <div className={`text-${tone}-300 font-medium`}>
          {entry.days_until_due === 0
            ? 'hoje'
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
