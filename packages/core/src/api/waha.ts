import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import type { WebhookHandler } from '../waha/webhook-handler.js'
import type { SessionManager } from '../waha/session-manager.js'
import type { MessageHistory } from '../waha/message-history.js'

interface WahaDeps {
  webhookHandler: WebhookHandler
  sessionManager: SessionManager | null
  messageHistory: MessageHistory
}

const webhookPayloadSchema = z.object({
  event: z.enum(['message', 'message.any', 'message.ack', 'session.status']),
  session: z.string().min(1),
  me: z.object({ id: z.string(), pushName: z.string() }).optional(),
  payload: z.record(z.unknown()),
  engine: z.string().optional(),
  environment: z.object({
    version: z.string(),
    engine: z.string(),
    tier: z.string(),
  }).optional(),
})

const historyQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  direction: z.enum(['incoming', 'outgoing']).optional(),
  session: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(50),
  offset: z.coerce.number().int().min(0).default(0),
})

export function registerWahaRoutes(server: FastifyInstance, deps: WahaDeps): void {
  const { webhookHandler, sessionManager, messageHistory } = deps

  // Capture raw body for HMAC validation (JSON.stringify of parsed body may differ from wire bytes)
  server.addHook('preParsing', async (request, _reply, payload) => {
    if (request.url === '/api/v1/webhooks/waha' && request.method === 'POST') {
      const chunks: Buffer[] = []
      for await (const chunk of payload) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      }
      const raw = Buffer.concat(chunks)
      ;(request as typeof request & { rawBody: string }).rawBody = raw.toString('utf8')
      const { Readable } = await import('node:stream')
      return Readable.from(raw)
    }
    return payload
  })

  server.post('/api/v1/webhooks/waha', async (request, reply) => {
    // HMAC enforcement: if secret is configured, REQUIRE the header
    const hmacHeader = request.headers['x-webhook-hmac'] as string | undefined
    if (webhookHandler.isHmacConfigured()) {
      if (!hmacHeader) {
        return reply.status(401).send({ error: 'Missing HMAC signature' })
      }
      const rawBody = (request as typeof request & { rawBody?: string }).rawBody ?? JSON.stringify(request.body)
      if (!webhookHandler.validateHmac(rawBody, hmacHeader)) {
        return reply.status(401).send({ error: 'Invalid HMAC signature' })
      }
    }

    const parsed = webhookPayloadSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid webhook payload', details: parsed.error.issues })
    }

    const result = await webhookHandler.processWebhook(parsed.data)
    return { ok: true, ...result }
  })

  const requireWahaClient = (reply: FastifyReply): boolean => {
    if (!sessionManager) {
      reply.status(503).send({ error: 'WAHA client not configured. Set WAHA_API_URL and WAHA_API_KEY.' })
      return false
    }
    return true
  }

  server.get('/api/v1/waha/sessions', async (_request, reply) => {
    if (!requireWahaClient(reply)) return
    return sessionManager!.discoverManagedSessions()
  })

  server.post('/api/v1/waha/health-check', async (_request, reply) => {
    if (!requireWahaClient(reply)) return
    await sessionManager!.checkHealth()
    return { ok: true, checkedAt: new Date().toISOString() }
  })

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

  server.get('/api/v1/waha/sessions/:name/qr', async (request, reply) => {
    if (!requireWahaClient(reply)) return
    const { name } = request.params as { name: string }
    try {
      const qrDataUri = await sessionManager!.getQrCode(name)
      return { ok: true, session: name, qr: qrDataUri }
    } catch (err) {
      return reply.status(500).send({
        error: 'QR code not available',
        detail: err instanceof Error ? err.message : String(err),
      })
    }
  })

  server.post('/api/v1/waha/sessions/:name/stop', async (request, reply) => {
    if (!requireWahaClient(reply)) return
    const { name } = request.params as { name: string }
    try {
      await sessionManager!.stopSession(name)
      return { ok: true, session: name }
    } catch (err) {
      return reply.status(500).send({
        error: 'Failed to stop session',
        detail: err instanceof Error ? err.message : String(err),
      })
    }
  })

  server.get('/api/v1/waha/history', async (request, reply) => {
    const parsed = historyQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid query', details: parsed.error.issues })
    }
    return messageHistory.query({
      fromNumber: parsed.data.from,
      toNumber: parsed.data.to,
      direction: parsed.data.direction,
      wahaSessionName: parsed.data.session,
      limit: parsed.data.limit,
      offset: parsed.data.offset,
    })
  })
}
