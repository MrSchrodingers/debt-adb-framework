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
  context: object | null
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
}
