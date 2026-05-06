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

describe('AdbProbeStrategy.probe — Level 1 retry wrapper', () => {
  it('retries once after recover when first attempt is retryable, succeeds on second', async () => {
    let probeAttempt = 0
    const stages: string[] = []
    const adb = {
      shell: async (_s: string, cmd: string) => {
        stages.push(cmd)
        if (cmd.startsWith('am start')) {
          probeAttempt++
          return ''
        }
        if (cmd.includes('uiautomator dump')) return ''
        if (cmd.includes('cat /sdcard/dispatch-probe.xml')) {
          // First attempt: chat_list (retryable). Second attempt: chat_open (decisive).
          return probeAttempt === 1
            ? '<hierarchy>' +
                '<node resource-id="com.whatsapp:id/conversations_row_header" />' +
                '<node resource-id="com.whatsapp:id/conversations_row_header" />' +
                '<node resource-id="com.whatsapp:id/conversations_row_header" />' +
              '</hierarchy>'
            : '<hierarchy><node resource-id="com.whatsapp:id/entry" /></hierarchy>'
        }
        return ''
      },
    } as any
    const strat = new AdbProbeStrategy(adb, async () => {})
    const result = await strat.probe('5511999999999', { deviceSerial: 'X' })
    expect(result.result).toBe('exists')
    // Recovery action should have happened between the two attempts.
    expect(stages.some((c) => c.includes('am force-stop com.whatsapp'))).toBe(true)
    // Two intent fires.
    const intentCalls = stages.filter((c) => c.startsWith('am start ') && c.includes('wa.me'))
    expect(intentCalls.length).toBe(2)
  })

  it('returns inconclusive after 2 retryable results in a row', async () => {
    const adb = {
      shell: async (_s: string, cmd: string) => {
        if (cmd.includes('cat /sdcard/dispatch-probe.xml')) {
          return '<hierarchy>' +
            '<node resource-id="com.whatsapp:id/conversations_row_header" />' +
            '<node resource-id="com.whatsapp:id/conversations_row_header" />' +
            '<node resource-id="com.whatsapp:id/conversations_row_header" />' +
            '</hierarchy>'
        }
        return ''
      },
    } as any
    const strat = new AdbProbeStrategy(adb, async () => {})
    const result = await strat.probe('5511999999999', { deviceSerial: 'X' })
    expect(result.result).toBe('inconclusive')
    expect((result.evidence as any).ui_state).toBe('chat_list')
  })

  it('non-retryable inconclusive returns immediately, no recovery', async () => {
    let probeAttempt = 0
    const stages: string[] = []
    const adb = {
      shell: async (_s: string, cmd: string) => {
        stages.push(cmd)
        if (cmd.startsWith('am start')) {
          probeAttempt++
          return ''
        }
        if (cmd.includes('uiautomator dump')) return ''
        if (cmd.includes('cat /sdcard/dispatch-probe.xml')) {
          // searching → continue polling, but the deadline is short, so
          // we'll exit the loop with timed_out:true. ui_state ends up as
          // 'searching' (not retryable in the wrapper).
          return '<hierarchy><node text="Pesquisando..." /></hierarchy>'
        }
        return ''
      },
    } as any
    const strat = new AdbProbeStrategy(adb, async () => {})
    const result = await strat.probe('5511999999999', { deviceSerial: 'X', timeoutMs: 200 })
    expect(result.result).toBe('inconclusive')
    // Only ONE intent fire — searching is not in the retryable set the
    // wrapper triggers on. The probe times out and that's the final answer.
    const intentCalls = stages.filter((c) => c.startsWith('am start ') && c.includes('wa.me'))
    expect(intentCalls.length).toBe(1)
  })
})

describe('AdbProbeStrategy — snapshot capture', () => {
  it('writes snapshot when classifier returns unknown', async () => {
    const writes: any[] = []
    const writer = {
      write: (input: any) => {
        writes.push(input)
        return '/tmp/snap/test.xml'
      },
    } as any
    const adb = {
      shell: async (_s: string, cmd: string) => {
        if (cmd.includes('cat /sdcard/dispatch-probe.xml')) {
          // No known markers → classifier returns 'unknown'
          return '<hierarchy><node class="android.widget.FrameLayout" package="com.android.systemui"/></hierarchy>'
        }
        return ''
      },
    } as any
    const strat = new AdbProbeStrategy(adb, async () => {}, undefined, writer)
    const result = await strat.probe('5511999999999', { deviceSerial: 'X', timeoutMs: 200 })
    expect(result.result).toBe('inconclusive')
    // Expect at least one write — both probe attempts (initial + recover) classify as unknown.
    expect(writes.length).toBeGreaterThanOrEqual(1)
    expect(writes[0].state).toBe('unknown')
    expect(writes[0].phone).toBe('5511999999999')
    expect((result.evidence as any).snapshot_path).toBe('/tmp/snap/test.xml')
  })

  it('writes snapshot when classifier returns unknown_dialog', async () => {
    const writes: any[] = []
    const writer = {
      write: (input: any) => {
        writes.push(input)
        return '/tmp/snap/dialog.xml'
      },
    } as any
    const adb = {
      shell: async (_s: string, cmd: string) => {
        if (cmd.includes('cat /sdcard/dispatch-probe.xml')) {
          // unknown_dialog: has android:id/message but no known text
          return '<hierarchy><node resource-id="android:id/message" text="Some new popup"/><node resource-id="android:id/button1"/></hierarchy>'
        }
        return ''
      },
    } as any
    const strat = new AdbProbeStrategy(adb, async () => {}, undefined, writer)
    await strat.probe('5511999999999', { deviceSerial: 'X', timeoutMs: 200 })
    expect(writes.length).toBeGreaterThanOrEqual(1)
    expect(writes[0].state).toBe('unknown_dialog')
  })

  it('does NOT write when classifier returns chat_open', async () => {
    const writes: any[] = []
    const writer = {
      write: (input: any) => {
        writes.push(input)
        return '/tmp/snap/test.xml'
      },
    } as any
    const adb = {
      shell: async (_s: string, cmd: string) => {
        if (cmd.includes('cat /sdcard/dispatch-probe.xml')) {
          return '<hierarchy><node resource-id="com.whatsapp:id/entry"/></hierarchy>'
        }
        return ''
      },
    } as any
    const strat = new AdbProbeStrategy(adb, async () => {}, undefined, writer)
    const result = await strat.probe('5511999999999', { deviceSerial: 'X' })
    expect(result.result).toBe('exists')
    expect(writes.length).toBe(0)
  })

  it('survives gracefully when writer is omitted', async () => {
    const adb = {
      shell: async (_s: string, cmd: string) => {
        if (cmd.includes('cat /sdcard/dispatch-probe.xml')) {
          return '<hierarchy><node class="android.widget.FrameLayout" package="com.android.systemui"/></hierarchy>'
        }
        return ''
      },
    } as any
    const strat = new AdbProbeStrategy(adb, async () => {}, undefined /* no writer */)
    const result = await strat.probe('5511999999999', { deviceSerial: 'X', timeoutMs: 200 })
    expect(result.result).toBe('inconclusive')
    // Should not throw, and snapshot_path should be absent in evidence.
    expect((result.evidence as any).snapshot_path).toBeUndefined()
  })
})
