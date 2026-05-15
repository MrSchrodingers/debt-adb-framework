import type Database from 'better-sqlite3'
import type { DealKey } from './types.js'
import type {
  DealInvalidationRequest,
  DealInvalidationResponse,
  DealLocalizationRequest,
  DealLocalizationResponse,
  IPipeboardClient,
} from './pipeboard-client.js'
import { PipeboardRestError } from './pipeboard-rest.js'
import {
  precheckPipeboardPendingWritebacks,
  precheckPipeboardRequestTotal,
} from '../../config/metrics.js'

/**
 * SQLite-backed at-least-once buffer for writebacks that fail because
 * Pipeboard is unreachable (5xx, 429, network errors). When the
 * primary call succeeds inline, nothing is enqueued. When it fails
 * with a retryable error, the writeback is persisted and a drain loop
 * retries it.
 *
 * The drain loop NEVER falls back to SQL — Pipeboard's blocklist
 * trigger silently NULLifies any SQL UPDATE that re-inserts a blocked
 * phone, so the only safe fallback is "queue and wait".
 *
 * Permanent failures (400, 401, 403, 409) are NOT enqueued — they
 * indicate caller bugs and would loop forever.
 */
type PendingKind = 'invalidate' | 'localize'

interface PendingRow {
  id: number
  kind: PendingKind
  job_id: string | null
  pasta: string
  deal_id: number
  contato_tipo: string
  contato_id: number
  payload_json: string
  attempts: number
  next_attempt_at: string
  last_error: string | null
  enqueued_at: string
}

const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS pending_writebacks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT NOT NULL CHECK (kind IN ('invalidate','localize')),
  job_id          TEXT,
  pasta           TEXT NOT NULL,
  deal_id         INTEGER NOT NULL,
  contato_tipo    TEXT NOT NULL,
  contato_id      INTEGER NOT NULL,
  payload_json    TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_error      TEXT,
  enqueued_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_pending_due
  ON pending_writebacks (next_attempt_at);
`

export interface PendingWritebacksOpts {
  client: IPipeboardClient
  /** Logger from the plugin context. */
  logger: {
    info: (msg: string, ctx?: Record<string, unknown>) => void
    warn: (msg: string, ctx?: Record<string, unknown>) => void
  }
  /** Drain interval in ms (default 30s). */
  drainIntervalMs?: number
  /** Max attempts before giving up and surfacing an alert (default 50). */
  maxAttempts?: number
  /** Injectable clock for tests. */
  now?: () => number
}

export class PendingWritebacks {
  private readonly db: Database.Database
  private readonly client: IPipeboardClient
  private readonly logger: PendingWritebacksOpts['logger']
  private readonly drainIntervalMs: number
  private readonly maxAttempts: number
  private readonly now: () => number
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(db: Database.Database, opts: PendingWritebacksOpts) {
    this.db = db
    this.client = opts.client
    this.logger = opts.logger
    this.drainIntervalMs = opts.drainIntervalMs ?? 30_000
    this.maxAttempts = opts.maxAttempts ?? 50
    this.now = opts.now ?? Date.now
  }

  initialize(): void {
    this.db.exec(SCHEMA_DDL)
    // Multi-tenant migration - default 'adb' preserves existing rows.
    this.idempotentAlter(
      'pending_writebacks',
      'tenant',
      "ALTER TABLE pending_writebacks ADD COLUMN tenant TEXT NOT NULL DEFAULT 'adb'",
    )
  }

  private idempotentAlter(table: string, column: string, ddl: string): void {
    const cols = this.db
      .prepare(`PRAGMA table_info(${table})`)
      .all() as Array<{ name: string }>
    if (cols.some((c) => c.name === column)) return
    this.db.prepare(ddl).run()
  }

  /**
   * Try the call inline; on retryable failure, persist for later.
   * Permanent failures bubble — caller decides what to log/alert.
   */
  async submitInvalidation(
    key: DealKey,
    payload: DealInvalidationRequest,
  ): Promise<DealInvalidationResponse | { enqueued: true; pendingId: number }> {
    try {
      return await this.client.applyDealInvalidation(key, payload)
    } catch (e) {
      if (this.isRetryable(e)) {
        const id = this.enqueue('invalidate', key, payload, e)
        return { enqueued: true, pendingId: id }
      }
      throw e
    }
  }

  async submitLocalization(
    key: DealKey,
    payload: DealLocalizationRequest,
  ): Promise<DealLocalizationResponse | { enqueued: true; pendingId: number }> {
    try {
      return await this.client.applyDealLocalization(key, payload)
    } catch (e) {
      if (this.isRetryable(e)) {
        const id = this.enqueue('localize', key, payload, e)
        return { enqueued: true, pendingId: id }
      }
      throw e
    }
  }

  /** Snapshot of how much is queued (operator visibility). */
  size(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM pending_writebacks')
      .get() as { n: number }
    return row.n
  }

  /** Start the periodic drain loop. */
  startDrain(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.drainOnce().catch((e) => {
        this.logger.warn('pending_writebacks drain failed', {
          error: e instanceof Error ? e.message : String(e),
        })
      })
    }, this.drainIntervalMs)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  stopDrain(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /**
   * Process every row whose `next_attempt_at` is in the past. Public
   * to allow tests to drain on demand without sleeping.
   */
  async drainOnce(): Promise<{ drained: number; failed: number }> {
    const nowIso = new Date(this.now()).toISOString()
    const dueRows = this.db
      .prepare(
        `SELECT * FROM pending_writebacks
          WHERE next_attempt_at <= ?
          ORDER BY id ASC
          LIMIT 100`,
      )
      .all(nowIso) as PendingRow[]
    let drained = 0
    let failed = 0
    for (const row of dueRows) {
      const key: DealKey = {
        pasta: row.pasta,
        deal_id: row.deal_id,
        contato_tipo: row.contato_tipo,
        contato_id: row.contato_id,
      }
      const payload = JSON.parse(row.payload_json) as
        | DealInvalidationRequest
        | DealLocalizationRequest
      try {
        if (row.kind === 'invalidate') {
          await this.client.applyDealInvalidation(
            key,
            payload as DealInvalidationRequest,
          )
        } else {
          await this.client.applyDealLocalization(
            key,
            payload as DealLocalizationRequest,
          )
        }
        this.db.prepare('DELETE FROM pending_writebacks WHERE id = ?').run(row.id)
        drained++
      } catch (e) {
        failed++
        const isPermanent = !this.isRetryable(e)
        const attempts = row.attempts + 1
        if (isPermanent || attempts >= this.maxAttempts) {
          this.logger.warn('pending_writebacks giving up', {
            id: row.id,
            kind: row.kind,
            key,
            attempts,
            permanent: isPermanent,
            error: e instanceof Error ? e.message : String(e),
          })
          this.db.prepare('DELETE FROM pending_writebacks WHERE id = ?').run(row.id)
        } else {
          const delayMs = Math.min(60_000 * Math.pow(2, attempts), 3_600_000)
          const next = new Date(this.now() + delayMs).toISOString()
          this.db
            .prepare(
              `UPDATE pending_writebacks
                  SET attempts = ?, next_attempt_at = ?, last_error = ?
                WHERE id = ?`,
            )
            .run(
              attempts,
              next,
              e instanceof Error ? e.message : String(e),
              row.id,
            )
        }
      }
    }
    if (drained > 0 || failed > 0) {
      this.logger.info('pending_writebacks drain', { drained, failed, due: dueRows.length })
    }
    precheckPipeboardPendingWritebacks.set(this.size())
    return { drained, failed }
  }

  private enqueue(
    kind: PendingKind,
    key: DealKey,
    payload: DealInvalidationRequest | DealLocalizationRequest,
    error: unknown,
  ): number {
    const ts = new Date(this.now()).toISOString()
    const result = this.db
      .prepare(
        `INSERT INTO pending_writebacks
           (kind, job_id, pasta, deal_id, contato_tipo, contato_id, payload_json, last_error, next_attempt_at, enqueued_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        kind,
        payload.jobId ?? null,
        key.pasta,
        key.deal_id,
        key.contato_tipo,
        key.contato_id,
        JSON.stringify(payload),
        error instanceof Error ? error.message : String(error),
        ts,
        ts,
      )
    this.logger.warn('pending_writebacks enqueued', {
      id: Number(result.lastInsertRowid),
      kind,
      key,
      error: error instanceof Error ? error.message : String(error),
    })
    precheckPipeboardRequestTotal.inc({ op: kind, status: 'enqueued' })
    precheckPipeboardPendingWritebacks.set(this.size())
    return Number(result.lastInsertRowid)
  }

  private isRetryable(e: unknown): boolean {
    if (e instanceof PipeboardRestError) return e.isRetryable
    if (e instanceof Error) {
      const name = e.name
      if (name === 'AbortError' || name === 'TypeError') return true
      if (/ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(e.message)) return true
    }
    return false
  }
}
