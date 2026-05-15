import type Database from 'better-sqlite3'
import { ulid } from 'ulid'

export type WritebackAction = 'update_stage' | 'create_activity' | 'add_note'

export interface PendingWriteback {
  id: string
  tenant: string
  lead_id: string
  action: WritebackAction
  payload_json: string
  attempts: number
  last_error: string | null
  next_attempt_at: string
  abandoned_at: string | null
  created_at: string
  updated_at: string
}

export interface EnqueueParams {
  tenant: string
  leadId: string
  action: WritebackAction
  payload: Record<string, unknown>
}

/**
 * Pending Pipedrive writeback queue. The response handler enqueues
 * (action, payload) when the live Pipedrive call fails (5xx after
 * retries, timeout, etc). A separate retry cron drains rows whose
 * `next_attempt_at` has elapsed, applying exponential backoff up to a
 * configurable max attempts before marking `abandoned_at`.
 *
 * Backoff schedule (minutes from last attempt): 1, 5, 15, 60, 240.
 * 5 retries total — the 6th failure abandons. ~4h total retry window.
 */
const BACKOFF_MIN = [1, 5, 15, 60, 240] as const

export class PendingWritebacks {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number = () => Date.now(),
  ) {}

  enqueue(params: EnqueueParams): string {
    const id = ulid()
    const nowIso = new Date(this.now()).toISOString()
    this.db
      .prepare(
        `INSERT INTO sdr_pending_writebacks
           (id, tenant, lead_id, action, payload_json, attempts, next_attempt_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      )
      .run(
        id,
        params.tenant,
        params.leadId,
        params.action,
        JSON.stringify(params.payload),
        nowIso,
        nowIso,
        nowIso,
      )
    return id
  }

  /** Returns rows ready to retry, ordered by oldest first. */
  duePending(limit = 50): PendingWriteback[] {
    const nowIso = new Date(this.now()).toISOString()
    return this.db
      .prepare(
        `SELECT * FROM sdr_pending_writebacks
          WHERE abandoned_at IS NULL AND next_attempt_at <= ?
          ORDER BY next_attempt_at ASC
          LIMIT ?`,
      )
      .all(nowIso, limit) as PendingWriteback[]
  }

  recordSuccess(id: string): void {
    // Success → just delete; we don't keep history here (the audit log
    // captures the final state).
    this.db.prepare(`DELETE FROM sdr_pending_writebacks WHERE id = ?`).run(id)
  }

  recordFailure(id: string, error: string): { abandoned: boolean; nextAttemptAt: string } {
    const row = this.db
      .prepare(`SELECT attempts FROM sdr_pending_writebacks WHERE id = ?`)
      .get(id) as { attempts: number } | undefined
    if (!row) return { abandoned: false, nextAttemptAt: new Date(this.now()).toISOString() }

    // Backoff slot = number of failures already on this row. First
    // failure → slot 0 (1 min wait), 2nd → slot 1 (5 min), ...
    const slot = row.attempts
    const nextAttempts = row.attempts + 1
    if (slot >= BACKOFF_MIN.length) {
      // Out of retries — abandon.
      const nowIso = new Date(this.now()).toISOString()
      this.db
        .prepare(
          `UPDATE sdr_pending_writebacks
              SET attempts = ?,
                  last_error = ?,
                  abandoned_at = ?,
                  updated_at = ?
            WHERE id = ?`,
        )
        .run(nextAttempts, error, nowIso, nowIso, id)
      return { abandoned: true, nextAttemptAt: nowIso }
    }

    const nextMs = this.now() + BACKOFF_MIN[slot] * 60 * 1000
    const nextIso = new Date(nextMs).toISOString()
    this.db
      .prepare(
        `UPDATE sdr_pending_writebacks
            SET attempts = ?, last_error = ?, next_attempt_at = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(nextAttempts, error, nextIso, nextIso, id)
    return { abandoned: false, nextAttemptAt: nextIso }
  }
}
