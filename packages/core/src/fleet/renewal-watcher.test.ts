import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { ChipRegistry } from './chip-registry.js'
import { RenewalWatcher, classifyAlerts } from './renewal-watcher.js'

function buildRegistry() {
  const db = new Database(':memory:')
  const reg = new ChipRegistry(db)
  reg.initialize()
  return { db, reg }
}

describe('RenewalWatcher', () => {
  it('emits upcoming_7d alert for chip due exactly 7 days from now', async () => {
    const { reg } = buildRegistry()
    // due_day 27 → for now=2026-04-20, due is 04-27 = 7 days away
    reg.createChip({
      phone_number: '5543991938235',
      carrier: 'vivo',
      plan_name: 'Plano X',
      acquisition_date: '2026-01-01',
      acquisition_cost_brl: 50,
      monthly_cost_brl: 99.9,
      payment_due_day: 27,
      paid_by_operator: 'matheus',
    })
    const sink = { send: vi.fn() }
    const watcher = new RenewalWatcher(reg, sink)
    const fired = await watcher.runSweep(new Date('2026-04-20T12:00:00Z'))
    expect(fired).toHaveLength(1)
    expect(fired[0]!.kind).toBe('upcoming_7d')
    expect(sink.send).toHaveBeenCalledTimes(1)
  })

  it('emits due_today alert when payment_due_day == today', async () => {
    const { reg } = buildRegistry()
    reg.createChip({
      phone_number: '5511999999999',
      carrier: 'claro',
      plan_name: 'Plano Y',
      acquisition_date: '2026-01-01',
      acquisition_cost_brl: 50,
      monthly_cost_brl: 50,
      payment_due_day: 20,
      paid_by_operator: 'matheus',
    })
    const sink = { send: vi.fn() }
    const watcher = new RenewalWatcher(reg, sink)
    const fired = await watcher.runSweep(new Date('2026-04-20T12:00:00Z'))
    expect(fired).toHaveLength(1)
    expect(fired[0]!.kind).toBe('due_today')
  })

  it('emits overdue_5d alert exactly 5 days after due', async () => {
    const { reg } = buildRegistry()
    reg.createChip({
      phone_number: '5511888888888',
      carrier: 'tim',
      plan_name: 'Plano Z',
      acquisition_date: '2026-01-01',
      acquisition_cost_brl: 50,
      monthly_cost_brl: 50,
      payment_due_day: 15,
      paid_by_operator: 'matheus',
    })
    const sink = { send: vi.fn() }
    const watcher = new RenewalWatcher(reg, sink)
    // 2026-04-20 is 5 days after 2026-04-15
    const fired = await watcher.runSweep(new Date('2026-04-20T12:00:00Z'))
    expect(fired).toHaveLength(1)
    expect(fired[0]!.kind).toBe('overdue_5d')
  })

  it('does not re-fire the same alert in subsequent sweeps', async () => {
    const { reg } = buildRegistry()
    reg.createChip({
      phone_number: '5511999999999',
      carrier: 'claro',
      plan_name: 'Plano Y',
      acquisition_date: '2026-01-01',
      acquisition_cost_brl: 50,
      monthly_cost_brl: 50,
      payment_due_day: 20,
      paid_by_operator: 'matheus',
    })
    const sink = { send: vi.fn() }
    const watcher = new RenewalWatcher(reg, sink)
    await watcher.runSweep(new Date('2026-04-20T08:00:00Z'))
    const fired2 = await watcher.runSweep(new Date('2026-04-20T16:00:00Z'))
    expect(fired2).toHaveLength(0)
    expect(sink.send).toHaveBeenCalledTimes(1)
  })

  it('skips chips that have already paid the upcoming period', async () => {
    const { reg } = buildRegistry()
    const c = reg.createChip({
      phone_number: '5543991938235',
      carrier: 'vivo',
      plan_name: 'X',
      acquisition_date: '2026-01-01',
      acquisition_cost_brl: 50,
      monthly_cost_brl: 99.9,
      payment_due_day: 20,
      paid_by_operator: 'matheus',
    })
    reg.recordPayment(c.id, {
      period: '2026-04',
      amount_brl: 99.9,
      paid_at: '2026-04-19',
      paid_by_operator: 'matheus',
    })
    const sink = { send: vi.fn() }
    const watcher = new RenewalWatcher(reg, sink)
    const fired = await watcher.runSweep(new Date('2026-04-20T12:00:00Z'))
    expect(fired).toHaveLength(0)
  })

  it('logs error when sink throws but does not abort the sweep', async () => {
    const { reg } = buildRegistry()
    reg.createChip({
      phone_number: '5511999999999',
      carrier: 'claro',
      plan_name: 'Plano Y',
      acquisition_date: '2026-01-01',
      acquisition_cost_brl: 50,
      monthly_cost_brl: 50,
      payment_due_day: 20,
      paid_by_operator: 'matheus',
    })
    const sink = { send: vi.fn(async () => { throw new Error('telegram down') }) }
    const logger = { info: vi.fn(), error: vi.fn() }
    const watcher = new RenewalWatcher(reg, sink, logger)
    const fired = await watcher.runSweep(new Date('2026-04-20T12:00:00Z'))
    expect(fired).toHaveLength(0) // sink failed, so not counted as fired
    expect(logger.error).toHaveBeenCalled()
  })
})

describe('classifyAlerts (pure)', () => {
  const base = {
    chip_id: 'c1',
    phone_number: '5543991938235',
    carrier: 'vivo',
    plan_name: 'X',
    monthly_cost_brl: 50,
    payment_due_day: 15,
    next_due_date: '2026-04-15',
    paid_for_period: null,
  }

  it('returns no alerts for paid chips', () => {
    expect(
      classifyAlerts({ ...base, days_until_due: 0, status: 'paid', paid_for_period: '2026-04' }),
    ).toEqual([])
  })

  it('emits due_today even when status disagrees (defensive)', () => {
    const out = classifyAlerts({ ...base, days_until_due: 0, status: 'upcoming' })
    expect(out).toHaveLength(1)
    expect(out[0]!.kind).toBe('due_today')
  })

  it('does not emit alerts for arbitrary mid-window days', () => {
    expect(classifyAlerts({ ...base, days_until_due: 3, status: 'upcoming' })).toEqual([])
    expect(classifyAlerts({ ...base, days_until_due: -2, status: 'overdue' })).toEqual([])
  })
})
