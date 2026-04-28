import type Database from 'better-sqlite3'
import { nanoid } from 'nanoid'

export interface AckPersistFailureRecord {
  id: string
  wahaMessageId: string
  ackLevel: number
  error: string
  ts: string
}

export interface InsertAckPersistFailureParams {
  wahaMessageId: string
  ackLevel: number
  error: string
}

/**
 * Persistence for waha:ack_persist_failed events. Each row captures a single
 * failed insert attempt against message_ack_history so the operator can audit
 * calibration data quality from the UI. Companion of AckHistory (ADR 0001).
 */
export class AckPersistFailures {
  constructor(private readonly db: Database.Database) {}

  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ack_persist_failures (
        id TEXT PRIMARY KEY,
        waha_message_id TEXT NOT NULL,
        ack_level INTEGER NOT NULL,
        error TEXT NOT NULL,
        ts TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_ack_persist_failures_ts
        ON ack_persist_failures(ts DESC);
    `)
  }

  insert(params: InsertAckPersistFailureParams): string {
    const id = nanoid()
    this.db
      .prepare(`
        INSERT INTO ack_persist_failures (id, waha_message_id, ack_level, error)
        VALUES (?, ?, ?, ?)
      `)
      .run(id, params.wahaMessageId, params.ackLevel, params.error)
    return id
  }

  countSince(sinceMs: number): number {
    const sinceIso = msToSqliteDatetime(sinceMs)
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM ack_persist_failures WHERE ts >= ?`)
      .get(sinceIso) as { n: number }
    return row.n
  }

  recentSince(sinceMs: number, limit: number): AckPersistFailureRecord[] {
    const sinceIso = msToSqliteDatetime(sinceMs)
    // Secondary sort by rowid DESC so rows inserted within the same SQLite
    // datetime() second still come back in insertion-reverse order.
    const rows = this.db
      .prepare(`
        SELECT id, waha_message_id, ack_level, error, ts
        FROM ack_persist_failures
        WHERE ts >= ?
        ORDER BY ts DESC, rowid DESC
        LIMIT ?
      `)
      .all(sinceIso, limit) as Array<{
      id: string
      waha_message_id: string
      ack_level: number
      error: string
      ts: string
    }>
    return rows.map((r) => ({
      id: r.id,
      wahaMessageId: r.waha_message_id,
      ackLevel: r.ack_level,
      error: r.error,
      ts: r.ts,
    }))
  }
}

function msToSqliteDatetime(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
}
