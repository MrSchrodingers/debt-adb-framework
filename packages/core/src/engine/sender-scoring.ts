import type Database from 'better-sqlite3'
import type { SenderHealth, SenderHealthStatus } from './sender-health.js'

// ── Role priority weights ────────────────────────────────────────────────────

const DEFAULT_ROLE_WEIGHTS: Record<'primary' | 'overflow' | 'backup' | 'reserve', number> = {
  primary: 1.0,
  overflow: 0.7,
  backup: 0.5,
  reserve: 0.3,
}

const DEFAULT_FAILURE_PENALTY = 1.0
const DEFAULT_IDLE_SATURATION_SEC = 3600

// ── Public interfaces ────────────────────────────────────────────────────────

export interface SenderScoringConfig {
  /**
   * Weight assigned per role (primary/overflow/backup/reserve).
   * Override any subset — unspecified roles fall back to defaults.
   */
  rolePriorityWeights?: Partial<Record<'primary' | 'overflow' | 'backup' | 'reserve', number>>
  /**
   * Controls how aggressively recent failures penalise a sender.
   * Passed into the consecutive-failure factor:
   *   1 / (1 + consecutive_failures^2 * failurePenalty)
   * Quadratic so a single failure is mild, but a streak bites hard.
   * Default: 1.0.
   */
  failurePenalty?: number
  /**
   * Seconds of idle time at which the time-since-last-send factor saturates
   * to 1.0 — no further boost for longer idle windows.
   * Default: 3600 (1 hour).
   */
  idleSaturationSec?: number
  /**
   * Injected clock for deterministic tests. Default: () => Date.now().
   */
  now?: () => number
}

export interface SenderCandidate {
  /** Digits-only sender phone number. */
  phone: string
  /** Role as declared in SenderConfig. */
  role: 'primary' | 'overflow' | 'backup' | 'reserve'
  /**
   * Pre-fetched health stats. Pass to avoid an extra DB read.
   * If null/undefined and the DB has no row, treated as brand-new (factors = 1.0).
   */
  health?: SenderHealthStatus | null
  /**
   * Pre-fetched last-send timestamp (ISO-8601).
   * null = never sent => idle factor = 1.0.
   */
  lastSendAt?: string | null
}

export interface ScoredSender {
  candidate: SenderCandidate
  score: number
  breakdown: {
    healthScore: number
    inverseRecentFailures: number
    timeSinceLastSendFactor: number
    pluginPriorityWeight: number
  }
}

// ── SenderScoring ────────────────────────────────────────────────────────────

/**
 * Computes a multiplicative score for each candidate sender:
 *
 *   score = healthScore x inverseRecentFailures x timeSinceLastSendFactor x pluginPriorityWeight
 *
 * Factor definitions
 * ──────────────────
 * healthScore:
 *   1 / (1 + totalFailures * failurePenalty / max(1, totalFailures + totalSuccesses))
 *   Penalises historically bad senders proportionally to their all-time failure rate.
 *
 * inverseRecentFailures (quadratic):
 *   1 / (1 + consecutive_failures^2 * failurePenalty)
 *   Punishes current failure streaks. 0 failures -> 1.0; 1 -> ~0.5; 3 -> ~0.1.
 *   Quadratic chosen over linear so a single failure barely bites while 3+ are hard-penalised.
 *
 * timeSinceLastSendFactor:
 *   min(secondsIdle / idleSaturationSec, 1.0)
 *   Spreads load: idle senders score higher. Saturates at 1 h by default.
 *   Never-sent senders -> 1.0 (max idle).
 *
 * pluginPriorityWeight:
 *   Configurable per role. Defaults: primary 1.0 / overflow 0.7 / backup 0.5 / reserve 0.3.
 *
 * Quarantined senders receive score = 0 (hard filter).
 * Paused senders must be filtered before building candidates (paused === 1 -> skip).
 *
 * Schema addition: last_send_at
 * ──────────────────────────────
 * initialize() adds last_send_at TEXT to sender_health via PRAGMA-guarded ALTER TABLE.
 * recordSend(phone) writes it after every successful dispatch (called by resolveSenderChain).
 */
export class SenderScoring {
  private readonly roleWeights: Record<'primary' | 'overflow' | 'backup' | 'reserve', number>
  private readonly failurePenalty: number
  private readonly idleSaturationSec: number
  private readonly now: () => number

  constructor(
    private readonly senderHealth: SenderHealth,
    private readonly db: Database.Database,
    config: SenderScoringConfig = {},
  ) {
    this.roleWeights = {
      ...DEFAULT_ROLE_WEIGHTS,
      ...(config.rolePriorityWeights ?? {}),
    }
    this.failurePenalty = config.failurePenalty ?? DEFAULT_FAILURE_PENALTY
    this.idleSaturationSec = config.idleSaturationSec ?? DEFAULT_IDLE_SATURATION_SEC
    this.now = config.now ?? (() => Date.now())
  }

  /**
   * Idempotently add last_send_at column to sender_health.
   * Safe to call multiple times.
   */
  initialize(): void {
    const cols = this.db.prepare('PRAGMA table_info(sender_health)').all() as { name: string }[]
    if (!cols.some(c => c.name === 'last_send_at')) {
      this.db.exec('ALTER TABLE sender_health ADD COLUMN last_send_at TEXT')
    }
  }

  /**
   * Record that a send was dispatched via the given phone number.
   * Writes last_send_at in sender_health so the idle factor stays accurate.
   */
  recordSend(phone: string): void {
    const now = new Date(this.now()).toISOString()
    this.db.prepare(`
      INSERT INTO sender_health (sender_number, last_send_at, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(sender_number) DO UPDATE SET
        last_send_at = excluded.last_send_at,
        updated_at   = excluded.updated_at
    `).run(phone, now, now)
  }

  /**
   * Score a single candidate. Returns score=0 when quarantined.
   */
  scoreSender(candidate: SenderCandidate): ScoredSender {
    if (this.senderHealth.isQuarantined(candidate.phone)) {
      return {
        candidate,
        score: 0,
        breakdown: {
          healthScore: 0,
          inverseRecentFailures: 0,
          timeSinceLastSendFactor: 0,
          pluginPriorityWeight: this.roleWeights[candidate.role],
        },
      }
    }

    const health = candidate.health !== undefined
      ? candidate.health
      : this.senderHealth.getStatus(candidate.phone)

    const lastSendAt = candidate.lastSendAt !== undefined
      ? candidate.lastSendAt
      : this.fetchLastSendAt(candidate.phone)

    const healthScore = this.computeHealthScore(health)
    const inverseRecentFailures = this.computeInverseRecentFailures(health)
    const timeSinceLastSendFactor = this.computeTimeFactor(lastSendAt)
    const pluginPriorityWeight = this.roleWeights[candidate.role]

    const score = healthScore * inverseRecentFailures * timeSinceLastSendFactor * pluginPriorityWeight

    return {
      candidate,
      score,
      breakdown: {
        healthScore,
        inverseRecentFailures,
        timeSinceLastSendFactor,
        pluginPriorityWeight,
      },
    }
  }

  /**
   * Score every candidate and return them sorted descending.
   * Quarantined senders (score = 0) are excluded from the result.
   */
  scoreChain(candidates: SenderCandidate[]): ScoredSender[] {
    return candidates
      .map(c => this.scoreSender(c))
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
  }

  /**
   * Pick the highest-scoring sender. Returns null if all are filtered out.
   */
  pickBest(candidates: SenderCandidate[]): ScoredSender | null {
    const ranked = this.scoreChain(candidates)
    return ranked[0] ?? null
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Historical failure-rate factor.
   * 1 / (1 + totalFailures * failurePenalty / max(1, total))
   */
  private computeHealthScore(health: SenderHealthStatus | null): number {
    if (!health) return 1.0
    const total = health.totalFailures + health.totalSuccesses
    if (total === 0) return 1.0
    return 1 / (1 + (health.totalFailures * this.failurePenalty) / Math.max(1, total))
  }

  /**
   * Recent-streak penalty (quadratic).
   * 1 / (1 + consecutive_failures^2 * failurePenalty)
   */
  private computeInverseRecentFailures(health: SenderHealthStatus | null): number {
    if (!health) return 1.0
    const cf = health.consecutiveFailures
    return 1 / (1 + cf * cf * this.failurePenalty)
  }

  /**
   * Idle-time factor capped at 1.0.
   */
  private computeTimeFactor(lastSendAt: string | null): number {
    if (!lastSendAt) return 1.0
    const secondsIdle = (this.now() - new Date(lastSendAt).getTime()) / 1000
    return Math.min(secondsIdle / this.idleSaturationSec, 1.0)
  }

  private fetchLastSendAt(phone: string): string | null {
    const row = this.db.prepare(
      'SELECT last_send_at FROM sender_health WHERE sender_number = ?',
    ).get(phone) as { last_send_at: string | null } | undefined
    return row?.last_send_at ?? null
  }
}
