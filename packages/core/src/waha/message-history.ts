import type Database from 'better-sqlite3'
import { nanoid } from 'nanoid'
import type { MessageHistoryRecord } from './types.js'

export interface InsertHistoryParams {
  messageId?: string | null
  direction: 'incoming' | 'outgoing'
  fromNumber: string | null
  toNumber: string | null
  text: string | null
  mediaType?: string | null
  mediaPath?: string | null
  deviceSerial?: string | null
  profileId?: number | null
  wahaMessageId?: string | null
  wahaSessionName?: string | null
  capturedVia: 'adb_send' | 'waha_webhook' | 'chatwoot_reply'
}

export interface HistoryQuery {
  fromNumber?: string
  toNumber?: string
  direction?: 'incoming' | 'outgoing'
  wahaSessionName?: string
  limit?: number
  offset?: number
}

export class MessageHistory {
  constructor(private readonly db: Database.Database) {}

  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS message_history (
        id TEXT PRIMARY KEY,
        message_id TEXT,
        direction TEXT NOT NULL,
        from_number TEXT,
        to_number TEXT,
        text TEXT,
        media_type TEXT,
        media_path TEXT,
        device_serial TEXT,
        profile_id INTEGER,
        waha_message_id TEXT,
        waha_session_name TEXT,
        captured_via TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_history_numbers
        ON message_history(from_number, to_number, created_at);
      CREATE INDEX IF NOT EXISTS idx_history_waha_message_id
        ON message_history(waha_message_id);
      CREATE INDEX IF NOT EXISTS idx_history_dedup
        ON message_history(to_number, captured_via, created_at);
    `)
  }

  insert(params: InsertHistoryParams): string {
    const id = nanoid()
    this.db.prepare(`
      INSERT INTO message_history
        (id, message_id, direction, from_number, to_number, text,
         media_type, media_path, device_serial, profile_id,
         waha_message_id, waha_session_name, captured_via, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      id,
      params.messageId ?? null,
      params.direction,
      params.fromNumber,
      params.toNumber,
      params.text,
      params.mediaType ?? null,
      params.mediaPath ?? null,
      params.deviceSerial ?? null,
      params.profileId ?? null,
      params.wahaMessageId ?? null,
      params.wahaSessionName ?? null,
      params.capturedVia,
    )
    return id
  }

  findByDedup(toNumber: string, timestamp: string, windowSeconds = 30): MessageHistoryRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM message_history
      WHERE to_number = ?
        AND captured_via = 'adb_send'
        AND direction = 'outgoing'
        AND abs(strftime('%s', created_at) - strftime('%s', ?)) <= ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(toNumber, timestamp, windowSeconds) as Record<string, unknown> | undefined

    return row ? this.rowToRecord(row) : null
  }

  updateWithWahaId(id: string, wahaMessageId: string): void {
    this.db.prepare(`
      UPDATE message_history SET waha_message_id = ? WHERE id = ?
    `).run(wahaMessageId, id)
  }

  getById(id: string): MessageHistoryRecord | null {
    const row = this.db.prepare('SELECT * FROM message_history WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined
    return row ? this.rowToRecord(row) : null
  }

  query(params: HistoryQuery): MessageHistoryRecord[] {
    const conditions: string[] = []
    const values: unknown[] = []

    if (params.fromNumber) {
      conditions.push('from_number = ?')
      values.push(params.fromNumber)
    }
    if (params.toNumber) {
      conditions.push('to_number = ?')
      values.push(params.toNumber)
    }
    if (params.direction) {
      conditions.push('direction = ?')
      values.push(params.direction)
    }
    if (params.wahaSessionName) {
      conditions.push('waha_session_name = ?')
      values.push(params.wahaSessionName)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const limit = params.limit ? `LIMIT ${params.limit}` : ''
    const offset = params.offset ? `OFFSET ${params.offset}` : ''

    const rows = this.db.prepare(
      `SELECT * FROM message_history ${where} ORDER BY created_at DESC ${limit} ${offset}`,
    ).all(...values) as Record<string, unknown>[]

    return rows.map((row) => this.rowToRecord(row))
  }

  cleanup(retentionDays: number): number {
    const result = this.db.prepare(`
      DELETE FROM message_history
      WHERE created_at < datetime('now', ? || ' days')
    `).run(`-${retentionDays}`)
    return result.changes
  }

  private rowToRecord(row: Record<string, unknown>): MessageHistoryRecord {
    return {
      id: row.id as string,
      messageId: row.message_id as string | null,
      direction: row.direction as 'incoming' | 'outgoing',
      fromNumber: row.from_number as string | null,
      toNumber: row.to_number as string | null,
      text: row.text as string | null,
      mediaType: row.media_type as string | null,
      mediaPath: row.media_path as string | null,
      deviceSerial: row.device_serial as string | null,
      profileId: row.profile_id as number | null,
      wahaMessageId: row.waha_message_id as string | null,
      wahaSessionName: row.waha_session_name as string | null,
      capturedVia: row.captured_via as 'adb_send' | 'waha_webhook' | 'chatwoot_reply',
      createdAt: row.created_at as string,
    }
  }
}
