import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS pasta_locks (
    lock_key       TEXT PRIMARY KEY,
    acquired_by    TEXT NOT NULL,
    acquired_at    TEXT NOT NULL,
    expires_at     TEXT NOT NULL,
    fence_token    INTEGER NOT NULL,
    context_json   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_pasta_locks_expires ON pasta_locks(expires_at);

  CREATE TABLE IF NOT EXISTS pasta_lock_fences (
    lock_key            TEXT PRIMARY KEY,
    next_fence_token    INTEGER NOT NULL DEFAULT 1
  );
`

export interface LockState {
  key: string
  acquiredBy: string
  acquiredAt: Date
  expiresAt: Date
  fenceToken: number
  context: Record<string, unknown> | null
}

export interface LockHandle {
  readonly key: string
  readonly fenceToken: number
  readonly acquiredAt: Date
  readonly expiresAt: Date
  release(): void
  isStillValid(): boolean
}

export class PastaLockManager {
  constructor(private readonly db: Database.Database) {}

  initialize(): void {
    this.db.exec(SCHEMA_SQL)
  }

  acquire(key: string, ttlMs: number, context?: Record<string, unknown>): LockHandle | null {
    const result = this.db.transaction(() => {
      const now = new Date()
      const nowIso = now.toISOString()
      const expiresAt = new Date(now.getTime() + ttlMs)
      const expiresIso = expiresAt.toISOString()

      // Lazy reap stale row for this key only.
      this.db
        .prepare('DELETE FROM pasta_locks WHERE lock_key = ? AND expires_at < ?')
        .run(key, nowIso)

      const existing = this.db
        .prepare('SELECT acquired_by FROM pasta_locks WHERE lock_key = ?')
        .get(key) as { acquired_by: string } | undefined
      if (existing) return null

      // Allocate next fence token (monotonic, persistent).
      this.db
        .prepare(`
          INSERT INTO pasta_lock_fences (lock_key, next_fence_token)
          VALUES (?, 2)
          ON CONFLICT (lock_key) DO UPDATE SET next_fence_token = next_fence_token + 1
        `)
        .run(key)
      const { next_fence_token } = this.db
        .prepare('SELECT next_fence_token FROM pasta_lock_fences WHERE lock_key = ?')
        .get(key) as { next_fence_token: number }
      const fenceToken = next_fence_token - 1

      const workerId = randomUUID()
      this.db
        .prepare(`
          INSERT INTO pasta_locks (lock_key, acquired_by, acquired_at, expires_at, fence_token, context_json)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(key, workerId, nowIso, expiresIso, fenceToken, JSON.stringify(context ?? null))

      return { key, workerId, fenceToken, acquiredAt: now, expiresAt }
    })()

    if (!result) return null
    return {
      key: result.key,
      fenceToken: result.fenceToken,
      acquiredAt: result.acquiredAt,
      expiresAt: result.expiresAt,
      release: () => this.releaseHolder(result.key, result.workerId, result.fenceToken),
      isStillValid: () => this.isHolder(result.key, result.workerId, result.fenceToken),
    }
  }

  async acquireWithWait(
    key: string,
    ttlMs: number,
    opts: { timeoutMs: number; pollMs: number; context?: Record<string, unknown> },
  ): Promise<LockHandle | null> {
    const deadline = Date.now() + opts.timeoutMs
    while (Date.now() < deadline) {
      const handle = this.acquire(key, ttlMs, opts.context)
      if (handle) return handle
      await new Promise((r) => setTimeout(r, opts.pollMs))
    }
    return null
  }

  releaseExpired(): number {
    const result = this.db
      .prepare('DELETE FROM pasta_locks WHERE expires_at < ?')
      .run(new Date().toISOString())
    return result.changes ?? 0
  }

  describe(key: string): LockState | null {
    const row = this.db
      .prepare('SELECT * FROM pasta_locks WHERE lock_key = ?')
      .get(key) as
      | { lock_key: string; acquired_by: string; acquired_at: string; expires_at: string; fence_token: number; context_json: string | null }
      | undefined
    if (!row) return null
    return this.rowToState(row)
  }

  listAll(): LockState[] {
    const rows = this.db
      .prepare('SELECT * FROM pasta_locks WHERE expires_at >= ? ORDER BY acquired_at')
      .all(new Date().toISOString()) as Array<{
        lock_key: string
        acquired_by: string
        acquired_at: string
        expires_at: string
        fence_token: number
        context_json: string | null
      }>
    return rows.map((r) => this.rowToState(r))
  }

  private rowToState(row: {
    lock_key: string
    acquired_by: string
    acquired_at: string
    expires_at: string
    fence_token: number
    context_json: string | null
  }): LockState {
    return {
      key: row.lock_key,
      acquiredBy: row.acquired_by,
      acquiredAt: new Date(row.acquired_at),
      expiresAt: new Date(row.expires_at),
      fenceToken: row.fence_token,
      context: row.context_json ? JSON.parse(row.context_json) : null,
    }
  }

  private releaseHolder(key: string, workerId: string, fenceToken: number): void {
    this.db
      .prepare('DELETE FROM pasta_locks WHERE lock_key = ? AND acquired_by = ? AND fence_token = ?')
      .run(key, workerId, fenceToken)
  }

  private isHolder(key: string, workerId: string, fenceToken: number): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM pasta_locks WHERE lock_key = ? AND acquired_by = ? AND fence_token = ?')
      .get(key, workerId, fenceToken)
    return Boolean(row)
  }
}
