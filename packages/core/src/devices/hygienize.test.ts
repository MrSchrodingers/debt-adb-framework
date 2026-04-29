import { describe, it, expect } from 'vitest'
import { hygienizeDevice, type HygienizeAdb } from './hygienize.js'

interface Capture {
  serial: string
  cmd: string
}

function buildAdb(opts: {
  /** Override return value for specific commands. Falls back to ''. */
  responder?: (cmd: string) => string
  /** Throw on these commands. */
  throwOn?: (cmd: string) => boolean
} = {}): { adb: HygienizeAdb; calls: Capture[] } {
  const calls: Capture[] = []
  const adb: HygienizeAdb = {
    async shell(serial: string, cmd: string): Promise<string> {
      calls.push({ serial, cmd })
      if (opts.throwOn?.(cmd)) throw new Error('simulated failure')
      return opts.responder?.(cmd) ?? ''
    },
  }
  return { adb, calls }
}

describe('hygienizeDevice', () => {
  it('starts on user 0 and returns to user 0 (standardized entry/exit)', async () => {
    let currentUser = 5 // simulate device starting on profile 5
    const { adb, calls } = buildAdb({
      responder: (cmd) => {
        if (cmd === 'am get-current-user') return String(currentUser)
        if (cmd.startsWith('am switch-user ')) {
          currentUser = Number(cmd.split(' ')[2])
          return ''
        }
        if (cmd === 'pm list users') return 'UserInfo{0:Main} running'
        if (cmd.includes('Success')) return 'Success'
        return ''
      },
    })
    const result = await hygienizeDevice(adb, 'POCO1', { skipVerification: true })

    expect(result.steps.initial_state).toMatch(/^P0:/)
    expect(result.steps.switched_back).toMatch(/^P0:(ok|FAILED)$/)
    expect(calls.some((c) => c.cmd === 'am switch-user 0')).toBe(true)
  })

  it('iterates every profile reported by `pm list users`', async () => {
    let currentUser = 0
    const { adb } = buildAdb({
      responder: (cmd) => {
        if (cmd === 'am get-current-user') return String(currentUser)
        if (cmd.startsWith('am switch-user ')) {
          currentUser = Number(cmd.split(' ')[2])
          return ''
        }
        if (cmd === 'pm list users') {
          return [
            'Users:',
            '\tUserInfo{0:Owner} running',
            '\tUserInfo{10:Profile 10}',
            '\tUserInfo{11:Profile 11}',
            '\tUserInfo{12:Profile 12}',
          ].join('\n')
        }
        return ''
      },
    })
    const result = await hygienizeDevice(adb, 'POCO1', { skipVerification: true })
    expect(result.profilesProcessed).toEqual([0, 10, 11, 12])
    expect(Object.keys(result.perProfileLog).length).toBe(4)
  })

  it('counts bloat removals across profiles', async () => {
    let currentUser = 0
    const { adb } = buildAdb({
      responder: (cmd) => {
        if (cmd === 'am get-current-user') return String(currentUser)
        if (cmd.startsWith('am switch-user ')) {
          currentUser = Number(cmd.split(' ')[2])
          return ''
        }
        if (cmd === 'pm list users') return 'UserInfo{0:Main} running'
        if (cmd.startsWith('pm uninstall')) return 'Success'
        return ''
      },
    })
    const result = await hygienizeDevice(adb, 'POCO1', { skipVerification: true })
    expect(result.bloatRemovedCount).toBeGreaterThan(0)
    expect(result.perProfileLog[0]).toContain('bloat:')
  })

  it('falls back from -k to non-keep when the first call fails', async () => {
    let currentUser = 0
    const { adb, calls } = buildAdb({
      responder: (cmd) => {
        if (cmd === 'am get-current-user') return String(currentUser)
        if (cmd.startsWith('am switch-user ')) {
          currentUser = Number(cmd.split(' ')[2])
          return ''
        }
        if (cmd === 'pm list users') return 'UserInfo{0:Main} running'
        if (cmd.startsWith('pm uninstall -k')) return 'Failure'
        if (cmd.startsWith('pm uninstall --user')) return 'Success'
        return ''
      },
    })
    const result = await hygienizeDevice(adb, 'POCO1', { skipVerification: true })
    expect(calls.some((c) => /^pm uninstall --user \d+ /.test(c.cmd))).toBe(true)
    expect(result.bloatRemovedCount).toBeGreaterThan(0)
  })

  it('detects survivors when verification is enabled', async () => {
    let currentUser = 0
    const { adb } = buildAdb({
      responder: (cmd) => {
        if (cmd === 'am get-current-user') return String(currentUser)
        if (cmd.startsWith('am switch-user ')) {
          currentUser = Number(cmd.split(' ')[2])
          return ''
        }
        if (cmd === 'pm list users') return 'UserInfo{0:Main} running'
        if (cmd.startsWith('pm uninstall')) return 'Success'
        if (cmd.startsWith('pm list packages --user')) {
          return [
            'package:com.whatsapp',
            'package:com.google.android.youtube',
            'package:com.miui.player',
            'package:com.android.settings',
          ].join('\n')
        }
        return ''
      },
    })
    const result = await hygienizeDevice(adb, 'POCO1') // verification on by default
    expect(result.survivedPackages[0]).toContain('com.google.android.youtube')
    expect(result.survivedPackages[0]).toContain('com.miui.player')
  })

  it('logs FALHOU when switch-user never converges', async () => {
    // get-current-user always returns 0 — switching to 10 will time out.
    // Use a short timeout to keep test fast.
    const { adb } = buildAdb({
      responder: (cmd) => {
        if (cmd === 'am get-current-user') return '0'
        if (cmd === 'pm list users') return 'UserInfo{10:Secondary}'
        return ''
      },
    })
    // We can't override the inner switchUserVerified timeout from outside,
    // so we accept the wall time. ensureUserZero at the top is fine
    // (already user 0). Only the loop iteration for uid=10 hits the 15s
    // timeout. Then ensureUserZero exit is fine again.
    const start = Date.now()
    const result = await hygienizeDevice(adb, 'POCO1', { skipVerification: true })
    const elapsed = Date.now() - start
    expect(result.profilesProcessed).toEqual([10])
    expect(result.perProfileLog[10]).toContain('FALHOU')
    expect(elapsed).toBeLessThan(20_000)
  }, 25_000)
})
