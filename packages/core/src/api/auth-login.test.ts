import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'
import Database from 'better-sqlite3'
import { registerAuthLogin } from './auth-login.js'
import { verifyJwt } from './jwt.js'
import { RefreshTokenStore } from './refresh-token.js'

const CFG = {
  username: 'admin',
  password: 'super-strong-pass',
  jwtSecret: 'jwt-test-secret',
  ttlSeconds: 60,
}

describe('POST /api/v1/auth/login', () => {
  let server: ReturnType<typeof Fastify>

  beforeEach(() => {
    server = Fastify()
    registerAuthLogin(server, CFG)
  })

  afterEach(async () => {
    await server.close()
  })

  it('returns 200 + token + expires_at on correct credentials', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: CFG.username, password: CFG.password },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.sub).toBe(CFG.username)
    expect(typeof body.token).toBe('string')
    expect(typeof body.expires_at).toBe('string')

    const verified = verifyJwt(body.token, CFG.jwtSecret)
    expect(verified.ok).toBe(true)
    if (verified.ok) expect(verified.payload.sub).toBe(CFG.username)
  })

  it('returns 401 on wrong password', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: CFG.username, password: 'wrong' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'invalid_credentials' })
  })

  it('returns 401 on wrong username', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'wronguser', password: CFG.password },
    })
    expect(res.statusCode).toBe(401)
  })

  it('returns 400 on missing fields', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: CFG.username },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_payload' })
  })

  it('returns 400 on empty username/password', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: '', password: '' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('does not leak which field was wrong (status code parity)', async () => {
    const a = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'wrong', password: CFG.password },
    })
    const b = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: CFG.username, password: 'wrong' },
    })
    expect(a.statusCode).toBe(b.statusCode)
    expect(a.json()).toEqual(b.json())
  })
})

describe('POST /api/v1/auth/login — bcrypt hash mode', () => {
  // Precomputed bcrypt hash of 'super-strong-pass' (cost 12). Hard-coded so
  // tests stay deterministic and fast — we never hash inside the test.
  const HASHED_CFG = {
    username: 'admin',
    password: '$2b$12$nLlGo3co/iC0FT.L90/iquJI.TTgZZlegcC67dJ0AempZBUINFv8y',
    jwtSecret: 'jwt-test-secret',
    ttlSeconds: 60,
  }
  const PLAINTEXT_OF_HASHED = 'super-strong-pass'

  let server: ReturnType<typeof Fastify>

  beforeEach(() => {
    server = Fastify()
    registerAuthLogin(server, HASHED_CFG)
  })

  afterEach(async () => {
    await server.close()
  })

  it('returns 200 + token when password is stored as bcrypt hash', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: HASHED_CFG.username, password: PLAINTEXT_OF_HASHED },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.sub).toBe(HASHED_CFG.username)
    expect(typeof body.token).toBe('string')
    const verified = verifyJwt(body.token, HASHED_CFG.jwtSecret)
    expect(verified.ok).toBe(true)
  })

  it('returns 401 on wrong password against bcrypt hash', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: HASHED_CFG.username, password: 'wrong-pass' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'invalid_credentials' })
  })
})

describe('POST /api/v1/auth/login — refresh token issuance (Task 3.4)', () => {
  let server: ReturnType<typeof Fastify>
  let db: Database.Database
  let store: RefreshTokenStore

  beforeEach(() => {
    db = new Database(':memory:')
    store = new RefreshTokenStore(db)
    server = Fastify()
    registerAuthLogin(server, {
      username: 'admin',
      password: 'super-strong-pass',
      jwtSecret: 'jwt-test-secret',
      ttlSeconds: 60,
      refreshTtlSeconds: 120,
      refreshTokenStore: store,
    })
  })

  afterEach(async () => {
    await server.close()
    db.close()
  })

  it('returns refresh_token + refresh_expires_at on successful login', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'admin', password: 'super-strong-pass' },
      headers: { 'user-agent': 'vitest/1.0' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toHaveProperty('token')
    expect(body).toHaveProperty('refresh_token')
    expect(body).toHaveProperty('expires_at')
    expect(body).toHaveProperty('refresh_expires_at')
    expect(body.sub).toBe('admin')
    expect(typeof body.refresh_token).toBe('string')
    expect(body.refresh_token).toMatch(/^[a-f0-9]{64}$/)
  })

  it('persists refresh token with user-agent metadata', async () => {
    await server.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'admin', password: 'super-strong-pass' },
      headers: { 'user-agent': 'vitest/1.0' },
    })
    const rows = db.prepare('SELECT user_agent FROM refresh_tokens WHERE user_id = ?').all('admin') as { user_agent: string | null }[]
    expect(rows.length).toBe(1)
    expect(rows[0].user_agent).toBe('vitest/1.0')
  })

  it('issued refresh token verifies cleanly via the store', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'admin', password: 'super-strong-pass' },
    })
    const body = res.json()
    const v = store.verify(body.refresh_token)
    expect(v.valid).toBe(true)
    if (v.valid) expect(v.userId).toBe('admin')
  })
})
