import type Database from 'better-sqlite3'
import { nanoid } from 'nanoid'
import type { MessageHistory } from './message-history.js'

export interface InsertAckParams {
  wahaMessageId: string
  ackLevel: number
  ackLevelName: string
  deliveredAt: string | null
  readAt: string | null
}

export interface AckHistoryRecord {
  id: string
  wahaMessageId: string
  ackLevel: number
  ackLevelName: string
  deliveredAt: string | null
  readAt: string | null
  observedAt: string
  senderPhone: string | null
  recipientPhone: string | null
}

/**
 * Persistence for `message.ack` events. Drives the WAHA ack-rate calibrator
 * (research/ack-rate-calibrator.ts) — the replacement signal for the
 * Frida-based ban-prediction calibration that was blocked on the POCO C71
 * stack (see ADR 0001).
 *
 * Schema is denormalized: sender/recipient phone numbers are pulled from
 * `message_history` on insert so calibration queries can run without joins.
 */
export class AckHistory {
  constructor(
    private readonly db: Database.Database,
    private readonly history: MessageHistory,
  ) {}

  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS message_ack_history (
        id TEXT PRIMARY KEY,
        waha_message_id TEXT NOT NULL,
        ack_level INTEGER NOT NULL,
        ack_level_name TEXT NOT NULL,
        delivered_at TEXT,
        read_at TEXT,
        observed_at TEXT NOT NULL DEFAULT (datetime('now')),
        sender_phone TEXT,
        recipient_phone TEXT,
        UNIQUE (waha_message_id, ack_level)
      );
      CREATE INDEX IF NOT EXISTS idx_ack_sender_observed
        ON message_ack_history(sender_phone, observed_at);
      CREATE INDEX IF NOT EXISTS idx_ack_msgid
        ON message_ack_history(waha_message_id);
    `)
  }

  /**
   * Insert an ack event. Resolves sender/recipient denormalized columns by
   * querying message_history on `waha_message_id`. If no matching row exists
   * (ack arrived before message_history caught up), inserts NULLs — the
   * calibrator skips these from per-sender stats but counts them in totals.
   *
   * Returns the new id, or `null` if a row with the same
   * `(waha_message_id, ack_level)` pair already existed (UNIQUE conflict).
   */
  insert(params: InsertAckParams): string | null {
    const sourceRow = this.db
      .prepare(`
        SELECT from_number, to_number
        FROM message_history
        WHERE waha_message_id = ?
        ORDER BY created_at DESC
        LIMIT 1
      `)
      .get(params.wahaMessageId) as { from_number: string | null; to_number: string | null } | undefined

    const id = nanoid()
    const result = this.db
      .prepare(`
        INSERT OR IGNORE INTO message_ack_history
          (id, waha_message_id, ack_level, ack_level_name,
           delivered_at, read_at, sender_phone, recipient_phone)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        params.wahaMessageId,
        params.ackLevel,
        params.ackLevelName,
        params.deliveredAt,
        params.readAt,
        sourceRow?.from_number ?? null,
        sourceRow?.to_number ?? null,
      )

    return result.changes > 0 ? id : null
  }

  queryByMessageId(wahaMessageId: string): AckHistoryRecord[] {
    const rows = this.db
      .prepare(`
        SELECT * FROM message_ack_history
        WHERE waha_message_id = ?
        ORDER BY ack_level ASC
      `)
      .all(wahaMessageId) as Record<string, unknown>[]
    return rows.map((r) => this.rowToRecord(r))
  }

  /**
   * Query acks for a specific sender within a time window.
   * Used by the calibrator for per-sender baseline calibration.
   */
  queryBySenderInRange(senderPhone: string, sinceMs: number, untilMs: number): AckHistoryRecord[] {
    const sinceIso = msToSqliteDatetime(sinceMs)
    const untilIso = msToSqliteDatetime(untilMs)
    const rows = this.db
      .prepare(`
        SELECT * FROM message_ack_history
        WHERE sender_phone = ?
          AND observed_at >= ?
          AND observed_at <= ?
        ORDER BY observed_at ASC
      `)
      .all(senderPhone, sinceIso, untilIso) as Record<string, unknown>[]
    return rows.map((r) => this.rowToRecord(r))
  }

  /**
   * Query all acks (including orphans with NULL sender_phone) within a range.
   * Used for global "data sufficiency" verdict in the CLI.
   */
  queryAllInRange(sinceMs: number, untilMs: number): AckHistoryRecord[] {
    const sinceIso = msToSqliteDatetime(sinceMs)
    const untilIso = msToSqliteDatetime(untilMs)
    const rows = this.db
      .prepare(`
        SELECT * FROM message_ack_history
        WHERE observed_at >= ?
          AND observed_at <= ?
        ORDER BY observed_at ASC
      `)
      .all(sinceIso, untilIso) as Record<string, unknown>[]
    return rows.map((r) => this.rowToRecord(r))
  }

  private rowToRecord(row: Record<string, unknown>): AckHistoryRecord {
    return {
      id: row.id as string,
      wahaMessageId: row.waha_message_id as string,
      ackLevel: row.ack_level as number,
      ackLevelName: row.ack_level_name as string,
      deliveredAt: (row.delivered_at as string | null) ?? null,
      readAt: (row.read_at as string | null) ?? null,
      observedAt: row.observed_at as string,
      senderPhone: (row.sender_phone as string | null) ?? null,
      recipientPhone: (row.recipient_phone as string | null) ?? null,
    }
  }
}

/**
 * Convert ms epoch to the format SQLite's `datetime('now')` produces:
 * `YYYY-MM-DD HH:MM:SS` (UTC, no timezone). Lexical comparison is correct
 * since the format is fixed-width.
 */
function msToSqliteDatetime(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
}

// Reference for ack levels (WAHA / Baileys / WhatsApp Web internal):
//   -1 error
//    0 pending
//    1 server (sent — message hit WhatsApp servers)
//    2 device (delivered — recipient device acknowledged)
//    3 read (recipient opened the chat)
//    4 played (voice / video message played)
