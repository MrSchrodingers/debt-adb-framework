import type { ChipRegistry } from './chip-registry.js'
import type { RenewalCalendarEntry } from './types.js'

/**
 * Cron-style watcher that scans the renewal calendar and emits Telegram
 * alerts for chips that need attention.
 *
 * Alert windows (per chip):
 *   - 7 days before due (e.g. due_at == today + 7)  — soft heads-up
 *   - On due date                                    — reminder
 *   - 5 days after due                               — escalation
 *
 * Idempotency: every run emits to a sink. The sink (Telegram, log, dispatcher)
 * is responsible for de-dup. Internally the watcher tracks last-fired-on
 * (chip_id, alert_kind, period) tuples in memory only — restarts will re-fire,
 * which is fine for low-frequency alerts (operators want the reminder back).
 *
 * The watcher does NOT mutate state; it just reads from the registry. It is
 * safe to call multiple times per day.
 */
export type RenewalAlertKind = 'upcoming_7d' | 'due_today' | 'overdue_5d'

export interface RenewalAlert {
  kind: RenewalAlertKind
  chip_id: string
  phone_number: string
  carrier: string
  plan_name: string
  monthly_cost_brl: number
  next_due_date: string
  days_until_due: number
  message: string
}

export interface RenewalAlertSink {
  send: (alert: RenewalAlert) => Promise<void> | void
}

export class RenewalWatcher {
  /** Tracks (chip_id, kind, period) tuples already fired in this process. */
  private firedKeys = new Set<string>()

  constructor(
    private registry: ChipRegistry,
    private sink: RenewalAlertSink,
    private logger?: { info: (msg: string, ctx?: unknown) => void; error: (msg: string, ctx?: unknown) => void },
  ) {}

  /** Run a sweep — call from cron (e.g. once per hour or daily 09:00). */
  async runSweep(now: Date = new Date()): Promise<RenewalAlert[]> {
    // Window: -10 to +14 days so we capture the three alert points in one go.
    const calendar = this.registry.renewalCalendar(14, now)
    const fired: RenewalAlert[] = []
    for (const entry of calendar) {
      const alerts = classifyAlerts(entry)
      for (const a of alerts) {
        const dedupKey = `${a.chip_id}|${a.kind}|${a.next_due_date}`
        if (this.firedKeys.has(dedupKey)) continue
        try {
          await this.sink.send(a)
          this.firedKeys.add(dedupKey)
          fired.push(a)
        } catch (e) {
          this.logger?.error('renewal alert sink failed', {
            kind: a.kind,
            chip_id: a.chip_id,
            error: e instanceof Error ? e.message : String(e),
          })
        }
      }
    }
    if (this.logger && fired.length > 0) {
      this.logger.info('renewal-watcher swept', { fired: fired.length })
    }
    return fired
  }

  /**
   * Forget the in-memory dedup state. Used by tests; in production the keys
   * naturally roll over since `next_due_date` shifts each month.
   */
  resetDedup(): void {
    this.firedKeys.clear()
  }
}

/**
 * Classify a calendar entry into 0..1 alert kinds. We never emit two kinds
 * for the same entry in the same sweep — `due_today` wins over `upcoming_7d`,
 * `overdue_5d` is its own slot.
 *
 * Exported for unit testing.
 */
export function classifyAlerts(entry: RenewalCalendarEntry): RenewalAlert[] {
  if (entry.status === 'paid') return []
  const out: RenewalAlert[] = []
  if (entry.status === 'due_today' || entry.days_until_due === 0) {
    out.push({
      kind: 'due_today',
      chip_id: entry.chip_id,
      phone_number: entry.phone_number,
      carrier: entry.carrier,
      plan_name: entry.plan_name,
      monthly_cost_brl: entry.monthly_cost_brl,
      next_due_date: entry.next_due_date,
      days_until_due: entry.days_until_due,
      message: `Plano vence HOJE — ${entry.phone_number} (${entry.carrier} ${entry.plan_name}, R$ ${entry.monthly_cost_brl.toFixed(2)})`,
    })
  } else if (entry.days_until_due === 7) {
    out.push({
      kind: 'upcoming_7d',
      chip_id: entry.chip_id,
      phone_number: entry.phone_number,
      carrier: entry.carrier,
      plan_name: entry.plan_name,
      monthly_cost_brl: entry.monthly_cost_brl,
      next_due_date: entry.next_due_date,
      days_until_due: entry.days_until_due,
      message: `Plano vence em 7 dias — ${entry.phone_number} (${entry.carrier} ${entry.plan_name}, R$ ${entry.monthly_cost_brl.toFixed(2)})`,
    })
  } else if (entry.days_until_due === -5) {
    out.push({
      kind: 'overdue_5d',
      chip_id: entry.chip_id,
      phone_number: entry.phone_number,
      carrier: entry.carrier,
      plan_name: entry.plan_name,
      monthly_cost_brl: entry.monthly_cost_brl,
      next_due_date: entry.next_due_date,
      days_until_due: entry.days_until_due,
      message: `ATRASADO 5 DIAS — ${entry.phone_number} (${entry.carrier} ${entry.plan_name}, R$ ${entry.monthly_cost_brl.toFixed(2)})`,
    })
  }
  return out
}
