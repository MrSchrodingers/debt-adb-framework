export interface SendWindowConfig {
  /** Hour (0-23) when window opens. Default: 7 */
  start: number
  /** Hour (0-23) when window closes. Default: 21 */
  end: number
  /** Comma-separated day numbers (1=Mon, 7=Sun). Default: '1,2,3,4,5' */
  days: string
  /** UTC offset in hours. Default: -3 (BRT) */
  utcOffsetHours: number
}

const DEFAULTS: SendWindowConfig = {
  start: 7,
  end: 21,
  days: '1,2,3,4,5',
  utcOffsetHours: -3,
}

export class SendWindow {
  private readonly config: SendWindowConfig
  private readonly allowedDays: Set<number>
  private readonly crossesMidnight: boolean

  constructor(config?: Partial<SendWindowConfig>) {
    this.config = { ...DEFAULTS, ...config }
    this.allowedDays = new Set(
      this.config.days
        .split(',')
        .map((d) => Number(d.trim()))
        .filter((d) => d >= 1 && d <= 7),
    )
    this.crossesMidnight = this.config.start >= this.config.end
  }

  /**
   * Get current local hour and day-of-week based on UTC offset.
   * Day-of-week uses ISO convention: 1=Mon, 7=Sun.
   */
  private getLocalTime(now = new Date()): { hour: number; minute: number; dayOfWeek: number } {
    const utcHours = now.getUTCHours()
    const utcMinutes = now.getUTCMinutes()
    const totalMinutes = utcHours * 60 + utcMinutes + this.config.utcOffsetHours * 60

    // Handle day rollover
    let adjustedMinutes = totalMinutes
    let dayOffset = 0
    if (adjustedMinutes < 0) {
      dayOffset = -1
      adjustedMinutes += 24 * 60
    } else if (adjustedMinutes >= 24 * 60) {
      dayOffset = 1
      adjustedMinutes -= 24 * 60
    }

    const hour = Math.floor(adjustedMinutes / 60)
    const minute = adjustedMinutes % 60

    // JS getUTCDay: 0=Sun, 1=Mon, ..., 6=Sat
    // Convert to ISO: 1=Mon, 7=Sun
    let jsDay = now.getUTCDay() + dayOffset
    if (jsDay < 0) jsDay += 7
    if (jsDay > 6) jsDay -= 7
    const dayOfWeek = jsDay === 0 ? 7 : jsDay

    return { hour, minute, dayOfWeek }
  }

  /**
   * Returns true if the send window is currently open.
   * For midnight-crossing windows (e.g., start=22, end=6):
   *   - open if hour >= start OR hour < end (on an allowed day)
   */
  isOpen(now?: Date): boolean {
    const { hour, dayOfWeek } = this.getLocalTime(now)

    if (this.crossesMidnight) {
      // For midnight-crossing, the "start" day is the day the window opens.
      // At hour >= start, we check dayOfWeek (the evening day).
      // At hour < end, we check the previous day's dayOfWeek since the window
      // started the day before. For simplicity, check current day for both halves
      // since the worker runs on the day when the work is happening.
      if (hour >= this.config.start) {
        return this.allowedDays.has(dayOfWeek)
      }
      if (hour < this.config.end) {
        // We're in the early morning — the window opened the previous day.
        // Check if the previous day was allowed.
        const prevDay = dayOfWeek === 1 ? 7 : dayOfWeek - 1
        return this.allowedDays.has(prevDay)
      }
      return false
    }

    if (!this.allowedDays.has(dayOfWeek)) return false
    return hour >= this.config.start && hour < this.config.end
  }

  /**
   * Returns the Date when the window will next be open.
   * If the window is currently open, returns `now`.
   */
  nextOpenAt(now?: Date): Date {
    const current = now ?? new Date()

    if (this.isOpen(current)) return current

    const local = this.getLocalTime(current)

    // If today is an allowed day and we haven't reached start yet, open is today at start
    if (this.allowedDays.has(local.dayOfWeek) && local.hour < this.config.start) {
      // For midnight-crossing windows, start is always in the evening so this still works
      return this.buildDate(current, 0, this.config.start)
    }

    // Find the next allowed day (starting from tomorrow)
    for (let offset = 1; offset <= 7; offset++) {
      let nextDayIso = ((local.dayOfWeek - 1 + offset) % 7) + 1 // 1-based ISO
      if (this.allowedDays.has(nextDayIso)) {
        return this.buildDate(current, offset, this.config.start)
      }
    }

    // Fallback — should not reach if at least one day is allowed
    return this.buildDate(current, 1, this.config.start)
  }

  /**
   * Returns milliseconds until the window opens. 0 if currently open.
   */
  msUntilOpen(now?: Date): number {
    if (this.isOpen(now)) return 0
    const next = this.nextOpenAt(now)
    const current = now ?? new Date()
    return Math.max(0, next.getTime() - current.getTime())
  }

  /**
   * Build a Date at `targetLocalHour` (in the configured timezone),
   * `dayOffset` local calendar days from `base`.
   *
   * We first compute the local midnight of the base date, then add
   * dayOffset days and the target hour — all in UTC arithmetic.
   * This avoids drift when the UTC day differs from the local day.
   */
  private buildDate(base: Date, dayOffset: number, targetLocalHour: number): Date {
    // Compute local midnight of `base` in UTC terms
    const localMidnightUtcHour = -this.config.utcOffsetHours // e.g., BRT(-3) => 3:00 UTC is local midnight
    const localMidnight = new Date(base)

    // Determine whether the base's UTC time is before local midnight
    // (meaning in local terms it's still the previous day)
    const baseTotalMinutesLocal =
      base.getUTCHours() * 60 + base.getUTCMinutes() + this.config.utcOffsetHours * 60
    if (baseTotalMinutesLocal < 0) {
      // Local date is one day behind UTC date — local midnight is the previous UTC day
      localMidnight.setUTCDate(localMidnight.getUTCDate() - 1)
    } else if (baseTotalMinutesLocal >= 24 * 60) {
      // Local date is one day ahead of UTC date
      localMidnight.setUTCDate(localMidnight.getUTCDate() + 1)
    }
    localMidnight.setUTCHours(localMidnightUtcHour, 0, 0, 0)

    // Add day offset and target hour
    const result = new Date(localMidnight.getTime())
    result.setUTCDate(result.getUTCDate() + dayOffset)
    result.setUTCHours(result.getUTCHours() + targetLocalHour)
    return result
  }
}
