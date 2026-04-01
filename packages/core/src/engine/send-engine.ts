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

    // Open WhatsApp chat via wa.me deep link
    await this.adb.shell(
      deviceSerial,
      `am start -a android.intent.action.VIEW -d "https://wa.me/${message.to}"`,
    )
    await this.delay(3000)

    // Type message char by char with Gaussian delays
    for (const char of message.body) {
      if (char === ' ') {
        await this.adb.shell(deviceSerial, 'input keyevent 62')
      } else {
        const escaped = char.replace(/'/g, "'\\''")
        await this.adb.shell(deviceSerial, `input text '${escaped}'`)
      }
      await this.delay(this.gaussianDelay(80, 30))
    }

    // Press send (Enter)
    await this.delay(500)
    await this.adb.shell(deviceSerial, 'input keyevent 66')

    // Wait for send + take screenshot
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
