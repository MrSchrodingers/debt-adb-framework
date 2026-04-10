import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import { buildCorsOrigins } from './cors.js'

describe('CORS configuration', () => {
  describe('buildCorsOrigins', () => {
    it('includes localhost:5173 and localhost:7890 by default', () => {
      const origins = buildCorsOrigins()
      expect(origins).toContain('http://localhost:5173')
      expect(origins).toContain('http://localhost:7890')
    })

    it('includes extra origins from DISPATCH_ALLOWED_ORIGINS', () => {
      const origins = buildCorsOrigins('https://app.example.com,https://admin.example.com')
      expect(origins).toContain('http://localhost:5173')
      expect(origins).toContain('http://localhost:7890')
      expect(origins).toContain('https://app.example.com')
      expect(origins).toContain('https://admin.example.com')
    })

    it('trims whitespace from extra origins', () => {
      const origins = buildCorsOrigins(' https://a.com , https://b.com ')
      expect(origins).toContain('https://a.com')
      expect(origins).toContain('https://b.com')
    })

    it('ignores empty strings in extra origins', () => {
      const origins = buildCorsOrigins(',,https://a.com,,')
      expect(origins).toHaveLength(4) // localhost:5173, localhost:5174, localhost:7890, https://a.com
    })
  })

  describe('Fastify CORS integration', () => {
    let server: ReturnType<typeof Fastify>

    beforeEach(async () => {
      server = Fastify()
      await server.register(cors, {
        origin: buildCorsOrigins(),
      })
      server.get('/api/v1/health', async () => ({ status: 'ok' }))
    })

    afterEach(async () => {
      await server.close()
    })

    it('returns CORS headers for allowed origin', async () => {
      const res = await server.inject({
        method: 'OPTIONS',
        url: '/api/v1/health',
        headers: {
          origin: 'http://localhost:5173',
          'access-control-request-method': 'GET',
        },
      })
      expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173')
    })

    it('does not return CORS headers for disallowed origin', async () => {
      const res = await server.inject({
        method: 'OPTIONS',
        url: '/api/v1/health',
        headers: {
          origin: 'https://evil.com',
          'access-control-request-method': 'GET',
        },
      })
      // @fastify/cors with array of origins returns no access-control-allow-origin for unmatched
      expect(res.headers['access-control-allow-origin']).toBeUndefined()
    })
  })
})
