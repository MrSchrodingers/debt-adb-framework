import type Database from 'better-sqlite3'
import { nanoid } from 'nanoid'
import { normalizeBrPhone, type PhoneNormalizerLogger } from '../monitor/phone-normalizer.js'
import type {
  Chip,
  ChipEvent,
  ChipMessage,
  ChipMessageCategory,
  ChipPayment,
  ChipPlanType,
  ChipStatus,
  MonthlySpendSummary,
  RenewalCalendarEntry,
  RenewalStatus,
} from './types.js'

/**
 * Persistence + business rules for the internal SIM-card fleet.
 *
 * Schema lives here (CREATE TABLE IF NOT EXISTS) so the registry is the single
 * source of truth — no separate migration runner. All four tables share the
 * `chip_*` prefix to avoid collision with WhatsApp message tables (`messages`,
 * `message_history`, etc) and the existing `wa_contacts` registry.
 *
 * Idempotency contract:
 *   - `phone_number` is UNIQUE on `chips`; createChip rejects duplicates.
 *   - `(chip_id, period)` is UNIQUE on `chip_payments` — recording the same
 *     payment twice for the same month is a 409 at the API layer.
 *   - Events and messages are append-only; soft-delete on chip flips
 *     `status='retired'` and stamps `retirement_date`.
 *
 * SECURITY: `notes`, `payment_method`, `acquired_for_purpose` and SMS texts
 * are operator/carrier-supplied free-form strings. They are stored verbatim
 * here; the API layer caps lengths at the Zod boundary, and React on the
 * consumer side auto-escapes when rendering as text.
 *
 * TODO (future): wire an ADB SMS auto-importer that reads
 * `content://sms` for each operator-managed chip and inserts rows into
 * `chip_messages` with `source='adb_sms_dump'`. v1 is manual entry only —
 * see issue tracker once the SMS dump path is unblocked on POCO C71.
 */
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS chips (
    id TEXT PRIMARY KEY,
    phone_number TEXT NOT NULL UNIQUE,
    carrier TEXT NOT NULL,
    plan_name TEXT NOT NULL,
    plan_type TEXT NOT NULL DEFAULT 'postpago',
    acquisition_date TEXT NOT NULL,
    acquisition_cost_brl REAL NOT NULL,
    monthly_cost_brl REAL NOT NULL,
    payment_due_day INTEGER NOT NULL,
    payment_method TEXT,
    paid_by_operator TEXT NOT NULL,
    invoice_ref TEXT,
    invoice_path TEXT,
    device_serial TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    acquired_for_purpose TEXT,
    retirement_date TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS chip_payments (
    id TEXT PRIMARY KEY,
    chip_id TEXT NOT NULL REFERENCES chips(id),
    period TEXT NOT NULL,
    amount_brl REAL NOT NULL,
    paid_at TEXT NOT NULL,
    paid_by_operator TEXT NOT NULL,
    payment_method TEXT,
    receipt_path TEXT,
    notes TEXT,
    UNIQUE (chip_id, period)
  );

  CREATE TABLE IF NOT EXISTS chip_events (
    id TEXT PRIMARY KEY,
    chip_id TEXT NOT NULL REFERENCES chips(id),
    event_type TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    operator TEXT,
    metadata_json TEXT,
    notes TEXT
  );

  CREATE TABLE IF NOT EXISTS chip_messages (
    id TEXT PRIMARY KEY,
    chip_id TEXT NOT NULL REFERENCES chips(id),
    from_number TEXT NOT NULL,
    message_text TEXT NOT NULL,
    received_at TEXT NOT NULL,
    category TEXT,
    source TEXT NOT NULL DEFAULT 'manual',
    raw_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_chips_status ON chips(status);
  CREATE INDEX IF NOT EXISTS idx_chips_carrier ON chips(carrier);
  CREATE INDEX IF NOT EXISTS idx_chips_device ON chips(device_serial)
    WHERE device_serial IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_chip_payments_period ON chip_payments(period);
  CREATE INDEX IF NOT EXISTS idx_chip_payments_chip ON chip_payments(chip_id, period);
  CREATE INDEX IF NOT EXISTS idx_chip_events_chip ON chip_events(chip_id, occurred_at);
  CREATE INDEX IF NOT EXISTS idx_chip_messages_chip ON chip_messages(chip_id, received_at);
`

export interface CreateChipInput {
  phone_number: string
  carrier: string
  plan_name: string
  plan_type?: ChipPlanType
  acquisition_date: string
  acquisition_cost_brl: number
  monthly_cost_brl: number
  payment_due_day: number
  payment_method?: string | null
  paid_by_operator: string
  invoice_ref?: string | null
  invoice_path?: string | null
  device_serial?: string | null
  status?: ChipStatus
  acquired_for_purpose?: string | null
  notes?: string | null
}

export interface UpdateChipInput {
  carrier?: string
  plan_name?: string
  plan_type?: ChipPlanType
  monthly_cost_brl?: number
  payment_due_day?: number
  payment_method?: string | null
  paid_by_operator?: string
  invoice_ref?: string | null
  invoice_path?: string | null
  device_serial?: string | null
  status?: ChipStatus
  acquired_for_purpose?: string | null
  notes?: string | null
}

export interface ListChipsFilter {
  carrier?: string
  status?: ChipStatus
  paid_by_operator?: string
  device_serial?: string
}

export interface RecordPaymentInput {
  period: string
  amount_brl: number
  paid_at: string
  paid_by_operator: string
  payment_method?: string | null
  receipt_path?: string | null
  notes?: string | null
}

export interface RecordEventInput {
  event_type: string
  occurred_at: string
  operator?: string | null
  metadata?: Record<string, unknown> | null
  notes?: string | null
}

export interface RecordMessageInput {
  from_number: string
  message_text: string
  received_at: string
  category?: ChipMessageCategory | null
  source?: 'manual' | 'adb_sms_dump'
  raw?: Record<string, unknown> | null
}

export class DuplicateChipError extends Error {
  readonly code = 'DUPLICATE_CHIP'
  constructor(public phone_number: string) {
    super(`chip with phone_number=${phone_number} already exists`)
  }
}

export class DuplicatePaymentError extends Error {
  readonly code = 'DUPLICATE_PAYMENT'
  constructor(public chip_id: string, public period: string) {
    super(`payment for chip=${chip_id} period=${period} already recorded`)
  }
}

export class ChipNotFoundError extends Error {
  readonly code = 'CHIP_NOT_FOUND'
  constructor(public chip_id: string) {
    super(`chip ${chip_id} not found`)
  }
}

export class ChipRegistry {
  constructor(private db: Database.Database) {}

  initialize(): void {
    this.db.exec(SCHEMA_SQL)
  }

  /**
   * Normalize every legacy `chips.phone_number` to canonical 13-digit BR
   * mobile (12-digit → insert 9-prefix; 11-digit → prepend `cc=55`).
   *
   * Conflict handling: when normalizing produces a value that already
   * exists in the table, the orphan row is DELETED (the canonical one
   * wins). This is safe because chip rows are placeholders auto-imported
   * from device mappings — operator edits live on the canonical row, the
   * orphan was created by an earlier buggy import. Returns the per-row
   * diff so the caller can log + diagnose.
   *
   * Idempotent — re-running over already-canonical rows is a no-op.
   */
  normalizeStoredPhones(logger?: PhoneNormalizerLogger): Array<{
    id: string
    before: string
    after: string
    action: 'updated' | 'deleted_duplicate'
  }> {
    const rows = this.db
      .prepare("SELECT id, phone_number FROM chips WHERE phone_number IS NOT NULL AND phone_number != ''")
      .all() as Array<{ id: string; phone_number: string }>
    const changes: Array<{
      id: string
      before: string
      after: string
      action: 'updated' | 'deleted_duplicate'
    }> = []
    const update = this.db.prepare('UPDATE chips SET phone_number = ? WHERE id = ?')
    const findExisting = this.db.prepare('SELECT id FROM chips WHERE phone_number = ?')
    const del = this.db.prepare('DELETE FROM chips WHERE id = ?')
    // Reparent child rows to the canonical chip before deletion to avoid FK
    // violations. INSERT OR IGNORE on the unique-constrained tables drops
    // duplicates that would otherwise collide on (chip_id, period) etc.
    const reparentEvents = this.db.prepare('UPDATE chip_events SET chip_id = ? WHERE chip_id = ?')
    const reparentMessages = this.db.prepare('UPDATE chip_messages SET chip_id = ? WHERE chip_id = ?')
    const reparentPayments = this.db.prepare(
      `UPDATE OR IGNORE chip_payments SET chip_id = ? WHERE chip_id = ?`,
    )
    const deleteOrphanPayments = this.db.prepare('DELETE FROM chip_payments WHERE chip_id = ?')
    const txn = this.db.transaction(() => {
      for (const row of rows) {
        const norm = normalizeBrPhone(row.phone_number, logger).phone
        if (!norm || norm === row.phone_number) continue
        const conflict = findExisting.get(norm) as { id: string } | undefined
        if (conflict && conflict.id !== row.id) {
          // Canonical row already exists — reparent children, then drop the orphan.
          reparentEvents.run(conflict.id, row.id)
          reparentMessages.run(conflict.id, row.id)
          reparentPayments.run(conflict.id, row.id)
          // Any payments that collided on UNIQUE (chip_id, period) stayed on
          // the orphan — clear them so the FK delete can complete.
          deleteOrphanPayments.run(row.id)
          del.run(row.id)
          changes.push({ id: row.id, before: row.phone_number, after: norm, action: 'deleted_duplicate' })
        } else {
          update.run(norm, row.id)
          changes.push({ id: row.id, before: row.phone_number, after: norm, action: 'updated' })
        }
      }
    })
    txn()
    return changes
  }

  // ── Chips CRUD ────────────────────────────────────────────────────────

  createChip(input: CreateChipInput): Chip {
    if (input.payment_due_day < 1 || input.payment_due_day > 31) {
      throw new Error('payment_due_day must be 1..31')
    }
    const id = nanoid()
    const status = input.status ?? 'active'
    const planType = input.plan_type ?? 'postpago'
    try {
      this.db
        .prepare(
          `INSERT INTO chips (
            id, phone_number, carrier, plan_name, plan_type,
            acquisition_date, acquisition_cost_brl, monthly_cost_brl,
            payment_due_day, payment_method, paid_by_operator,
            invoice_ref, invoice_path, device_serial, status,
            acquired_for_purpose, notes
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          input.phone_number,
          input.carrier.toLowerCase(),
          input.plan_name,
          planType,
          input.acquisition_date,
          input.acquisition_cost_brl,
          input.monthly_cost_brl,
          input.payment_due_day,
          input.payment_method ?? null,
          input.paid_by_operator,
          input.invoice_ref ?? null,
          input.invoice_path ?? null,
          input.device_serial ?? null,
          status,
          input.acquired_for_purpose ?? null,
          input.notes ?? null,
        )
    } catch (e) {
      if (e instanceof Error && /UNIQUE constraint failed: chips\.phone_number/.test(e.message)) {
        throw new DuplicateChipError(input.phone_number)
      }
      throw e
    }

    // Auto-log "acquired" event so the timeline is never empty for a new chip.
    this.recordEvent(id, {
      event_type: 'acquired',
      occurred_at: input.acquisition_date,
      operator: input.paid_by_operator,
      metadata: {
        plan_name: input.plan_name,
        plan_type: planType,
        acquisition_cost_brl: input.acquisition_cost_brl,
        monthly_cost_brl: input.monthly_cost_brl,
        device_serial: input.device_serial ?? null,
      },
      notes: input.acquired_for_purpose ?? null,
    })

    return this.getChip(id)!
  }

  getChip(id: string): Chip | null {
    const row = this.db.prepare('SELECT * FROM chips WHERE id = ?').get(id) as
      | Chip
      | undefined
    return row ?? null
  }

  getChipByPhone(phone_number: string): Chip | null {
    const row = this.db
      .prepare('SELECT * FROM chips WHERE phone_number = ?')
      .get(phone_number) as Chip | undefined
    return row ?? null
  }

  listChips(filter: ListChipsFilter = {}): Chip[] {
    const where: string[] = []
    const params: unknown[] = []
    if (filter.carrier) {
      where.push('carrier = ?')
      params.push(filter.carrier.toLowerCase())
    }
    if (filter.status) {
      where.push('status = ?')
      params.push(filter.status)
    }
    if (filter.paid_by_operator) {
      where.push('paid_by_operator = ?')
      params.push(filter.paid_by_operator)
    }
    if (filter.device_serial) {
      where.push('device_serial = ?')
      params.push(filter.device_serial)
    }
    const sql = `SELECT * FROM chips ${
      where.length ? 'WHERE ' + where.join(' AND ') : ''
    } ORDER BY created_at DESC`
    return this.db.prepare(sql).all(...params) as Chip[]
  }

  updateChip(id: string, patch: UpdateChipInput): Chip {
    const current = this.getChip(id)
    if (!current) throw new ChipNotFoundError(id)
    if (patch.payment_due_day !== undefined && (patch.payment_due_day < 1 || patch.payment_due_day > 31)) {
      throw new Error('payment_due_day must be 1..31')
    }
    const fields: string[] = []
    const params: unknown[] = []
    const set = <K extends keyof UpdateChipInput>(col: string, val: UpdateChipInput[K]) => {
      if (val !== undefined) {
        fields.push(`${col} = ?`)
        params.push(val ?? null)
      }
    }
    set('carrier', patch.carrier?.toLowerCase())
    set('plan_name', patch.plan_name)
    set('plan_type', patch.plan_type)
    set('monthly_cost_brl', patch.monthly_cost_brl)
    set('payment_due_day', patch.payment_due_day)
    set('payment_method', patch.payment_method)
    set('paid_by_operator', patch.paid_by_operator)
    set('invoice_ref', patch.invoice_ref)
    set('invoice_path', patch.invoice_path)
    set('device_serial', patch.device_serial)
    set('status', patch.status)
    set('acquired_for_purpose', patch.acquired_for_purpose)
    set('notes', patch.notes)
    if (fields.length === 0) return current
    params.push(id)
    this.db.prepare(`UPDATE chips SET ${fields.join(', ')} WHERE id = ?`).run(...params)

    // If status changed to "retired", stamp retirement_date and emit event.
    if (patch.status && patch.status !== current.status) {
      if (patch.status === 'retired') {
        this.db
          .prepare('UPDATE chips SET retirement_date = COALESCE(retirement_date, ?) WHERE id = ?')
          .run(new Date().toISOString(), id)
        this.recordEvent(id, {
          event_type: 'retired',
          occurred_at: new Date().toISOString(),
          operator: patch.paid_by_operator ?? current.paid_by_operator,
          metadata: { previous_status: current.status },
        })
      } else if (patch.status === 'banned') {
        this.recordEvent(id, {
          event_type: 'banned',
          occurred_at: new Date().toISOString(),
          operator: patch.paid_by_operator ?? current.paid_by_operator,
          metadata: { previous_status: current.status },
        })
      }
    }
    return this.getChip(id)!
  }

  /**
   * Soft-delete: status → 'retired' + retirement_date stamped. We keep the row
   * so payment history and timeline survive — a hard delete would orphan
   * `chip_payments` and `chip_events` due to the FK.
   */
  retireChip(id: string, operator: string): Chip {
    return this.updateChip(id, { status: 'retired', paid_by_operator: operator })
  }

  // ── Payments ──────────────────────────────────────────────────────────

  recordPayment(chip_id: string, input: RecordPaymentInput): ChipPayment {
    if (!this.getChip(chip_id)) throw new ChipNotFoundError(chip_id)
    if (!/^\d{4}-\d{2}$/.test(input.period)) {
      throw new Error(`period must be YYYY-MM (got: ${input.period})`)
    }
    const id = nanoid()
    try {
      this.db
        .prepare(
          `INSERT INTO chip_payments (
            id, chip_id, period, amount_brl, paid_at,
            paid_by_operator, payment_method, receipt_path, notes
          ) VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          chip_id,
          input.period,
          input.amount_brl,
          input.paid_at,
          input.paid_by_operator,
          input.payment_method ?? null,
          input.receipt_path ?? null,
          input.notes ?? null,
        )
    } catch (e) {
      if (e instanceof Error && /UNIQUE constraint failed/.test(e.message)) {
        throw new DuplicatePaymentError(chip_id, input.period)
      }
      throw e
    }
    this.recordEvent(chip_id, {
      event_type: 'plan_paid',
      occurred_at: input.paid_at,
      operator: input.paid_by_operator,
      metadata: {
        period: input.period,
        amount_brl: input.amount_brl,
        payment_method: input.payment_method ?? null,
      },
    })
    return this.getPayment(id)!
  }

  getPayment(id: string): ChipPayment | null {
    const row = this.db.prepare('SELECT * FROM chip_payments WHERE id = ?').get(id) as
      | ChipPayment
      | undefined
    return row ?? null
  }

  listPayments(chip_id: string): ChipPayment[] {
    return this.db
      .prepare('SELECT * FROM chip_payments WHERE chip_id = ? ORDER BY period DESC')
      .all(chip_id) as ChipPayment[]
  }

  // ── Events ────────────────────────────────────────────────────────────

  recordEvent(chip_id: string, input: RecordEventInput): ChipEvent {
    if (!this.getChip(chip_id)) throw new ChipNotFoundError(chip_id)
    const id = nanoid()
    this.db
      .prepare(
        `INSERT INTO chip_events (id, chip_id, event_type, occurred_at, operator, metadata_json, notes)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        chip_id,
        input.event_type,
        input.occurred_at,
        input.operator ?? null,
        input.metadata ? JSON.stringify(input.metadata) : null,
        input.notes ?? null,
      )
    return this.getEvent(id)!
  }

  getEvent(id: string): ChipEvent | null {
    const row = this.db.prepare('SELECT * FROM chip_events WHERE id = ?').get(id) as
      | ChipEvent
      | undefined
    return row ?? null
  }

  listEvents(chip_id: string): ChipEvent[] {
    return this.db
      .prepare(
        'SELECT * FROM chip_events WHERE chip_id = ? ORDER BY occurred_at DESC',
      )
      .all(chip_id) as ChipEvent[]
  }

  // ── Messages ──────────────────────────────────────────────────────────

  recordMessage(chip_id: string, input: RecordMessageInput): ChipMessage {
    if (!this.getChip(chip_id)) throw new ChipNotFoundError(chip_id)
    const id = nanoid()
    const source = input.source ?? 'manual'
    this.db
      .prepare(
        `INSERT INTO chip_messages (
          id, chip_id, from_number, message_text, received_at,
          category, source, raw_json
        ) VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        chip_id,
        input.from_number,
        input.message_text,
        input.received_at,
        input.category ?? null,
        source,
        input.raw ? JSON.stringify(input.raw) : null,
      )
    // Mirror into the event timeline so the chip detail view shows the SMS.
    this.recordEvent(chip_id, {
      event_type: 'sms_received',
      occurred_at: input.received_at,
      operator: null,
      metadata: {
        from_number: input.from_number,
        category: input.category ?? null,
        source,
      },
    })
    return this.getMessage(id)!
  }

  getMessage(id: string): ChipMessage | null {
    const row = this.db.prepare('SELECT * FROM chip_messages WHERE id = ?').get(id) as
      | ChipMessage
      | undefined
    return row ?? null
  }

  listMessages(chip_id: string): ChipMessage[] {
    return this.db
      .prepare(
        'SELECT * FROM chip_messages WHERE chip_id = ? ORDER BY received_at DESC',
      )
      .all(chip_id) as ChipMessage[]
  }

  // ── Reports ───────────────────────────────────────────────────────────

  /**
   * Monthly spend across the active fleet for a given period (`YYYY-MM`).
   *
   * Total = sum of `monthly_cost_brl` of every chip that was active at any
   * point during the period (status='active' OR (status='retired' AND
   * retirement_date >= period_start)).
   *
   * Paid = sum of `amount_brl` from `chip_payments` rows in `period`.
   *
   * Outstanding = max(0, total - paid).
   *
   * NOTE: we treat `monthly_cost_brl` as the planned spend — actual paid
   * amounts may differ (e.g. partial credits, plan changes mid-period).
   * Operators see both numbers in the dashboard.
   */
  monthlySpend(period: string): MonthlySpendSummary {
    if (!/^\d{4}-\d{2}$/.test(period)) {
      throw new Error(`period must be YYYY-MM (got: ${period})`)
    }
    const periodStart = `${period}-01`
    const chips = this.db
      .prepare(
        `SELECT * FROM chips
         WHERE status = 'active'
            OR (status = 'retired' AND (retirement_date IS NULL OR retirement_date >= ?))`,
      )
      .all(periodStart) as Chip[]

    const payments = this.db
      .prepare('SELECT * FROM chip_payments WHERE period = ?')
      .all(period) as ChipPayment[]

    const paidByChip = new Map<string, number>()
    for (const p of payments) {
      paidByChip.set(p.chip_id, (paidByChip.get(p.chip_id) ?? 0) + p.amount_brl)
    }

    let total = 0
    let paid = 0
    const byCarrier: MonthlySpendSummary['by_carrier'] = {}
    const byOperator: MonthlySpendSummary['by_operator'] = {}
    let activeChips = 0

    for (const chip of chips) {
      const planned = chip.monthly_cost_brl
      const paidForChip = paidByChip.get(chip.id) ?? 0
      total += planned
      paid += paidForChip
      if (chip.status === 'active') activeChips += 1

      const carrierBucket = byCarrier[chip.carrier] ?? { count: 0, total_brl: 0, paid_brl: 0 }
      carrierBucket.count += 1
      carrierBucket.total_brl += planned
      carrierBucket.paid_brl += paidForChip
      byCarrier[chip.carrier] = carrierBucket

      const opBucket = byOperator[chip.paid_by_operator] ?? { count: 0, total_brl: 0 }
      opBucket.count += 1
      opBucket.total_brl += planned
      byOperator[chip.paid_by_operator] = opBucket
    }

    return {
      period,
      total_brl: round2(total),
      paid_brl: round2(paid),
      outstanding_brl: round2(Math.max(0, total - paid)),
      by_carrier: Object.fromEntries(
        Object.entries(byCarrier).map(([k, v]) => [
          k,
          {
            count: v.count,
            total_brl: round2(v.total_brl),
            paid_brl: round2(v.paid_brl),
          },
        ]),
      ),
      by_operator: Object.fromEntries(
        Object.entries(byOperator).map(([k, v]) => [
          k,
          { count: v.count, total_brl: round2(v.total_brl) },
        ]),
      ),
      active_chips: activeChips,
    }
  }

  /**
   * Returns the renewal calendar for the next `windowDays` days.
   *
   * For each active chip we surface the *most relevant* upcoming/overdue
   * obligation. Two cases:
   *
   *   1. Current period is unpaid and today is at-or-past due_day → return
   *      the "this month" due date as overdue (negative days_until_due).
   *   2. Otherwise return the next future due date (this month if today <
   *      due_day, else next month). Status is paid/due_today/upcoming.
   *
   * Filter rules:
   *   - Skip 'paid' entries unless windowDays > 365 (audit mode).
   *   - Skip 'upcoming' beyond the window.
   *
   * `now` is injectable for deterministic tests.
   */
  renewalCalendar(windowDays = 30, now: Date = new Date()): RenewalCalendarEntry[] {
    const chips = this.listChips({ status: 'active' })
    const out: RenewalCalendarEntry[] = []
    for (const chip of chips) {
      // ── Resolve which due date is "current" for this chip ───────────
      const currentPeriod = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
      const paidThisPeriodRow = this.db
        .prepare('SELECT id FROM chip_payments WHERE chip_id = ? AND period = ?')
        .get(chip.id, currentPeriod) as { id: string } | undefined

      // This-month due date (clamped if month is short).
      const thisMonthDue = clampedDueDate(chip.payment_due_day, now.getUTCFullYear(), now.getUTCMonth())
      const todayDay = now.getUTCDate()

      let dueDate: Date
      let period: string
      let paid: boolean
      if (!paidThisPeriodRow && todayDay >= thisMonthDue.getUTCDate()) {
        // Current month obligation (today == due_day or already past it,
        // unpaid) — surface as the relevant entry.
        dueDate = thisMonthDue
        period = currentPeriod
        paid = false
      } else {
        // Future obligation — next occurrence after today.
        dueDate = nextDueDate(chip.payment_due_day, now)
        period = `${dueDate.getUTCFullYear()}-${String(dueDate.getUTCMonth() + 1).padStart(2, '0')}`
        const futurePaidRow = this.db
          .prepare('SELECT id FROM chip_payments WHERE chip_id = ? AND period = ?')
          .get(chip.id, period) as { id: string } | undefined
        paid = Boolean(futurePaidRow)
      }
      const daysUntil = daysBetween(now, dueDate)

      let status: RenewalStatus
      if (paid) status = 'paid'
      else if (daysUntil < 0) status = 'overdue'
      else if (daysUntil === 0) status = 'due_today'
      else status = 'upcoming'

      // Filters.
      if (windowDays <= 365 && status === 'paid') continue
      if (status === 'upcoming' && daysUntil > windowDays) continue

      out.push({
        chip_id: chip.id,
        phone_number: chip.phone_number,
        carrier: chip.carrier,
        plan_name: chip.plan_name,
        monthly_cost_brl: chip.monthly_cost_brl,
        payment_due_day: chip.payment_due_day,
        next_due_date: dueDate.toISOString().slice(0, 10),
        days_until_due: daysUntil,
        status,
        paid_for_period: paid ? period : null,
      })
    }
    return out.sort((a, b) => a.days_until_due - b.days_until_due)
  }

  /** Convenience: chips overdue right now (status='overdue' from renewalCalendar). */
  overdue(now: Date = new Date()): RenewalCalendarEntry[] {
    return this.renewalCalendar(365, now).filter((e) => e.status === 'overdue')
  }

  // ── Auto-import from the device-side mapping tables ──────────────────
  //
  // The `whatsapp_accounts` table is populated by WaAccountMapper as it
  // walks each Android profile and reads the registered phone via the
  // contacts content provider. `sender_mapping` is populated by the
  // device commissioning UI when an operator binds a phone to a profile.
  //
  // Both are good sources for the chip catalogue: every phone that lives
  // on a device should have a corresponding row in `chips` so cost
  // tracking, renewal alerts, and the Frota page never show empty.
  //
  // Idempotency: `INSERT OR IGNORE` against the UNIQUE phone_number — an
  // operator-edited chip (real plan/cost values) is preserved across boots.
  // Re-running the import only inserts NEW phones discovered on devices.

  /**
   * Import every distinct phone_number from `whatsapp_accounts` as a chip.
   * Skips rows where phone_number IS NULL (placeholders waiting for setup).
   *
   * Returns counts so the boot log + admin endpoint can report progress.
   */
  importFromWhatsappAccounts(now: Date = new Date()): ChipImportResult {
    return this.importFromTable({
      sourceTable: 'whatsapp_accounts',
      query: `SELECT device_serial, profile_id, package_name, phone_number
              FROM whatsapp_accounts
              WHERE phone_number IS NOT NULL AND phone_number != ''`,
      countAllRowsQuery: `SELECT COUNT(*) AS c FROM whatsapp_accounts
                          WHERE phone_number IS NULL OR phone_number = ''`,
      buildNotes: (row) =>
        `Auto-importado de whatsapp_accounts: device ${row.device_serial} ` +
        `profile ${row.profile_id} package ${row.package_name}. ` +
        `Editar valores reais (custo, vencimento, operadora).`,
      buildMetadata: (row) => ({
        profile_id: row.profile_id,
        package_name: row.package_name,
        device_serial: row.device_serial,
      }),
      now,
    })
  }

  /**
   * Import every distinct phone_number from `sender_mapping` as a chip.
   * Skips inactive senders.
   */
  importFromSenderMapping(now: Date = new Date()): ChipImportResult {
    // Defensive: sender_mapping may not exist in tests that only init the registry.
    const tableExists = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='sender_mapping'",
      )
      .get() as { name: string } | undefined
    if (!tableExists) {
      return {
        source: 'sender_mapping',
        inserted: 0,
        skipped: 0,
        already_exists: 0,
        skipped_no_phone: 0,
        errors: [],
      }
    }
    return this.importFromTable({
      sourceTable: 'sender_mapping',
      query: `SELECT phone_number, device_serial, profile_id, app_package
              FROM sender_mapping
              WHERE active = 1 AND phone_number IS NOT NULL AND phone_number != ''`,
      countAllRowsQuery: `SELECT COUNT(*) AS c FROM sender_mapping
                          WHERE active = 1 AND (phone_number IS NULL OR phone_number = '')`,
      buildNotes: (row) =>
        `Auto-importado de sender_mapping: device ${row.device_serial} ` +
        `profile ${row.profile_id} package ${row.app_package}. ` +
        `Editar valores reais (custo, vencimento, operadora).`,
      buildMetadata: (row) => ({
        profile_id: row.profile_id,
        package_name: row.app_package,
        device_serial: row.device_serial,
      }),
      now,
    })
  }

  /** Run BOTH imports — used at boot. */
  importFromDevices(now: Date = new Date()): {
    whatsapp_accounts: ChipImportResult
    sender_mapping: ChipImportResult
  } {
    return {
      whatsapp_accounts: this.importFromWhatsappAccounts(now),
      sender_mapping: this.importFromSenderMapping(now),
    }
  }

  private importFromTable(args: {
    sourceTable: string
    query: string
    buildNotes: (row: ImportSourceRow) => string
    buildMetadata: (row: ImportSourceRow) => Record<string, unknown>
    now: Date
    /**
     * Optional: when provided, total count of source rows including those
     * skipped due to NULL/empty `phone_number`. The dedicated counter is
     * surfaced as `skipped_no_phone` so the UI can nudge the operator
     * toward UIAutomator scan when rows exist but have no number yet.
     */
    countAllRowsQuery?: string
  }): ChipImportResult {
    const { sourceTable, query, buildNotes, buildMetadata, now, countAllRowsQuery } = args
    let rows: ImportSourceRow[]
    try {
      rows = this.db.prepare(query).all() as ImportSourceRow[]
    } catch {
      // Table doesn't exist yet (e.g. fresh DB before WaAccountMapper init).
      return { source: sourceTable, inserted: 0, skipped: 0, already_exists: 0, skipped_no_phone: 0, errors: [] }
    }

    // Count rows in source that have NULL / empty phone — surface so UI can
    // nudge operator toward UIAutomator scan.
    let skippedNoPhone = 0
    if (countAllRowsQuery) {
      try {
        const r = this.db.prepare(countAllRowsQuery).get() as { c: number } | undefined
        skippedNoPhone = Number(r?.c ?? 0)
      } catch {
        skippedNoPhone = 0
      }
    }

    let inserted = 0
    let alreadyExists = 0
    const errors: Array<{ phone_number: string; error: string }> = []
    const acquisitionDate = now.toISOString().slice(0, 10)

    // Group by phone_number — `whatsapp_accounts` has one row per
    // (device, profile, package) but a chip is keyed by phone_number alone.
    const byPhone = new Map<string, ImportSourceRow>()
    for (const row of rows) {
      const phone = String(row.phone_number ?? '').trim()
      if (!phone) continue
      if (!byPhone.has(phone)) byPhone.set(phone, row)
    }

    for (const [phone, row] of byPhone.entries()) {
      // INSERT OR IGNORE on UNIQUE — preserves operator edits.
      try {
        const id = nanoid()
        const result = this.db
          .prepare(
            `INSERT OR IGNORE INTO chips (
              id, phone_number, carrier, plan_name, plan_type,
              acquisition_date, acquisition_cost_brl, monthly_cost_brl,
              payment_due_day, payment_method, paid_by_operator,
              invoice_ref, invoice_path, device_serial, status,
              acquired_for_purpose, notes
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            id,
            phone,
            'unknown',
            'A definir',
            'postpago',
            acquisitionDate,
            0,
            0,
            15,
            null,
            `auto-import (${sourceTable})`,
            null,
            null,
            row.device_serial ?? null,
            'active',
            null,
            buildNotes(row),
          )
        if (result.changes > 0) {
          inserted += 1
          // Auto-event for the new chip's timeline.
          try {
            this.recordEvent(id, {
              event_type: 'acquired',
              occurred_at: acquisitionDate,
              operator: `auto-import (${sourceTable})`,
              metadata: buildMetadata(row),
              notes: 'Auto-importado a partir do device — preencher dados reais',
            })
          } catch {
            // recordEvent throws if the chip wasn't actually created (race).
            // Safe to ignore — the chip insert was the source of truth.
          }
        } else {
          alreadyExists += 1
        }
      } catch (e) {
        errors.push({
          phone_number: phone,
          error: e instanceof Error ? e.message : String(e),
        })
      }
    }
    return {
      source: sourceTable,
      inserted,
      // `skipped` retained for backwards-compatibility (= already_exists).
      // New code should use `already_exists` and `skipped_no_phone` directly.
      skipped: alreadyExists,
      already_exists: alreadyExists,
      skipped_no_phone: skippedNoPhone,
      errors,
    }
  }
}

// ── Import-from-devices types ───────────────────────────────────────────

interface ImportSourceRow {
  phone_number: string | null
  device_serial: string | null
  profile_id: number
  package_name?: string
  app_package?: string
}

export interface ChipImportResult {
  source: string
  /** New chips inserted. */
  inserted: number
  /**
   * Backwards-compatible alias for `already_exists`. Pre-existing callers
   * (and the `chip-registry-import.test.ts` suite) read this field; we keep
   * it identical to `already_exists` so removing it would be a breaking change.
   */
  skipped: number
  /** Source rows whose phone is already registered in `chips`. */
  already_exists: number
  /**
   * Source rows present in the table but with `phone_number IS NULL` (i.e.
   * placeholders awaiting UIAutomator scrape). Surfaced so the UI can nudge
   * the operator toward "Auto-detectar números".
   */
  skipped_no_phone: number
  errors: Array<{ phone_number: string; error: string }>
}

// ── Helpers ─────────────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** Returns a date for `dueDay` clamped to the last day of (year, month). */
function clampedDueDate(dueDay: number, year: number, month: number): Date {
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  return new Date(Date.UTC(year, month, Math.min(dueDay, lastDay)))
}

/**
 * Computes the next occurrence of `dueDay` (1..31) on or after `now` (UTC).
 *
 * Edge cases:
 *   - Months with fewer days than dueDay (Feb 30, Apr 31, …) clamp to the
 *     last calendar day of that month.
 *   - If today is past the due day this month, advance to next month.
 */
export function nextDueDate(dueDay: number, now: Date): Date {
  const year = now.getUTCFullYear()
  const month = now.getUTCMonth() // 0-indexed
  const today = now.getUTCDate()
  const tryMonth = (y: number, m: number): Date => {
    const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
    const day = Math.min(dueDay, lastDay)
    return new Date(Date.UTC(y, m, day))
  }
  // This-month candidate.
  const thisMonth = tryMonth(year, month)
  if (thisMonth.getUTCDate() >= today) return thisMonth
  // Otherwise, next month (rolling year).
  const nm = month === 11 ? 0 : month + 1
  const ny = month === 11 ? year + 1 : year
  return tryMonth(ny, nm)
}

/** Whole-day delta from `now` to `target` (UTC, anchored at start-of-day). */
function daysBetween(now: Date, target: Date): number {
  const a = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const b = Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate())
  return Math.round((b - a) / 86_400_000)
}
