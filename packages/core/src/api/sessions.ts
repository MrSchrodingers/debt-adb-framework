import type { FastifyInstance, FastifyReply } from 'fastify'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { InboxAutomation } from '../chatwoot/inbox-automation.js'
import type { ManagedSessions } from '../chatwoot/managed-sessions.js'
import type { SenderMapping } from '../engine/sender-mapping.js'

/**
 * Generates a 13-digit numeric placeholder for a session that has not
 * yet been paired. Format: `99999` + 8 digits derived from sha256(
 * sessionName). Looks Brazilian (13 digits, 9-prefix), survives the
 * sender_mapping `normalizePhone` step (which strips non-digits), and
 * the `99999` prefix lets the reconciler tell placeholders apart from
 * real numbers so it never deletes them.
 */
function placeholderPhoneFor(sessionName: string): string {
  const hash = createHash('sha256').update(sessionName).digest('hex')
  // First 8 hex chars → integer → 8-digit zero-padded decimal slice.
  const n = parseInt(hash.slice(0, 8), 16) % 100_000_000
  return '99999' + String(n).padStart(8, '0')
}

interface SessionDeps {
  inboxAutomation: InboxAutomation | null
  managedSessions: ManagedSessions
  senderMapping?: SenderMapping
}

const bulkManagedSchema = z.object({
  sessionNames: z.array(z.string().min(1)).min(1),
})

const createInboxSchema = z.object({
  inboxName: z.string().min(1).optional(),
})

const attachDeviceSchema = z.object({
  device_serial: z.string().min(1).max(64),
  profile_id: z.number().int().min(0).max(99),
})

export function registerSessionRoutes(server: FastifyInstance, deps: SessionDeps): void {
  const { inboxAutomation, managedSessions } = deps

  const requireAutomation = (reply: FastifyReply): boolean => {
    if (!inboxAutomation) {
      reply.status(503).send({
        error: 'Session automation not configured. Set WAHA_API_URL, WAHA_API_KEY, CHATWOOT_API_URL, CHATWOOT_API_TOKEN.',
      })
      return false
    }
    return true
  }

  // --- All WAHA sessions (enriched) ---
  server.get('/api/v1/sessions', async (_request, reply) => {
    if (!requireAutomation(reply)) return
    return inboxAutomation!.listSessionsWithStatus()
  })

  // --- Managed sessions group (SQLite, contiguous) ---
  server.get('/api/v1/sessions/managed', async () => {
    return managedSessions.listManaged()
  })

  server.post('/api/v1/sessions/managed', async (request, reply) => {
    if (!requireAutomation(reply)) return

    const parsed = bulkManagedSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid request', details: parsed.error.issues })
    }

    return inboxAutomation!.bulkSetManaged(parsed.data.sessionNames)
  })

  server.get('/api/v1/sessions/managed/:name', async (request, reply) => {
    const { name } = request.params as { name: string }
    const record = managedSessions.get(name)
    if (!record) {
      return reply.status(404).send({ error: 'Session not found' })
    }
    return record
  })

  server.delete('/api/v1/sessions/managed/:name', async (request, reply) => {
    const { name } = request.params as { name: string }
    try {
      managedSessions.setManaged(name, false)
      return { ok: true, session: name, managed: false }
    } catch (err) {
      if (err instanceof Error && err.message.includes('not found')) {
        return reply.status(404).send({ error: 'Session not found' })
      }
      throw err
    }
  })

  server.put('/api/v1/sessions/managed/:name', async (request, reply) => {
    const { name } = request.params as { name: string }
    try {
      managedSessions.setManaged(name, true)
      return { ok: true, session: name, managed: true }
    } catch (err) {
      if (err instanceof Error && err.message.includes('not found')) {
        return reply.status(404).send({ error: 'Session not found' })
      }
      throw err
    }
  })

  // --- Attach session to device + profile (required before pairing) ---
  // Pairing flow needs (waha_session, device_serial, profile_id) in
  // sender_mapping to know which Android user to switch to. This
  // endpoint pins the session to a (device, profile), persists it on
  // both managed_sessions and sender_mapping, and unblocks pair/QR.
  server.put('/api/v1/sessions/managed/:name/device', async (request, reply) => {
    const { name } = request.params as { name: string }
    const parsed = attachDeviceSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid request', details: parsed.error.issues })
    }
    const session = managedSessions.get(name)
    if (!session) {
      return reply.status(404).send({ error: 'Session not found' })
    }
    try {
      managedSessions.attachToDevice(name, parsed.data.device_serial, parsed.data.profile_id)
      // Mirror into sender_mapping so /waha/sessions/:name/pair can
      // resolve (device, profile). Phone number is a placeholder until
      // pairing concludes — we use the session name to keep the unique
      // constraint happy without colliding with real numbers.
      if (deps.senderMapping) {
        const placeholder = session.phoneNumber || placeholderPhoneFor(name)
        const existing = deps.senderMapping.getByPhone(placeholder)
        if (existing) {
          deps.senderMapping.update(placeholder, {
            deviceSerial: parsed.data.device_serial,
            profileId: parsed.data.profile_id,
            wahaSession: name,
          })
        } else {
          deps.senderMapping.create({
            phoneNumber: placeholder,
            deviceSerial: parsed.data.device_serial,
            profileId: parsed.data.profile_id,
            wahaSession: name,
          })
        }
      }
      return {
        ok: true,
        session: name,
        device_serial: parsed.data.device_serial,
        profile_id: parsed.data.profile_id,
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('not found')) {
        return reply.status(404).send({ error: 'Session not found' })
      }
      throw err
    }
  })

  // --- Per-session operations ---
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
}
