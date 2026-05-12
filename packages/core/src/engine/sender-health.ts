import type Database from 'better-sqlite3'
import type { DispatchEmitter } from '../events/index.js'

export interface SenderHealthConfig {
  quarantineAfterFailures: number
  quarantineDurationMs: number
}

export interface SenderHealthStatus {
  consecutiveFailures: number
  quarantinedUntil: string | null
  /** Set when NEW-2 ack-cluster detector pauses the sender (ack=-1 cluster). */
  timelockUntil: string | null
  /** 'timelock_suspected' when the timelock path fired; null otherwise. */
  pauseReason: string | null
  totalFailures: number
  totalSuccesses: number
}

const DEFAULTS: SenderHealthConfig = {
  quarantineAfterFailures: 3,
  quarantineDurationMs: 3_600_000, // 1 hour
}

export class SenderHealth {
  private config: SenderHealthConfig

  constructor(
    private db: Database.Database,
    config?: Partial<SenderHealthConfig>,
    private emitter?: DispatchEmitter,
  ) {
    this.config = { ...DEFAULTS, ...config }
  }

  recordSuccess(sender: string): void {
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO sender_health (sender_number, consecutive_failures, total_successes, last_success_at, updated_at)
      VALUES (?, 0, 1, ?, ?)
      ON CONFLICT(sender_number) DO UPDATE SET
        consecutive_failures = 0,
        total_successes = total_successes + 1,
        last_success_at = excluded.last_success_at,
        updated_at = excluded.updated_at
    `).run(sender, now, now)
  }

  recordFailure(sender: string): void {
    const now = new Date().toISOString()
    // First do the UPSERT to increment failure counts
    this.db.prepare(`
      INSERT INTO sender_health (sender_number, consecutive_failures, total_failures, last_failure_at, updated_at)
      VALUES (?, 1, 1, ?, ?)
      ON CONFLICT(sender_number) DO UPDATE SET
        consecutive_failures = consecutive_failures + 1,
        total_failures = total_failures + 1,
        last_failure_at = excluded.last_failure_at,
        updated_at = excluded.updated_at
    `).run(sender, now, now)

    // Then check if quarantine threshold is reached and set quarantined_until
    const row = this.db.prepare(
      'SELECT consecutive_failures FROM sender_health WHERE sender_number = ?',
    ).get(sender) as { consecutive_failures: number } | undefined

    if (row && row.consecutive_failures >= this.config.quarantineAfterFailures) {
      const quarantinedUntil = new Date(Date.now() + this.config.quarantineDurationMs).toISOString()
      this.db.prepare(
        'UPDATE sender_health SET quarantined_until = ?, updated_at = ? WHERE sender_number = ?',
      ).run(quarantinedUntil, now, sender)
      this.emitter?.emit('sender:quarantined', {
        sender,
        failureCount: row.consecutive_failures,
        quarantinedUntil,
      })
    }
  }

  isQuarantined(sender: string): boolean {
    const row = this.db.prepare(
      'SELECT quarantined_until, timelock_until FROM sender_health WHERE sender_number = ?',
    ).get(sender) as
      | { quarantined_until: string | null; timelock_until: string | null }
      | undefined

    if (!row) return false

    const now = new Date().toISOString()
    let stillPaused = false

    // Path 1: consecutive_failures quarantine (existing flow)
    if (row.quarantined_until) {
      if (row.quarantined_until > now) {
        stillPaused = true
      } else {
        // Quarantine expired — clear it
        this.db.prepare(`
          UPDATE sender_health
          SET consecutive_failures = 0, quarantined_until = NULL, updated_at = ?
          WHERE sender_number = ? AND quarantined_until IS NOT NULL AND quarantined_until <= ?
        `).run(now, sender, now)
        const quarantineStart =
          new Date(row.quarantined_until).getTime() - this.config.quarantineDurationMs
        const actualMs = Date.now() - quarantineStart
        this.emitter?.emit('sender:released', {
          sender,
          quarantineDurationActualMs: actualMs,
        })
      }
    }

    // Path 2: timelock (ack-cluster path, written by AckClusterDetector)
    if (row.timelock_until) {
      if (row.timelock_until > now) {
        stillPaused = true
      } else {
        this.db.prepare(`
          UPDATE sender_health
          SET timelock_until = NULL, pause_reason = NULL, updated_at = ?
          WHERE sender_number = ? AND timelock_until IS NOT NULL AND timelock_until <= ?
        `).run(now, sender, now)
        this.emitter?.emit('sender:timelock_released', { sender })
      }
    }

    return stillPaused
  }

  getStatus(sender: string): SenderHealthStatus | null {
    const row = this.db.prepare(
      'SELECT consecutive_failures, quarantined_until, timelock_until, pause_reason, total_failures, total_successes FROM sender_health WHERE sender_number = ?',
    ).get(sender) as {
      consecutive_failures: number
      quarantined_until: string | null
      timelock_until: string | null
      pause_reason: string | null
      total_failures: number
      total_successes: number
    } | undefined

    if (!row) return null

    return {
      consecutiveFailures: row.consecutive_failures,
      quarantinedUntil: row.quarantined_until,
      timelockUntil: row.timelock_until,
      pauseReason: row.pause_reason,
      totalFailures: row.total_failures,
      totalSuccesses: row.total_successes,
    }
  }
}
