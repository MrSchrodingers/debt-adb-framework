import { timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { signJwt } from './jwt.js'
import { verifyPassword } from './password-hash.js'
import type { RefreshTokenStore } from './refresh-token.js'

const LoginSchema = z.object({
  username: z.string().min(1).max(120),
  password: z.string().min(1).max(512),
})

export interface AuthLoginConfig {
  username: string
  password: string
  jwtSecret: string
  /**
   * Access-token TTL in seconds. Default 15 minutes — short-lived, paired
   * with a 24h refresh token for the auto-refresh flow (Task 3.4).
   */
  ttlSeconds?: number
  /**
   * Refresh-token TTL in seconds. Default 24h.
   */
  refreshTtlSeconds?: number
  /**
   * Refresh token store. When supplied, the response includes a
   * `refresh_token` + `refresh_expires_at` pair. When omitted, the route
   * still works but only returns the short-lived access token (kept for
   * backward compat with tests that don't care about refresh).
   */
  refreshTokenStore?: RefreshTokenStore
}

/**
 * Constant-time compare on byte buffers, length-aware (timingSafeEqual itself
 * throws on length mismatch — wrap it).
 */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/**
 * Public login endpoint. Mounted only when DISPATCH_AUTH_USER, DISPATCH_AUTH_PASSWORD
 * and DISPATCH_JWT_SECRET are all set; otherwise the gate is bypassed entirely
 * (dev mode parity with DISPATCH_API_KEY).
 *
 * Always returns within roughly the same time regardless of which check failed
 * to avoid leaking which input was wrong. We always call `verifyPassword`
 * (which dominates timing via bcrypt cost) even when the username does not
 * match, then combine the booleans at the end.
 */
export function registerAuthLogin(server: FastifyInstance, cfg: AuthLoginConfig): void {
  const ttl = cfg.ttlSeconds ?? 15 * 60
  const refreshTtl = cfg.refreshTtlSeconds ?? 24 * 60 * 60

  server.post('/api/v1/auth/login', async (request, reply) => {
    const parsed = LoginSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_payload' })
    }

    const userOk = safeEqual(parsed.data.username, cfg.username)
    const passOk = await verifyPassword(parsed.data.password, cfg.password)
    if (!userOk || !passOk) {
      return reply.status(401).send({ error: 'invalid_credentials' })
    }

    const token = signJwt({ sub: cfg.username }, cfg.jwtSecret, ttl)
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString()

    if (cfg.refreshTokenStore) {
      const userAgent = (request.headers['user-agent'] as string | undefined) ?? undefined
      const ip = request.ip
      const refresh = cfg.refreshTokenStore.issue(cfg.username, refreshTtl, { userAgent, ip })
      return reply.send({
        token,
        refresh_token: refresh.token,
        expires_at: expiresAt,
        refresh_expires_at: refresh.expiresAt,
        sub: cfg.username,
      })
    }

    return reply.send({ token, expires_at: expiresAt, sub: cfg.username })
  })
}
