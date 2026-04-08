import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { SendEngine } from './send-engine.js'
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
    if (cmd.includes('uiautomator dump')) return ''
    if (cmd.includes('cat /sdcard/dispatch-ui.xml')) return CHAT_READY_XML
    if (cmd.includes('content query --uri content://com.android.contacts/phone_lookup')) {
      return 'display_name=Test'
    }
    if (cmd.includes('dumpsys power')) return 'mScreenOn=true'
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
    engine = new SendEngine(mockAdb, queue, emitter)

    // Mock internal delay to avoid real waits (~8s per send)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(engine as any, 'delay').mockResolvedValue(undefined)
  })

  /** Enqueue and return the real DB message */
  const enqueueMsg = (key = 'key-1') =>
    queue.enqueue({ to: '5543991938235', body: 'Hi', idempotencyKey: key, senderNumber: '5543996835100' })

  describe('send() — user switching removed', () => {
    it('does NOT call am switch-user', async () => {
      const msg = enqueueMsg()
      stubShellForSend(mockAdb)

      await engine.send(msg, 'device-1', 10)

      const calls = (mockAdb.shell as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[1] as string)
      const switchCalls = calls.filter((cmd: string) => cmd.includes('am switch-user'))
      expect(switchCalls).toHaveLength(0)
    })

    it('uses --user flag in am start intent when profileId is provided', async () => {
      const msg = enqueueMsg()
      stubShellForSend(mockAdb)

      await engine.send(msg, 'device-1', 10)

      const calls = (mockAdb.shell as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[1] as string)
      const amStartCalls = calls.filter((cmd: string) => cmd.includes('am start'))
      expect(amStartCalls).toHaveLength(1)
      expect(amStartCalls[0]).toContain('--user 10')
    })

    it('does NOT include --user flag when profileId is undefined', async () => {
      const msg = enqueueMsg()
      stubShellForSend(mockAdb)

      await engine.send(msg, 'device-1')

      const calls = (mockAdb.shell as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[1] as string)
      const amStartCalls = calls.filter((cmd: string) => cmd.includes('am start'))
      expect(amStartCalls).toHaveLength(1)
      expect(amStartCalls[0]).not.toContain('--user')
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

    it('returns screenshot buffer and duration', async () => {
      const msg = enqueueMsg()
      stubShellForSend(mockAdb)

      const result = await engine.send(msg, 'device-1')

      expect(result.screenshot).toBeInstanceOf(Buffer)
      expect(result.durationMs).toBeGreaterThanOrEqual(0)
    })
  })

  describe('dialog detection', () => {
    it('dismisses "Enviar para" chooser and taps WhatsApp + Sempre', async () => {
      const msg = enqueueMsg('dialog-1')
      const shellMock = mockAdb.shell as ReturnType<typeof vi.fn>

      let dumpCount = 0
      shellMock.mockImplementation(async (_serial: string, cmd: string) => {
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
        if (cmd.includes('dumpsys power')) return 'mScreenOn=true'
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
        if (cmd.includes('dumpsys power')) return 'mScreenOn=true'
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
        if (cmd.includes('dumpsys power')) return 'mScreenOn=true'
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
        if (cmd.includes('uiautomator dump')) return ''
        if (cmd.includes('cat /sdcard/dispatch-ui.xml')) {
          return '<hierarchy><node text="Loading..." /></hierarchy>'
        }
        if (cmd.includes('content query --uri content://com.android.contacts/phone_lookup')) {
          return 'display_name=Test'
        }
        if (cmd.includes('dumpsys power')) return 'mScreenOn=true'
        if (cmd.includes('dumpsys window')) return 'mDreamingLockscreen=false'
        return ''
      })

      await expect(engine.send(msg, 'device-1')).rejects.toThrow('Chat input not ready')
    })
  })

  describe('pre-send health check', () => {
    it('wakes screen if it is off', async () => {
      const msg = enqueueMsg('health-1')
      const shellMock = mockAdb.shell as ReturnType<typeof vi.fn>

      let powerCallCount = 0
      shellMock.mockImplementation(async (_serial: string, cmd: string) => {
        if (cmd.includes('dumpsys power')) {
          powerCallCount++
          // First call: screen off, subsequent: screen on
          return powerCallCount === 1 ? 'mScreenOn=false' : 'mScreenOn=true'
        }
        if (cmd.includes('dumpsys window')) return 'mDreamingLockscreen=false'
        if (cmd.includes('uiautomator dump')) return ''
        if (cmd.includes('cat /sdcard/dispatch-ui.xml')) return CHAT_READY_XML
        if (cmd.includes('content query --uri content://com.android.contacts/phone_lookup')) {
          return 'display_name=Test'
        }
        return ''
      })

      await engine.send(msg, 'device-1')

      const calls = shellMock.mock.calls.map((c: unknown[]) => c[1] as string)
      expect(calls.some((cmd: string) => cmd.includes('KEYCODE_WAKEUP'))).toBe(true)
    })

    it('swipes to unlock if lock screen is showing', async () => {
      const msg = enqueueMsg('health-2')
      const shellMock = mockAdb.shell as ReturnType<typeof vi.fn>

      let windowCallCount = 0
      shellMock.mockImplementation(async (_serial: string, cmd: string) => {
        if (cmd.includes('dumpsys power')) return 'mScreenOn=true'
        if (cmd.includes('dumpsys window')) {
          windowCallCount++
          return windowCallCount === 1 ? 'mDreamingLockscreen=true' : 'mDreamingLockscreen=false'
        }
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

    it('throws if screen never recovers', async () => {
      const msg = enqueueMsg('health-3')
      const shellMock = mockAdb.shell as ReturnType<typeof vi.fn>

      shellMock.mockImplementation(async (_serial: string, cmd: string) => {
        if (cmd.includes('dumpsys power')) return 'mScreenOn=false'
        if (cmd.includes('dumpsys window')) return 'mDreamingLockscreen=false'
        return ''
      })

      await expect(engine.send(msg, 'device-1')).rejects.toThrow('Screen not ready')
    })
  })
})
