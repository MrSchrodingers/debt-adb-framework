import { writeFile, mkdir } from 'node:fs/promises'
import type { AdbBridge } from '../adb/index.js'
import type { MessageQueue, Message } from '../queue/index.js'
import type { DispatchEmitter } from '../events/index.js'
import { escapeForAdbContent } from './contact-utils.js'

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

  constructor(
    private adb: AdbBridge,
    private queue: MessageQueue,
    private emitter: DispatchEmitter,
    private strategy: SendStrategy = new SendStrategy(),
  ) {}

  get isProcessing(): boolean {
    return this.processing
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

    try {
      this.queue.updateStatus(message.id, 'sending')
      this.emitter.emit('message:sending', { id: message.id, deviceSerial })

      // Normalize and validate phone number (accept +55, spaces, hyphens — strip to digits)
      const phoneDigits = message.to.replace(/[\s\-+()]/g, '')
      if (!/^\d{10,15}$/.test(phoneDigits)) {
        throw new Error(`Invalid phone number: ${message.to}`)
      }

      if (isFirstInBatch) {
        await this.ensureScreenReady(deviceSerial)
        await this.ensureCleanState(deviceSerial, appPackage)
      } else {
        // Between messages: BACK to exit chat, keep WhatsApp open
        await this.adb.shell(deviceSerial, 'input keyevent 4')
        await this.delay(500)
      }

      const contactRegistered = await this.ensureContact(deviceSerial, phoneDigits)

      // Select chat opening method (diversifies entryPointSource fingerprint)
      const method = this.strategy.selectMethod()
      let dialogsDismissed = 0

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
        if (!usePreFill) {
          await this.typeMessage(deviceSerial, message.body)
        }
      } else if (method === 'search') {
        if (isFirstInBatch) {
          await this.adb.shell(deviceSerial, `am start -n ${appPackage}/com.whatsapp.HomeActivity`)
          await this.delay(3000)
        }
        await this.openViaSearch(deviceSerial, phoneDigits, message.body)
        dialogsDismissed = 0
      } else {
        await this.openViaTyping(deviceSerial, phoneDigits, message.body, appPackage)
        dialogsDismissed = 0
      }

      await this.delay(300)
      await this.tapSendButton(deviceSerial)

      // Wait for send confirmation
      await this.delay(2000)
      const screenshot = await this.adb.screenshot(deviceSerial)

      // Persist screenshot to disk for audit trail
      const screenshotDir = 'reports/sends'
      const screenshotPath = `${screenshotDir}/${message.id}.png`
      try {
        await mkdir(screenshotDir, { recursive: true })
        await writeFile(screenshotPath, screenshot)
        this.queue.updateScreenshotPath(message.id, screenshotPath)
      } catch {
        // Screenshot persistence is best-effort — don't fail the send
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
      })

      return { screenshot, durationMs, contactRegistered, dialogsDismissed }
    } catch (err) {
      try { this.queue.updateStatus(message.id, 'failed') } catch { /* DB may be closed */ }
      this.emitter.emit('message:failed', {
        id: message.id,
        error: err instanceof Error ? err.message : String(err),
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
        await this.adb.shell(deviceSerial, `input tap ${cx} ${cy}`)
        await this.delay(1000)
      }
      // Tap "Sempre" / "Always" if present
      const alwaysXml = await this.dumpUi(deviceSerial)
      const alwaysMatch = alwaysXml.match(/text="(Sempre|Always)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/)
      if (alwaysMatch) {
        const cx = Math.round((Number(alwaysMatch[2]) + Number(alwaysMatch[4])) / 2)
        const cy = Math.round((Number(alwaysMatch[3]) + Number(alwaysMatch[5])) / 2)
        await this.adb.shell(deviceSerial, `input tap ${cx} ${cy}`)
        await this.delay(1500)
      }
      return true
    }

    // "Continuar no WhatsApp" / "Continue to chat"
    const continueMatch = xml.match(/text="(Continuar|Continue)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/)
    if (continueMatch) {
      const cx = Math.round((Number(continueMatch[2]) + Number(continueMatch[4])) / 2)
      const cy = Math.round((Number(continueMatch[3]) + Number(continueMatch[5])) / 2)
      await this.adb.shell(deviceSerial, `input tap ${cx} ${cy}`)
      await this.delay(1500)
      return true
    }

    // "Permitir" (notification permission)
    const allowMatch = xml.match(/text="(Permitir|Allow)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/)
    if (allowMatch) {
      const cx = Math.round((Number(allowMatch[2]) + Number(allowMatch[4])) / 2)
      const cy = Math.round((Number(allowMatch[3]) + Number(allowMatch[5])) / 2)
      await this.adb.shell(deviceSerial, `input tap ${cx} ${cy}`)
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

      // Not ready yet — wait and retry
      await this.delay(1000)
    }

    // All retries exhausted — throw transient error
    throw new Error('Chat input not ready after dialog detection retries')
  }

  /**
   * Open chat via WhatsApp search bar.
   * Uses last 8 digits to minimize false matches (4 digits is too ambiguous
   * when multiple contacts share the same suffix).
   * Coordinates are POCO C71 specific (720x1600).
   */
  private async openViaSearch(deviceSerial: string, phone: string, body: string): Promise<void> {
    // Tap search icon
    await this.adb.shell(deviceSerial, 'input tap 624 172')
    await this.delay(1000)
    // Type last 8 digits — specific enough to match a single contact
    const searchDigits = phone.slice(-8)
    await this.adb.shell(deviceSerial, `input text '${searchDigits}'`)
    await this.delay(1500)
    // Tap first search result
    await this.adb.shell(deviceSerial, 'input tap 360 350')
    await this.delay(2000)
    await this.typeMessage(deviceSerial, body)
  }

  private async openViaTyping(deviceSerial: string, phone: string, body: string, appPackage = 'com.whatsapp'): Promise<void> {
    await this.adb.shell(
      deviceSerial,
      `am start -a android.intent.action.VIEW -d "https://wa.me/${phone}" -p ${appPackage}`,
    )
    await this.delay(2000)
    await this.waitForChatReady(deviceSerial)
    await this.typeMessage(deviceSerial, body)
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
      await this.adb.shell(deviceSerial, `input tap ${cx} ${cy}`)
    } else {
      await this.adb.shell(deviceSerial, 'input keyevent 66')
    }
  }

  /**
   * Type message in word-level chunks with natural delays.
   * ~3-5x faster than char-by-char while maintaining human-like pacing.
   * Each word = 1 ADB call instead of N chars = N ADB calls.
   */
  private async typeMessage(deviceSerial: string, text: string): Promise<void> {
    // Split text into words, preserving spaces
    const words = text.split(/(\s+)/)

    for (const segment of words) {
      if (!segment) continue

      if (/^\s+$/.test(segment)) {
        // Whitespace segment: type spaces via keyevent (more reliable)
        for (const ch of segment) {
          if (ch === '\n') {
            await this.adb.shell(deviceSerial, 'input keyevent 66') // ENTER
          } else {
            await this.adb.shell(deviceSerial, 'input keyevent 62') // SPACE
          }
        }
      } else {
        // Word segment: type entire word in one shell call
        const escaped = segment.replace(/'/g, "'\\''")
        await this.adb.shell(deviceSerial, `input text '${escaped}'`)
      }

      // Human-like pause between words (150-350ms, gaussian)
      await this.delay(this.gaussianDelay(200, 60))
    }
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
