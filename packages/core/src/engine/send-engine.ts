import type { AdbBridge } from '../adb/index.js'
import type { MessageQueue, Message } from '../queue/index.js'
import type { DispatchEmitter } from '../events/index.js'

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

      await this.ensureCleanState(deviceSerial)
      await this.ensureContact(deviceSerial, message.to)

      await this.adb.shell(
        deviceSerial,
        `am start -a android.intent.action.VIEW -d "https://wa.me/${message.to}" -p com.whatsapp`,
      )
      await this.delay(4000)

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

  private async ensureCleanState(deviceSerial: string): Promise<void> {
    await this.adb.shell(deviceSerial, 'input keyevent 4') // BACK
    await this.delay(300)
    await this.adb.shell(deviceSerial, 'input keyevent 3') // HOME
    await this.delay(500)
  }

  private async ensureContact(deviceSerial: string, phone: string): Promise<void> {
    if (this.queue.hasContact(phone)) return

    const name = `Contato ${phone.slice(-4)}`
    await this.adb.shell(
      deviceSerial,
      `am start -a android.intent.action.INSERT -t vnd.android.cursor.dir/contact --es phone "${phone}" --es name "${name}"`,
    )
    await this.delay(2000)

    // Two BACKs to dismiss contact editor (save prompt + editor)
    for (let i = 0; i < 2; i++) {
      await this.adb.shell(deviceSerial, 'input keyevent 4')
      await this.delay(500)
    }

    this.queue.saveContact(phone, name)
  }

  private async tapSendButton(deviceSerial: string): Promise<void> {
    await this.adb.shell(deviceSerial, 'uiautomator dump /sdcard/dispatch-ui.xml')
    const xml = await this.adb.shell(deviceSerial, 'cat /sdcard/dispatch-ui.xml')

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
