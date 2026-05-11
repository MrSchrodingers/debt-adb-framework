import { describe, it, expect } from 'vitest'
import { checkDeviceReady } from './device-health.js'
import type { AdbShellAdapter } from '../monitor/types.js'

/** Tiny mock — records every command and lets the test script the response. */
function makeAdb(handler: (cmd: string) => Promise<string> | string): {
  adb: AdbShellAdapter
  calls: string[]
} {
  const calls: string[] = []
  return {
    calls,
    adb: {
      shell: async (_serial: string, command: string) => {
        calls.push(command)
        return await handler(command)
      },
    },
  }
}

describe('checkDeviceReady', () => {
  it('returns ok when boot is completed and no app is required', async () => {
    const { adb, calls } = makeAdb(() => '1\n')
    const r = await checkDeviceReady(adb, 'serial-A')
    expect(r).toEqual({ ok: true })
    // Only one call: just the boot prop. No pidof when appPackage absent.
    expect(calls).toEqual(['getprop sys.boot_completed'])
  })

  it('flags boot_not_completed when the prop reads "0"', async () => {
    const { adb } = makeAdb(() => '0\n')
    const r = await checkDeviceReady(adb, 'serial-A')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('boot_not_completed')
    expect(r.detail).toBe('0')
  })

  it('runs pidof when appPackage is supplied and reports app_not_running on empty', async () => {
    const { adb, calls } = makeAdb((cmd) => {
      if (cmd === 'getprop sys.boot_completed') return '1\n'
      if (cmd === 'pidof com.whatsapp') return '   \n'
      throw new Error('unexpected ' + cmd)
    })
    const r = await checkDeviceReady(adb, 'serial-A', { appPackage: 'com.whatsapp' })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('app_not_running')
    expect(calls).toEqual(['getprop sys.boot_completed', 'pidof com.whatsapp'])
  })

  it('returns ok when boot completed AND pidof returns a PID', async () => {
    const { adb } = makeAdb((cmd) => {
      if (cmd === 'getprop sys.boot_completed') return '1\n'
      if (cmd === 'pidof com.whatsapp') return '12345\n'
      throw new Error('unexpected ' + cmd)
    })
    const r = await checkDeviceReady(adb, 'serial-A', { appPackage: 'com.whatsapp' })
    expect(r).toEqual({ ok: true })
  })

  it.each([
    ['device offline', 'device_offline'],
    ['error: device not found', 'device_offline'],
    ['no devices/emulators found', 'device_offline'],
    ['error: device unauthorized', 'device_offline'],
    ['connection refused (10061)', 'device_offline'],
    ['ECONNRESET while reading stream', 'adb_shell_failed'],
    ['ADB shell timeout after 30000ms: getprop sys.boot_completed', 'adb_shell_failed'],
  ] as const)('classifies shell error %j as %s', async (msg, expectedReason) => {
    const { adb } = makeAdb(() => { throw new Error(msg) })
    const r = await checkDeviceReady(adb, 'serial-A')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe(expectedReason)
    expect(r.detail).toContain(msg.slice(0, 30))
  })

  it('caps detail length to 200 chars to keep logs readable', async () => {
    const long = 'x'.repeat(5000)
    const { adb } = makeAdb(() => { throw new Error(long) })
    const r = await checkDeviceReady(adb, 'serial-A')
    expect(r.detail!.length).toBeLessThanOrEqual(200)
  })

  it('reports adb_shell_failed when pidof itself blows up (not the boot call)', async () => {
    const { adb } = makeAdb((cmd) => {
      if (cmd === 'getprop sys.boot_completed') return '1\n'
      throw new Error('pidof: no such command')
    })
    const r = await checkDeviceReady(adb, 'serial-A', { appPackage: 'com.whatsapp' })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('adb_shell_failed')
    expect(r.detail).toContain('pidof: no such')
  })
})
