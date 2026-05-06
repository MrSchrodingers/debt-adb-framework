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
    // Tiny timeout so the wall-clock-bounded poll loop terminates quickly.
    const res = await s.probe('5543991938235', { deviceSerial: 'poco-1', timeoutMs: 50 })
    expect(res.result).toBe('inconclusive')
  })

  it('rejects unsafe variant values (command injection guard)', async () => {
    const adb = mockAdb('')
    const s = new AdbProbeStrategy(adb, sleepMock)
    await expect(s.probe('5543; rm -rf /', { deviceSerial: 'poco-1' })).rejects.toThrow(/unsafe/)
  })
})

describe('AdbProbeStrategy.recover', () => {
  it('force-stops com.whatsapp on chat_list', async () => {
    const shells: string[] = []
    const adb = {
      shell: async (_s: string, cmd: string) => {
        shells.push(cmd)
        return ''
      },
    } as any
    const strat = new AdbProbeStrategy(adb, async () => {})
    await (strat as any).recover('chat_list', 'serial1')
    expect(shells.some((c) => c.includes('am force-stop com.whatsapp'))).toBe(true)
    expect(shells.some((c) => c.includes('input keyevent'))).toBe(false)
  })

  it('force-stops on contact_picker and unknown', async () => {
    for (const state of ['contact_picker', 'unknown']) {
      const shells: string[] = []
      const adb = {
        shell: async (_s: string, cmd: string) => {
          shells.push(cmd)
          return ''
        },
      } as any
      const strat = new AdbProbeStrategy(adb, async () => {})
      await (strat as any).recover(state, 'serial1')
      expect(shells.some((c) => c.includes('am force-stop com.whatsapp'))).toBe(true)
    }
  })

  it('sends BACK keyevent twice on disappearing_msg_dialog', async () => {
    const shells: string[] = []
    const adb = {
      shell: async (_s: string, cmd: string) => {
        shells.push(cmd)
        return ''
      },
    } as any
    const strat = new AdbProbeStrategy(adb, async () => {})
    await (strat as any).recover('disappearing_msg_dialog', 'serial1')
    const backCalls = shells.filter((c) => c.includes('input keyevent 4'))
    expect(backCalls.length).toBe(2)
    expect(shells.some((c) => c.includes('force-stop'))).toBe(false)
  })

  it('sends BACK keyevent twice on unknown_dialog', async () => {
    const shells: string[] = []
    const adb = {
      shell: async (_s: string, cmd: string) => {
        shells.push(cmd)
        return ''
      },
    } as any
    const strat = new AdbProbeStrategy(adb, async () => {})
    await (strat as any).recover('unknown_dialog', 'serial1')
    const backCalls = shells.filter((c) => c.includes('input keyevent 4'))
    expect(backCalls.length).toBe(2)
  })
})
