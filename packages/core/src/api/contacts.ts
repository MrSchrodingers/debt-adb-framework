import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { ContactRegistry } from '../contacts/contact-registry.js'
import { normalizePhone, InvalidPhoneError } from '../validator/br-phone-resolver.js'
import type { AdbBridge } from '../adb/index.js'
import type { MessageQueue } from '../queue/index.js'
import { escapeForAdbContent } from '../engine/contact-utils.js'

const rawPhoneSchema = z.string().min(8).max(20)

const recheckSchema = z.object({
  reason: z.string().min(3).max(500),
})

const DEVICE_SERIAL_RE = /^[a-zA-Z0-9_:.\-]+$/

const syncToDeviceSchema = z.object({
  device_serial: z.string().regex(DEVICE_SERIAL_RE, 'Unsafe device serial'),
  profile_id: z.number().int().min(0).max(99).optional(),
  contacts: z.array(z.object({
    phone: z.string().regex(/^\+?\d{10,15}$/, 'Must be 10-15 digits'),
    name: z.string()
      .min(3, 'Name too short')
      .max(100)
      .refine((n) => {
        const trimmed = n.trim()
        if (/^contato\s+\d+$/i.test(trimmed)) return false
        if (/^\d+$/.test(trimmed)) return false
        const words = trimmed.split(/\s+/).filter((w) => w.length >= 2 && !/^[|~]/.test(w) && !/^\d+$/.test(w))
        return words.length >= 2
      }, 'Full name required (≥ 2 real words) for audit compliance'),
  })).min(1).max(1000),
})

/**
 * Register a batch of contacts directly on an Android device's ContactsProvider
 * inside the target profile. Each profile has its own provider — a profile 10
 * WhatsApp will not see contacts in profile 0. This endpoint is safe to call
 * for arbitrary name/phone pairs (e.g. backfilling from Chatwoot or CSV import).
 */
async function syncContactsToDevice(
  adb: AdbBridge,
  queue: MessageQueue,
  deviceSerial: string,
  profileId: number,
  contacts: { phone: string; name: string }[],
): Promise<{ registered: number; alreadyExists: number; errors: number; errorDetails: Array<{ phone: string; error: string }> }> {
  const stats = { registered: 0, alreadyExists: 0, errors: 0, errorDetails: [] as Array<{ phone: string; error: string }> }
  const userFlag = `--user ${profileId}`

  // Detect Google account once (cached by engine separately; here we re-detect for standalone calls)
  let acctBinds = `--bind account_type:n: --bind account_name:n:`
  try {
    const dump = await adb.shell(deviceSerial, 'dumpsys account')
    const m = dump.match(/Account \{name=([^,}]+),\s*type=com\.google\}/)
    if (m) {
      acctBinds = `--bind account_type:s:com.google --bind account_name:s:${m[1].trim()}`
    }
  } catch {
    // fallthrough to Local
  }

  for (const c of contacts) {
    const phoneDigits = c.phone.replace(/\D/g, '')
    if (!/^\d{10,15}$/.test(phoneDigits)) {
      stats.errors++
      stats.errorDetails.push({ phone: c.phone, error: 'invalid phone format' })
      continue
    }
    try {
      const existing = await adb.shell(
        deviceSerial,
        `content query ${userFlag} --uri content://com.android.contacts/phone_lookup/${phoneDigits} --projection display_name`,
      )
      if (existing.includes('display_name=')) {
        stats.alreadyExists++
        if (!queue.hasContact(phoneDigits)) queue.saveContact(phoneDigits, c.name)
        continue
      }

      await adb.shell(
        deviceSerial,
        `content insert ${userFlag} --uri content://com.android.contacts/raw_contacts ${acctBinds}`,
      )
      const idOut = await adb.shell(
        deviceSerial,
        `content query ${userFlag} --uri content://com.android.contacts/raw_contacts --projection _id --sort "_id DESC LIMIT 1"`,
      )
      const rid = idOut.match(/_id=(\d+)/)?.[1]
      if (!rid) throw new Error('failed to get raw_contact_id')
      const safe = escapeForAdbContent(c.name)
      await adb.shell(
        deviceSerial,
        `content insert ${userFlag} --uri content://com.android.contacts/data --bind raw_contact_id:i:${rid} --bind mimetype:s:vnd.android.cursor.item/name --bind data1:s:${safe}`,
      )
      await adb.shell(
        deviceSerial,
        `content insert ${userFlag} --uri content://com.android.contacts/data --bind raw_contact_id:i:${rid} --bind mimetype:s:vnd.android.cursor.item/phone_v2 --bind data1:s:${phoneDigits} --bind data2:i:1`,
      )
      if (!queue.hasContact(phoneDigits)) queue.saveContact(phoneDigits, c.name)
      stats.registered++
    } catch (err) {
      stats.errors++
      stats.errorDetails.push({ phone: c.phone, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return stats
}

export function registerContactRoutes(
  server: FastifyInstance,
  registry: ContactRegistry,
  adb?: AdbBridge,
  queue?: MessageQueue,
): void {
  server.get('/api/v1/contacts', async (req) => {
    const q = req.query as {
      limit?: string
      offset?: string
      exists?: string
      ddd?: string
      search?: string
    }
    let exists_on_wa: 0 | 1 | null | undefined
    if (q.exists === '1') exists_on_wa = 1
    else if (q.exists === '0') exists_on_wa = 0
    else if (q.exists === 'null') exists_on_wa = null
    return registry.list({
      limit: q.limit ? Number(q.limit) : undefined,
      offset: q.offset ? Number(q.offset) : undefined,
      exists_on_wa,
      ddd: q.ddd,
      search: q.search,
    })
  })

  server.get('/api/v1/contacts/:phone', async (req, reply) => {
    const { phone } = req.params as { phone: string }
    try {
      const { normalized } = normalizePhone(phone)
      const row = registry.lookup(normalized)
      if (!row) return reply.status(404).send({ error: 'Not found', phone_normalized: normalized })
      return row
    } catch (e) {
      if (e instanceof InvalidPhoneError) return reply.status(400).send({ error: e.message })
      throw e
    }
  })

  server.get('/api/v1/contacts/:phone/history', async (req, reply) => {
    const { phone } = req.params as { phone: string }
    const { limit } = req.query as { limit?: string }
    try {
      const { normalized } = normalizePhone(phone)
      const entries = registry.history(normalized, {
        limit: limit ? Math.min(Math.max(Number(limit), 1), 1000) : 100,
      })
      return { phone_normalized: normalized, entries }
    } catch (e) {
      if (e instanceof InvalidPhoneError) return reply.status(400).send({ error: e.message })
      throw e
    }
  })

  server.post('/api/v1/contacts/:phone/recheck', async (req, reply) => {
    const parsed = recheckSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parsed.error.issues })
    }
    const { phone } = req.params as { phone: string }
    try {
      const { normalized } = normalizePhone(phone)
      registry.forceRecheckDue(normalized, parsed.data.reason)
      return reply.status(200).send({ ok: true, phone_normalized: normalized })
    } catch (e) {
      if (e instanceof InvalidPhoneError) return reply.status(400).send({ error: e.message })
      if (e instanceof Error && e.message.includes('unknown phone')) {
        return reply.status(404).send({ error: e.message })
      }
      throw e
    }
  })

  if (adb && queue) {
    server.post('/api/v1/contacts/sync-to-device', async (req, reply) => {
      const parsed = syncToDeviceSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Validation failed', details: parsed.error.issues })
      }
      // If no profile_id given, detect current foreground user on the device
      let profileId = parsed.data.profile_id
      if (profileId === undefined) {
        try {
          const out = await adb.shell(parsed.data.device_serial, 'am get-current-user')
          profileId = parseInt(out.trim(), 10) || 0
        } catch {
          profileId = 0
        }
      }
      const stats = await syncContactsToDevice(
        adb, queue, parsed.data.device_serial, profileId, parsed.data.contacts,
      )
      return reply.status(200).send({ profile_id: profileId, device_serial: parsed.data.device_serial, ...stats })
    })
  }

  server.post('/api/v1/contacts/check', async (req, reply) => {
    const schema = z.object({ phone: rawPhoneSchema })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parsed.error.issues })
    }
    try {
      const norm = normalizePhone(parsed.data.phone)
      const contact = registry.lookup(norm.normalized)
      return {
        phone_input: parsed.data.phone,
        phone_normalized: norm.normalized,
        ddd: norm.ddd,
        isAmbiguousDdd: norm.isAmbiguousDdd,
        variants: norm.variants,
        contact,
      }
    } catch (e) {
      if (e instanceof InvalidPhoneError) return reply.status(400).send({ error: e.message })
      throw e
    }
  })
}
