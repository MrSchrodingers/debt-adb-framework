import type Database from 'better-sqlite3'
import { nanoid } from 'nanoid'

export interface AckRateThresholdRecord {
  id: string
  senderPhone: string
  threshold: number
  windowMs: number
  appliedAt: string
  appliedBy: string
  supersededBy: string | null
}

export interface ApplyThresholdParams {
  senderPhone: string
  threshold: number
  windowMs: number
  appliedBy?: string
}

/**
 * Per-sender ack-rate thresholds applied by an operator from the UI.
 * Replaces the env-default DISPATCH_BAN_PREDICTION_* knob for senders that
 * have an active (non-superseded) row. New rows supersede the previous one
 * for the same sender, so we keep an audit trail of every change without
 * mutating .env (constraint from ADR 0001).
 */
export class AckRateThresholds {
  constructor(private readonly db: Database.Database) {}

  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ack_rate_thresholds (
        id TEXT PRIMARY KEY,
        sender_phone TEXT NOT NULL,
        threshold REAL NOT NULL,
        window_ms INTEGER NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now')),
        applied_by TEXT NOT NULL DEFAULT 'operator',
        superseded_by TEXT,
        FOREIGN KEY (superseded_by) REFERENCES ack_rate_thresholds(id)
      );
      CREATE INDEX IF NOT EXISTS idx_ack_rate_thresholds_sender_active
        ON ack_rate_thresholds(sender_phone) WHERE superseded_by IS NULL;
    `)
  }

  apply(params: ApplyThresholdParams): string {
    if (params.threshold < 0 || params.threshold > 1) {
      throw new Error(`threshold must be in [0, 1], got ${params.threshold}`)
    }
    if (params.windowMs <= 0) {
      throw new Error(`windowMs must be > 0, got ${params.windowMs}`)
    }
    const id = nanoid()
    const tx = this.db.transaction(() => {
      const prev = this.db
        .prepare(`
          SELECT id FROM ack_rate_thresholds
          WHERE sender_phone = ? AND superseded_by IS NULL
        `)
        .get(params.senderPhone) as { id: string } | undefined

      this.db
        .prepare(`
          INSERT INTO ack_rate_thresholds
            (id, sender_phone, threshold, window_ms, applied_by)
          VALUES (?, ?, ?, ?, ?)
        `)
        .run(
          id,
          params.senderPhone,
          params.threshold,
          params.windowMs,
          params.appliedBy ?? 'operator',
        )

      if (prev) {
        this.db
          .prepare(`UPDATE ack_rate_thresholds SET superseded_by = ? WHERE id = ?`)
          .run(id, prev.id)
      }
    })
    tx()
    return id
  }

  getActive(senderPhone: string): AckRateThresholdRecord | null {
    const row = this.db
      .prepare(`
        SELECT id, sender_phone, threshold, window_ms, applied_at, applied_by, superseded_by
        FROM ack_rate_thresholds
        WHERE sender_phone = ? AND superseded_by IS NULL
        ORDER BY applied_at DESC
        LIMIT 1
      `)
      .get(senderPhone) as
      | {
          id: string
          sender_phone: string
          threshold: number
          window_ms: number
          applied_at: string
          applied_by: string
          superseded_by: string | null
        }
      | undefined
    if (!row) return null
    return rowToRecord(row)
  }

  listActive(): AckRateThresholdRecord[] {
    const rows = this.db
      .prepare(`
        SELECT id, sender_phone, threshold, window_ms, applied_at, applied_by, superseded_by
        FROM ack_rate_thresholds
        WHERE superseded_by IS NULL
        ORDER BY applied_at DESC
      `)
      .all() as Array<{
      id: string
      sender_phone: string
      threshold: number
      window_ms: number
      applied_at: string
      applied_by: string
      superseded_by: string | null
    }>
    return rows.map(rowToRecord)
  }

  history(senderPhone: string): AckRateThresholdRecord[] {
    const rows = this.db
      .prepare(`
        SELECT id, sender_phone, threshold, window_ms, applied_at, applied_by, superseded_by
        FROM ack_rate_thresholds
        WHERE sender_phone = ?
        ORDER BY applied_at DESC
      `)
      .all(senderPhone) as Array<{
      id: string
      sender_phone: string
      threshold: number
      window_ms: number
      applied_at: string
      applied_by: string
      superseded_by: string | null
    }>
    return rows.map(rowToRecord)
  }
}

function rowToRecord(row: {
  id: string
  sender_phone: string
  threshold: number
  window_ms: number
  applied_at: string
  applied_by: string
  superseded_by: string | null
}): AckRateThresholdRecord {
  return {
    id: row.id,
    senderPhone: row.sender_phone,
    threshold: row.threshold,
    windowMs: row.window_ms,
    appliedAt: row.applied_at,
    appliedBy: row.applied_by,
    supersededBy: row.superseded_by,
  }
}
