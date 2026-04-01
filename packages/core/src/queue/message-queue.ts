import type Database from 'better-sqlite3'
import { nanoid } from 'nanoid'
import type { EnqueueParams, Message, MessageStatus } from './types.js'

export class MessageQueue {
  constructor(private db: Database.Database) {}

  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        to_number TEXT NOT NULL,
        body TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        priority INTEGER NOT NULL DEFAULT 5,
        sender_number TEXT,
        status TEXT NOT NULL DEFAULT 'queued',
        locked_by TEXT,
        locked_at TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE INDEX IF NOT EXISTS idx_messages_dequeue
        ON messages(status, priority, created_at);
    `)
  }

  enqueue(params: EnqueueParams): Message {
    const id = nanoid()
    const row = this.db.prepare(`
      INSERT INTO messages (id, to_number, body, idempotency_key, priority, sender_number)
      VALUES (?, ?, ?, ?, ?, ?)
      RETURNING *
    `).get(
      id,
      params.to,
      params.body,
      params.idempotencyKey,
      params.priority ?? 5,
      params.senderNumber ?? null,
    ) as Record<string, unknown>
    return this.rowToMessage(row)
  }

  dequeue(deviceSerial: string): Message | null {
    const txn = this.db.transaction(() => {
      return this.db.prepare(`
        UPDATE messages
        SET status = 'locked',
            locked_by = ?,
            locked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = (
          SELECT id FROM messages
          WHERE status = 'queued'
          ORDER BY priority ASC, created_at ASC
          LIMIT 1
        )
        RETURNING *
      `).get(deviceSerial) as Record<string, unknown> | undefined
    })
    const row = txn.immediate()
    return row ? this.rowToMessage(row) : null
  }

  updateStatus(id: string, status: MessageStatus): Message {
    const row = this.db.prepare(`
      UPDATE messages
      SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
      RETURNING *
    `).get(status, id) as Record<string, unknown> | undefined

    if (!row) {
      throw new Error(`Message not found: ${id}`)
    }
    return this.rowToMessage(row)
  }

  cleanStaleLocks(): number {
    const result = this.db.prepare(`
      UPDATE messages
      SET status = 'queued',
          locked_by = NULL,
          locked_at = NULL,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE status = 'locked'
        AND locked_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-120 seconds')
    `).run()
    return result.changes
  }

  list(status?: MessageStatus, limit = 50): Message[] {
    const rows = status
      ? this.db.prepare(
          'SELECT * FROM messages WHERE status = ? ORDER BY created_at DESC LIMIT ?',
        ).all(status, limit) as Record<string, unknown>[]
      : this.db.prepare(
          'SELECT * FROM messages ORDER BY created_at DESC LIMIT ?',
        ).all(limit) as Record<string, unknown>[]
    return rows.map(row => this.rowToMessage(row))
  }

  getById(id: string): Message | null {
    const row = this.db.prepare(
      'SELECT * FROM messages WHERE id = ?',
    ).get(id) as Record<string, unknown> | undefined
    return row ? this.rowToMessage(row) : null
  }

  private rowToMessage(row: Record<string, unknown>): Message {
    return {
      id: row.id as string,
      to: row.to_number as string,
      body: row.body as string,
      idempotencyKey: row.idempotency_key as string,
      priority: row.priority as number,
      senderNumber: (row.sender_number as string) ?? null,
      status: row.status as MessageStatus,
      lockedBy: (row.locked_by as string) ?? null,
      lockedAt: (row.locked_at as string) ?? null,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    }
  }
}
