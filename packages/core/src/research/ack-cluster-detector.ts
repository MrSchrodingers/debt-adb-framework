import type Database from 'better-sqlite3'
import type { DispatchEmitter } from '../events/index.js'

export interface AckClusterDetectorConfig {
  /** Number of ack=-1 errors within `windowMs` that triggers a timelock. */
  clusterCount: number
  /** Sliding window (ms) for counting fresh errors per sender. */
  windowMs: number
  /** Duration (ms) of the timelock pause applied to a sender on trigger. */
  pauseMs: number
}

const DEFAULTS: AckClusterDetectorConfig = {
  clusterCount: 3,
  windowMs: 60_000,
  pauseMs: 300_000,
}

/**
 * AckClusterDetector — Reachout Timelock heuristic via WAHA ack errors.
 *
 * WAHA Plus (linked-device passive listener) surfaces `message.ack` webhooks
 * for every ack the phone sees on outgoing messages. When the WhatsApp server
 * rejects a message (Reachout Timelock / Error 463 / progressive enforcement)
 * the ack arrives with level=-1. A cluster of such errors in a short window
 * is a strong signal that the sender is under server-side rate limit, so we
 * pause it briefly to avoid burning more reputation.
 *
 * Detection: count ack=-1 per sender in a sliding window. When `clusterCount`
 * is reached, write `timelock_until = now + pauseMs` + `pause_reason` to
 * `sender_health` and emit `sender:timelock_suspected`. SenderHealth.isQuarantined
 * picks up the timelock column and skips dequeue while the pause is active.
 */
export class AckClusterDetector {
  private windows = new Map<string, number[]>()
  private config: AckClusterDetectorConfig

  constructor(
    private db: Database.Database,
    private emitter: DispatchEmitter,
    config?: Partial<AckClusterDetectorConfig>,
  ) {
    this.config = { ...DEFAULTS, ...config }
  }

  /**
   * Idempotent migration: adds `timelock_until` and `pause_reason` columns to
   * an existing `sender_health` table.
   */
  initialize(): void {
    const cols = this.db
      .prepare('PRAGMA table_info(sender_health)')
      .all() as Array<{ name: string }>
    const names = new Set(cols.map((c) => c.name))
    if (!names.has('timelock_until')) {
      this.db.exec('ALTER TABLE sender_health ADD COLUMN timelock_until TEXT')
    }
    if (!names.has('pause_reason')) {
      this.db.exec('ALTER TABLE sender_health ADD COLUMN pause_reason TEXT')
    }
  }

  recordAckError(senderPhone: string, observedAtMs: number = Date.now()): void {
    if (!senderPhone) return
    const cutoff = observedAtMs - this.config.windowMs
    const fresh = (this.windows.get(senderPhone) ?? []).filter((t) => t >= cutoff)
    fresh.push(observedAtMs)
    this.windows.set(senderPhone, fresh)

    if (fresh.length >= this.config.clusterCount) {
      const until = new Date(observedAtMs + this.config.pauseMs).toISOString()
      this.applyTimelock(senderPhone, until)
      this.windows.set(senderPhone, [])
    }
  }

  private applyTimelock(senderPhone: string, until: string): void {
    const now = new Date().toISOString()
    this.db
      .prepare(`
        INSERT INTO sender_health (sender_number, timelock_until, pause_reason, updated_at)
        VALUES (?, ?, 'timelock_suspected', ?)
        ON CONFLICT(sender_number) DO UPDATE SET
          timelock_until = excluded.timelock_until,
          pause_reason = 'timelock_suspected',
          updated_at = excluded.updated_at
      `)
      .run(senderPhone, until, now)

    this.emitter.emit('sender:timelock_suspected', {
      sender: senderPhone,
      timelockUntil: until,
      clusterCount: this.config.clusterCount,
      windowMs: this.config.windowMs,
    })
  }
}
