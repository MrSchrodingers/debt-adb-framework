import { describe, it, expect, vi } from 'vitest'
import { AdbProbeStrategy } from './adb-probe-strategy.js'

function mockAdb(ui: string) {
  return {
    shell: vi.fn(async (_serial: string, cmd: string) => {
      if (cmd.startsWith('am start')) return ''
      if (cmd.startsWith('uiautomator dump')) return ''
      if (cmd.startsWith('cat')) return ui
      return ''
    }),
  }
}

describe('AdbProbeStrategy', () => {
  const sleepMock = async () => {}

  it('returns exists when EditText present', async () => {
    const adb = mockAdb(`<node class="android.widget.EditText" resource-id="com.whatsapp:id/entry" />`)
    const s = new AdbProbeStrategy(adb, sleepMock)
    const res = await s.probe('5543991938235', { deviceSerial: 'poco-1' })
    expect(res.result).toBe('exists')
    expect(res.confidence).toBe(0.95)
  })

  it('returns not_exists when invite CTA present', async () => {
    const adb = mockAdb(
      `<node resource-id="com.whatsapp:id/invite_cta" text="Convidar para o WhatsApp" />`,
    )
    const s = new AdbProbeStrategy(adb, sleepMock)
    const res = await s.probe('5543999999001', { deviceSerial: 'poco-1' })
    expect(res.result).toBe('not_exists')
  })

  it('returns inconclusive when neither signal present', async () => {
    const adb = mockAdb(`<node class="android.widget.TextView" />`)
    const s = new AdbProbeStrategy(adb, sleepMock)
    const res = await s.probe('5543991938235', { deviceSerial: 'poco-1' })
    expect(res.result).toBe('inconclusive')
  })

  it('rejects unsafe variant values (command injection guard)', async () => {
    const adb = mockAdb('')
    const s = new AdbProbeStrategy(adb, sleepMock)
    await expect(s.probe('5543; rm -rf /', { deviceSerial: 'poco-1' })).rejects.toThrow(/unsafe/)
  })
})
