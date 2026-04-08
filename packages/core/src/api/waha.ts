import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import type { WebhookHandler } from '../waha/webhook-handler.js'
import type { SessionManager } from '../waha/session-manager.js'
import type { MessageHistory } from '../waha/message-history.js'
import type { AdbBridge } from '../adb/index.js'
import type { SenderMapping } from '../engine/sender-mapping.js'

interface WahaDeps {
  webhookHandler: WebhookHandler
  sessionManager: SessionManager | null
  messageHistory: MessageHistory
  adb?: AdbBridge
  senderMapping?: SenderMapping
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

  /** Reliable UIAutomator dump with retry on "null root node" */
  const dumpUiReliable = async (adbBridge: AdbBridge, serial: string, retries = 3): Promise<string> => {
    for (let i = 0; i < retries; i++) {
      const result = await adbBridge.shell(serial, 'uiautomator dump /sdcard/dispatch-ui.xml')
      if (!result.includes('ERROR') && !result.includes('null root node')) {
        return adbBridge.shell(serial, 'cat /sdcard/dispatch-ui.xml')
      }
      await new Promise(r => setTimeout(r, 1000))
    }
    return adbBridge.shell(serial, 'cat /sdcard/dispatch-ui.xml')
  }

  /** Extract center of bounds from UIAutomator XML text match */
  const tapText = async (adbBridge: AdbBridge, serial: string, xml: string, pattern: RegExp): Promise<boolean> => {
    const match = xml.match(pattern)
    if (!match) return false
    const cx = Math.round((Number(match[2]) + Number(match[4])) / 2)
    const cy = Math.round((Number(match[3]) + Number(match[5])) / 2)
    await adbBridge.shell(serial, `input tap ${cx} ${cy}`)
    return true
  }

  /**
   * Full pairing flow: switch Android user → open WhatsApp → navigate to
   * Linked Devices → restart WAHA session → return QR code
   */
  server.post('/api/v1/waha/sessions/:name/pair', async (request, reply) => {
    if (!requireWahaClient(reply)) return
    const { name } = request.params as { name: string }
    const { adb, senderMapping } = deps

    if (!adb || !senderMapping) {
      return reply.status(503).send({ error: 'ADB or SenderMapping not available' })
    }

    const steps: string[] = []

    try {
      // 1. Resolve session → sender mapping → profile_id + device_serial
      const mappings = senderMapping.listAll().filter(m => m.waha_session === name)
      if (mappings.length === 0) {
        return reply.status(404).send({ error: `No sender mapping found for session ${name}` })
      }
      const mapping = mappings[0]
      const { device_serial: serial, profile_id: profileId } = mapping
      steps.push(`Resolved: profile=${profileId}, device=${serial.slice(0, 12)}...`)

      // 2. Switch Android user
      await adb.shell(serial, `am switch-user ${profileId}`)
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 1000))
        const current = await adb.shell(serial, 'am get-current-user')
        if (parseInt(current.trim(), 10) === profileId) break
      }
      await new Promise(r => setTimeout(r, 2000))
      steps.push(`Switched to user ${profileId}`)

      // 3. Wake screen
      await adb.shell(serial, 'input keyevent KEYCODE_WAKEUP')
      await new Promise(r => setTimeout(r, 500))
      steps.push('Screen woken')

      // 4. Open WhatsApp
      await adb.shell(serial, 'am force-stop com.whatsapp')
      await new Promise(r => setTimeout(r, 500))
      await adb.shell(serial, 'am start -n com.whatsapp/com.whatsapp.HomeActivity')
      await new Promise(r => setTimeout(r, 3000))
      steps.push('WhatsApp opened')

      // 5. Navigate to Linked Devices: overflow → Dispositivos conectados → Conectar
      try {
        const xml1 = await dumpUiReliable(adb, serial)
        const overflowTapped = await tapText(adb, serial, xml1,
          /resource-id="com\.whatsapp:id\/menuitem_overflow"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/)
        if (!overflowTapped) { steps.push('Overflow menu not found — navigate manually'); throw null }
        await new Promise(r => setTimeout(r, 2000))
        steps.push('Menu aberto')

        const xml2 = await dumpUiReliable(adb, serial)
        const linkedTapped = await tapText(adb, serial, xml2,
          /text="(Dispositivos conectados|Linked [Dd]evices)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/)
        if (!linkedTapped) { steps.push('"Dispositivos conectados" not found — navigate manually'); throw null }
        await new Promise(r => setTimeout(r, 2000))
        steps.push('Tela Dispositivos conectados')

        const xml3 = await dumpUiReliable(adb, serial)
        const linkTapped = await tapText(adb, serial, xml3,
          /text="(CONECTAR DISPOSITIVO|Conectar um dispositivo|Conectar dispositivo|Link a [Dd]evice)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/i)
        if (linkTapped) {
          await new Promise(r => setTimeout(r, 2000))
          steps.push('Scanner QR aberto no device')
        } else {
          steps.push('"Conectar dispositivo" not found — pode estar banido ou necessitar autorizacao biometrica')
        }
      } catch {
        // Navigation failed at some point — device is at least on WhatsApp
      }

      // 6. Restart WAHA session
      try {
        await sessionManager!.restartSession(name)
        steps.push('WAHA session restarted')
      } catch {
        steps.push('WAHA session restart failed — may already be in SCAN_QR_CODE')
      }

      // 7. Wait for SCAN_QR_CODE state, then fetch QR
      await new Promise(r => setTimeout(r, 5000))
      let qr: string | null = null
      try {
        qr = await sessionManager!.getQrCode(name)
        steps.push('QR code fetched')
      } catch {
        steps.push('QR code not available yet — retry via GET /qr')
      }

      return {
        ok: true,
        session: name,
        profileId,
        deviceSerial: serial,
        qr,
        steps,
      }
    } catch (err) {
      return reply.status(500).send({
        error: 'Pairing flow failed',
        detail: err instanceof Error ? err.message : String(err),
        steps,
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
