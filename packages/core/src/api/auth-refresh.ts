import { z } from 'zod'
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { signJwt } from './jwt.js'
import type { RefreshTokenStore } from './refresh-token.js'
import type { RateLimitOptions } from '@fastify/rate-limit'

const RefreshSchema = z.object({
  refresh_token: z.string().min(1).max(512),
})

export interface AuthRefreshConfig {
  /**
   * Used as the JWT `sub` claim and as the user identity binding when no
   * multi-user system exists. Must match what /auth/login issued for.
   * (Currently single-user — see `DISPATCH_AUTH_USER`.)
   */
  username: string
  jwtSecret: string
  /** Default 15 minutes. */
  accessTtlSeconds?: number
  /** Default 24h. */
  refreshTtlSeconds?: number
  store: RefreshTokenStore
  /**
   * Task 11.1: optional route-level rate limit config.
   * When omitted, no rate limit is applied on this route (useful in tests
   * where @fastify/rate-limit is not registered).
   */
  rateLimitConfig?: RateLimitOptions
}

/**
 * POST /api/v1/auth/refresh — exchanges an opaque refresh token for a fresh
 * access JWT and a rotated refresh token. The refresh row is revoked atomically
 * within the same SQLite transaction as the new issue (see RefreshTokenStore.rotate)
 * so a leaked token cannot be reused once a refresh has been observed.
 *
 * Public route: must be added to PUBLIC_ROUTES in api-auth.ts because the
 * caller's access JWT will already be expired by the time it hits this
 * endpoint (that's the whole point).
 */
export function registerAuthRefresh(server: FastifyInstance, cfg: AuthRefreshConfig): void {
  const accessTtl = cfg.accessTtlSeconds ?? 15 * 60
  const refreshTtl = cfg.refreshTtlSeconds ?? 24 * 60 * 60

  const handler = async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = RefreshSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_payload' })
    }

    const userAgent = (request.headers['user-agent'] as string | undefined) ?? undefined
    const ip = request.ip
    const { result, newToken } = cfg.store.rotate(parsed.data.refresh_token, refreshTtl, { userAgent, ip })
    if (!result.valid || !newToken) {
      return reply.status(401).send({ error: 'invalid_refresh' })
    }

    const accessToken = signJwt({ sub: result.userId }, cfg.jwtSecret, accessTtl)
    const expiresAt = new Date(Date.now() + accessTtl * 1000).toISOString()
    return reply.send({
      token: accessToken,
      refresh_token: newToken.token,
      expires_at: expiresAt,
      refresh_expires_at: newToken.expiresAt,
      sub: result.userId,
    })
  }

  server.route({
    method: 'POST',
    url: '/api/v1/auth/refresh',
    config: cfg.rateLimitConfig ? { rateLimit: cfg.rateLimitConfig } : {},
    handler,
  })
}
