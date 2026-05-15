import { writeFile, mkdir } from 'node:fs/promises'
import type { AdbBridge } from '../adb/index.js'
import type { MessageQueue, Message } from '../queue/index.js'
import type { DispatchEmitter } from '../events/index.js'
import { escapeForAdbContent } from './contact-utils.js'
import type { EventRecorder } from './event-recorder.js'
import type { ScreenshotPolicy } from '../config/screenshot-policy.js'
import type { ContactCache } from './contact-cache.js'
import type { MediaSender } from './media-sender.js'
import { ScreenshotValidator } from './screenshot-validator.js'
import { getTracer } from '../telemetry/tracer.js'
import { SpanStatusCode } from '@opentelemetry/api'

/** Packages allowed in am start/force-stop commands. Reject everything else. */
const ALLOWED_PACKAGES = new Set(['com.whatsapp', 'com.whatsapp.w4b'])

/** Device serials: alphanumeric + limited safe chars. Reject shell metacharacters. */
const DEVICE_SERIAL_RE = /^[a-zA-Z0-9_:.\-]+$/

/**
 * Thrown by SendEngine.send() when the post-send UI dump indicates the
 * tap on the send button did NOT deliver the message (chat input still
 * shows the body, dialog appeared after send, etc).
 *
 * The orchestrator MUST treat this as a real ADB failure but MUST NOT
 * dispatch the WAHA fallback for it: if the validation was a false
 * negative, WAHA would send a duplicate. Re-enqueue for an ADB retry is
 * the safe choice; permanent failure after maxRetries surfaces the
 * problem without doubling delivery.
 */
export class PostSendValidationError extends Error {
  readonly skipWahaFallback = true
  constructor(public readonly validationReason: string) {
    super(`post_send_validation failed: ${validationReason}`)
    this.name = 'PostSendValidationError'
  }
}
import { SendStrategy } from './send-strategy.js'

export interface SendResult {
  screenshot: Buffer
  durationMs: number
  contactRegistered: boolean
  dialogsDismissed: number
}

export class SendEngine {
  private processing = false
  private touchDeviceCache = new Map<string, string | null>()
  /** Per-device cache of Google account (name + type) for contact creation */
  private googleAccountCache = new Map<string, { type: string; name: string } | null>()

  constructor(
    private adb: AdbBridge,
    private queue: MessageQueue,
    private emitter: DispatchEmitter,
    private strategy: SendStrategy = new SendStrategy(),
    private recorder?: EventRecorder,
    private screenshotPolicy?: ScreenshotPolicy,
    private contactCache?: ContactCache,
    private mediaSender?: MediaSender,
  ) {}

  /**
   * Detect the device's primary Google account for contact registration.
   * Per project feedback (memory/feedback_send_flow.md): contacts MUST be saved
   * to Google account, not Local — otherwise WhatsApp may not sync them.
   * Returns null if no Google account is configured (fallback to Local).
   */
  private async detectGoogleAccount(deviceSerial: string): Promise<{ type: string; name: string } | null> {
    if (this.googleAccountCache.has(deviceSerial)) {
      return this.googleAccountCache.get(deviceSerial) ?? null
    }
    try {
      const out = await this.adb.shell(deviceSerial, 'dumpsys account')
      const match = out.match(/Account \{name=([^,}]+),\s*type=com\.google\}/)
      if (match) {
        const account = { type: 'com.google', name: match[1].trim() }
        this.googleAccountCache.set(deviceSerial, account)
        return account
      }
    } catch {
      // fallthrough
    }
    this.googleAccountCache.set(deviceSerial, null)
    return null
  }

  /**
   * Detect the currently foregrounded Android user profile. Needed because
   * each profile has an isolated ContactsProvider — contacts created in profile
   * 0 are invisible to the WhatsApp running in profile 10 (multi-user setup).
   */
  private async detectForegroundUser(deviceSerial: string): Promise<number> {
    try {
      const out = await this.adb.shell(deviceSerial, 'am get-current-user')
      const parsed = parseInt(out.trim(), 10)
      return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0
    } catch {
      return 0
    }
  }

  private record(messageId: string, event: string, metadata?: Record<string, unknown>): void {
    this.recorder?.record(messageId, event, metadata)
  }

  /**
   * Capture a forensic screenshot for a message that post_send_validation
   * decided was not delivered. The capture is intentionally best-effort —
   * the calling path is about to throw PostSendValidationError, so any
   * failure here must not mask the original validation failure.
   */
  private async captureForensicScreenshot(deviceSerial: string, messageId: string): Promise<void> {
    try {
      const buf = (await this.adb.screenshot(deviceSerial)) as Buffer
      const path = `reports/sends/${messageId}.png`
      await mkdir('reports/sends', { recursive: true })
      const processed = this.screenshotPolicy
        ? await this.screenshotPolicy.processBuffer(buf)
        : buf
      await writeFile(path, processed)
      this.queue.markScreenshotPersisted(messageId, path, processed.length)
      this.record(messageId, 'screenshot_forensic', { path, reason: 'post_send_validation_failed' })
    } catch (err) {
      this.record(messageId, 'screenshot_forensic_failed', {
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timeout: ${label} exceeded ${ms}ms`)), ms)
    })
    try {
      return await Promise.race([promise, timeout])
    } finally {
      clearTimeout(timer!)
    }
  }

  get isProcessing(): boolean {
    return this.processing
  }

  /**
   * Register a contact on the Android device without sending a message.
   * Used for contact aging — pre-register contacts days before the first send
   * so WhatsApp doesn't see "contact created + message sent in the same second".
   *
   * @returns 'registered' if a new contact was created, 'exists' if already on device
   */
  async registerContact(deviceSerial: string, phone: string, name: string): Promise<'registered' | 'exists'> {
    if (!DEVICE_SERIAL_RE.test(deviceSerial)) {
      throw new Error('Rejected device serial: contains unsafe characters')
    }
    const phoneDigits = phone.replace(/[\s\-+()]/g, '')
    if (!/^\d{10,15}$/.test(phoneDigits)) {
      throw new Error(`Invalid phone number: ${phone}`)
    }

    // Save name to contacts DB so future sends can use it for search diversification
    if (!this.queue.hasContact(phoneDigits)) {
      this.queue.saveContact(phoneDigits, name)
    }

    const created = await this.ensureContact(deviceSerial, phoneDigits)
    return created ? 'registered' : 'exists'
  }

  /**
   * @param isFirstInBatch — if true, does full cleanup (force-stop + screen wake).
   *   Subsequent messages in the same batch skip these for speed.
   * @param appPackage — Android package to use for sending (default: com.whatsapp).
   *   Pass 'com.whatsapp.w4b' to send via WhatsApp Business.
   */
  async send(message: Message, deviceSerial: string, isFirstInBatch = true, appPackage = 'com.whatsapp'): Promise<SendResult> {
    this.processing = true
    const startTime = Date.now()

    // Security: allowlist-only for shell command arguments
    if (!ALLOWED_PACKAGES.has(appPackage)) {
      throw new Error(`Rejected app package: ${appPackage} — only ${[...ALLOWED_PACKAGES].join(', ')} allowed`)
    }
    if (!DEVICE_SERIAL_RE.test(deviceSerial)) {
      throw new Error(`Rejected device serial: contains unsafe characters`)
    }

    const tracer = getTracer()
    const span = tracer.startSpan('engine.send', {
      attributes: {
        'idempotency_key': message.idempotencyKey,
        'message.id': message.id,
        'message.to': message.to,
        'device.serial': deviceSerial,
        'plugin_name': message.pluginName ?? '',
        'provider': 'adb',
        'app_package': appPackage,
      },
    })

    let method: string = 'unknown' // enrichment: populated in text/media branch, used in emit

    try {
      this.queue.updateStatus(message.id, 'locked', 'sending')
      this.emitter.emit('message:sending', { id: message.id, deviceSerial })

      // Normalize and validate phone number (accept +55, spaces, hyphens — strip to digits)
      const phoneDigits = message.to.replace(/[\s\-+()]/g, '')
      if (!/^\d{10,15}$/.test(phoneDigits)) {
        throw new Error(`Invalid phone number: ${message.to}`)
      }

      // Quick WhatsApp health check — verify the app is launchable
      const waRunning = await this.adb.shell(deviceSerial, `pidof ${appPackage}`).catch(() => '')
      if (!waRunning.trim()) {
        // WA not running — try to start it first
        await this.adb.shell(deviceSerial, `am start -n ${appPackage}/com.whatsapp.HomeActivity`).catch(() => {})
        await this.delay(3000)
        const waRunning2 = await this.adb.shell(deviceSerial, `pidof ${appPackage}`).catch(() => '')
        if (!waRunning2.trim()) {
          throw new Error(`WhatsApp (${appPackage}) not responding — app may need reinstall`)
        }
      }
      this.record(message.id, 'wa_health_check', { running: true, appPackage })

      if (isFirstInBatch) {
        await this.ensureScreenReady(deviceSerial)
        this.record(message.id, 'screen_ready', { wakeSent: true })
        await this.ensureCleanState(deviceSerial, appPackage)
        this.record(message.id, 'clean_state', { forceStoppedPackage: appPackage })
      } else {
        // Between messages: BACK to exit chat, keep WhatsApp open
        await this.adb.shell(deviceSerial, 'input keyevent 4')
        await this.delay(500)
      }

      const contactRegistered = await this.ensureContact(deviceSerial, phoneDigits)
      this.record(message.id, 'contact_resolved', { registered: contactRegistered, phone: phoneDigits })

      let dialogsDismissed = 0

      // Media send flow — share intent (bypasses text-only strategy)
      if (message.mediaUrl && message.mediaType) {
        method = 'media'
        if (!this.mediaSender) {
          throw new Error('Media sending not configured — MediaSender not provided')
        }

        await this.mediaSender.sendMedia({
          deviceSerial,
          mediaUrl: message.mediaUrl,
          mediaType: message.mediaType,
          appPackage,
          caption: message.mediaCaption ?? undefined,
        })

        this.record(message.id, 'media_sent', { mediaType: message.mediaType, hasCaption: !!message.mediaCaption })

        // Wait for share intent to process and dismiss any app chooser dialogs
        await this.delay(3000)
        dialogsDismissed = await this.waitForChatReady(deviceSerial, 5, appPackage)
        await this.tapSendButton(deviceSerial)
        this.record(message.id, 'send_tapped', { method: 'media_share' })
      } else {
        // Text-only flow — pick chat-open method via content-aware strategy.
        // Bodies with non-ASCII or newlines cannot be rendered reliably by
        // typing-based paths (search/typing/chatlist all funnel through
        // Android `input text`), so the strategy falls back to prefill in
        // those cases. See ce34766b for the prior "always prefill" rationale.
        const pick = this.strategy.selectEffectiveMethod(message.body)
        method = pick.method
        this.record(message.id, 'strategy_selected', {
          method,
          selectedRaw: pick.selectedRaw,
          fallbackToPrefill: pick.fallbackToPrefill,
          appPackage,
        })

        if (method === 'prefill') {
          const encodedBody = encodeURIComponent(message.body)
          const deepLink = `https://wa.me/${phoneDigits}?text=${encodedBody}`
          await this.adb.shell(
            deviceSerial,
            `am start -a android.intent.action.VIEW -d '${deepLink}' -p ${appPackage}`,
          )
          await this.delay(isFirstInBatch ? 4000 : 2000)
          await this.detectNoWhatsAppPopup(deviceSerial, phoneDigits)
          dialogsDismissed = await this.waitForChatReady(deviceSerial, 5, appPackage)
        } else if (method === 'search') {
          await this.openViaSearch(deviceSerial, phoneDigits, message.body, appPackage)
        } else if (method === 'typing') {
          await this.openViaTyping(deviceSerial, phoneDigits, message.body, appPackage)
        } else if (method === 'chatlist') {
          await this.openViaChatList(deviceSerial, phoneDigits, message.body, appPackage)
        }

        this.record(message.id, 'chat_opened', { method, dialogsDismissed })
        this.record(message.id, 'message_composed', { method, bodyLength: message.body.length })

        await this.delay(300)
        await this.tapSendButton(deviceSerial)
        this.record(message.id, 'send_tapped', {})
      }

      // Wait for send confirmation
      await this.delay(2000)

      // Post-send validation — authoritative. The UI dump tells us whether
      // the tap on the send button actually delivered the message or the
      // body is still sitting in the chat input field. Marking the message
      // as sent BEFORE this check (the previous behaviour) silently lied
      // to the operator and to downstream metrics whenever the tap missed.
      //
      // Validation throws are treated as soft positives (mark sent) to
      // preserve the old "don't double-send via WAHA" property — a
      // validation infrastructure failure should not be conflated with
      // a real delivery failure.
      let validationDecidedFailure = false
      let validationReason = ''
      try {
        const postSendXml = await this.dumpUi(deviceSerial)
        const validator = new ScreenshotValidator()
        const validation = validator.validate(postSendXml, appPackage)
        this.record(message.id, 'post_send_validation', {
          valid: validation.valid,
          reason: validation.reason,
          chatInputFound: validation.chatInputFound,
          dialogDetected: validation.dialogDetected,
          chatInputHasBodyText: validation.chatInputHasBodyText ?? false,
          lastMessageVisible: validation.lastMessageVisible,
        })
        if (!validation.valid) {
          validationDecidedFailure = true
          validationReason = validation.reason
        }
      } catch (err) {
        // Validation is best-effort — don't fail the send if UI dump fails.
        // Keep the legacy "treat as sent" behaviour on infra errors so we
        // don't lose visibility on otherwise-successful sends.
        this.record(message.id, 'post_send_validation', {
          valid: false,
          reason: `UI dump failed: ${err instanceof Error ? err.message : String(err)}`,
        })
      }

      if (validationDecidedFailure) {
        // Best-effort screenshot for forensic evidence — still happens
        // even though the send is being marked as failed.
        await this.captureForensicScreenshot(deviceSerial, message.id).catch(() => undefined)
        throw new PostSendValidationError(validationReason)
      }

      const durationMs = Date.now() - startTime
      this.queue.updateStatus(message.id, 'sending', 'sent')
      this.emitter.emit('message:sent', {
        id: message.id,
        sentAt: new Date().toISOString(),
        durationMs,
        deviceSerial,
        contactRegistered,
        dialogsDismissed,
        strategyMethod: message.mediaUrl ? 'media' : method,
        appPackage,
        senderNumber: message.senderNumber ?? undefined,
      })

      // Screenshot handling — use policy if available
      const shouldCapture = this.screenshotPolicy
        ? this.screenshotPolicy.shouldCapture(true)
        : true // default: always capture (backward-compatible)

      let screenshot: Buffer = Buffer.alloc(0)
      if (shouldCapture) {
        try {
          screenshot = await this.adb.screenshot(deviceSerial) as Buffer
          const screenshotPath = this.screenshotPolicy
            ? this.screenshotPolicy.getOutputPath(message.id)
            : `reports/sends/${message.id}.png`

          await mkdir('reports/sends', { recursive: true })
          const processed = this.screenshotPolicy
            ? await this.screenshotPolicy.processBuffer(screenshot)
            : screenshot
          await writeFile(screenshotPath, processed)
          this.queue.markScreenshotPersisted(message.id, screenshotPath, processed.length)
          this.record(message.id, 'screenshot_saved', { path: screenshotPath, format: this.screenshotPolicy?.format ?? 'png' })
        } catch (err) {
          // Screenshot persistence is best-effort — don't fail the send
          const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
          this.queue.markScreenshotFailed(message.id, reason)
          this.record(message.id, 'screenshot_failed', { reason })
        }
      } else {
        const skipReason = this.screenshotPolicy?.skipReason() ?? 'policy'
        this.queue.markScreenshotSkipped(message.id, skipReason)
        this.record(message.id, 'screenshot_skipped', { mode: 'sample', reason: skipReason })
      }

      span.setAttributes({ 'send.method': method, 'result': 'sent' })
      span.setStatus({ code: SpanStatusCode.OK })
      span.end()
      return { screenshot, durationMs, contactRegistered, dialogsDismissed }
    } catch (err) {
      // Status transitions on failure are handled by the caller (worker-orchestrator or manual send)
      // so we only clean up device state here and re-throw
      try { await this.ensureCleanState(deviceSerial, appPackage) } catch { /* device may be disconnected */ }

      span.setAttribute('result', 'failed')
      span.recordException(err as Error)
      span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) })
      span.end()
      throw err
    } finally {
      this.processing = false
    }
  }

  private async ensureScreenReady(deviceSerial: string): Promise<void> {
    // Wake + unlock in single batch command (saves 1 round-trip)
    await this.adb.shell(deviceSerial, 'input keyevent KEYCODE_WAKEUP && sleep 0.3 && input swipe 540 1800 540 800 300')
    await this.delay(500)
  }

  private async ensureCleanState(deviceSerial: string, appPackage = 'com.whatsapp'): Promise<void> {
    // Force-stop + HOME in single batch command
    await this.adb.shell(deviceSerial, `am force-stop ${appPackage} && sleep 0.2 && input keyevent 3`)
    await this.delay(300)
  }

  /** Returns true if a NEW contact was created, false if it already existed */
  private async ensureContact(deviceSerial: string, phone: string): Promise<boolean> {
    // Check cache first — skip ADB lookup if contact recently verified
    if (this.contactCache?.isVerified(deviceSerial, phone)) {
      if (!this.queue.hasContact(phone)) {
        const dbName = this.queue.getContactName(phone)
        this.queue.saveContact(phone, dbName ?? `Contato ${phone.slice(-4)}`)
      }
      return false // Already verified — not a new registration
    }

    // Get name from DB (plugin saves patient.name during enqueue)
    const dbName = this.queue.getContactName(phone)
    const name = dbName ?? `Contato ${phone.slice(-4)}`
    const escapedName = escapeForAdbContent(name)

    // Multi-user: target the profile that's currently foreground (where WhatsApp is running).
    // ContactsProvider is isolated per Android user — contacts created in profile 0 are
    // invisible to WhatsApp running in profile 10.
    const foregroundUser = await this.detectForegroundUser(deviceSerial)
    const userFlag = `--user ${foregroundUser}`

    // Check if contact exists on the Android device (in the active profile)
    try {
      const existing = await this.adb.shell(
        deviceSerial,
        `content query ${userFlag} --uri content://com.android.contacts/phone_lookup/${phone} --projection display_name`,
      )
      if (existing.includes('display_name=')) {
        if (!this.queue.hasContact(phone)) {
          this.queue.saveContact(phone, name)
        }
        this.contactCache?.markVerified(deviceSerial, phone)
        return false
      }
    } catch {
      // phone_lookup failed — continue to create
    }

    // Create contact via content provider (no UI dialog).
    // Per feedback_send_flow.md: MUST use Google account (not Local) for WhatsApp sync —
    // when available in the current profile. Profile 10+ usually has only Local/USIM.
    const googleAccount = await this.detectGoogleAccount(deviceSerial)
    const acctBinds = googleAccount
      ? `--bind account_type:s:${googleAccount.type} --bind account_name:s:${googleAccount.name}`
      : `--bind account_type:n: --bind account_name:n:`
    try {
      await this.adb.shell(
        deviceSerial,
        `content insert ${userFlag} --uri content://com.android.contacts/raw_contacts ${acctBinds}`,
      )

      const idOutput = await this.adb.shell(
        deviceSerial,
        `content query ${userFlag} --uri content://com.android.contacts/raw_contacts --projection _id --sort "_id DESC LIMIT 1"`,
      )
      const idMatch = idOutput.match(/_id=(\d+)/)
      if (idMatch) {
        const rawId = idMatch[1]
        await this.adb.shell(
          deviceSerial,
          `content insert ${userFlag} --uri content://com.android.contacts/data --bind raw_contact_id:i:${rawId} --bind mimetype:s:vnd.android.cursor.item/name --bind data1:s:${escapedName}`,
        )
        await this.adb.shell(
          deviceSerial,
          `content insert ${userFlag} --uri content://com.android.contacts/data --bind raw_contact_id:i:${rawId} --bind mimetype:s:vnd.android.cursor.item/phone_v2 --bind data1:s:${escapeForAdbContent(phone)} --bind data2:i:1`,
        )
        this.record(phone, 'contact_created', {
          account_type: googleAccount?.type ?? 'local',
          account_name: googleAccount?.name ?? '',
          raw_contact_id: rawId,
          profile: foregroundUser,
        })
      }
    } catch (err) {
      this.record(phone, 'contact_insert_failed', {
        phone, error: err instanceof Error ? err.message : String(err), profile: foregroundUser,
      })
    }

    // Only save to DB if no name exists yet (don't overwrite plugin-provided patient name)
    if (!this.queue.hasContact(phone)) {
      this.queue.saveContact(phone, name)
    }
    this.contactCache?.markVerified(deviceSerial, phone)
    return true
  }

  private async dumpUi(deviceSerial: string, maxRetries = 3): Promise<string> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const dumpResult = await this.adb.shell(deviceSerial, 'uiautomator dump /sdcard/dispatch-ui.xml')
      // UIAutomator sometimes fails with "null root node" after user switch
      if (dumpResult.includes('ERROR') || dumpResult.includes('null root node')) {
        await this.delay(1000)
        continue
      }
      return this.adb.shell(deviceSerial, 'cat /sdcard/dispatch-ui.xml')
    }
    // Last attempt — read whatever is there
    return this.adb.shell(deviceSerial, 'cat /sdcard/dispatch-ui.xml')
  }

  private async dismissDialogs(deviceSerial: string, xml: string): Promise<boolean> {
    // "Enviar para" / "Abrir com" chooser → tap "WhatsApp" then "Sempre"
    if (/text="(Enviar para|Abrir com|Share with|Open with)"/i.test(xml)) {
      const waMatch = xml.match(/text="WhatsApp(?:\s+Business)?"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/)
      if (waMatch) {
        const cx = Math.round((Number(waMatch[1]) + Number(waMatch[3])) / 2)
        const cy = Math.round((Number(waMatch[2]) + Number(waMatch[4])) / 2)
        await this.sendeventTap(deviceSerial, cx, cy)
        await this.delay(1000)
      }
      // Tap "Sempre" / "Always" if present
      const alwaysXml = await this.dumpUi(deviceSerial)
      const alwaysMatch = alwaysXml.match(/text="(Sempre|Always)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/)
      if (alwaysMatch) {
        const cx = Math.round((Number(alwaysMatch[2]) + Number(alwaysMatch[4])) / 2)
        const cy = Math.round((Number(alwaysMatch[3]) + Number(alwaysMatch[5])) / 2)
        await this.sendeventTap(deviceSerial, cx, cy)
        await this.delay(1500)
      }
      return true
    }

    // "Continuar no WhatsApp" / "Continue to chat"
    const continueMatch = xml.match(/text="(Continuar|Continue)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/)
    if (continueMatch) {
      const cx = Math.round((Number(continueMatch[2]) + Number(continueMatch[4])) / 2)
      const cy = Math.round((Number(continueMatch[3]) + Number(continueMatch[5])) / 2)
      await this.sendeventTap(deviceSerial, cx, cy)
      await this.delay(1500)
      return true
    }

    // "Confiar" / "Trust" (unknown contact warning — WhatsApp shows this for new numbers)
    const trustMatch = xml.match(/text="(Confiar|Trust|Confiar neste contato|Trust this contact)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/)
    if (trustMatch) {
      const cx = Math.round((Number(trustMatch[2]) + Number(trustMatch[4])) / 2)
      const cy = Math.round((Number(trustMatch[3]) + Number(trustMatch[5])) / 2)
      await this.sendeventTap(deviceSerial, cx, cy)
      await this.delay(1500)
      return true
    }

    // "OK" button on trust/safety dialogs
    const okMatch = xml.match(/text="(OK|Ok)"[^>]*clickable="true"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/)
    if (okMatch && (xml.includes('confiar') || xml.includes('trust') || xml.includes('segurança') || xml.includes('safety'))) {
      const cx = Math.round((Number(okMatch[2]) + Number(okMatch[4])) / 2)
      const cy = Math.round((Number(okMatch[3]) + Number(okMatch[5])) / 2)
      await this.sendeventTap(deviceSerial, cx, cy)
      await this.delay(1000)
      return true
    }

    // "Permitir" (notification permission)
    const allowMatch = xml.match(/text="(Permitir|Allow)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/)
    if (allowMatch) {
      const cx = Math.round((Number(allowMatch[2]) + Number(allowMatch[4])) / 2)
      const cy = Math.round((Number(allowMatch[3]) + Number(allowMatch[5])) / 2)
      await this.sendeventTap(deviceSerial, cx, cy)
      await this.delay(1000)
      return true
    }

    return false
  }

  /**
   * Detect "number not on WhatsApp" popup after wa.me deep link.
   * This popup appears when the recipient doesn't have WhatsApp installed.
   * Shows: "O número de telefone +55 XX XXXXX-XXXX não está no WhatsApp."
   * with buttons "Convidar para o WhatsApp" and "Cancelar".
   *
   * If detected: dismiss popup, clean up, throw non-retryable error.
   * This prevents cascade failures where every subsequent message also fails
   * because the popup stays on screen.
   */
  private async detectNoWhatsAppPopup(deviceSerial: string, phone: string): Promise<void> {
    const xml = await this.dumpUi(deviceSerial)

    // Check for the "not on WhatsApp" popup specifically
    // Portuguese: "O número de telefone +55 XX XXXXX-XXXX não está no WhatsApp."
    // English: "The phone number ... is not on WhatsApp."
    const noWhatsApp = xml.includes('não está no WhatsApp') ||
      xml.includes('not on WhatsApp') ||
      xml.includes('Convidar para o WhatsApp') ||
      xml.includes('Invite to WhatsApp')

    if (noWhatsApp) {
      // Dismiss: BACK to close popup, then HOME to clean state
      await this.adb.shell(deviceSerial, 'input keyevent 4')
      await this.delay(500)
      await this.adb.shell(deviceSerial, 'input keyevent 4')
      await this.delay(500)

      // Re-open WhatsApp home to reset state for next message
      await this.adb.shell(deviceSerial, 'am start -n com.whatsapp/com.whatsapp.HomeActivity')
      await this.delay(1500)

      const error = new Error(`Recipient ${phone} is not on WhatsApp — number cannot receive messages`)
      error.name = 'NoWhatsAppError'
      throw error
    }
  }

  /** Returns number of dialogs dismissed before chat became ready */
  private async waitForChatReady(deviceSerial: string, maxRetries = 5, appPackage = 'com.whatsapp'): Promise<number> {
    let dismissedCount = 0
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const xml = await this.dumpUi(deviceSerial)

      // Check for known dialogs and dismiss them
      const dismissed = await this.dismissDialogs(deviceSerial, xml)
      if (dismissed) {
        dismissedCount++
        // Re-dump after dismissal to check for chat input
        await this.delay(1000)
        continue
      }

      // Verify chat input field is ready. Resource-id namespace usually
      // mirrors the Android package, but the Business app (w4b) ships
      // some views with the legacy `com.whatsapp:id/...` prefix. Accept
      // both as a "chat input ready" signal to avoid bouncing through
      // recovery on those views.
      if (
        xml.includes(`${appPackage}:id/entry`) ||
        xml.includes(`${appPackage}:id/text_entry_view`) ||
        xml.includes('com.whatsapp:id/entry') ||
        xml.includes('com.whatsapp:id/text_entry_view')
      ) {
        return dismissedCount
      }

      // Unknown state — try BACK keyevent as generic dialog dismissal
      await this.adb.shell(deviceSerial, 'input keyevent 4')
      await this.delay(1500)
    }

    // All retries exhausted — throw transient error
    throw new Error('Chat input not ready after dialog detection retries')
  }

  /**
   * Open chat via WhatsApp search bar using UIAutomator bounds.
   * Searches by last 8 digits (70%) or contact name (30%) for fingerprint diversity.
   * Resolution-independent — works on any screen size.
   */
  private async openViaSearch(deviceSerial: string, phone: string, body: string, appPackage = 'com.whatsapp'): Promise<void> {
    let xml = await this.dumpUi(deviceSerial)
    let searchIcon = this.findSearchElement(xml, appPackage)

    // Recovery: if search not found, force HomeActivity and retry
    if (!searchIcon) {
      await this.adb.shell(deviceSerial, `am start -n ${appPackage}/com.whatsapp.HomeActivity`)
      await this.delay(3000)
      const recoveryXml = await this.dumpUi(deviceSerial)
      await this.dismissDialogs(deviceSerial, recoveryXml)
      await this.delay(1000)
      xml = await this.dumpUi(deviceSerial)
      searchIcon = this.findSearchElement(xml, appPackage)
      if (!searchIcon) {
        throw new Error('Search element not found after recovery — WhatsApp home screen not reachable')
      }
    }

    // Tap search icon
    await this.sendeventTap(deviceSerial, searchIcon.cx, searchIcon.cy)
    await this.delay(1000)

    // Always search by last 8 digits — reliable and avoids encoding issues with contact names
    const searchQuery = phone.slice(-8)
    const escapedQuery = searchQuery.replace(/'/g, "'\\''")
    await this.adb.shell(deviceSerial, `input text '${escapedQuery}'`)
    await this.delay(1500)

    // Dump UI again to find the first search result
    const searchResultXml = await this.dumpUi(deviceSerial)
    const firstResult = this.findElementBounds(searchResultXml, {
      resourceId: `${appPackage}:id/conversations_row_contact_name`,
    })
    if (!firstResult) {
      throw new Error(`Search result not found for query "${searchQuery}" — contact may not exist in WhatsApp`)
    }

    // Tap first search result
    await this.sendeventTap(deviceSerial, firstResult.cx, firstResult.cy)
    await this.delay(2000)
    await this.clearInputField(deviceSerial)
    await this.typeMessage(deviceSerial, body)
  }

  /**
   * Open chat via WhatsApp chat list (for contacts messaged before).
   * Launches HomeActivity, finds contact row by name, taps it.
   * Falls back to openViaSearch() if contact not found in chat list.
   */
  async openViaChatList(deviceSerial: string, phone: string, body: string, appPackage = 'com.whatsapp'): Promise<void> {
    // Security: validate inputs (same guards as send())
    if (!ALLOWED_PACKAGES.has(appPackage)) {
      throw new Error(`Rejected app package: ${appPackage}`)
    }
    if (!DEVICE_SERIAL_RE.test(deviceSerial)) {
      throw new Error('Rejected device serial: contains unsafe characters')
    }

    // Open WhatsApp home screen
    await this.adb.shell(deviceSerial, `am start -n ${appPackage}/com.whatsapp.HomeActivity`)
    await this.delay(3000)

    const contactName = this.queue.getContactName(phone)
    if (!contactName) {
      // No name in DB — cannot search chat list by name, fall back
      await this.openViaSearch(deviceSerial, phone, body, appPackage)
      return
    }

    const xml = await this.dumpUi(deviceSerial)

    // Search for contact row by name in the chat list
    // Escape regex special chars from contact name to prevent injection into RegExp
    const escapedName = this.escapeRegex(contactName)
    const contactRow = this.findElementBounds(xml, {
      resourceId: `${appPackage}:id/conversations_row_contact_name`,
      text: new RegExp(`^${escapedName}$`, 'i'),
    })

    if (!contactRow) {
      // Contact not visible in chat list — fall back to search
      await this.openViaSearch(deviceSerial, phone, body, appPackage)
      return
    }

    // Tap the contact row
    await this.sendeventTap(deviceSerial, contactRow.cx, contactRow.cy)
    await this.delay(2000)
    await this.waitForChatReady(deviceSerial, 5, appPackage)
    await this.clearInputField(deviceSerial)
    await this.typeMessage(deviceSerial, body)
  }

  private async openViaTyping(deviceSerial: string, phone: string, body: string, appPackage = 'com.whatsapp'): Promise<void> {
    await this.adb.shell(
      deviceSerial,
      `am start -a android.intent.action.VIEW -d "https://wa.me/${phone}" -p ${appPackage}`,
    )
    await this.delay(2000)
    await this.waitForChatReady(deviceSerial, 5, appPackage)
    await this.clearInputField(deviceSerial)
    await this.typeMessage(deviceSerial, body)
  }

  /**
   * Find a UI element by resource-id, text, or content-desc in the UIAutomator XML.
   * Returns the center coordinates of the matching element's bounds, or null if not found.
   */
  private findElementBounds(
    xml: string,
    matcher: { resourceId?: string; text?: RegExp; contentDesc?: RegExp },
  ): { cx: number; cy: number } | null {
    // Parse all nodes from the XML — each <node ...> block
    const nodeRegex = /<node\b[^>]*>/g
    let nodeMatch: RegExpExecArray | null

    while ((nodeMatch = nodeRegex.exec(xml)) !== null) {
      const nodeStr = nodeMatch[0]

      // Check resource-id match
      if (matcher.resourceId) {
        const ridMatch = nodeStr.match(/resource-id="([^"]*)"/)
        if (!ridMatch || ridMatch[1] !== matcher.resourceId) continue
      }

      // Check text match (regex)
      if (matcher.text) {
        const textMatch = nodeStr.match(/\btext="([^"]*)"/)
        if (!textMatch || !matcher.text.test(textMatch[1])) continue
      }

      // Check content-desc match (regex)
      if (matcher.contentDesc) {
        const descMatch = nodeStr.match(/content-desc="([^"]*)"/)
        if (!descMatch || !matcher.contentDesc.test(descMatch[1])) continue
      }

      // Extract bounds [x1,y1][x2,y2]
      const boundsMatch = nodeStr.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/)
      if (!boundsMatch) continue

      const x1 = Number(boundsMatch[1])
      const y1 = Number(boundsMatch[2])
      const x2 = Number(boundsMatch[3])
      const y2 = Number(boundsMatch[4])
      return { cx: Math.round((x1 + x2) / 2), cy: Math.round((y1 + y2) / 2) }
    }

    return null
  }

  /**
   * Find the WhatsApp search element in UIAutomator XML.
   * Supports multiple WA layouts:
   * - New (2025+): search bar with com.whatsapp:id/my_search_bar or search_icon
   * - Legacy: menuitem_search icon
   * - Fallback: content-desc matching Search/Pesquisar
   */
  private findSearchElement(xml: string, appPackage = 'com.whatsapp'): { cx: number; cy: number } | null {
    // New WA layout: integrated search bar (tap anywhere on the bar)
    const searchBar = this.findElementBounds(xml, {
      resourceId: `${appPackage}:id/my_search_bar`,
    })
    if (searchBar) return searchBar

    // New WA layout: search icon inside the bar
    const searchIcon = this.findElementBounds(xml, {
      resourceId: `${appPackage}:id/search_icon`,
    })
    if (searchIcon) return searchIcon

    // Legacy WA layout: menuitem_search
    const menuSearch = this.findElementBounds(xml, {
      resourceId: `${appPackage}:id/menuitem_search`,
    })
    if (menuSearch) return menuSearch

    // Fallback: content-desc matching search-related text (namespace-agnostic).
    return this.findElementBounds(xml, {
      contentDesc: /^(Search|Pesquisar|Pergunte.*pesquise)$/i,
    })
  }

  /**
   * Escape special regex characters in a string to safely use it in a RegExp constructor.
   */
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  private async tapSendButton(deviceSerial: string): Promise<void> {
    const xml = await this.dumpUi(deviceSerial)

    // WhatsApp Business (com.whatsapp.w4b) shares resource ID namespace with com.whatsapp
    const match = xml.match(
      /resource-id="com\.whatsapp:id\/send"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/,
    )

    if (match) {
      const [, x1, y1, x2, y2] = match.map(Number)
      const cx = Math.round((x1 + x2) / 2)
      const cy = Math.round((y1 + y2) / 2)
      await this.sendeventTap(deviceSerial, cx, cy)
    } else {
      await this.adb.shell(deviceSerial, 'input keyevent 66')
    }
  }

  /**
   * Clear any residual text in the chat input field.
   * Moves cursor to end, selects all, then deletes. Safe if field is already empty.
   */
  private async clearInputField(deviceSerial: string): Promise<void> {
    // KEYCODE_MOVE_END (123) → CTRL+A via keyevent combo → KEYCODE_DEL (67)
    await this.adb.shell(deviceSerial, 'input keyevent 123') // move to end
    await this.adb.shell(deviceSerial, 'input keyevent --press KEYCODE_CTRL_LEFT KEYCODE_A') // select all
    await this.delay(100)
    await this.adb.shell(deviceSerial, 'input keyevent 67') // delete selection
    await this.delay(200)
  }

  /**
   * Type message in 50-char chunks with natural delays.
   * Splits on newlines (sent via ENTER keyevent), then sends each line
   * in chunks of up to 50 chars via `input text`. ~80% fewer ADB calls
   * compared to word-by-word approach.
   */
  private async typeMessage(deviceSerial: string, text: string): Promise<void> {
    const lines = text.split('\n')

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx]

      if (line.length > 0) {
        // Send line in chunks of up to 50 chars (ADB input text reliability limit)
        for (let i = 0; i < line.length; i += 50) {
          const chunk = line.slice(i, i + 50)
          const escaped = chunk.replace(/'/g, "'\\''")
          await this.adb.shell(deviceSerial, `input text '${escaped}'`)
          // Human-like pause between chunks (100-250ms, gaussian)
          if (i + 50 < line.length) {
            await this.delay(this.gaussianDelay(150, 40))
          }
        }
      }

      // Type newline between lines (not after last line)
      if (lineIdx < lines.length - 1) {
        await this.adb.shell(deviceSerial, 'input keyevent 66') // ENTER
        await this.delay(this.gaussianDelay(100, 30))
      }
    }
  }

  /**
   * Detect the touchscreen input device by scanning /dev/input/eventN.
   * Checks the ABS capabilities bitmask for ABS_MT_POSITION_X (bit 53) and ABS_MT_POSITION_Y (bit 54).
   * Result is cached per device serial to avoid repeated filesystem scans.
   */
  private async detectTouchDevice(deviceSerial: string): Promise<string | null> {
    if (this.touchDeviceCache.has(deviceSerial)) {
      return this.touchDeviceCache.get(deviceSerial)!
    }

    for (let i = 0; i <= 10; i++) {
      const caps = await this.adb.shell(deviceSerial,
        `su -c "cat /sys/class/input/event${i}/device/capabilities/abs 2>/dev/null"`,
      ).catch(() => '')
      const trimmed = caps.trim().replace(/\s+/g, '')
      if (!trimmed) continue
      // Non-rooted devices return stderr text on stdout for this `su -c "..."`
      // pattern (e.g. "/system/bin/sh: su: inaccessible or not found"). Guard
      // against feeding that into BigInt — only proceed when the trimmed
      // output is a valid hex bitmask string. Anything else is skipped and
      // the loop advances to the next event index.
      if (!/^[0-9a-fA-F]+$/.test(trimmed)) continue
      // Parse hex bitmask — check for ABS_MT_POSITION_X (bit 53) + ABS_MT_POSITION_Y (bit 54)
      const val = BigInt('0x' + trimmed)
      if ((val & (1n << 53n)) && (val & (1n << 54n))) {
        const device = `/dev/input/event${i}`
        this.touchDeviceCache.set(deviceSerial, device)
        return device
      }
    }

    this.touchDeviceCache.set(deviceSerial, null)
    return null
  }

  /**
   * Tap via Linux sendevent on the touchscreen input device.
   * Bypasses Android's input injection framework, eliminating the POLICY_FLAG_INJECTED flag
   * that WhatsApp could detect. Falls back to `input tap` when root or touch device is unavailable.
   *
   * Event codes:
   * - ABS_MT_TRACKING_ID (3,57): 0 to start, 0xFFFFFFFF to end
   * - ABS_MT_POSITION_X (3,53): x coordinate
   * - ABS_MT_POSITION_Y (3,54): y coordinate
   * - ABS_MT_TOUCH_MAJOR (3,48): finger contact area (5-10)
   * - BTN_TOUCH (1,330): 1 down, 0 up
   * - SYN_REPORT (0,0,0): sync
   */
  private async sendeventTap(deviceSerial: string, x: number, y: number): Promise<void> {
    const touchDevice = await this.detectTouchDevice(deviceSerial)
    if (!touchDevice) {
      // No touch device detected — fall back to input tap
      await this.adb.shell(deviceSerial, `input tap ${x} ${y}`)
      return
    }

    // Realistic finger contact area variation
    const touchMajor = 5 + Math.floor(Math.random() * 6) // 5-10
    // Slight position jitter (+/- 3px)
    const jx = x + Math.floor(Math.random() * 7) - 3
    const jy = y + Math.floor(Math.random() * 7) - 3
    // Realistic hold time: 60-140ms
    const holdUs = 60000 + Math.floor(Math.random() * 80000)

    await this.adb.shell(deviceSerial,
      `su -c "sendevent ${touchDevice} 3 57 0; ` +
      `sendevent ${touchDevice} 3 53 ${jx}; ` +
      `sendevent ${touchDevice} 3 54 ${jy}; ` +
      `sendevent ${touchDevice} 3 48 ${touchMajor}; ` +
      `sendevent ${touchDevice} 1 330 1; ` +
      `sendevent ${touchDevice} 0 0 0; ` +
      `usleep ${holdUs}; ` +
      `sendevent ${touchDevice} 3 57 4294967295; ` +
      `sendevent ${touchDevice} 1 330 0; ` +
      `sendevent ${touchDevice} 0 0 0"`,
    )
  }

  private gaussianDelay(mean: number, stddev: number): number {
    const u1 = Math.random()
    const u2 = Math.random()
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
    return Math.max(20, Math.round(mean + z * stddev))
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}
