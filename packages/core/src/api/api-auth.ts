import { timingSafeEqual } from 'node:crypto'
import type { FastifyInstance } from 'fastify'

const PUBLIC_ROUTES = [
  '/api/v1/health',
]

const PUBLIC_PREFIXES = [
  '/api/v1/webhooks/waha',
]

function isPublicRoute(url: string): boolean {
  for (const route of PUBLIC_ROUTES) {
    if (url === route) return true
  }
  for (const prefix of PUBLIC_PREFIXES) {
    if (url.startsWith(prefix)) return true
  }
  return false
}

export function registerApiAuth(server: FastifyInstance, apiKey: string | undefined): void {
  if (!apiKey) return // Dev mode: no auth when key is not set

  server.addHook('onRequest', async (request, reply) => {
    if (isPublicRoute(request.url)) return

    const providedKey = request.headers['x-api-key'] as string | undefined
    if (!providedKey || providedKey.length !== apiKey.length ||
        !timingSafeEqual(Buffer.from(providedKey), Buffer.from(apiKey))) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }
  })
}
