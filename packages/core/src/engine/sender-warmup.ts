import type Database from 'better-sqlite3'

export interface WarmupTier {
  tier: number
  minDays: number
  maxDays: number
  dailyCap: number
  firstContactDelayMs: number
  recurringContactDelayMs: number
}

const WARMUP_TIERS: WarmupTier[] = [
  { tier: 1, minDays: 0, maxDays: 2, dailyCap: 20, firstContactDelayMs: 90_000, recurringContactDelayMs: 60_000 },
  { tier: 2, minDays: 3, maxDays: 6, dailyCap: 50, firstContactDelayMs: 60_000, recurringContactDelayMs: 45_000 },
  { tier: 3, minDays: 7, maxDays: 13, dailyCap: 100, firstContactDelayMs: 45_000, recurringContactDelayMs: 30_000 },
  { tier: 4, minDays: 14, maxDays: Infinity, dailyCap: 150, firstContactDelayMs: 45_000, recurringContactDelayMs: 15_000 },
]

export class SenderWarmup {
  constructor(private db: Database.Database) {}

  /** Ensure sender has a warmup record. Called on first message. */
  activateSender(senderNumber: string): void {
    this.db.prepare(
      'INSERT OR IGNORE INTO sender_warmup (sender_number, activated_at) VALUES (?, ?)'
    ).run(senderNumber, new Date().toISOString())
  }

  /** Skip warmup for migrated/experienced senders */
  skipWarmup(senderNumber: string): void {
    this.activateSender(senderNumber)
    this.db.prepare(
      'UPDATE sender_warmup SET skipped = 1, skipped_at = ? WHERE sender_number = ?'
    ).run(new Date().toISOString(), senderNumber)
  }

  /** Get the current warmup tier for a sender */
  getTier(senderNumber: string): WarmupTier {
    const row = this.db.prepare(
      'SELECT activated_at, skipped FROM sender_warmup WHERE sender_number = ?'
    ).get(senderNumber) as { activated_at: string; skipped: number } | undefined

    if (!row) {
      // Not activated yet — return tier 1
      return WARMUP_TIERS[0]
    }

    if (row.skipped) {
      // Skipped warmup — return tier 4 (full cap)
      return WARMUP_TIERS[WARMUP_TIERS.length - 1]
    }

    const daysSinceActivation = Math.floor(
      (Date.now() - new Date(row.activated_at).getTime()) / (24 * 60 * 60 * 1000)
    )

    for (const tier of WARMUP_TIERS) {
      if (daysSinceActivation >= tier.minDays && daysSinceActivation <= tier.maxDays) {
        return tier
      }
    }

    return WARMUP_TIERS[WARMUP_TIERS.length - 1]
  }

  /** Get effective daily cap considering warmup */
  getEffectiveDailyCap(senderNumber: string): number {
    return this.getTier(senderNumber).dailyCap
  }

  /** Get effective delays considering warmup */
  getEffectiveDelays(senderNumber: string): { firstContactDelayMs: number; recurringContactDelayMs: number } {
    const tier = this.getTier(senderNumber)
    return {
      firstContactDelayMs: tier.firstContactDelayMs,
      recurringContactDelayMs: tier.recurringContactDelayMs,
    }
  }
}
