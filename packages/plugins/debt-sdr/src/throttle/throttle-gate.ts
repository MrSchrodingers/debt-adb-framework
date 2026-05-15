import type Database from 'better-sqlite3'

export type GateDecision =
  | { allowed: true }
  | { allowed: false; reason: 'outside_hours'; next_eligible_at: string }
  | { allowed: false; reason: 'min_interval'; next_eligible_at: string }
  | { allowed: false; reason: 'daily_max'; next_eligible_at: string }

export interface ThrottleConfig {
  per_sender_daily_max: number
  min_interval_minutes: number
  operating_hours: { start: string; end: string }
  tz: string
}

export interface ThrottleGateDeps {
  /** Returns now() in ms — override for deterministic tests. */
  now?: () => number
  /** Override for tests that inject a clock. */
  formatInTz?: (ms: number, tz: string) => { hhmm: string; ymd: string; iso: string }
}

/**
 * Throttle gate — last guard before enqueue.
 *
 * Rules (per spec §5.1 throttle block):
 *   1. operating_hours[start, end] in tenant.tz (HH:MM 24h)
 *   2. per_sender_daily_max — count `sent`+`locked`+`sending` rows for
 *      sender_number on the current local date (tenant.tz day boundary)
 *   3. min_interval_minutes — last `sent_at` for sender plus interval
 *
 * Resolution order: outside_hours first (most blocking), then
 * daily_max, then min_interval. Returns a `next_eligible_at` ISO so
 * the sequencer can schedule re-tries deterministically.
 *
 * Reads only from the core `messages` table — no SDR-private state.
 * This keeps the gate composable: same throttle applies whether the
 * caller is SDR or a future plugin.
 */
export class ThrottleGate {
  private readonly now: () => number
  private readonly formatInTz: (ms: number, tz: string) => { hhmm: string; ymd: string; iso: string }

  constructor(
    private readonly db: Database.Database,
    deps: ThrottleGateDeps = {},
  ) {
    this.now = deps.now ?? (() => Date.now())
    this.formatInTz = deps.formatInTz ?? defaultFormatInTz
  }

  check(senderPhone: string, config: ThrottleConfig): GateDecision {
    const nowMs = this.now()
    const { hhmm, ymd } = this.formatInTz(nowMs, config.tz)

    // 1. Operating hours.
    if (hhmm < config.operating_hours.start || hhmm >= config.operating_hours.end) {
      const next = this.nextOpeningIso(nowMs, config)
      return { allowed: false, reason: 'outside_hours', next_eligible_at: next }
    }

    // 2. Daily max — count sends in current local date for this sender.
    const sentToday = this.countSentToday(senderPhone, ymd, config.tz)
    if (sentToday >= config.per_sender_daily_max) {
      const next = this.nextOpeningIso(nowMs + 24 * 60 * 60 * 1000, config)
      return { allowed: false, reason: 'daily_max', next_eligible_at: next }
    }

    // 3. Min interval.
    const lastSent = this.lastSentAt(senderPhone)
    if (lastSent) {
      const minIntervalMs = config.min_interval_minutes * 60 * 1000
      const since = nowMs - Date.parse(lastSent)
      if (since < minIntervalMs) {
        const next = new Date(Date.parse(lastSent) + minIntervalMs).toISOString()
        return { allowed: false, reason: 'min_interval', next_eligible_at: next }
      }
    }

    return { allowed: true }
  }

  private countSentToday(senderPhone: string, ymd: string, tz: string): number {
    // Rough bounds in UTC: start/end of local day. We accept that the
    // count may be ±1 across DST boundaries — daily_max is a soft cap,
    // not a contract.
    const [y, m, d] = ymd.split('-').map(Number)
    const startUtcMs = utcMsAtLocalMidnight(y, m, d, tz)
    const endUtcMs = startUtcMs + 24 * 60 * 60 * 1000
    const startIso = new Date(startUtcMs).toISOString()
    const endIso = new Date(endUtcMs).toISOString()
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM messages
          WHERE sender_number = ?
            AND status IN ('sent','locked','sending')
            AND COALESCE(sent_at, updated_at) >= ?
            AND COALESCE(sent_at, updated_at) <  ?`,
      )
      .get(senderPhone, startIso, endIso) as { n: number }
    return row.n
  }

  private lastSentAt(senderPhone: string): string | null {
    const row = this.db
      .prepare(
        `SELECT MAX(COALESCE(sent_at, updated_at)) AS last_sent
           FROM messages
          WHERE sender_number = ? AND status = 'sent'`,
      )
      .get(senderPhone) as { last_sent: string | null }
    return row?.last_sent ?? null
  }

  private nextOpeningIso(fromMs: number, config: ThrottleConfig): string {
    const [openH, openM] = config.operating_hours.start.split(':').map(Number)
    const { hhmm, ymd } = this.formatInTz(fromMs, config.tz)
    const [y, m, d] = ymd.split('-').map(Number)
    const nextDayMs =
      hhmm >= config.operating_hours.end || hhmm < config.operating_hours.start
        ? hhmm >= config.operating_hours.end
          ? utcMsAtLocalTime(y, m, d, openH, openM, config.tz) + 24 * 60 * 60 * 1000
          : utcMsAtLocalTime(y, m, d, openH, openM, config.tz)
        : fromMs
    return new Date(nextDayMs).toISOString()
  }
}

// ── helpers ────────────────────────────────────────────────────────────

function defaultFormatInTz(ms: number, tz: string): { hhmm: string; ymd: string; iso: string } {
  // Use Intl.DateTimeFormat with explicit parts so we don't have to
  // shell out to a real tz library. Fine for fixed offsets like
  // America/Sao_Paulo where DST isn't observed in 2026+.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  const parts = fmt.formatToParts(new Date(ms))
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  const ymd = `${get('year')}-${get('month')}-${get('day')}`
  const hhmm = `${get('hour')}:${get('minute')}`
  return { hhmm, ymd, iso: new Date(ms).toISOString() }
}

function utcMsAtLocalTime(y: number, m: number, d: number, hh: number, mm: number, tz: string): number {
  // Compute UTC ms that corresponds to local midnight + (hh, mm) in tz.
  // We do a binary-search-free trick: render the supposed UTC ms back
  // through Intl and adjust.
  const guess = Date.UTC(y, m - 1, d, hh, mm)
  const offsetMin = tzOffsetMinutes(guess, tz)
  return guess + offsetMin * 60 * 1000
}

function utcMsAtLocalMidnight(y: number, m: number, d: number, tz: string): number {
  return utcMsAtLocalTime(y, m, d, 0, 0, tz)
}

function tzOffsetMinutes(utcMs: number, tz: string): number {
  // tz offset in minutes from UTC for the given timezone at the given
  // utcMs. America/Sao_Paulo is -03:00 (no DST since 2019).
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    timeZoneName: 'shortOffset',
  })
  const parts = fmt.formatToParts(new Date(utcMs))
  const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT'
  const match = name.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/)
  if (!match) return 0
  const sign = match[1] === '-' ? 1 : -1
  const h = parseInt(match[2], 10)
  const min = match[3] ? parseInt(match[3], 10) : 0
  return sign * (h * 60 + min)
}
