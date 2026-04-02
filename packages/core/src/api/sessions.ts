import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { InboxAutomation } from '../chatwoot/inbox-automation.js'
import type { ManagedSessions } from '../chatwoot/managed-sessions.js'

interface SessionDeps {
  inboxAutomation: InboxAutomation | null
  managedSessions: ManagedSessions
}

const bulkManagedSchema = z.object({
  sessionNames: z.array(z.string().min(1)).min(1),
})

const createInboxSchema = z.object({
  inboxName: z.string().min(1).optional(),
})

export function registerSessionRoutes(server: FastifyInstance, deps: SessionDeps): void {
  const { inboxAutomation, managedSessions } = deps

  const requireAutomation = (reply: ReturnType<typeof server.decorateReply>): boolean => {
    if (!inboxAutomation) {
      (reply as { status: (code: number) => { send: (body: unknown) => void } }).status(503).send({
        error: 'Session automation not configured. Set WAHA_API_URL, WAHA_API_KEY, CHATWOOT_API_URL, CHATWOOT_API_TOKEN.',
      })
      return false
    }
    return true
  }

  // List all WAHA sessions enriched with managed/chatwoot status
  server.get('/api/v1/sessions', async (_request, reply) => {
    if (!requireAutomation(reply)) return
    return inboxAutomation!.listSessionsWithStatus()
  })

  // List only managed sessions (from SQLite, no WAHA call)
  server.get('/api/v1/sessions/managed', async () => {
    return managedSessions.listManaged()
  })

  // Bulk set sessions as managed
  server.post('/api/v1/sessions/managed', async (request, reply) => {
    if (!requireAutomation(reply)) return

    const parsed = bulkManagedSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid request', details: parsed.error.issues })
    }

    return inboxAutomation!.bulkSetManaged(parsed.data.sessionNames)
  })

  // Unmanage a session (set managed=false, keep record)
  server.delete('/api/v1/sessions/managed/:name', async (request, reply) => {
    const { name } = request.params as { name: string }
    try {
      managedSessions.setManaged(name, false)
      return { ok: true, session: name, managed: false }
    } catch (err) {
      return reply.status(404).send({
        error: 'Session not found',
        detail: err instanceof Error ? err.message : String(err),
      })
    }
  })

  // Re-manage a session
  server.put('/api/v1/sessions/managed/:name', async (request, reply) => {
    const { name } = request.params as { name: string }
    try {
      managedSessions.setManaged(name, true)
      return { ok: true, session: name, managed: true }
    } catch (err) {
      return reply.status(404).send({
        error: 'Session not found',
        detail: err instanceof Error ? err.message : String(err),
      })
    }
  })

  // Create Chatwoot inbox for a session
  server.post('/api/v1/sessions/:name/inbox', async (request, reply) => {
    if (!requireAutomation(reply)) return

    const { name } = request.params as { name: string }
    const parsed = createInboxSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid request', details: parsed.error.issues })
    }

    const result = await inboxAutomation!.createInboxForSession(name, parsed.data)
    if (!result.success) {
      return reply.status(500).send({ error: 'Inbox creation failed', detail: result.error })
    }
    return result
  })

  // Get QR code for a session (for pairing)
  server.get('/api/v1/sessions/:name/qr', async (request, reply) => {
    if (!requireAutomation(reply)) return

    const { name } = request.params as { name: string }
    try {
      const qr = await inboxAutomation!.getQrCode(name)
      return { qr, session: name }
    } catch (err) {
      return reply.status(400).send({
        error: 'QR code not available',
        detail: err instanceof Error ? err.message : String(err),
      })
    }
  })

  // Get single managed session detail
  server.get('/api/v1/sessions/managed/:name', async (request, reply) => {
    const { name } = request.params as { name: string }
    const record = managedSessions.get(name)
    if (!record) {
      return reply.status(404).send({ error: 'Session not found' })
    }
    return record
  })
}
