/**
 * Task 11.2 — HMAC verification flag tests.
 *
 * Verifies the PLUGIN_<NAME>_HMAC_REQUIRED env flag behaviour:
 *  - true  → requests without X-Dispatch-Signature → 401
 *  - false → requests without X-Dispatch-Signature → pass through (warning logged)
 *
 * The logic lives in the dynamic plugin-route handler in server.ts.
 * We replicate that handler in isolation to avoid spinning up the full
 * createServer() (which requires ADB, SQLite path, etc.).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHmac, timingSafeEqual } from 'node:crypto'
import Fastify from 'fastify'

const HMAC_SECRET = 'test-hmac-secret-32-bytes-long!!'
const API_KEY = 'test-api-key-for-oralsin'

/**
 * Registers a minimal plugin route that mirrors the HMAC-check logic from
 * server.ts. The `hmacRequired` flag corresponds to
 * PLUGIN_ORALSIN_HMAC_REQUIRED in production.
 */
function registerPluginRoute(
  server: ReturnType<typeof Fastify>,
  opts: { hmacRequired: boolean },
) {
  server.post('/api/v1/plugins/oralsin/enqueue', async (req, reply) => {
    // Simplified auth: accept X-Api-Key only (no JWT in unit test)
    const providedKey = (req.headers as Record<string, string>)['x-api-key'] ?? ''
    if (
      providedKey.length !== API_KEY.length ||
      !timingSafeEqual(Buffer.from(providedKey), Buffer.from(API_KEY))
    ) {
      return reply.status(401).send({ error: 'Invalid API key' })
    }

    // Mirror the Task 11.2 HMAC logic from server.ts
    const reqMethod = req.method.toUpperCase()
    if (reqMethod === 'POST' || reqMethod === 'PUT' || reqMethod === 'PATCH') {
      const provided = (req.headers as Record<string, string>)['x-dispatch-signature'] ?? ''
      if (opts.hmacRequired) {
        const rawBody = (req as unknown as { rawBody?: string }).rawBody ?? JSON.stringify(req.body) ?? ''
        const expected =
          'sha256=' + createHmac('sha256', HMAC_SECRET).update(rawBody).digest('hex')
        if (
          provided.length !== expected.length ||
          !timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
        ) {
          return reply.status(401).send({ error: 'Invalid HMAC signature' })
        }
      }
      // else: missing signature is allowed (warning would be logged in production)
    }

    return reply.status(200).send({ ok: true })
  })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Task 11.2: HMAC_REQUIRED=true — rejects unsigned requests', () => {
  let server: ReturnType<typeof Fastify>

  beforeEach(async () => {
    server = Fastify({ logger: false })
    registerPluginRoute(server, { hmacRequired: true })
    await server.ready()
  })

  afterEach(async () => {
    await server.close()
  })

  it('returns 401 when X-Dispatch-Signature is absent', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/plugins/oralsin/enqueue',
      headers: { 'x-api-key': API_KEY },
      payload: { to: '5543991938235', message: 'test' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'Invalid HMAC signature' })
  })

  it('returns 401 when X-Dispatch-Signature is wrong', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/plugins/oralsin/enqueue',
      headers: {
        'x-api-key': API_KEY,
        'x-dispatch-signature': 'sha256=deadbeef',
      },
      payload: { to: '5543991938235', message: 'test' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'Invalid HMAC signature' })
  })

  it('returns 200 when X-Dispatch-Signature is correct', async () => {
    const body = JSON.stringify({ to: '5543991938235', message: 'test' })
    const sig = 'sha256=' + createHmac('sha256', HMAC_SECRET).update(body).digest('hex')

    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/plugins/oralsin/enqueue',
      headers: {
        'x-api-key': API_KEY,
        'x-dispatch-signature': sig,
        'content-type': 'application/json',
      },
      body,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
  })
})

describe('Task 11.2: HMAC_REQUIRED=false — unsigned requests pass through', () => {
  let server: ReturnType<typeof Fastify>

  beforeEach(async () => {
    server = Fastify({ logger: false })
    registerPluginRoute(server, { hmacRequired: false })
    await server.ready()
  })

  afterEach(async () => {
    await server.close()
  })

  it('returns 200 when X-Dispatch-Signature is absent (backward compat)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/plugins/oralsin/enqueue',
      headers: { 'x-api-key': API_KEY },
      payload: { to: '5543991938235', message: 'test' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
  })

  it('also accepts correctly-signed requests when flag is false', async () => {
    const body = JSON.stringify({ to: '5543991938235', message: 'test' })
    const sig = 'sha256=' + createHmac('sha256', HMAC_SECRET).update(body).digest('hex')

    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/plugins/oralsin/enqueue',
      headers: {
        'x-api-key': API_KEY,
        'x-dispatch-signature': sig,
        'content-type': 'application/json',
      },
      body,
    })
    expect(res.statusCode).toBe(200)
  })
})
