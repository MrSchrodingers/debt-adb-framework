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
})
