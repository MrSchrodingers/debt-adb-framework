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
    // Delete stale XML before dumping to avoid reading old data
    await adbBridge.shell(serial, 'rm -f /sdcard/dispatch-ui.xml').catch(() => {})
    for (let i = 0; i < retries; i++) {
      const result = await adbBridge.shell(serial, 'uiautomator dump /sdcard/dispatch-ui.xml')
      if (!result.includes('ERROR') && !result.includes('null root node')) {
        return adbBridge.shell(serial, 'cat /sdcard/dispatch-ui.xml')
      }
      await new Promise(r => setTimeout(r, 1500))
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
        return reply.status(412).send({
          error: 'session_not_attached',
          detail:
            `Session ${name} is not attached to any device/profile. ` +
            `Call PUT /api/v1/sessions/managed/${name}/device with {device_serial, profile_id} first.`,
        })
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
      await new Promise(r => setTimeout(r, 5000))
      steps.push('WhatsApp opened')

      // 5. Detect onboarding state BEFORE attempting Linked Devices
      // navigation. WhatsApp on a freshly-created Android user is in
      // welcome / agree-to-terms / "enter your phone number" state —
      // it has no overflow menu, no "Dispositivos conectados" entry,
      // no chat list. Tapping (684,124) and (500,532) blindly there
      // hits arbitrary controls and the operator gets no signal that
      // the profile needs primary registration first. Worse, the
      // operator may believe the system targeted the wrong profile.
      //
      // Detect explicitly: dump UI, look for onboarding markers
      // (Concordar/Agree, Insira o seu/Enter your, Verifique seu
      // numero/Verify), and short-circuit with an actionable message.
      // Only when we see HOME chat-list signals do we proceed with
      // the overflow-menu tap chain.
      const profileBareLabel = `profile ${profileId}`
      const initialXml = await dumpUiReliable(adb, serial).catch(() => '')
      const isOnboarding =
        /Concordar e continuar|Aceitar (e )?(continuar|prosseguir)|Agree (and|&) [Cc]ontinue|Concordo|Termos de [Ss]erviço|Terms of [Ss]ervice/i.test(initialXml) ||
        /Insira (o )?seu n[uú]mero|Enter your phone number|Confirme seu n[uú]mero|Verify your phone number|Verifique seu n[uú]mero/i.test(initialXml) ||
        /Bem[- ]vindo ao WhatsApp|Welcome to WhatsApp/i.test(initialXml)

      if (isOnboarding) {
        // Surface the diagnostic AND the (device, profile, session)
        // tuple so the operator can act without guessing which user
        // to switch to. WhatsApp Multi-Device requires a phone number
        // to be primary-registered before it can be added as a
        // linked device — Dispatch can't bypass that.
        const helpMsg =
          `WhatsApp em ${profileBareLabel} esta na tela inicial (Concordar / Inserir numero). ` +
          `Esse profile precisa ser pareado primeiro como numero PRIMARIO via SMS/ligacao ` +
          `antes de ser usado como linked device. Switch-user ${profileId} ja foi feito - ` +
          `complete o cadastro do numero da sessao "${name}" no proprio device, depois clique Pair de novo.`
        steps.push('WhatsApp em tela de onboarding — pareamento primario pendente')
        steps.push(helpMsg)
        return reply.status(409).send({
          error: 'profile_not_registered',
          detail: helpMsg,
          profile_id: profileId,
          device_serial: serial,
          session: name,
          steps,
        })
      }

      // 6. Navigate: overflow → Dispositivos conectados → CONECTAR DISPOSITIVO
      // Uses sequential ADB taps — UIAutomator is unreliable for popup menus via adbkit
      let scannerOpened = false
      try {
        // Tap overflow (top-right "..." button) — position stable on POCO C71 720x1640
        await adb.shell(serial, 'input tap 684 124')
        await new Promise(r => setTimeout(r, 3000))
        steps.push('Menu aberto')

        // Tap "Dispositivos conectados" (4th item, y≈532 on 720x1640)
        await adb.shell(serial, 'input tap 500 532')
        await new Promise(r => setTimeout(r, 2500))

        // Verify we're on Linked Devices screen
        const xml2 = await dumpUiReliable(adb, serial)
        if (xml2.includes('CONECTAR DISPOSITIVO') || xml2.includes('Conectar dispositivo') || xml2.includes('Link a device')) {
          steps.push('Tela Dispositivos conectados')
          // Tap "CONECTAR DISPOSITIVO"
          const linkTapped = await tapText(adb, serial, xml2,
            /text="(CONECTAR DISPOSITIVO|Conectar um dispositivo|Conectar dispositivo|Link a [Dd]evice)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/i)
          if (linkTapped) {
            await new Promise(r => setTimeout(r, 2000))
            steps.push('Scanner QR aberto no device')
            scannerOpened = true
          }
        } else if (xml2.includes('Dispositivos conectados')) {
          steps.push('Tela Dispositivos conectados (sem botao Conectar — pode estar banido)')
        } else {
          steps.push(
            `Navegacao para Dispositivos conectados falhou em ${profileBareLabel}. ` +
            `Abra manualmente: WhatsApp > "..." > Dispositivos conectados > Conectar dispositivo. ` +
            `Verifique se o user atual corresponde a sessao "${name}".`,
          )
        }
      } catch (navErr) {
        steps.push(
          `Tap automation crashou em ${profileBareLabel}: ${navErr instanceof Error ? navErr.message : String(navErr)}. ` +
          `Abra manualmente: WhatsApp > "..." > Dispositivos conectados.`,
        )
      }
      if (!scannerOpened) {
        // Carry the diagnostic into a dedicated step so the UI
        // operator panel renders it next to the QR (which still
        // shows up below if WAHA produces one).
        steps.push(`Acao manual necessaria no ${profileBareLabel} — sessao: ${name}`)
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
