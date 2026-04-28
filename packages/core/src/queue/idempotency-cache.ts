import type Database from 'better-sqlite3'

// ── IdempotencyCache — time-bounded deduplication window (Task 4.3) ──
//
// Stores idempotency key → message_id mappings with TTL semantics.
// On a hit within the TTL window, the original message_id is returned and
// the caller skips re-enqueuing. On expiry or a fresh key, a new mapping
// is written and the caller proceeds to enqueue.
//
// Atomicity: SELECT + INSERT/UPDATE wrapped in a synchronous transaction.
// better-sqlite3 is synchronous, so the window between select and upsert
// is never yielded — the transaction is the correct primitive.

export interface IdempotencyCacheConfig {
  /** Default TTL in seconds for new reservations. Default 3600 (1 hour). */
  defaultTtlSec: number
  /** Clock function, injectable for deterministic tests. Defaults to Date.now. */
  now?: () => number
}

interface IdempotencyRow {
  key: string
  message_id: string
  expires_at: string
}

export class IdempotencyCache {
  private readonly now: () => number
  private stmtGet: Database.Statement<[string], IdempotencyRow> | null = null
  private stmtUpsert: Database.Statement | null = null
  private stmtCleanup: Database.Statement | null = null

  constructor(
    private readonly db: Database.Database,
    private readonly config: IdempotencyCacheConfig,
  ) {
    this.now = config.now ?? (() => Date.now())
  }

  /**
   * Create the idempotency_keys table and supporting index if they do not
   * already exist. Safe to call multiple times (idempotent).
   * Also prepares hot-path statements once (avoids re-prepare on every call).
   */
  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS idempotency_keys (
        key TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires
        ON idempotency_keys(expires_at);
    `)

    this.stmtGet = this.db.prepare<[string], IdempotencyRow>(
      'SELECT key, message_id, expires_at FROM idempotency_keys WHERE key = ?',
    )
    this.stmtUpsert = this.db.prepare(
      `INSERT INTO idempotency_keys (key, message_id, expires_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         message_id = excluded.message_id,
         expires_at = excluded.expires_at`,
    )
    this.stmtCleanup = this.db.prepare(
      'DELETE FROM idempotency_keys WHERE expires_at < ?',
    )
  }

  /** Lazy fallback if checkAndReserve is called before initialize() (defensive). */
  private ensurePrepared(): void {
    if (!this.stmtGet || !this.stmtUpsert || !this.stmtCleanup) this.initialize()
  }

  /**
   * Atomic check-and-reserve.
   *
   * - If the key exists and has NOT expired: cache hit — returns
   *   { hit: true, messageId: <original> }. Caller skips enqueue.
   * - If the key does not exist OR the existing row is expired: cache miss —
   *   upserts the row and returns { hit: false, messageId }. Caller enqueues.
   *
   * @param key          Idempotency key supplied by the upstream client.
   * @param messageId    The message ID the caller intends to use on a miss.
   * @param ttlSec       Per-call override; falls back to config.defaultTtlSec.
   */
  checkAndReserve(
    key: string,
    messageId: string,
    ttlSec?: number,
  ): { hit: boolean; messageId: string } {
    this.ensurePrepared()
    const stmtGet = this.stmtGet!
    const stmtUpsert = this.stmtUpsert!
    const effectiveTtl = ttlSec ?? this.config.defaultTtlSec
    const nowMs = this.now()
    const expiresAt = new Date(nowMs + effectiveTtl * 1000).toISOString()

    return this.db.transaction((): { hit: boolean; messageId: string } => {
      const existing = stmtGet.get(key)
      if (existing && new Date(existing.expires_at).getTime() > nowMs) {
        return { hit: true, messageId: existing.message_id }
      }
      stmtUpsert.run(key, messageId, expiresAt)
      return { hit: false, messageId }
    })()
  }

  /**
   * Delete all rows where expires_at < now.
   * Returns the number of rows deleted.
   */
  cleanupExpired(): number {
    this.ensurePrepared()
    const nowIso = new Date(this.now()).toISOString()
    return this.stmtCleanup!.run(nowIso).changes
  }

  /**
   * Read-only lookup. Returns null for unknown or expired keys.
   * (Does NOT remove expired rows — call cleanupExpired() for that.)
   */
  get(key: string): { key: string; messageId: string; expiresAt: string } | null {
    this.ensurePrepared()
    const row = this.stmtGet!.get(key)
    if (!row) return null
    return { key: row.key, messageId: row.message_id, expiresAt: row.expires_at }
  }
}
