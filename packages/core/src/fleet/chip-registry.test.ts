import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  ChipRegistry,
  DuplicateChipError,
  DuplicatePaymentError,
  ChipNotFoundError,
  nextDueDate,
} from './chip-registry.js'

function buildRegistry(): { db: Database.Database; reg: ChipRegistry } {
  const db = new Database(':memory:')
  const reg = new ChipRegistry(db)
  reg.initialize()
  return { db, reg }
}

const baseChip = {
  phone_number: '5543991938235',
  carrier: 'vivo',
  plan_name: 'Vivo Controle 30GB',
  acquisition_date: '2026-01-15',
  acquisition_cost_brl: 50,
  monthly_cost_brl: 99.9,
  payment_due_day: 15,
  paid_by_operator: 'matheus',
}

describe('ChipRegistry — schema + CRUD', () => {
  it('initialize is idempotent (CREATE IF NOT EXISTS)', () => {
    const { db, reg } = buildRegistry()
    reg.initialize() // second call must not throw
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[]
    const names = tables.map((t) => t.name)
    expect(names).toContain('chips')
    expect(names).toContain('chip_payments')
    expect(names).toContain('chip_events')
    expect(names).toContain('chip_messages')
  })

  it('createChip stores all columns + auto-logs an "acquired" event', () => {
    const { reg } = buildRegistry()
    const chip = reg.createChip({
      ...baseChip,
      payment_method: 'Cartão Inter 1234',
      device_serial: 'POCO_C71_001',
      acquired_for_purpose: 'Oralsin SP',
      notes: 'Recebido em mãos',
    })
    expect(chip.id).toMatch(/.+/)
    expect(chip.phone_number).toBe('5543991938235')
    expect(chip.carrier).toBe('vivo')
    expect(chip.status).toBe('active')
    expect(chip.plan_type).toBe('postpago')

    const events = reg.listEvents(chip.id)
    expect(events).toHaveLength(1)
    expect(events[0]!.event_type).toBe('acquired')
  })

  it('createChip rejects duplicate phone_number with DuplicateChipError', () => {
    const { reg } = buildRegistry()
    reg.createChip(baseChip)
    expect(() => reg.createChip(baseChip)).toThrow(DuplicateChipError)
  })

  it('createChip validates payment_due_day is 1..31', () => {
    const { reg } = buildRegistry()
    expect(() => reg.createChip({ ...baseChip, payment_due_day: 0 })).toThrow()
    expect(() => reg.createChip({ ...baseChip, payment_due_day: 32 })).toThrow()
  })

  it('listChips filters by carrier and status', () => {
    const { reg } = buildRegistry()
    reg.createChip(baseChip)
    reg.createChip({ ...baseChip, phone_number: '5511999999999', carrier: 'CLARO' })
    reg.createChip({ ...baseChip, phone_number: '5511888888888', carrier: 'tim', status: 'banned' })

    expect(reg.listChips({ carrier: 'vivo' })).toHaveLength(1)
    expect(reg.listChips({ carrier: 'claro' })).toHaveLength(1) // case-insensitive
    expect(reg.listChips({ status: 'banned' })).toHaveLength(1)
    expect(reg.listChips({})).toHaveLength(3)
  })

  it('updateChip merges only provided fields', () => {
    const { reg } = buildRegistry()
    const c = reg.createChip(baseChip)
    const updated = reg.updateChip(c.id, { notes: 'Atualizado', monthly_cost_brl: 79.9 })
    expect(updated.notes).toBe('Atualizado')
    expect(updated.monthly_cost_brl).toBe(79.9)
    expect(updated.phone_number).toBe(c.phone_number)
    expect(updated.plan_name).toBe(c.plan_name)
  })

  it('updateChip throws ChipNotFoundError for unknown id', () => {
    const { reg } = buildRegistry()
    expect(() => reg.updateChip('nope', { notes: 'x' })).toThrow(ChipNotFoundError)
  })

  it('retireChip soft-deletes (status=retired + retirement_date) and emits event', () => {
    const { reg } = buildRegistry()
    const c = reg.createChip(baseChip)
    const retired = reg.retireChip(c.id, 'matheus')
    expect(retired.status).toBe('retired')
    expect(retired.retirement_date).toMatch(/\d{4}-\d{2}-\d{2}/)

    const events = reg.listEvents(c.id).map((e) => e.event_type)
    expect(events).toContain('retired')
  })
})

describe('ChipRegistry — payments', () => {
  it('recordPayment validates period format', () => {
    const { reg } = buildRegistry()
    const c = reg.createChip(baseChip)
    expect(() =>
      reg.recordPayment(c.id, {
        period: '2026-4', // invalid
        amount_brl: 99.9,
        paid_at: '2026-04-15',
        paid_by_operator: 'matheus',
      }),
    ).toThrow()
  })

  it('recordPayment is idempotent on (chip_id, period)', () => {
    const { reg } = buildRegistry()
    const c = reg.createChip(baseChip)
    reg.recordPayment(c.id, {
      period: '2026-04',
      amount_brl: 99.9,
      paid_at: '2026-04-15',
      paid_by_operator: 'matheus',
    })
    expect(() =>
      reg.recordPayment(c.id, {
        period: '2026-04',
        amount_brl: 99.9,
        paid_at: '2026-04-16',
        paid_by_operator: 'matheus',
      }),
    ).toThrow(DuplicatePaymentError)
  })

  it('recordPayment emits a "plan_paid" event mirroring the payment', () => {
    const { reg } = buildRegistry()
    const c = reg.createChip(baseChip)
    reg.recordPayment(c.id, {
      period: '2026-04',
      amount_brl: 99.9,
      paid_at: '2026-04-15T10:00:00Z',
      paid_by_operator: 'matheus',
      payment_method: 'Pix',
    })
    const types = reg.listEvents(c.id).map((e) => e.event_type)
    expect(types).toContain('plan_paid')
  })

  it('listPayments returns rows for a chip ordered by period DESC', () => {
    const { reg } = buildRegistry()
    const c = reg.createChip(baseChip)
    reg.recordPayment(c.id, {
      period: '2026-03',
      amount_brl: 99.9,
      paid_at: '2026-03-15',
      paid_by_operator: 'matheus',
    })
    reg.recordPayment(c.id, {
      period: '2026-04',
      amount_brl: 99.9,
      paid_at: '2026-04-15',
      paid_by_operator: 'matheus',
    })
    const list = reg.listPayments(c.id)
    expect(list).toHaveLength(2)
    expect(list[0]!.period).toBe('2026-04')
  })
})

describe('ChipRegistry — messages + events', () => {
  it('recordMessage stores the SMS and mirrors a "sms_received" event', () => {
    const { reg } = buildRegistry()
    const c = reg.createChip(baseChip)
    reg.recordMessage(c.id, {
      from_number: '1058',
      message_text: 'Sua recarga de R$ 30 foi processada',
      received_at: '2026-04-15T09:00:00Z',
      category: 'recharge_confirmation',
    })
    const msgs = reg.listMessages(c.id)
    expect(msgs).toHaveLength(1)
    expect(msgs[0]!.category).toBe('recharge_confirmation')
    expect(msgs[0]!.source).toBe('manual')

    const types = reg.listEvents(c.id).map((e) => e.event_type)
    expect(types).toContain('sms_received')
  })

  it('recordMessage on unknown chip_id throws ChipNotFoundError', () => {
    const { reg } = buildRegistry()
    expect(() =>
      reg.recordMessage('missing', {
        from_number: '1058',
        message_text: 'x',
        received_at: '2026-01-01',
      }),
    ).toThrow(ChipNotFoundError)
  })

  it('recordEvent stores metadata as JSON and listEvents returns desc by occurred_at', () => {
    const { reg } = buildRegistry()
    const c = reg.createChip(baseChip)
    reg.recordEvent(c.id, {
      event_type: 'plan_changed',
      occurred_at: '2026-04-20T10:00:00Z',
      metadata: { from_plan: 'Controle 20GB', to_plan: 'Controle 30GB' },
    })
    const events = reg.listEvents(c.id)
    expect(events[0]!.event_type).toBe('plan_changed')
    expect(JSON.parse(events[0]!.metadata_json!)).toEqual({
      from_plan: 'Controle 20GB',
      to_plan: 'Controle 30GB',
    })
  })
})

describe('ChipRegistry — reports', () => {
  it('monthlySpend aggregates active chips and payments for the period', () => {
    const { reg } = buildRegistry()
    const a = reg.createChip({ ...baseChip, phone_number: '5543991938235', monthly_cost_brl: 100 })
    const b = reg.createChip({
      ...baseChip,
      phone_number: '5511999999999',
      carrier: 'claro',
      monthly_cost_brl: 50,
      paid_by_operator: 'daniel',
    })
    reg.recordPayment(a.id, {
      period: '2026-04',
      amount_brl: 100,
      paid_at: '2026-04-15',
      paid_by_operator: 'matheus',
    })
    const r = reg.monthlySpend('2026-04')
    expect(r.total_brl).toBe(150)
    expect(r.paid_brl).toBe(100)
    expect(r.outstanding_brl).toBe(50)
    expect(r.by_carrier['vivo']!.total_brl).toBe(100)
    expect(r.by_carrier['claro']!.paid_brl).toBe(0)
    expect(r.by_operator['matheus']!.count).toBe(1)
    expect(r.by_operator['daniel']!.count).toBe(1)
    expect(r.active_chips).toBe(2)
    void b
  })

  it('renewalCalendar marks paid chips and surfaces overdue ones', () => {
    const { reg } = buildRegistry()
    // due_day=15 → for now=2026-04-20, this-month due is 04-15 (5 days overdue)
    const overdue = reg.createChip({
      ...baseChip,
      phone_number: '5543991938235',
      payment_due_day: 15,
    })
    // due_day=25 → due in 5 days from now=2026-04-20
    reg.createChip({
      ...baseChip,
      phone_number: '5511999999999',
      payment_due_day: 25,
    })
    const now = new Date('2026-04-20T12:00:00Z')
    const cal = reg.renewalCalendar(30, now)
    const byPhone = Object.fromEntries(cal.map((c) => [c.phone_number, c]))
    expect(byPhone['5543991938235']!.status).toBe('overdue')
    expect(byPhone['5543991938235']!.days_until_due).toBeLessThan(0)
    expect(byPhone['5511999999999']!.status).toBe('upcoming')

    // After paying April, the next due (May 15, 25 days away) is now the
    // surfaced entry — status flips from 'overdue' to 'upcoming'.
    reg.recordPayment(overdue.id, {
      period: '2026-04',
      amount_brl: 99.9,
      paid_at: '2026-04-21',
      paid_by_operator: 'matheus',
    })
    const cal2 = reg.renewalCalendar(30, now)
    const byPhone2 = Object.fromEntries(cal2.map((c) => [c.phone_number, c]))
    expect(byPhone2['5543991938235']!.status).toBe('upcoming')
    expect(byPhone2['5543991938235']!.days_until_due).toBe(25)
  })

  it('overdue() returns only entries with negative days_until_due', () => {
    const { reg } = buildRegistry()
    reg.createChip({
      ...baseChip,
      phone_number: '5543991938235',
      payment_due_day: 1,
    })
    const now = new Date('2026-04-20T12:00:00Z')
    const overdue = reg.overdue(now)
    expect(overdue).toHaveLength(1)
    expect(overdue[0]!.days_until_due).toBeLessThan(0)
  })
})

describe('ChipRegistry — normalizeStoredPhones', () => {
  it('upgrades a 12-digit legacy phone to canonical 13-digit', () => {
    const { db, reg } = buildRegistry()
    db.prepare(
      `INSERT INTO chips (id, phone_number, carrier, plan_name, plan_type,
         acquisition_date, acquisition_cost_brl, monthly_cost_brl,
         payment_due_day, paid_by_operator, status)
       VALUES ('c1', '554391938235', 'vivo', 'Plan', 'postpago', '2026-01-01',
               0, 0, 15, 'op', 'active')`,
    ).run()
    const changes = reg.normalizeStoredPhones()
    expect(changes).toEqual([{ id: 'c1', before: '554391938235', after: '5543991938235', action: 'updated' }])
    const row = db.prepare('SELECT phone_number FROM chips WHERE id = ?').get('c1') as { phone_number: string }
    expect(row.phone_number).toBe('5543991938235')
  })

  it('deletes the orphan when normalization would create a duplicate', () => {
    const { db, reg } = buildRegistry()
    db.prepare(
      `INSERT INTO chips (id, phone_number, carrier, plan_name, plan_type,
         acquisition_date, acquisition_cost_brl, monthly_cost_brl,
         payment_due_day, paid_by_operator, status)
       VALUES (?, ?, 'vivo', 'P', 'postpago', '2026-01-01', 0, 0, 15, 'op', 'active')`,
    ).run('canonical', '5543991938235')
    db.prepare(
      `INSERT INTO chips (id, phone_number, carrier, plan_name, plan_type,
         acquisition_date, acquisition_cost_brl, monthly_cost_brl,
         payment_due_day, paid_by_operator, status)
       VALUES (?, ?, 'vivo', 'P', 'postpago', '2026-01-01', 0, 0, 15, 'op', 'active')`,
    ).run('orphan', '554391938235')

    const changes = reg.normalizeStoredPhones()
    expect(changes).toEqual([{ id: 'orphan', before: '554391938235', after: '5543991938235', action: 'deleted_duplicate' }])
    expect(reg.listChips()).toHaveLength(1)
    expect(reg.listChips()[0]!.id).toBe('canonical')
  })

  it('reparents child rows (chip_events) to the canonical chip when deleting orphan', () => {
    const { db, reg } = buildRegistry()
    db.prepare(
      `INSERT INTO chips (id, phone_number, carrier, plan_name, plan_type,
         acquisition_date, acquisition_cost_brl, monthly_cost_brl,
         payment_due_day, paid_by_operator, status)
       VALUES (?, ?, 'vivo', 'P', 'postpago', '2026-01-01', 0, 0, 15, 'op', 'active')`,
    ).run('canonical', '5543991938235')
    db.prepare(
      `INSERT INTO chips (id, phone_number, carrier, plan_name, plan_type,
         acquisition_date, acquisition_cost_brl, monthly_cost_brl,
         payment_due_day, paid_by_operator, status)
       VALUES (?, ?, 'vivo', 'P', 'postpago', '2026-01-01', 0, 0, 15, 'op', 'active')`,
    ).run('orphan', '554391938235')
    db.prepare(
      `INSERT INTO chip_events (id, chip_id, event_type, occurred_at)
       VALUES ('e1', 'orphan', 'created', '2026-01-01')`,
    ).run()

    reg.normalizeStoredPhones()

    const event = db.prepare('SELECT chip_id FROM chip_events WHERE id = ?').get('e1') as { chip_id: string }
    expect(event.chip_id).toBe('canonical')
    expect(reg.listChips()).toHaveLength(1)
    expect(reg.listChips()[0]!.id).toBe('canonical')
  })

  it('is idempotent — re-running over canonical rows is a no-op', () => {
    const { reg } = buildRegistry()
    reg.createChip({
      phone_number: '5543991938235',
      carrier: 'vivo',
      plan_name: 'P',
      acquisition_date: '2026-01-01',
      acquisition_cost_brl: 0,
      monthly_cost_brl: 0,
      payment_due_day: 15,
      paid_by_operator: 'op',
    })
    expect(reg.normalizeStoredPhones()).toHaveLength(0)
    expect(reg.normalizeStoredPhones()).toHaveLength(0)
  })
})

describe('nextDueDate edge cases', () => {
  it('clamps to last day of month for short months (Feb 30)', () => {
    const date = nextDueDate(30, new Date('2026-02-01T00:00:00Z'))
    expect(date.toISOString().slice(0, 10)).toBe('2026-02-28')
  })

  it('rolls into next year when advancing past December', () => {
    const date = nextDueDate(15, new Date('2026-12-20T00:00:00Z'))
    expect(date.toISOString().slice(0, 10)).toBe('2027-01-15')
  })

  it('returns same-month date when today is on or before due day', () => {
    const date = nextDueDate(15, new Date('2026-04-10T00:00:00Z'))
    expect(date.toISOString().slice(0, 10)).toBe('2026-04-15')
  })
})
