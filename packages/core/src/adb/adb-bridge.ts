import adbkit, { type Adb as AdbType } from '@devicefarmer/adbkit'
import type { DeviceInfo } from './types.js'

const Adb: typeof AdbType =
  ((adbkit as Record<string, unknown>).default as typeof AdbType) ??
  (adbkit as unknown as typeof AdbType)

export class AdbBridge {
  private client: ReturnType<typeof Adb.createClient>

  constructor() {
    this.client = Adb.createClient()
  }

  async discover(): Promise<DeviceInfo[]> {
    const devices = await this.client.listDevices()
    const results: DeviceInfo[] = []

    for (const d of devices) {
      const info: DeviceInfo = {
        serial: d.id,
        type: d.type as DeviceInfo['type'],
      }
      if (d.type === 'device') {
        const [brand, model] = await Promise.all([
          this.getProp(d.id, 'ro.product.brand'),
          this.getProp(d.id, 'ro.product.model'),
        ])
        info.brand = brand
        info.model = model
      }
      results.push(info)
    }

    return results
  }

  async shell(serial: string, command: string): Promise<string> {
    const device = this.client.getDevice(serial)
    const stream = await device.shell(command)
    const buf = await Adb.util.readAll(stream)
    return buf.toString().trim()
  }

  async screenshot(serial: string): Promise<Buffer> {
    const device = this.client.getDevice(serial)
    const stream = await device.screencap()
    return Adb.util.readAll(stream)
  }

  async health(serial: string): Promise<{ battery: number; model: string }> {
    const batteryOutput = await this.shell(serial, 'dumpsys battery | grep level')
    const batteryMatch = batteryOutput.match(/level:\s*(\d+)/)
    const battery = batteryMatch ? parseInt(batteryMatch[1], 10) : -1

    const model = await this.getProp(serial, 'ro.product.model')

    return { battery, model }
  }

  private async getProp(serial: string, prop: string): Promise<string> {
    return this.shell(serial, `getprop ${prop}`)
  }
}
