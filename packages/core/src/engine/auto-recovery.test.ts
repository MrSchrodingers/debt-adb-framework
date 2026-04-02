import { describe, it, expect, beforeEach, vi } from 'vitest'
import { AutoRecovery } from './auto-recovery.js'
import type { AdbShellAdapter } from '../monitor/types.js'

describe('AutoRecovery', () => {
  let adb: AdbShellAdapter
  let recovery: AutoRecovery

  beforeEach(() => {
    adb = { shell: vi.fn<(serial: string, cmd: string) => Promise<string>>() }
    recovery = new AutoRecovery(adb)
  })

  describe('detectCrash', () => {
    it('returns crashed=true, hasPid=false when send button not found and no PID', () => {
      const result = recovery.detectCrash(false, '') // empty pidof output = no process
      expect(result.crashed).toBe(true)
      expect(result.hasPid).toBe(false)
    })

    it('returns crashed=true, hasPid=true when send button not found but PID exists', () => {
      const result = recovery.detectCrash(false, '12345') // pidof returns PID
      expect(result.crashed).toBe(true)
      expect(result.hasPid).toBe(true)
    })

    it('returns crashed=false when send button found', () => {
      const result = recovery.detectCrash(true, '12345')
      expect(result.crashed).toBe(false)
      expect(result.hasPid).toBe(true)
    })

    it('returns crashed=false even when no PID but button found', () => {
      // Edge case: button found but process not detected (unlikely but possible)
      const result = recovery.detectCrash(true, '')
      expect(result.crashed).toBe(false)
    })
  })

  describe('recover', () => {
    it('force-stops and restarts WA when no PID', async () => {
      const mockShell = adb.shell as ReturnType<typeof vi.fn>
      mockShell.mockResolvedValue('') // all commands succeed

      const result = await recovery.recover(
        'DEVICE1',
        { crashed: true, hasPid: false },
        '5543991938235',
      )

      expect(result.recovered).toBe(true)
      expect(result.action).toBe('force_stop')

      // Verify force-stop was called
      expect(mockShell).toHaveBeenCalledWith(
        'DEVICE1',
        expect.stringContaining('force-stop'),
      )
      // Verify WA was restarted with intent
      expect(mockShell).toHaveBeenCalledWith(
        'DEVICE1',
        expect.stringContaining('am start'),
      )
    })

    it('presses BACK 3 times and re-opens when PID exists but no UI', async () => {
      const mockShell = adb.shell as ReturnType<typeof vi.fn>
      mockShell.mockResolvedValue('')

      const result = await recovery.recover(
        'DEVICE1',
        { crashed: true, hasPid: true },
        '5543991938235',
      )

      expect(result.recovered).toBe(true)
      expect(result.action).toBe('back_reopen')

      // Verify BACK was pressed 3 times
      const backCalls = mockShell.mock.calls.filter(
        ([, cmd]) => typeof cmd === 'string' && cmd.includes('keyevent 4'),
      )
      expect(backCalls.length).toBeGreaterThanOrEqual(3)
    })

    it('returns action=none when not crashed', async () => {
      const result = await recovery.recover(
        'DEVICE1',
        { crashed: false, hasPid: true },
        '5543991938235',
      )

      expect(result.recovered).toBe(true)
      expect(result.action).toBe('none')
    })

    it('uses custom package name when provided', async () => {
      const mockShell = adb.shell as ReturnType<typeof vi.fn>
      mockShell.mockResolvedValue('')

      await recovery.recover(
        'DEVICE1',
        { crashed: true, hasPid: false },
        '5543991938235',
        'com.whatsapp.w4b',
      )

      expect(mockShell).toHaveBeenCalledWith(
        'DEVICE1',
        expect.stringContaining('com.whatsapp.w4b'),
      )
    })

    it('returns recovered=false when recovery commands fail', async () => {
      const mockShell = adb.shell as ReturnType<typeof vi.fn>
      mockShell.mockRejectedValue(new Error('Device disconnected'))

      const result = await recovery.recover(
        'DEVICE1',
        { crashed: true, hasPid: false },
        '5543991938235',
      )

      expect(result.recovered).toBe(false)
    })
  })
})
