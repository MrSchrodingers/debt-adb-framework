import type Database from 'better-sqlite3'
import { nanoid } from 'nanoid'
import type { EnqueueParams, Message, MessageStatus, PaginatedFilters, PaginatedResult, BatchResult, SkippedItem } from './types.js'
import { VALID_TRANSITIONS } from './types.js'
import { getTracer } from '../telemetry/tracer.js'
import { SpanStatusCode } from '@opentelemetry/api'

/**
 * Strip all non-digit characters from a phone string.
 * Used to normalise phone numbers at the recordBan / isBlacklisted boundary so
 * that "+5543991938235", "55 43 99193-8235", and "5543991938235" all resolve to
 * the same blacklist key regardless of how the caller formatted the number.
 */
function normalizeDigits(phone: string): string {
  return phone.replace(/\D/g, '')
}

export class MessageQueue {
  constructor(private db: Database.Database) {}

  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        to_number TEXT NOT NULL,
        body TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        priority INTEGER NOT NULL DEFAULT 5 CHECK (priority BETWEEN 1 AND 10),
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
        fallback_used INTEGER NOT NULL DEFAULT 0,
        fallback_provider TEXT,
        sent_at TEXT DEFAULT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE INDEX IF NOT EXISTS idx_messages_dequeue
        ON messages(status, priority, created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_sender_number
        ON messages(sender_number);
      CREATE INDEX IF NOT EXISTS idx_messages_sender_daily
        ON messages(sender_number, status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_messages_plugin_name
        ON messages(plugin_name, status, created_at);

      CREATE TABLE IF NOT EXISTS contacts (
        phone TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        registered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      CREATE TABLE IF NOT EXISTS sender_health (
        sender_number TEXT PRIMARY KEY,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        quarantined_until TEXT,
        last_failure_at TEXT,
        last_success_at TEXT,
        total_failures INTEGER NOT NULL DEFAULT 0,
        total_successes INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      CREATE TABLE IF NOT EXISTS message_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL,
        event TEXT NOT NULL,
        metadata TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX IF NOT EXISTS idx_message_events_msg ON message_events(message_id);

      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor TEXT NOT NULL DEFAULT 'api',
        action TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT,
        before_state TEXT,
        after_state TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX IF NOT EXISTS idx_audit_log_resource ON audit_log(resource_type, resource_id);
      CREATE INDEX IF NOT EXISTS idx_audit_log_time ON audit_log(created_at);

      CREATE TABLE IF NOT EXISTS sender_warmup (
        sender_number TEXT PRIMARY KEY,
        activated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        skipped INTEGER NOT NULL DEFAULT 0,
        skipped_at TEXT
      );

      CREATE TABLE IF NOT EXISTS blacklist (
        phone_number TEXT PRIMARY KEY,
        reason TEXT NOT NULL,
        detected_message TEXT,
        detected_pattern TEXT,
        source_session TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `)

    // Migration: add screenshot_path column if not present
    const cols = this.db.prepare("PRAGMA table_info(messages)").all() as { name: string }[]
    if (!cols.some(c => c.name === 'screenshot_path')) {
      this.db.exec("ALTER TABLE messages ADD COLUMN screenshot_path TEXT")
    }

    // Migration: add media columns if not present
    if (!cols.some(c => c.name === 'media_url')) {
      this.db.exec("ALTER TABLE messages ADD COLUMN media_url TEXT")
      this.db.exec("ALTER TABLE messages ADD COLUMN media_type TEXT")
      this.db.exec("ALTER TABLE messages ADD COLUMN media_caption TEXT")
    }

    // Migration: add sent_at column if not present
    if (!cols.some(c => c.name === 'sent_at')) {
      this.db.exec("ALTER TABLE messages ADD COLUMN sent_at TEXT DEFAULT NULL")
    }

    // Task 5.4: extend blacklist with hit counter + last_hit_at
    const blCols = this.db.prepare('PRAGMA table_info(blacklist)').all() as { name: string }[]
    const blColNames = new Set(blCols.map(c => c.name))
    if (!blColNames.has('hits')) {
      this.db.exec('ALTER TABLE blacklist ADD COLUMN hits INTEGER NOT NULL DEFAULT 1')
    }
    if (!blColNames.has('last_hit_at')) {
      // SQLite does not accept non-constant defaults in ALTER TABLE — use NULL;
      // populated on first recordBan() call.
      this.db.exec('ALTER TABLE blacklist ADD COLUMN last_hit_at TEXT')
    }
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_blacklist_source_hit ON blacklist(reason, last_hit_at)',
    )
  }

  /**
   * Record a banned number. If already present, increments `hits` and updates
   * `last_hit_at`. If new, inserts with hits=1.
   *
   * Phone is normalised to digits-only before storage so that "+5543991938235",
   * "55 43 99193-8235", and "5543991938235" all map to the same blacklist key.
   * `isBlacklisted` applies the same normalisation at lookup time.
   *
   * @param phone   The recipient phone number (any format — normalised internally).
   * @param source  'engine_failures' | 'precheck_invalid' | 'ocr_ban_detected'
   * @param meta    Optional forensic context.
   */
  recordBan(
    phone: string,
    source: string,
    meta?: { detectedMessage?: string; detectedPattern?: string; sourceSession?: string },
  ): void {
    const normalised = normalizeDigits(phone)
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO blacklist (phone_number, reason, detected_message, detected_pattern, source_session, created_at, hits, last_hit_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(phone_number) DO UPDATE SET
        hits             = hits + 1,
        last_hit_at      = excluded.last_hit_at,
        reason           = excluded.reason,
        detected_message = COALESCE(excluded.detected_message, detected_message),
        detected_pattern = COALESCE(excluded.detected_pattern, detected_pattern),
        source_session   = COALESCE(excluded.source_session, source_session)
    `).run(
      normalised,
      source,
      meta?.detectedMessage ?? null,
      meta?.detectedPattern ?? null,
      meta?.sourceSession ?? null,
      now,
      now,
    )
  }

  isBlacklisted(phone: string): boolean {
    const normalised = normalizeDigits(phone)
    const row = this.db.prepare('SELECT 1 FROM blacklist WHERE phone_number = ?').get(normalised)
    return !!row
  }

  enqueue(params: EnqueueParams): Message {
    if (this.isBlacklisted(params.to)) {
      throw new Error(`Phone ${params.to} is blacklisted — message rejected`)
    }
    const id = nanoid()
    const tracer = getTracer()
    return tracer.startActiveSpan('queue.enqueue', (span) => {
      span.setAttributes({
        'idempotency_key': params.idempotencyKey,
        'plugin_name': params.pluginName ?? '',
        'message.to': params.to,
        'message.priority': params.priority ?? 5,
      })
      try {
        const row = this.db.prepare(`
          INSERT INTO messages (id, to_number, body, idempotency_key, priority, sender_number,
                                plugin_name, correlation_id, senders_config, context, max_retries,
                                media_url, media_type, media_caption)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          params.mediaUrl ?? null,
          params.mediaType ?? null,
          params.mediaCaption ?? null,
        ) as Record<string, unknown>
        const message = this.rowToMessage(row)
        span.setAttribute('message.id', message.id)
        span.setStatus({ code: SpanStatusCode.OK })
        return message
      } catch (err) {
        span.recordException(err as Error)
        span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) })
        throw err
      } finally {
        span.end()
      }
    })
  }

  enqueueBatch(paramsList: EnqueueParams[]): BatchResult {
    const pluginName = paramsList[0]?.pluginName ?? ''
    // Span key: first idempotency_key + batch size for traceability
    const spanIdempotencyKey =
      paramsList.length === 1
        ? (paramsList[0]?.idempotencyKey ?? '')
        : `${paramsList[0]?.idempotencyKey ?? ''}+${paramsList.length - 1}more`

    const tracer = getTracer()
    return tracer.startActiveSpan('queue.enqueue_batch', (span) => {
      span.setAttributes({
        'idempotency_key': spanIdempotencyKey,
        'plugin_name': pluginName,
        'batch.size': paramsList.length,
      })
      try {
        const insert = this.db.prepare(`
          INSERT OR IGNORE INTO messages (id, to_number, body, idempotency_key, priority, sender_number,
                                plugin_name, correlation_id, senders_config, context, max_retries,
                                media_url, media_type, media_caption)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        const select = this.db.prepare('SELECT * FROM messages WHERE id = ?')
        const saveContactStmt = this.db.prepare(
          'INSERT INTO contacts (phone, name) VALUES (?, ?) ON CONFLICT(phone) DO UPDATE SET name = excluded.name',
        )

        const txn = this.db.transaction((list: EnqueueParams[]) => {
          const enqueued: Message[] = []
          const skipped: SkippedItem[] = []

          for (const params of list) {
            // Skip blacklisted numbers per-item
            if (this.isBlacklisted(params.to)) {
              skipped.push({ idempotencyKey: params.idempotencyKey, reason: 'blacklisted', to: params.to })
              continue
            }

            const id = params.id ?? nanoid()
            const result = insert.run(
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
              params.mediaUrl ?? null,
              params.mediaType ?? null,
              params.mediaCaption ?? null,
            )

            if (result.changes === 0) {
              // ON CONFLICT DO NOTHING — duplicate idempotency_key
              skipped.push({ idempotencyKey: params.idempotencyKey, reason: 'duplicate' })
              continue
            }

            const row = select.get(id) as Record<string, unknown>
            enqueued.push(this.rowToMessage(row))

            // D5: saveContact inside the batch transaction
            if (params.contactName) {
              saveContactStmt.run(params.to, params.contactName)
            }
          }

          return { enqueued, skipped }
        })
        const result = txn(paramsList)
        span.setAttributes({
          'batch.enqueued': result.enqueued.length,
          'batch.skipped': result.skipped.length,
        })
        span.setStatus({ code: SpanStatusCode.OK })
        return result
      } catch (err) {
        span.recordException(err as Error)
        span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) })
        throw err
      } finally {
        span.end()
      }
    })
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
    const whereClause = pluginName ? 'WHERE plugin_name = ?' : ''
    const binds = pluginName ? [pluginName] : []

    const row = this.db.prepare(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'queued') AS pending,
        COUNT(*) FILTER (WHERE status IN ('locked', 'sending')) AS processing,
        COUNT(*) FILTER (WHERE status IN ('failed', 'permanently_failed')
          AND updated_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour')) AS failed_last_hour,
        MIN(CASE WHEN status = 'queued' THEN created_at END) AS oldest_queued
      FROM messages
      ${whereClause}
    `).get(...binds) as {
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
    const tracer = getTracer()
    return tracer.startActiveSpan('queue.dequeue', (span) => {
      span.setAttribute('device.serial', deviceSerial)
      try {
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
        const message = row ? this.rowToMessage(row) : null
        if (message) {
          span.setAttributes({
            'message.id': message.id,
            'idempotency_key': message.idempotencyKey,
            'message.to': message.to,
            'plugin_name': message.pluginName ?? '',
          })
        }
        span.setAttribute('queue.dequeued', message !== null)
        span.setStatus({ code: SpanStatusCode.OK })
        return message
      } catch (err) {
        span.recordException(err as Error)
        span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) })
        throw err
      } finally {
        span.end()
      }
    })
  }

  updateStatus(id: string, from: MessageStatus, to: MessageStatus): Message {
    if (!VALID_TRANSITIONS[from]?.includes(to)) {
      throw new Error(`Invalid state transition: ${from} → ${to}`)
    }
    const sentAtClause = to === 'sent' ? ", sent_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')" : ''
    const row = this.db.prepare(`
      UPDATE messages
      SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')${sentAtClause}
      WHERE id = ? AND status = ?
      RETURNING *
    `).get(to, id, from) as Record<string, unknown> | undefined

    if (!row) {
      throw new Error(`Message not found or status mismatch (expected ${from}): ${id}`)
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
      WHERE id = ? AND status IN ('sending', 'failed', 'locked')
      RETURNING *
    `).get(id) as Record<string, unknown> | undefined

    if (!row) throw new Error(`Message not found or invalid state for requeue: ${id}`)
    return this.rowToMessage(row)
  }

  /**
   * Replay a message from any terminal or failed state back to `queued`.
   * Unlike `requeueForRetry`, this accepts `permanently_failed` and `waiting_device`
   * as source states, and resets `attempts` to 0 so the full retry budget is restored.
   *
   * Refuses to replay `sent` messages unless `allowSent` is true.
   */
  replay(id: string, allowSent = false): Message {
    const current = this.db.prepare(
      'SELECT status FROM messages WHERE id = ?',
    ).get(id) as { status: string } | undefined

    if (!current) throw new Error(`Message not found: ${id}`)

    if (current.status === 'sent' && !allowSent) {
      throw new Error(`Refusing to replay message ${id} with status 'sent'. Pass allowSent=true to override.`)
    }

    const row = this.db.prepare(`
      UPDATE messages
      SET status = 'queued',
          attempts = 0,
          locked_by = NULL,
          locked_at = NULL,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
      RETURNING *
    `).get(id) as Record<string, unknown> | undefined

    if (!row) throw new Error(`Failed to replay message: ${id}`)
    return this.rowToMessage(row)
  }

  markPermanentlyFailed(id: string, attempts?: number): Message {
    const attemptsClause = attempts !== undefined ? ', attempts = ?' : ''
    const binds = attempts !== undefined
      ? ['permanently_failed', attempts, id]
      : ['permanently_failed', id]
    const row = this.db.prepare(`
      UPDATE messages
      SET status = ?${attemptsClause},
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ? AND status IN ('queued', 'locked', 'sending', 'failed', 'waiting_device')
      RETURNING *
    `).get(...binds) as Record<string, unknown> | undefined

    if (!row) throw new Error(`Message not found or invalid state for permanently_failed: ${id}`)
    return this.rowToMessage(row)
  }

  cleanStaleLocks(): number {
    // R1: Recover locked > 120s
    const lockedResult = this.db.prepare(`
      UPDATE messages
      SET status = 'queued',
          locked_by = NULL,
          locked_at = NULL,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE status = 'locked'
        AND locked_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-120 seconds')
    `).run()

    // R1/Decision #9: Recover sending > 300s (2x worst case send timeout)
    const sendingResult = this.db.prepare(`
      UPDATE messages
      SET status = 'queued',
          locked_by = NULL,
          locked_at = NULL,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE status = 'sending'
        AND updated_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-300 seconds')
    `).run()

    return lockedResult.changes + sendingResult.changes
  }

  /** Decision #8: Expire waiting_device messages older than TTL */
  expireWaitingDeviceMessages(ttlMs: number): Message[] {
    const ttlSeconds = Math.floor(ttlMs / 1000)
    const rows = this.db.prepare(`
      UPDATE messages
      SET status = 'permanently_failed',
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE status = 'waiting_device'
        AND updated_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || ? || ' seconds')
      RETURNING *
    `).all(ttlSeconds) as Record<string, unknown>[]
    return rows.map(row => this.rowToMessage(row))
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

    if (filters.senderNumber) {
      conditions.push('sender_number = ?')
      params.push(filters.senderNumber)
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

  getContactName(phone: string): string | null {
    const row = this.db.prepare('SELECT name FROM contacts WHERE phone = ?').get(phone) as { name: string } | undefined
    return row?.name ?? null
  }

  getAllContactPhones(): string[] {
    const rows = this.db.prepare('SELECT phone FROM contacts').all() as { phone: string }[]
    return rows.map(r => r.phone)
  }

  saveContact(phone: string, name: string): void {
    this.db.prepare(
      'INSERT INTO contacts (phone, name) VALUES (?, ?) ON CONFLICT(phone) DO UPDATE SET name = excluded.name',
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
      sentAt: (row.sent_at as string) ?? null,
      fallbackUsed: (row.fallback_used as number) ?? 0,
      fallbackProvider: (row.fallback_provider as string) ?? null,
      screenshotPath: (row.screenshot_path as string) ?? null,
      mediaUrl: (row.media_url as string) ?? null,
      mediaType: (row.media_type as string) ?? null,
      mediaCaption: (row.media_caption as string) ?? null,
    }
  }

  dequeueBySender(deviceSerial: string, batchSize = 50): Message[] {
    const txn = this.db.transaction(() => {
      // Step 1: Check for high-priority messages (priority < 5)
      const highPriority = this.db.prepare(`
        SELECT * FROM messages
        WHERE status = 'queued' AND priority < 5
        ORDER BY priority ASC, created_at ASC
        LIMIT 1
      `).get() as Record<string, unknown> | undefined

      if (highPriority) {
        // Lock just the high-priority message
        const row = this.db.prepare(`
          UPDATE messages
          SET status = 'locked',
              locked_by = ?,
              locked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE id = ?
          RETURNING *
        `).get(deviceSerial, highPriority.id as string) as Record<string, unknown> | undefined
        return row ? [this.rowToMessage(row)] : []
      }

      // Step 2: Find sender group with most pending messages
      const topSender = this.db.prepare(`
        SELECT sender_number, COUNT(*) as cnt
        FROM messages
        WHERE status = 'queued' AND sender_number IS NOT NULL
        GROUP BY sender_number
        ORDER BY cnt DESC
        LIMIT 1
      `).get() as { sender_number: string; cnt: number } | undefined

      if (!topSender) {
        // Fallback: dequeue any single queued message (no sender_number set)
        const any = this.db.prepare(`
          UPDATE messages
          SET status = 'locked',
              locked_by = ?,
              locked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE id = (
            SELECT id FROM messages WHERE status = 'queued'
            ORDER BY priority ASC, created_at ASC LIMIT 1
          )
          RETURNING *
        `).get(deviceSerial) as Record<string, unknown> | undefined
        return any ? [this.rowToMessage(any)] : []
      }

      // Step 3: Lock batch for that sender
      const ids = this.db.prepare(`
        SELECT id FROM messages
        WHERE status = 'queued' AND sender_number = ?
        ORDER BY priority ASC, created_at ASC
        LIMIT ?
      `).all(topSender.sender_number, batchSize) as { id: string }[]

      if (ids.length === 0) return []

      const placeholders = ids.map(() => '?').join(',')
      this.db.prepare(`
        UPDATE messages
        SET status = 'locked',
            locked_by = ?,
            locked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id IN (${placeholders})
      `).run(deviceSerial, ...ids.map((r) => r.id))

      // Re-select in order (RETURNING * does not preserve order)
      const rows = this.db.prepare(`
        SELECT * FROM messages WHERE id IN (${placeholders})
        ORDER BY priority ASC, created_at ASC
      `).all(...ids.map((r) => r.id)) as Record<string, unknown>[]

      return rows.map((row) => this.rowToMessage(row))
    })

    return txn.immediate()
  }

  updateScreenshotPath(id: string, screenshotPath: string): void {
    this.db.prepare(
      "UPDATE messages SET screenshot_path = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
    ).run(screenshotPath, id)
  }

  markFallbackUsed(id: string, provider: string): void {
    this.db.prepare(
      "UPDATE messages SET fallback_used = 1, fallback_provider = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
    ).run(provider, id)
  }

  getSenderDailyCount(senderNumber: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) as cnt FROM messages
      WHERE sender_number = ? AND status = 'sent'
        AND updated_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', 'start of day', '-3 hours')
    `).get(senderNumber) as { cnt: number }
    return row.cnt
  }

  isFirstContactWith(toNumber: string, senderNumber: string): boolean {
    const row = this.db.prepare(`
      SELECT 1 FROM messages
      WHERE to_number = ? AND sender_number = ? AND status = 'sent'
      LIMIT 1
    `).get(toNumber, senderNumber)
    return row === undefined
  }
}
