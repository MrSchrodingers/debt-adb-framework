export interface RateLimitConfig {
  /** Max messages per sender per day. Default: 150 */
  maxPerSenderPerDay: number
  /** Delay (ms) before sending to a first-time contact. Default: 45000 (45s) */
  firstContactDelayMs: number
  /** Delay (ms) between recurring contact messages. Default: 15000 (15s) */
  recurringContactDelayMs: number
  /** Jitter range (0-1) applied to delays. Default: 0.3 (±30%) */
  jitterRange: number
}

const DEFAULTS: RateLimitConfig = {
  maxPerSenderPerDay: 150,
  firstContactDelayMs: 45_000,
  recurringContactDelayMs: 15_000,
  jitterRange: 0.3,
}

export class RateLimitGuard {
  private config: RateLimitConfig

  constructor(config?: Partial<RateLimitConfig>) {
    this.config = { ...DEFAULTS, ...config }
  }

  static fromEnv(env: Record<string, string | undefined>): RateLimitGuard {
    return new RateLimitGuard({
      maxPerSenderPerDay: Number(env.MAX_PER_SENDER_PER_DAY) || DEFAULTS.maxPerSenderPerDay,
      firstContactDelayMs: Number(env.FIRST_CONTACT_DELAY_MS) || DEFAULTS.firstContactDelayMs,
      recurringContactDelayMs: Number(env.RECURRING_CONTACT_DELAY_MS) || DEFAULTS.recurringContactDelayMs,
      jitterRange: Number(env.RATE_LIMIT_JITTER) || DEFAULTS.jitterRange,
    })
  }

  canSend(currentDailyCount: number): boolean {
    return currentDailyCount < this.config.maxPerSenderPerDay
  }

  getInterMessageDelay(isFirstContact: boolean): number {
    const base = isFirstContact
      ? this.config.firstContactDelayMs
      : this.config.recurringContactDelayMs

    const jitter = base * this.config.jitterRange * (Math.random() * 2 - 1)
    return Math.round(Math.max(5_000, base + jitter))
  }

  get maxPerSenderPerDay(): number {
    return this.config.maxPerSenderPerDay
  }
}
