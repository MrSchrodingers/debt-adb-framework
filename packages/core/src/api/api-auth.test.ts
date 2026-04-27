import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Fastify from 'fastify'
import { registerApiAuth } from './api-auth.js'

describe('API Auth Hook', () => {
  let server: ReturnType<typeof Fastify>

  beforeEach(async () => {
    server = Fastify()
    // Register test routes to verify auth behavior
    server.get('/api/v1/health', async () => ({ status: 'ok' }))
    server.post('/api/v1/webhooks/waha', async () => ({ received: true }))
    server.get('/api/v1/messages', async () => ([]))
    server.post('/api/v1/messages', async () => ({ id: 'test' }))
    server.get('/api/v1/admin/plugins', async () => ([]))
  })

  afterEach(async () => {
    await server.close()
  })

  describe('when DISPATCH_API_KEY is set', () => {
    beforeEach(() => {
      registerApiAuth(server, 'test-secret-key')
    })

    it('rejects requests without X-API-Key header', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/messages',
      })
      expect(res.statusCode).toBe(401)
      expect(res.json()).toEqual({ error: 'Unauthorized' })
    })

    it('rejects requests with wrong X-API-Key', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/messages',
        headers: { 'x-api-key': 'wrong-key' },
      })
      expect(res.statusCode).toBe(401)
      expect(res.json()).toEqual({ error: 'Unauthorized' })
    })

    it('accepts requests with correct X-API-Key', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/messages',
        headers: { 'x-api-key': 'test-secret-key' },
      })
      expect(res.statusCode).toBe(200)
    })

    it('allows GET /api/v1/health without key (public)', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/health',
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ status: 'ok' })
    })

    it('allows POST /api/v1/webhooks/waha without key (has own HMAC auth)', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/webhooks/waha',
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ received: true })
    })

    it('rejects POST /api/v1/messages without key', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/messages',
      })
      expect(res.statusCode).toBe(401)
    })

    it('rejects admin routes without key', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/admin/plugins',
      })
      expect(res.statusCode).toBe(401)
    })
  })

  describe('when DISPATCH_API_KEY is empty (dev mode)', () => {
    beforeEach(() => {
      registerApiAuth(server, '')
    })

    it('allows all requests without key (auth disabled)', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/messages',
      })
      expect(res.statusCode).toBe(200)
    })
  })

  describe('when DISPATCH_API_KEY is undefined (dev mode)', () => {
    beforeEach(() => {
      registerApiAuth(server, undefined)
    })

    it('allows all requests without key (auth disabled)', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/messages',
      })
      expect(res.statusCode).toBe(200)
    })
  })

  describe('Bearer JWT auth (UI login flow)', () => {
    const SECRET = 'jwt-secret-test'

    beforeEach(() => {
      registerApiAuth(server, { apiKey: 'test-secret-key', jwtSecret: SECRET })
    })

    it('accepts a valid Bearer JWT in lieu of X-API-Key', async () => {
      const { signJwt } = await import('./jwt.js')
      const token = signJwt({ sub: 'admin' }, SECRET, 60)
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/messages',
        headers: { authorization: `Bearer ${token}` },
      })
      expect(res.statusCode).toBe(200)
    })

    it('rejects an expired Bearer JWT', async () => {
      const { signJwt } = await import('./jwt.js')
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      const token = signJwt({ sub: 'admin' }, SECRET, 60)
      vi.setSystemTime(new Date('2026-01-01T00:02:00Z'))
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/messages',
        headers: { authorization: `Bearer ${token}` },
      })
      vi.useRealTimers()
      expect(res.statusCode).toBe(401)
      expect(res.json().reason).toBe('expired')
    })

    it('rejects a Bearer JWT signed with the wrong secret', async () => {
      const { signJwt } = await import('./jwt.js')
      const token = signJwt({ sub: 'admin' }, 'other-secret', 60)
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/messages',
        headers: { authorization: `Bearer ${token}` },
      })
      expect(res.statusCode).toBe(401)
      expect(res.json().reason).toBe('bad_signature')
    })

    it('still accepts X-API-Key when Bearer is absent', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/messages',
        headers: { 'x-api-key': 'test-secret-key' },
      })
      expect(res.statusCode).toBe(200)
    })

    it('allows POST /api/v1/auth/login as a public route', async () => {
      server.post('/api/v1/auth/login', async () => ({ token: 'fake' }))
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username: 'a', password: 'b' },
      })
      expect(res.statusCode).toBe(200)
    })
  })
})
