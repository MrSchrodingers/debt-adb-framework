import type { AdbBridge } from '../adb/index.js'
import type { MessageQueue, Message } from '../queue/index.js'
import type { DispatchEmitter } from '../events/index.js'

export interface SendResult {
  screenshot: Buffer
  durationMs: number
}

export class SendEngine {
  constructor(
    private adb: AdbBridge,
    private queue: MessageQueue,
    private emitter: DispatchEmitter,
  ) {}

  async send(message: Message, deviceSerial: string): Promise<SendResult> {
    const startTime = Date.now()

    this.queue.updateStatus(message.id, 'sending')
    this.emitter.emit('message:sending', { id: message.id, deviceSerial })

    // Step 0: Ensure clean state — dismiss any overlays, go home
    await this.ensureCleanState(deviceSerial)

    // Step 1: Register contact (ensures WhatsApp can find them)
    await this.registerContact(deviceSerial, message.to)

    // Step 2: Open WhatsApp Messenger chat (explicit -p com.whatsapp to avoid Business)
    await this.adb.shell(
      deviceSerial,
      `am start -a android.intent.action.VIEW -d "https://wa.me/${message.to}" -p com.whatsapp`,
    )
    await this.delay(4000)

    // Step 3: Type message char by char with Gaussian delays
    for (const char of message.body) {
      if (char === ' ') {
        await this.adb.shell(deviceSerial, 'input keyevent 62')
      } else {
        const escaped = char.replace(/'/g, "'\\''")
        await this.adb.shell(deviceSerial, `input text '${escaped}'`)
      }
      await this.delay(this.gaussianDelay(80, 30))
    }

    // Step 4: Find and tap send button via UI hierarchy
    await this.delay(500)
    await this.tapSendButton(deviceSerial)

    // Step 5: Wait for send + take screenshot
    await this.delay(2000)
    const screenshot = await this.adb.screenshot(deviceSerial)

    const durationMs = Date.now() - startTime
    this.queue.updateStatus(message.id, 'sent')
    this.emitter.emit('message:sent', {
      id: message.id,
      sentAt: new Date().toISOString(),
      durationMs,
    })

    return { screenshot, durationMs }
  }

  private async ensureCleanState(deviceSerial: string): Promise<void> {
    // Dismiss any dialogs/overlays
    await this.adb.shell(deviceSerial, 'input keyevent 4') // BACK
    await this.delay(300)
    // Go to home screen for a clean starting point
    await this.adb.shell(deviceSerial, 'input keyevent 3') // HOME
    await this.delay(500)
  }

  private async registerContact(deviceSerial: string, phone: string): Promise<void> {
    const name = `Contato ${phone.slice(-4)}`
    await this.adb.shell(
      deviceSerial,
      `am start -a android.intent.action.INSERT -t vnd.android.cursor.dir/contact --es phone "${phone}" --es name "${name}"`,
    )
    await this.delay(2000)

    // Dismiss contact editor — press back twice to exit
    await this.adb.shell(deviceSerial, 'input keyevent 4')
    await this.delay(500)
    await this.adb.shell(deviceSerial, 'input keyevent 4')
    await this.delay(500)
  }

  private async tapSendButton(deviceSerial: string): Promise<void> {
    // Use uiautomator to find the send button reliably
    await this.adb.shell(deviceSerial, 'uiautomator dump /sdcard/dispatch-ui.xml')
    const xml = await this.adb.shell(deviceSerial, 'cat /sdcard/dispatch-ui.xml')

    const sendMatch = xml.match(
      /resource-id="com\.whatsapp:id\/send"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/,
    )

    if (sendMatch) {
      const cx = Math.round((parseInt(sendMatch[1]) + parseInt(sendMatch[3])) / 2)
      const cy = Math.round((parseInt(sendMatch[2]) + parseInt(sendMatch[4])) / 2)
      await this.adb.shell(deviceSerial, `input tap ${cx} ${cy}`)
    } else {
      // Fallback: press Enter (works in some WhatsApp configurations)
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
