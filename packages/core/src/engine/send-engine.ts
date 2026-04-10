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

/** Packages allowed in am start/force-stop commands. Reject everything else. */
const ALLOWED_PACKAGES = new Set(['com.whatsapp', 'com.whatsapp.w4b'])

/** Device serials: alphanumeric + limited safe chars. Reject shell metacharacters. */
const DEVICE_SERIAL_RE = /^[a-zA-Z0-9_:.\-]+$/
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

  private record(messageId: string, event: string, metadata?: Record<string, unknown>): void {
    this.recorder?.record(messageId, event, metadata)
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

    let method: string = 'unknown' // enrichment: populated in text/media branch, used in emit

    try {
      this.queue.updateStatus(message.id, 'sending')
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
        dialogsDismissed = await this.waitForChatReady(deviceSerial)
        await this.tapSendButton(deviceSerial)
        this.record(message.id, 'send_tapped', { method: 'media_share' })
      } else {
        // Text-only flow — select chat opening method (diversifies entryPointSource fingerprint)
        method = this.strategy.selectMethod(message.body.length)
        this.record(message.id, 'strategy_selected', { method, appPackage })

        if (method === 'prefill') {
          // wa.me?text= pre-fill (fast, no typing indicator)
          const encodedBody = encodeURIComponent(message.body)
          const deepLink = `https://wa.me/${phoneDigits}?text=${encodedBody}`
          const usePreFill = deepLink.length < 2000

          await this.adb.shell(
            deviceSerial,
            `am start -a android.intent.action.VIEW -d "${usePreFill ? deepLink : `https://wa.me/${phoneDigits}`}" -p ${appPackage}`,
          )
          await this.delay(isFirstInBatch ? 4000 : 2000)
          dialogsDismissed = await this.waitForChatReady(deviceSerial)
          this.record(message.id, 'chat_opened', { method, dialogsDismissed })
          if (!usePreFill) {
            await this.withTimeout(this.typeMessage(deviceSerial, message.body), 30_000, 'typeMessage')
          }
          this.record(message.id, 'message_composed', { method, bodyLength: message.body.length })
        } else if (method === 'search') {
          if (isFirstInBatch) {
            await this.adb.shell(deviceSerial, `am start -n ${appPackage}/com.whatsapp.HomeActivity`)
            await this.delay(3000)
          }
          await this.withTimeout(this.openViaSearch(deviceSerial, phoneDigits, message.body, appPackage), 30_000, 'openViaSearch')
          dialogsDismissed = 0
          this.record(message.id, 'chat_opened', { method, dialogsDismissed })
          this.record(message.id, 'message_composed', { method, bodyLength: message.body.length })
        } else if (method === 'chatlist') {
          await this.withTimeout(this.openViaChatList(deviceSerial, phoneDigits, message.body, appPackage), 30_000, 'openViaChatList')
          dialogsDismissed = 0
          this.record(message.id, 'chat_opened', { method, dialogsDismissed })
          this.record(message.id, 'message_composed', { method, bodyLength: message.body.length })
        } else {
          await this.withTimeout(this.openViaTyping(deviceSerial, phoneDigits, message.body, appPackage), 30_000, 'openViaTyping')
          dialogsDismissed = 0
          this.record(message.id, 'chat_opened', { method, dialogsDismissed })
          this.record(message.id, 'message_composed', { method, bodyLength: message.body.length })
        }

        await this.delay(300)
        await this.tapSendButton(deviceSerial)
        this.record(message.id, 'send_tapped', {})
      }

      // Wait for send confirmation
      await this.delay(2000)

      // Post-send validation — check UI state via XML dump (observability-only)
      try {
        const postSendXml = await this.dumpUi(deviceSerial)
        const validator = new ScreenshotValidator()
        const validation = validator.validate(postSendXml)
        this.record(message.id, 'post_send_validation', {
          valid: validation.valid,
          reason: validation.reason,
          chatInputFound: validation.chatInputFound,
          dialogDetected: validation.dialogDetected,
          lastMessageVisible: validation.lastMessageVisible,
        })
      } catch {
        // Validation is best-effort — don't fail the send if UI dump fails
        this.record(message.id, 'post_send_validation', { valid: false, reason: 'UI dump failed' })
      }

      // Screenshot handling — use policy if available
      const shouldCapture = this.screenshotPolicy
        ? this.screenshotPolicy.shouldCapture(true)
        : true // default: always capture (backward-compatible)

      let screenshot = Buffer.alloc(0)
      if (shouldCapture) {
        screenshot = await this.adb.screenshot(deviceSerial)
        const screenshotPath = this.screenshotPolicy
          ? this.screenshotPolicy.getOutputPath(message.id)
          : `reports/sends/${message.id}.png`

        try {
          await mkdir('reports/sends', { recursive: true })
          const processed = this.screenshotPolicy
            ? await this.screenshotPolicy.processBuffer(screenshot)
            : screenshot
          await writeFile(screenshotPath, processed)
          this.queue.updateScreenshotPath(message.id, screenshotPath)
          this.record(message.id, 'screenshot_saved', { path: screenshotPath, format: this.screenshotPolicy?.format ?? 'png' })
        } catch {
          // Screenshot persistence is best-effort — don't fail the send
        }
      } else {
        this.record(message.id, 'screenshot_skipped', { mode: 'sample' })
      }

      const durationMs = Date.now() - startTime
      this.queue.updateStatus(message.id, 'sent')
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

      return { screenshot, durationMs, contactRegistered, dialogsDismissed }
    } catch (err) {
      try { this.queue.updateStatus(message.id, 'failed') } catch { /* DB may be closed */ }
      this.emitter.emit('message:failed', {
        id: message.id,
        error: err instanceof Error ? err.message : String(err),
        attempts: message.attempts,
        senderNumber: message.senderNumber ?? undefined,
        lastStrategyMethod: method,
      })

      try { await this.ensureCleanState(deviceSerial, appPackage) } catch { /* device may be disconnected */ }

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

    // Check if contact exists on the Android device
    try {
      const existing = await this.adb.shell(
        deviceSerial,
        `content query --uri content://com.android.contacts/phone_lookup/${phone} --projection display_name`,
      )
      if (existing.includes('display_name=')) {
        // Contact exists on device — no need to create
        if (!this.queue.hasContact(phone)) {
          this.queue.saveContact(phone, name)
        }
        this.contactCache?.markVerified(deviceSerial, phone)
        return false
      }
    } catch {
      // phone_lookup failed — continue to create
    }

    // Create contact via content provider (no UI dialog)
    try {
      await this.adb.shell(
        deviceSerial,
        `content insert --uri content://com.android.contacts/raw_contacts --bind account_type:n: --bind account_name:n:`,
      )

      const idOutput = await this.adb.shell(
        deviceSerial,
        `content query --uri content://com.android.contacts/raw_contacts --projection _id --sort "_id DESC LIMIT 1"`,
      )
      const idMatch = idOutput.match(/_id=(\d+)/)
      if (idMatch) {
        const rawId = idMatch[1]
        await this.adb.shell(
          deviceSerial,
          `content insert --uri content://com.android.contacts/data --bind raw_contact_id:i:${rawId} --bind mimetype:s:vnd.android.cursor.item/name --bind data1:s:${escapedName}`,
        )
        await this.adb.shell(
          deviceSerial,
          `content insert --uri content://com.android.contacts/data --bind raw_contact_id:i:${rawId} --bind mimetype:s:vnd.android.cursor.item/phone_v2 --bind data1:s:${escapeForAdbContent(phone)} --bind data2:i:1`,
        )
      }
    } catch {
      // Contact creation failed — continue anyway, wa.me works without saved contact
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

  /** Returns number of dialogs dismissed before chat became ready */
  private async waitForChatReady(deviceSerial: string, maxRetries = 5): Promise<number> {
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

      // Verify chat input field is ready
      // WhatsApp Business (com.whatsapp.w4b) shares resource ID namespace with com.whatsapp
      if (
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
    let searchIcon = this.findSearchElement(xml)

    // Recovery: if search not found, force HomeActivity and retry
    if (!searchIcon) {
      await this.adb.shell(deviceSerial, `am start -n ${appPackage}/com.whatsapp.HomeActivity`)
      await this.delay(3000)
      const recoveryXml = await this.dumpUi(deviceSerial)
      await this.dismissDialogs(deviceSerial, recoveryXml)
      await this.delay(1000)
      xml = await this.dumpUi(deviceSerial)
      searchIcon = this.findSearchElement(xml)
      if (!searchIcon) {
        throw new Error('Search element not found after recovery — WhatsApp home screen not reachable')
      }
    }

    // Tap search icon
    await this.sendeventTap(deviceSerial, searchIcon.cx, searchIcon.cy)
    await this.delay(1000)

    // Diversify search query: 70% digits, 30% contact name (if available)
    let searchQuery: string
    const contactName = this.queue.getContactName(phone)
    if (contactName && Math.random() < 0.3) {
      // Search by contact name — escape single quotes for ADB shell
      searchQuery = contactName
    } else {
      // Search by last 8 digits — specific enough to match a single contact
      searchQuery = phone.slice(-8)
    }
    const escapedQuery = searchQuery.replace(/'/g, "'\\''")
    await this.adb.shell(deviceSerial, `input text '${escapedQuery}'`)
    await this.delay(1500)

    // Dump UI again to find the first search result
    const searchResultXml = await this.dumpUi(deviceSerial)
    const firstResult = this.findElementBounds(searchResultXml, {
      resourceId: 'com.whatsapp:id/conversations_row_contact_name',
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
      resourceId: 'com.whatsapp:id/conversations_row_contact_name',
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
    await this.waitForChatReady(deviceSerial)
    await this.clearInputField(deviceSerial)
    await this.typeMessage(deviceSerial, body)
  }

  private async openViaTyping(deviceSerial: string, phone: string, body: string, appPackage = 'com.whatsapp'): Promise<void> {
    await this.adb.shell(
      deviceSerial,
      `am start -a android.intent.action.VIEW -d "https://wa.me/${phone}" -p ${appPackage}`,
    )
    await this.delay(2000)
    await this.waitForChatReady(deviceSerial)
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
  private findSearchElement(xml: string): { cx: number; cy: number } | null {
    // New WA layout: integrated search bar (tap anywhere on the bar)
    const searchBar = this.findElementBounds(xml, {
      resourceId: 'com.whatsapp:id/my_search_bar',
    })
    if (searchBar) return searchBar

    // New WA layout: search icon inside the bar
    const searchIcon = this.findElementBounds(xml, {
      resourceId: 'com.whatsapp:id/search_icon',
    })
    if (searchIcon) return searchIcon

    // Legacy WA layout: menuitem_search
    const menuSearch = this.findElementBounds(xml, {
      resourceId: 'com.whatsapp:id/menuitem_search',
    })
    if (menuSearch) return menuSearch

    // Fallback: content-desc matching search-related text
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
      if (caps.trim()) {
        // Parse hex bitmask — check for ABS_MT_POSITION_X (bit 53) + ABS_MT_POSITION_Y (bit 54)
        const val = BigInt('0x' + caps.trim().replace(/\s+/g, ''))
        if ((val & (1n << 53n)) && (val & (1n << 54n))) {
          const device = `/dev/input/event${i}`
          this.touchDeviceCache.set(deviceSerial, device)
          return device
        }
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
