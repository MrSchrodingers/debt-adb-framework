import { createHash, randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'

const DEFAULT_TTL_SECONDS = 24 * 60 * 60 // 24h

export interface IssueMeta {
  userAgent?: string
  ip?: string
}

export interface IssuedToken {
  id: string
  token: string
  expiresAt: string
}

export type VerifyResult =
  | { valid: true; id: string; userId: string }
  | { valid: false; reason: 'invalid' | 'expired' | 'revoked' }

interface RawRow {
  id: string
  user_id: string
  expires_at: string
  revoked_at: string | null
}

interface ActiveTokenRow {
  id: string
  issuedAt: string
  expiresAt: string
  lastUsedAt: string | null
  userAgent: string | null
  ip: string | null
}

/**
 * Opaque (non-JWT) refresh token store backed by SQLite. Tokens are 32-byte
 * random hex strings (64 chars) issued to a user; only the sha256 hash is
 * persisted. Verification = lookup by hash, status check, refresh of
 * `last_used_at`. Rotation revokes the old row and issues a fresh one inside
 * a SQLite transaction so concurrent refresh calls cannot both succeed.
 *
 * Schema is created inline at construction time (CREATE TABLE IF NOT EXISTS)
 * to follow the convention of other modules (HealthCollector, DeviceManager,
 * SenderMapping). No external migrations file.
 */
export class RefreshTokenStore {
  constructor(private db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        issued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        last_used_at TEXT,
        user_agent TEXT,
        ip TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id, revoked_at);
      CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expiry ON refresh_tokens(expires_at);
    `)
  }

  issue(userId: string, ttlSeconds: number = DEFAULT_TTL_SECONDS, meta: IssueMeta = {}): IssuedToken {
    const id = randomBytes(16).toString('hex')
    const token = randomBytes(32).toString('hex')
    const tokenHash = createHash('sha256').update(token).digest('hex')
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString()
    this.db
      .prepare(
        `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, user_agent, ip)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, userId, tokenHash, expiresAt, meta.userAgent ?? null, meta.ip ?? null)
    return { id, token, expiresAt }
  }

  verify(token: string): VerifyResult {
    const tokenHash = createHash('sha256').update(token).digest('hex')
    const row = this.db
      .prepare(
        `SELECT id, user_id, expires_at, revoked_at FROM refresh_tokens WHERE token_hash = ?`,
      )
      .get(tokenHash) as RawRow | undefined
    if (!row) return { valid: false, reason: 'invalid' }
    if (row.revoked_at) return { valid: false, reason: 'revoked' }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      return { valid: false, reason: 'expired' }
    }
    this.db
      .prepare(
        `UPDATE refresh_tokens SET last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
      )
      .run(row.id)
    return { valid: true, id: row.id, userId: row.user_id }
  }

  revoke(id: string): void {
    this.db
      .prepare(
        `UPDATE refresh_tokens
         SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ? AND revoked_at IS NULL`,
      )
      .run(id)
  }

  /**
   * Atomic rotate: verify(old) -> revoke(old.id) -> issue(new). Wrapped in a
   * SQLite transaction so a concurrent refresh racing on the same token
   * sees the revoked_at marker on the second call.
   */
  rotate(
    token: string,
    ttlSeconds: number = DEFAULT_TTL_SECONDS,
    meta: IssueMeta = {},
  ): { result: VerifyResult; newToken?: IssuedToken } {
    const tx = this.db.transaction(() => {
      const v = this.verify(token)
      if (!v.valid) return { result: v }
      this.revoke(v.id)
      const newToken = this.issue(v.userId, ttlSeconds, meta)
      return { result: v, newToken }
    })
    return tx() as { result: VerifyResult; newToken?: IssuedToken }
  }

  listForUser(userId: string): ActiveTokenRow[] {
    return this.db
      .prepare(
        `SELECT id,
                issued_at   AS issuedAt,
                expires_at  AS expiresAt,
                last_used_at AS lastUsedAt,
                user_agent  AS userAgent,
                ip
         FROM refresh_tokens
         WHERE user_id = ?
           AND revoked_at IS NULL
           AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         ORDER BY issued_at DESC`,
      )
      .all(userId) as ActiveTokenRow[]
  }
}
