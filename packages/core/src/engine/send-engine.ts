import { writeFile, mkdir } from 'node:fs/promises'
import type { AdbBridge } from '../adb/index.js'
import type { MessageQueue, Message } from '../queue/index.js'
import type { DispatchEmitter } from '../events/index.js'
import { escapeForAdbContent } from './contact-utils.js'

export interface SendResult {
  screenshot: Buffer
  durationMs: number
}

export class SendEngine {
  private processing = false

  constructor(
    private adb: AdbBridge,
    private queue: MessageQueue,
    private emitter: DispatchEmitter,
  ) {}

  get isProcessing(): boolean {
    return this.processing
  }

  async send(message: Message, deviceSerial: string): Promise<SendResult> {
    this.processing = true
    const startTime = Date.now()

    try {
      this.queue.updateStatus(message.id, 'sending')
      this.emitter.emit('message:sending', { id: message.id, deviceSerial })

      await this.ensureScreenReady(deviceSerial)
      await this.ensureCleanState(deviceSerial)
      await this.ensureContact(deviceSerial, message.to)

      // No --user flag needed — worker loop already switched to correct foreground user
      await this.adb.shell(
        deviceSerial,
        `am start -a android.intent.action.VIEW -d "https://wa.me/${message.to}" -p com.whatsapp`,
      )
      await this.delay(4000)

      // Detect and dismiss known WhatsApp dialogs, then verify chat is ready
      await this.waitForChatReady(deviceSerial)

      for (const char of message.body) {
        if (char === ' ') {
          await this.adb.shell(deviceSerial, 'input keyevent 62')
        } else {
          const escaped = char.replace(/'/g, "'\\''")
          await this.adb.shell(deviceSerial, `input text '${escaped}'`)
        }
        await this.delay(this.gaussianDelay(80, 30))
      }

      await this.delay(500)
      await this.tapSendButton(deviceSerial)

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
      })

      return { screenshot, durationMs }
    } catch (err) {
      try { this.queue.updateStatus(message.id, 'failed') } catch { /* DB may be closed */ }
      this.emitter.emit('message:failed', {
        id: message.id,
        error: err instanceof Error ? err.message : String(err),
      })

      try { await this.ensureCleanState(deviceSerial) } catch { /* device may be disconnected */ }

      throw err
    } finally {
      this.processing = false
    }
  }

  private async ensureScreenReady(deviceSerial: string): Promise<void> {
    // Proactively wake the screen — cheap and prevents false negatives after user switch
    await this.adb.shell(deviceSerial, 'input keyevent KEYCODE_WAKEUP')
    await this.delay(500)

    // Dismiss lock screen if present
    const windowState = await this.adb.shell(deviceSerial, 'dumpsys window')
    if (/mDreamingLockscreen=true|isStatusBarKeyguard=true|mShowingLockscreen=true/i.test(windowState)) {
      await this.adb.shell(deviceSerial, 'input swipe 540 1800 540 800 300')
      await this.delay(1000)
    }
  }

  private async ensureCleanState(deviceSerial: string): Promise<void> {
    // Force-stop WhatsApp to ensure a fresh start (prevents "Activity not started" issue)
    await this.adb.shell(deviceSerial, 'am force-stop com.whatsapp')
    await this.delay(300)
    await this.adb.shell(deviceSerial, 'input keyevent 3') // HOME
    await this.delay(500)
  }

  private async ensureContact(deviceSerial: string, phone: string): Promise<void> {
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
        return
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
      const waMatch = xml.match(/text="WhatsApp"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/)
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

  private async waitForChatReady(deviceSerial: string, maxRetries = 5): Promise<void> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const xml = await this.dumpUi(deviceSerial)

      // Check for known dialogs and dismiss them
      const dismissed = await this.dismissDialogs(deviceSerial, xml)
      if (dismissed) {
        // Re-dump after dismissal to check for chat input
        await this.delay(1000)
        continue
      }

      // Verify chat input field is ready
      if (
        xml.includes('com.whatsapp:id/entry') ||
        xml.includes('com.whatsapp:id/text_entry_view')
      ) {
        return // Chat is ready
      }

      // Not ready yet — wait and retry
      await this.delay(1000)
    }

    // All retries exhausted — throw transient error
    throw new Error('Chat input not ready after dialog detection retries')
  }

  private async tapSendButton(deviceSerial: string): Promise<void> {
    const xml = await this.dumpUi(deviceSerial)

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
