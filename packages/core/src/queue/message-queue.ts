import type Database from 'better-sqlite3'
import { nanoid } from 'nanoid'
import type { EnqueueParams, Message, MessageStatus, PaginatedFilters, PaginatedResult } from './types.js'

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
        attempts INTEGER NOT NULL DEFAULT 0,
        locked_by TEXT,
        locked_at TEXT,
        plugin_name TEXT,
        correlation_id TEXT,
        senders_config TEXT,
        context TEXT,
        waha_message_id TEXT,
        max_retries INTEGER NOT NULL DEFAULT 3,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE INDEX IF NOT EXISTS idx_messages_dequeue
        ON messages(status, priority, created_at);

      CREATE TABLE IF NOT EXISTS contacts (
        phone TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        registered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
    `)
  }

  enqueue(params: EnqueueParams): Message {
    const id = nanoid()
    const row = this.db.prepare(`
      INSERT INTO messages (id, to_number, body, idempotency_key, priority, sender_number,
                            plugin_name, correlation_id, senders_config, context, max_retries)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `).get(
      id,
      params.to,
      params.body,
      params.idempotencyKey,
      params.priority ?? 5,
      params.senderNumber ?? null,
      params.pluginName ?? null,
      params.correlationId ?? null,
      params.sendersConfig ?? null,
      params.context ?? null,
      params.maxRetries ?? 3,
    ) as Record<string, unknown>
    return this.rowToMessage(row)
  }

  enqueueBatch(paramsList: EnqueueParams[]): Message[] {
    const insert = this.db.prepare(`
      INSERT INTO messages (id, to_number, body, idempotency_key, priority, sender_number,
                            plugin_name, correlation_id, senders_config, context, max_retries)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `)
    const txn = this.db.transaction((list: EnqueueParams[]) => {
      return list.map((params) => {
        const id = nanoid()
        const row = insert.get(
          id,
          params.to,
          params.body,
          params.idempotencyKey,
          params.priority ?? 5,
          params.senderNumber ?? null,
          params.pluginName ?? null,
          params.correlationId ?? null,
          params.sendersConfig ?? null,
          params.context ?? null,
          params.maxRetries ?? 3,
        ) as Record<string, unknown>
        return this.rowToMessage(row)
      })
    })
    return txn(paramsList)
  }

  updateWahaMessageId(id: string, wahaMessageId: string): void {
    this.db.prepare(
      "UPDATE messages SET waha_message_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
    ).run(wahaMessageId, id)
  }

  getByWahaMessageId(wahaMessageId: string): Message | null {
    const row = this.db.prepare(
      'SELECT * FROM messages WHERE waha_message_id = ?',
    ).get(wahaMessageId) as Record<string, unknown> | undefined
    return row ? this.rowToMessage(row) : null
  }

  getQueueStats(pluginName?: string): { pending: number; processing: number; failedLastHour: number; oldestPendingAgeSeconds: number | null } {
    const row = this.db.prepare(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'queued') AS pending,
        COUNT(*) FILTER (WHERE status IN ('locked', 'sending')) AS processing,
        COUNT(*) FILTER (WHERE status IN ('failed', 'permanently_failed')
          AND updated_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour')) AS failed_last_hour,
        MIN(CASE WHEN status = 'queued' THEN created_at END) AS oldest_queued
      FROM messages
      WHERE (? IS NULL OR plugin_name = ?)
    `).get(pluginName ?? null, pluginName ?? null) as {
      pending: number
      processing: number
      failed_last_hour: number
      oldest_queued: string | null
    }

    let oldestPendingAgeSeconds: number | null = null
    if (row.oldest_queued) {
      oldestPendingAgeSeconds = Math.floor((Date.now() - new Date(row.oldest_queued).getTime()) / 1000)
    }

    return {
      pending: row.pending,
      processing: row.processing,
      failedLastHour: row.failed_last_hour,
      oldestPendingAgeSeconds,
    }
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

  requeueForRetry(id: string): Message {
    const row = this.db.prepare(`
      UPDATE messages
      SET status = 'queued',
          attempts = attempts + 1,
          locked_by = NULL,
          locked_at = NULL,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
      RETURNING *
    `).get(id) as Record<string, unknown> | undefined

    if (!row) throw new Error(`Message not found: ${id}`)
    return this.rowToMessage(row)
  }

  markPermanentlyFailed(id: string): Message {
    return this.updateStatus(id, 'permanently_failed')
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
    const query = status
      ? 'SELECT * FROM messages WHERE status = ? ORDER BY created_at DESC LIMIT ?'
      : 'SELECT * FROM messages ORDER BY created_at DESC LIMIT ?'
    const params = status ? [status, limit] : [limit]
    const rows = this.db.prepare(query).all(...params) as Record<string, unknown>[]
    return rows.map(row => this.rowToMessage(row))
  }

  listPaginated(filters: PaginatedFilters): PaginatedResult {
    const conditions: string[] = []
    const params: unknown[] = []

    if (filters.status) {
      conditions.push('status = ?')
      params.push(filters.status)
    }

    if (filters.pluginName) {
      conditions.push('plugin_name = ?')
      params.push(filters.pluginName)
    }

    if (filters.phone) {
      conditions.push('to_number LIKE ?')
      params.push(`%${filters.phone}%`)
    }

    if (filters.dateFrom) {
      conditions.push('created_at >= ?')
      params.push(`${filters.dateFrom}T00:00:00.000Z`)
    }

    if (filters.dateTo) {
      conditions.push('created_at <= ?')
      params.push(`${filters.dateTo}T23:59:59.999Z`)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    const countRow = this.db.prepare(
      `SELECT COUNT(*) AS total FROM messages ${where}`,
    ).get(...params) as { total: number }

    const limit = filters.limit ?? 50
    const offset = filters.offset ?? 0

    const rows = this.db.prepare(
      `SELECT * FROM messages ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset) as Record<string, unknown>[]

    return {
      data: rows.map(row => this.rowToMessage(row)),
      total: countRow.total,
    }
  }

  getById(id: string): Message | null {
    const row = this.db.prepare(
      'SELECT * FROM messages WHERE id = ?',
    ).get(id) as Record<string, unknown> | undefined
    return row ? this.rowToMessage(row) : null
  }

  hasContact(phone: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM contacts WHERE phone = ?').get(phone)
    return row !== undefined
  }

  saveContact(phone: string, name: string): void {
    this.db.prepare(
      'INSERT OR IGNORE INTO contacts (phone, name) VALUES (?, ?)',
    ).run(phone, name)
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
      attempts: (row.attempts as number) ?? 0,
      lockedBy: (row.locked_by as string) ?? null,
      lockedAt: (row.locked_at as string) ?? null,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      pluginName: (row.plugin_name as string) ?? null,
      correlationId: (row.correlation_id as string) ?? null,
      sendersConfig: (row.senders_config as string) ?? null,
      context: (row.context as string) ?? null,
      wahaMessageId: (row.waha_message_id as string) ?? null,
      maxRetries: (row.max_retries as number) ?? 3,
    }
  }
}
