/**
 * QualityWatcher — periodic recompute of composite quality score per sender.
 *
 * On each tick:
 *   1. List active senders.
 *   2. For each: compose inputs → score → persist sample.
 *   3. Check thresholds:
 *        - absolute: score < cfg.absolute → pause + alert kind='low_score'
 *        - rapid drop: score - score(24h ago) <= cfg.deltaWindow24h → pause + alert 'rapid_decline'
 *   4. Skip pause/alert when sender is already paused (idempotency).
 *
 * Composer/pauseSender/alert are dependency-injected so the watcher remains
 * testable without a Fastify server, ADB, or Telegram tokens.
 */

import type { QualityHistory } from './quality-history.js'
import type { QualityScoreInputs } from './quality-score.js'
import { computeQualityScore } from './quality-score.js'
import { msToSqliteDatetime } from './sqlite-datetime.js'

export const QUALITY_AUDIT_ACTIONS = {
  lowScore: 'quality.auto_pause.low_score',
  rapidDecline: 'quality.auto_pause.rapid_decline',
} as const

export interface QualityThresholds {
  /** Pause when score < absolute. */
  absolute: number
  /** Pause when (current - past24h) <= deltaWindow24h. Negative number. */
  deltaWindow24h: number
}

export interface QualityAlertEvent {
  kind: 'low_score' | 'rapid_decline'
  senderPhone: string
  total: number
  previousTotal?: number
  reason: string
}

export interface WatcherDeps {
  history: QualityHistory
  composer: (senderPhone: string) => QualityScoreInputs
  listSenders: () => string[]
  pauseSender: (phone: string, reason: string) => void
  isPaused: (phone: string) => boolean
  alert: (event: QualityAlertEvent) => void
  thresholds: QualityThresholds
  logger?: { warn: (msg: string, ctx?: unknown) => void; info?: (msg: string, ctx?: unknown) => void }
  /** Optional audit hook — invoked once per pause action with full context. */
  audit?: (entry: { action: string; senderPhone: string; total: number; previousTotal?: number; reason: string }) => void
}

export class QualityWatcher {
  constructor(private readonly deps: WatcherDeps) {}

  tick(now: Date = new Date()): void {
    const senders = this.deps.listSenders()
    for (const sender of senders) {
      this.processSender(sender, now)
    }
  }

  private processSender(senderPhone: string, now: Date): void {
    let inputs: QualityScoreInputs
    try {
      inputs = this.deps.composer(senderPhone)
    } catch (err) {
      this.deps.logger?.warn('quality-watcher: composer failed', { senderPhone, err: String(err) })
      return
    }

    const result = computeQualityScore(inputs)

    const past = this.deps.history.sampleAtOrBefore(
      senderPhone,
      msToSqliteDatetime(now.getTime() - 24 * 3_600_000),
    )

    const latest = this.deps.history.latest(senderPhone)
    if (!latest || latest.total !== result.total) {
      this.deps.history.record({
        senderPhone,
        total: result.total,
        components: result.components,
      })
    }

    if (this.deps.isPaused(senderPhone)) {
      return
    }

    if (result.total < this.deps.thresholds.absolute) {
      const reason = `quality score ${result.total} < threshold ${this.deps.thresholds.absolute}`
      this.deps.pauseSender(senderPhone, reason)
      this.deps.alert({
        kind: 'low_score',
        senderPhone,
        total: result.total,
        previousTotal: past?.total,
        reason,
      })
      this.deps.audit?.({
        action: QUALITY_AUDIT_ACTIONS.lowScore,
        senderPhone,
        total: result.total,
        previousTotal: past?.total,
        reason,
      })
      return
    }

    if (past) {
      const delta = result.total - past.total
      if (delta <= this.deps.thresholds.deltaWindow24h) {
        const reason = `quality score Δ ${delta} in 24h (now=${result.total} prev=${past.total})`
        this.deps.pauseSender(senderPhone, reason)
        this.deps.alert({
          kind: 'rapid_decline',
          senderPhone,
          total: result.total,
          previousTotal: past.total,
          reason,
        })
        this.deps.audit?.({
          action: QUALITY_AUDIT_ACTIONS.rapidDecline,
          senderPhone,
          total: result.total,
          previousTotal: past.total,
          reason,
        })
      }
    }
  }
}
