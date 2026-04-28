/**
 * Task 11.1 — @fastify/rate-limit integration tests.
 *
 * Uses app.inject() for in-process requests — no real TCP, no timers.
 * The plugin stores counts in-memory (default store), so each describe block
 * gets a fresh server instance to avoid cross-test pollution.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'
import fastifyRateLimit from '@fastify/rate-limit'
import Database from 'better-sqlite3'
import { registerAuthLogin } from './auth-login.js'
import { registerAuthRefresh } from './auth-refresh.js'
import { RefreshTokenStore } from './refresh-token.js'

// ── helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal Fastify server with @fastify/rate-limit registered (global:false). */
async function buildServer() {
  const server = Fastify({
    // Suppress pino output in tests
    logger: false,
  })
  await server.register(fastifyRateLimit, {
    global: false,
    max: 60,
    timeWindow: '1 minute',
    keyGenerator: (req) => {
      const xff = (req.headers['x-forwarded-for'] as string | undefined)
        ?.split(',')[0]
        ?.trim()
      return xff ?? req.ip
    },
  })
  return server
}

// ── POST /api/v1/auth/login — 5/min per IP ───────────────────────────────────

describe('rate-limit: POST /api/v1/auth/login', () => {
  let server: ReturnType<typeof Fastify>

  beforeEach(async () => {
    server = await buildServer()
    registerAuthLogin(server, {
      username: 'admin',
      password: 'super-strong-pass',
      jwtSecret: 'jwt-test-secret',
      ttlSeconds: 60,
      rateLimitConfig: { max: 5, timeWindow: '1 minute' },
    })
    await server.ready()
  })

  afterEach(async () => {
    await server.close()
  })

  it('allows up to 5 requests and blocks the 6th with 429', async () => {
    const payload = { username: 'admin', password: 'wrong-pass' }
    const headers = { 'x-forwarded-for': '10.0.0.1' }

    for (let i = 0; i < 5; i++) {
      const res = await server.inject({ method: 'POST', url: '/api/v1/auth/login', payload, headers })
      // Should be 401 (wrong password), NOT 429
      expect(res.statusCode).toBe(401)
    }

    // 6th request from same IP must be rate-limited
    const blocked = await server.inject({ method: 'POST', url: '/api/v1/auth/login', payload, headers })
    expect(blocked.statusCode).toBe(429)
  })

  it('tracks different IPs independently', async () => {
    const payload = { username: 'admin', password: 'wrong-pass' }

    // Exhaust limit for IP-A
    for (let i = 0; i < 5; i++) {
      await server.inject({ method: 'POST', url: '/api/v1/auth/login', payload, headers: { 'x-forwarded-for': '10.0.0.2' } })
    }
    const blockedA = await server.inject({ method: 'POST', url: '/api/v1/auth/login', payload, headers: { 'x-forwarded-for': '10.0.0.2' } })
    expect(blockedA.statusCode).toBe(429)

    // IP-B is unaffected
    const allowedB = await server.inject({ method: 'POST', url: '/api/v1/auth/login', payload, headers: { 'x-forwarded-for': '10.0.0.3' } })
    expect(allowedB.statusCode).toBe(401) // Auth error, NOT rate limit
  })

  it('429 response includes Retry-After header', async () => {
    const payload = { username: 'admin', password: 'wrong-pass' }
    const headers = { 'x-forwarded-for': '10.0.0.4' }

    for (let i = 0; i < 5; i++) {
      await server.inject({ method: 'POST', url: '/api/v1/auth/login', payload, headers })
    }
    const blocked = await server.inject({ method: 'POST', url: '/api/v1/auth/login', payload, headers })
    expect(blocked.statusCode).toBe(429)
    expect(blocked.headers['retry-after']).toBeDefined()
  })
})

// ── POST /api/v1/auth/refresh — 60/min per IP ────────────────────────────────

describe('rate-limit: POST /api/v1/auth/refresh', () => {
  let server: ReturnType<typeof Fastify>
  let db: Database.Database
  let store: RefreshTokenStore

  beforeEach(async () => {
    db = new Database(':memory:')
    store = new RefreshTokenStore(db)
    server = await buildServer()
    registerAuthRefresh(server, {
      username: 'admin',
      jwtSecret: 'jwt-test-secret',
      accessTtlSeconds: 60,
      refreshTtlSeconds: 120,
      store,
      rateLimitConfig: { max: 60, timeWindow: '1 minute' },
    })
    await server.ready()
  })

  afterEach(async () => {
    await server.close()
    db.close()
  })

  it('allows first 60 requests and blocks the 61st', async () => {
    const payload = { refresh_token: 'invalid-token-payload' }
    const headers = { 'x-forwarded-for': '10.1.0.1' }

    for (let i = 0; i < 60; i++) {
      const res = await server.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload, headers })
      // 401 because token is invalid, but NOT 429 yet
      expect(res.statusCode).toBe(401)
    }

    // 61st must be blocked
    const blocked = await server.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload, headers })
    expect(blocked.statusCode).toBe(429)
  })
})

// ── Generic plugin route — /enqueue keyed by API key ─────────────────────────

describe('rate-limit: plugin /enqueue — keyed by X-Api-Key', () => {
  it('applies rate limit config on plugin enqueue routes', async () => {
    const server = await buildServer()

    // Register a minimal stand-in for /enqueue with rate limit keyed by API key
    server.route({
      method: 'POST',
      url: '/api/v1/plugins/oralsin/enqueue',
      config: {
        rateLimit: {
          max: 3,
          timeWindow: '1 minute',
          keyGenerator: (req: import('fastify').FastifyRequest): string =>
            (req.headers as Record<string, string>)['x-api-key'] ?? req.ip,
        },
      },
      handler: async (_req, reply) => reply.status(200).send({ ok: true }),
    })
    await server.ready()

    const headers = { 'x-api-key': 'test-plugin-key' }

    for (let i = 0; i < 3; i++) {
      const res = await server.inject({ method: 'POST', url: '/api/v1/plugins/oralsin/enqueue', headers })
      expect(res.statusCode).toBe(200)
    }

    // 4th request from same API key must be blocked
    const blocked = await server.inject({ method: 'POST', url: '/api/v1/plugins/oralsin/enqueue', headers })
    expect(blocked.statusCode).toBe(429)

    // Different API key is unaffected
    const different = await server.inject({ method: 'POST', url: '/api/v1/plugins/oralsin/enqueue', headers: { 'x-api-key': 'other-key' } })
    expect(different.statusCode).toBe(200)

    await server.close()
  })
})
