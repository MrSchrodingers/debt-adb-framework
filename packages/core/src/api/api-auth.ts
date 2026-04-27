import { timingSafeEqual } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { verifyJwt } from './jwt.js'

const PUBLIC_ROUTES = [
  '/api/v1/health',
  '/healthz',            // legacy/k8s-style probe used by Caddy and external monitors
  '/api/v1/auth/login',  // Login is the only way to get a JWT in the first place
  '/api/v1/auth/refresh', // Task 3.4: caller's access JWT may already be expired
  // S13: /metrics removed — now requires API key (Decision #12)
]

const PUBLIC_PREFIXES = [
  '/api/v1/webhooks/waha',
  '/api/v1/plugins/',  // Plugin routes have their own auth via plugin-specific API key
]

function isPublicRoute(url: string): boolean {
  // Strip query string for prefix/exact matching
  const path = url.split('?')[0]
  for (const route of PUBLIC_ROUTES) {
    if (path === route) return true
  }
  for (const prefix of PUBLIC_PREFIXES) {
    if (path.startsWith(prefix)) return true
  }
  return false
}

export interface ApiAuthConfig {
  /** Static API key for service-to-service callers (existing behavior). */
  apiKey?: string
  /** HMAC secret used to verify JWTs issued by /api/v1/auth/login. */
  jwtSecret?: string
}

/**
 * Auth gate for /api/v1/* (excluding PUBLIC_ROUTES / PUBLIC_PREFIXES).
 *
 * A request is allowed if EITHER:
 *   - X-API-Key (or `?key=` query param) matches the configured apiKey, OR
 *   - Authorization: Bearer <jwt> verifies against jwtSecret and is unexpired.
 *
 * If neither apiKey nor jwtSecret is configured, the gate is disabled
 * (dev mode parity with the original behavior).
 */
export function registerApiAuth(server: FastifyInstance, config: ApiAuthConfig | string | undefined): void {
  // Backward-compat: a bare string was the API key in the original signature.
  const cfg: ApiAuthConfig = typeof config === 'string' ? { apiKey: config } : (config ?? {})
  if (!cfg.apiKey && !cfg.jwtSecret) return // Dev mode: nothing to enforce

  server.addHook('onRequest', async (request, reply) => {
    if (isPublicRoute(request.url)) return

    // 1. Bearer JWT
    const auth = request.headers['authorization'] as string | undefined
    if (auth && auth.startsWith('Bearer ') && cfg.jwtSecret) {
      const token = auth.slice(7).trim()
      const verified = verifyJwt(token, cfg.jwtSecret)
      if (verified.ok) return
      // Bearer presented but invalid → 401 immediately (don't fall through to API key)
      return reply.status(401).send({ error: 'Unauthorized', reason: verified.reason })
    }

    // 2. X-API-Key (header or ?key= query)
    if (cfg.apiKey) {
      const providedKey = (request.headers['x-api-key'] as string | undefined)
        ?? (request.query as Record<string, string>)?.key
      if (providedKey && providedKey.length === cfg.apiKey.length &&
          timingSafeEqual(Buffer.from(providedKey), Buffer.from(cfg.apiKey))) {
        return
      }
    }

    return reply.status(401).send({ error: 'Unauthorized' })
  })
}
