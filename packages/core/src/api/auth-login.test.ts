import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'
import { registerAuthLogin } from './auth-login.js'
import { verifyJwt } from './jwt.js'

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
