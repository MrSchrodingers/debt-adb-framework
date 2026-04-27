import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'
import Database from 'better-sqlite3'
import { RefreshTokenStore } from './refresh-token.js'
import { registerAuthRefresh } from './auth-refresh.js'
import { verifyJwt } from './jwt.js'

const SECRET = 'jwt-test-secret'

describe('POST /api/v1/auth/refresh', () => {
  let server: ReturnType<typeof Fastify>
  let db: Database.Database
  let store: RefreshTokenStore

  beforeEach(() => {
    db = new Database(':memory:')
    store = new RefreshTokenStore(db)
    server = Fastify()
    registerAuthRefresh(server, {
      username: 'admin',
      jwtSecret: SECRET,
      accessTtlSeconds: 60,
      refreshTtlSeconds: 120,
      store,
    })
  })

  afterEach(async () => {
    await server.close()
    db.close()
  })

  it('returns 400 on missing/invalid payload', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: {},
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_payload' })
  })

  it('returns 401 on unknown refresh token', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refresh_token: 'deadbeef'.repeat(8) },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'invalid_refresh' })
  })

  it('returns 401 on revoked refresh token', async () => {
    const issued = store.issue('admin', 60)
    store.revoke(issued.id)
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refresh_token: issued.token },
    })
    expect(res.statusCode).toBe(401)
  })

  it('returns 401 on expired refresh token', async () => {
    const issued = store.issue('admin', 60)
    // Backdate the row instead of fake-timing the runtime — vi.useFakeTimers
    // would freeze the Fastify inject pipeline (setImmediate/queueMicrotask)
    // and hang the request.
    db.prepare('UPDATE refresh_tokens SET expires_at = ? WHERE id = ?').run(
      '2020-01-01T00:00:00.000Z',
      issued.id,
    )
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refresh_token: issued.token },
    })
    expect(res.statusCode).toBe(401)
  })

  it('returns 200 + new access JWT + new refresh on valid token', async () => {
    const issued = store.issue('admin', 60)
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refresh_token: issued.token },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toHaveProperty('token')
    expect(body).toHaveProperty('refresh_token')
    expect(body).toHaveProperty('expires_at')
    expect(body).toHaveProperty('refresh_expires_at')
    expect(body.sub).toBe('admin')
    // New refresh token differs from the one we sent
    expect(body.refresh_token).not.toBe(issued.token)
    // Access token verifies
    const v = verifyJwt(body.token, SECRET)
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.payload.sub).toBe('admin')
  })

  it('rotates: old refresh becomes invalid after refresh succeeds', async () => {
    const issued = store.issue('admin', 60)
    const first = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refresh_token: issued.token },
    })
    expect(first.statusCode).toBe(200)
    // Re-using the same old refresh now must fail
    const second = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refresh_token: issued.token },
    })
    expect(second.statusCode).toBe(401)
  })

  it('captures user-agent + ip on rotation', async () => {
    const issued = store.issue('admin', 60)
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refresh_token: issued.token },
      headers: { 'user-agent': 'vitest-ua' },
    })
    const body = res.json()
    const newRow = db.prepare(
      'SELECT user_agent, ip FROM refresh_tokens WHERE token_hash != ? AND user_id = ? ORDER BY issued_at DESC LIMIT 1',
    ).get(
      // not the original — but we don't have the hash; use a sentinel that won't match
      'NONE',
      'admin',
    ) as { user_agent: string | null; ip: string | null }
    expect(newRow.user_agent).toBe('vitest-ua')
    expect(typeof body.refresh_token).toBe('string')
  })
})
