import type { FastifyInstance, FastifyReply } from 'fastify'
import type { WebhookHandler } from '../waha/webhook-handler.js'
import type { SessionManager } from '../waha/session-manager.js'
import type { MessageHistory } from '../waha/message-history.js'

interface WahaDeps {
  webhookHandler: WebhookHandler
  sessionManager: SessionManager | null
  messageHistory: MessageHistory
}

export function registerWahaRoutes(server: FastifyInstance, deps: WahaDeps): void {
  const { webhookHandler, sessionManager, messageHistory } = deps

  // Webhook receiver — WAHA sends events here
  // Use rawBody for HMAC validation (JSON.stringify of parsed body may differ from wire bytes)
  server.addHook('preParsing', async (request, _reply, payload) => {
    if (request.url === '/api/v1/webhooks/waha' && request.method === 'POST') {
      const chunks: Buffer[] = []
      for await (const chunk of payload) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      }
      const raw = Buffer.concat(chunks)
      ;(request as typeof request & { rawBody: string }).rawBody = raw.toString('utf8')
      // Return a new readable stream for Fastify's body parser
      const { Readable } = await import('node:stream')
      return Readable.from(raw)
    }
    return payload
  })

  server.post('/api/v1/webhooks/waha', async (request, reply) => {
    // HMAC validation (if configured)
    const hmacHeader = request.headers['x-webhook-hmac'] as string | undefined
    if (hmacHeader) {
      const rawBody = (request as typeof request & { rawBody?: string }).rawBody ?? JSON.stringify(request.body)
      if (!webhookHandler.validateHmac(rawBody, hmacHeader)) {
        return reply.status(401).send({ error: 'Invalid HMAC signature' })
      }
    }

    const payload = request.body as Record<string, unknown>
    if (!payload.event || !payload.session) {
      return reply.status(400).send({ error: 'Missing required fields: event, session' })
    }

    const result = await webhookHandler.processWebhook(payload as unknown as Parameters<typeof webhookHandler.processWebhook>[0])
    return { ok: true, ...result }
  })

  const requireWahaClient = (reply: FastifyReply): boolean => {
    if (!sessionManager) {
      reply.status(503).send({ error: 'WAHA client not configured. Set WAHA_API_URL and WAHA_API_KEY.' })
      return false
    }
    return true
  }

  // List managed WAHA sessions (matched with ADB devices)
  server.get('/api/v1/waha/sessions', async (_request, reply) => {
    if (!requireWahaClient(reply)) return
    return sessionManager!.discoverManagedSessions()
  })

  // Trigger health check manually
  server.post('/api/v1/waha/health-check', async (_request, reply) => {
    if (!requireWahaClient(reply)) return
    await sessionManager!.checkHealth()
    return { ok: true, checkedAt: new Date().toISOString() }
  })

  // Add Dispatch webhook to a session
  server.post('/api/v1/waha/sessions/:name/webhook', async (request, reply) => {
    if (!requireWahaClient(reply)) return
    const { name } = request.params as { name: string }
    try {
      await sessionManager!.addWebhook(name)
      return { ok: true, session: name }
    } catch (err) {
      return reply.status(500).send({
        error: 'Failed to add webhook',
        detail: err instanceof Error ? err.message : String(err),
      })
    }
  })

  // Restart a WAHA session
  server.post('/api/v1/waha/sessions/:name/restart', async (request, reply) => {
    if (!requireWahaClient(reply)) return
    const { name } = request.params as { name: string }
    try {
      await sessionManager!.restartSession(name)
      return { ok: true, session: name }
    } catch (err) {
      return reply.status(500).send({
        error: 'Failed to restart session',
        detail: err instanceof Error ? err.message : String(err),
      })
    }
  })

  // Query message history
  server.get('/api/v1/waha/history', async (request) => {
    const query = request.query as Record<string, string | undefined>
    return messageHistory.query({
      fromNumber: query.from,
      toNumber: query.to,
      direction: query.direction as 'incoming' | 'outgoing' | undefined,
      wahaSessionName: query.session,
      limit: query.limit ? parseInt(query.limit, 10) : 50,
      offset: query.offset ? parseInt(query.offset, 10) : 0,
    })
  })
}
