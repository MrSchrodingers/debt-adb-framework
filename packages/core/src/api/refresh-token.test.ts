import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { RefreshTokenStore } from './refresh-token.js'

describe('RefreshTokenStore', () => {
  let db: Database.Database
  let store: RefreshTokenStore

  beforeEach(() => {
    db = new Database(':memory:')
    store = new RefreshTokenStore(db)
  })

  afterEach(() => {
    db.close()
  })

  describe('issue()', () => {
    it('returns id, opaque token (~64 hex chars), and ISO expiresAt', () => {
      const issued = store.issue('alice', 60)
      expect(typeof issued.id).toBe('string')
      expect(issued.id.length).toBeGreaterThanOrEqual(16)
      expect(typeof issued.token).toBe('string')
      expect(issued.token).toMatch(/^[a-f0-9]{64}$/)
      expect(typeof issued.expiresAt).toBe('string')
      // ISO 8601
      expect(new Date(issued.expiresAt).toString()).not.toBe('Invalid Date')
    })

    it('persists row with sha256 hash, no plaintext token, revoked_at NULL', () => {
      const { id, token } = store.issue('alice', 60)
      const expectedHash = createHash('sha256').update(token).digest('hex')
      const row = db.prepare(
        'SELECT id, user_id, token_hash, revoked_at FROM refresh_tokens WHERE id = ?',
      ).get(id) as { id: string; user_id: string; token_hash: string; revoked_at: string | null }
      expect(row.id).toBe(id)
      expect(row.user_id).toBe('alice')
      expect(row.token_hash).toBe(expectedHash)
      expect(row.revoked_at).toBeNull()
      // No column should leak the plaintext
      const allCols = db.prepare("SELECT * FROM refresh_tokens WHERE id = ?").get(id) as Record<string, unknown>
      for (const [k, v] of Object.entries(allCols)) {
        if (k === 'token_hash') continue
        expect(v).not.toBe(token)
      }
    })

    it('issues unique tokens across calls', () => {
      const a = store.issue('alice', 60)
      const b = store.issue('alice', 60)
      expect(a.id).not.toBe(b.id)
      expect(a.token).not.toBe(b.token)
    })

    it('records meta (userAgent, ip) when provided', () => {
      const { id } = store.issue('alice', 60, { userAgent: 'curl/8', ip: '10.0.0.1' })
      const row = db.prepare(
        'SELECT user_agent, ip FROM refresh_tokens WHERE id = ?',
      ).get(id) as { user_agent: string | null; ip: string | null }
      expect(row.user_agent).toBe('curl/8')
      expect(row.ip).toBe('10.0.0.1')
    })

    it('uses default 24h TTL when ttlSeconds omitted', () => {
      vi.useFakeTimers()
      const t0 = new Date('2026-01-01T00:00:00.000Z')
      vi.setSystemTime(t0)
      const { expiresAt } = store.issue('alice')
      const delta = new Date(expiresAt).getTime() - t0.getTime()
      vi.useRealTimers()
      expect(delta).toBe(24 * 60 * 60 * 1000)
    })
  })

  describe('verify()', () => {
    it('returns valid=true with userId+id for unrevoked unexpired token', () => {
      const { id, token } = store.issue('alice', 60)
      const v = store.verify(token)
      expect(v.valid).toBe(true)
      if (v.valid) {
        expect(v.userId).toBe('alice')
        expect(v.id).toBe(id)
      }
    })

    it('returns invalid for unknown token', () => {
      const v = store.verify('deadbeef'.repeat(8))
      expect(v).toEqual({ valid: false, reason: 'invalid' })
    })

    it('returns expired when expires_at in past', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      const { token } = store.issue('alice', 60)
      vi.setSystemTime(new Date('2026-01-01T00:02:00Z'))
      const v = store.verify(token)
      vi.useRealTimers()
      expect(v).toEqual({ valid: false, reason: 'expired' })
    })

    it('returns revoked after revoke()', () => {
      const { id, token } = store.issue('alice', 60)
      store.revoke(id)
      const v = store.verify(token)
      expect(v).toEqual({ valid: false, reason: 'revoked' })
    })

    it('updates last_used_at on successful verify', () => {
      const { id, token } = store.issue('alice', 60)
      const before = db.prepare('SELECT last_used_at FROM refresh_tokens WHERE id = ?').get(id) as { last_used_at: string | null }
      expect(before.last_used_at).toBeNull()
      store.verify(token)
      const after = db.prepare('SELECT last_used_at FROM refresh_tokens WHERE id = ?').get(id) as { last_used_at: string | null }
      expect(after.last_used_at).not.toBeNull()
    })
  })

  describe('revoke()', () => {
    it('marks token revoked_at and is idempotent', () => {
      const { id, token } = store.issue('alice', 60)
      store.revoke(id)
      const row1 = db.prepare('SELECT revoked_at FROM refresh_tokens WHERE id = ?').get(id) as { revoked_at: string | null }
      expect(row1.revoked_at).not.toBeNull()
      // second revoke must not overwrite the timestamp
      const firstTs = row1.revoked_at!
      store.revoke(id)
      const row2 = db.prepare('SELECT revoked_at FROM refresh_tokens WHERE id = ?').get(id) as { revoked_at: string | null }
      expect(row2.revoked_at).toBe(firstTs)
      // verify rejects
      const v = store.verify(token)
      expect(v.valid).toBe(false)
    })
  })

  describe('rotate()', () => {
    it('verifies, revokes old, and issues new — atomically', () => {
      const old = store.issue('alice', 60)
      const out = store.rotate(old.token, 60)
      expect(out.result.valid).toBe(true)
      expect(out.newToken).toBeDefined()
      expect(out.newToken!.token).not.toBe(old.token)
      // old now invalid
      const reverify = store.verify(old.token)
      expect(reverify.valid).toBe(false)
      expect(reverify.valid === false && reverify.reason).toBe('revoked')
      // new is valid
      const newVerify = store.verify(out.newToken!.token)
      expect(newVerify.valid).toBe(true)
    })

    it('returns invalid result without issuing when token unknown', () => {
      const out = store.rotate('deadbeef'.repeat(8), 60)
      expect(out.result.valid).toBe(false)
      expect(out.newToken).toBeUndefined()
    })

    it('returns expired without issuing when token expired', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      const { token } = store.issue('alice', 60)
      vi.setSystemTime(new Date('2026-01-01T00:02:00Z'))
      const out = store.rotate(token, 60)
      vi.useRealTimers()
      expect(out.result.valid).toBe(false)
      expect(out.newToken).toBeUndefined()
    })
  })

  describe('listForUser()', () => {
    it('returns only active (non-revoked, non-expired) tokens for user', () => {
      const a = store.issue('alice', 60, { userAgent: 'A', ip: '1.1.1.1' })
      store.issue('alice', 60, { userAgent: 'B' })
      const c = store.issue('alice', 60)
      store.issue('bob', 60)
      store.revoke(c.id)

      const active = store.listForUser('alice')
      const ids = active.map((r) => r.id)
      expect(ids).toContain(a.id)
      expect(ids).not.toContain(c.id) // revoked
      expect(active.every((r) => r.expiresAt && r.issuedAt)).toBe(true)
      // shape sanity
      const aRow = active.find((r) => r.id === a.id)!
      expect(aRow.userAgent).toBe('A')
      expect(aRow.ip).toBe('1.1.1.1')
    })

    it('excludes expired tokens', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      const { id } = store.issue('alice', 60)
      vi.setSystemTime(new Date('2026-01-01T00:02:00Z'))
      const active = store.listForUser('alice')
      vi.useRealTimers()
      expect(active.find((r) => r.id === id)).toBeUndefined()
    })
  })
})
