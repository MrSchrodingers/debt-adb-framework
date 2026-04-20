import { describe, it, expect, vi } from 'vitest'
import Database from 'better-sqlite3'
import { SendEngine } from './send-engine.js'
import { MessageQueue } from '../queue/index.js'
import { DispatchEmitter } from '../events/index.js'
import type { AdbBridge } from '../adb/index.js'

describe('SendEngine.registerContact — profile-aware + Google account', () => {
  function buildMockAdb(currentUser = 10, googleAccount = 'debtnotificacoes@gmail.com') {
    const calls: string[] = []
    const mock = {
      shell: vi.fn(async (_serial: string, cmd: string) => {
        calls.push(cmd)
        if (cmd === 'am get-current-user') return `${currentUser}\n`
        if (cmd === 'dumpsys account') {
          return googleAccount
            ? `  Account {name=${googleAccount}, type=com.google}\n  Account {name=Meet, type=com.google.android.apps.tachyon}`
            : 'no google'
        }
        if (cmd.includes('phone_lookup')) return ''
        if (cmd.startsWith('content insert') && cmd.includes('/raw_contacts')) return ''
        if (cmd.startsWith('content query') && cmd.includes('/raw_contacts') && cmd.includes('_id DESC LIMIT 1')) {
          return 'Row: 0 _id=999'
        }
        return ''
      }),
      screenshot: vi.fn(),
      discover: vi.fn(),
      forward: vi.fn(),
      pull: vi.fn(),
    } as unknown as AdbBridge
    return { mock, calls }
  }

  function buildEngine(adb: AdbBridge) {
    const db = new Database(':memory:')
    const queue = new MessageQueue(db)
    queue.initialize()
    const emitter = new DispatchEmitter()
    return new SendEngine(adb, queue, emitter)
  }

  it('passes --user <foregroundUser> to every content command', async () => {
    const { mock, calls } = buildMockAdb(10)
    const engine = buildEngine(mock)

    await engine.registerContact('test-device', '5543991938235', 'ROSANGELA DA SILVA')

    const contentCalls = calls.filter((c) => c.startsWith('content '))
    expect(contentCalls.length).toBeGreaterThan(0)
    for (const c of contentCalls) {
      expect(c).toMatch(/--user 10\b/)
    }
  })

  it('uses com.google account when detected', async () => {
    const { mock, calls } = buildMockAdb(10, 'debtnotificacoes@gmail.com')
    const engine = buildEngine(mock)

    await engine.registerContact('test-device', '5543912345678', 'NOVO PACIENTE TESTE')

    const rawContactInsert = calls.find((c) => c.includes('/raw_contacts') && c.startsWith('content insert'))
    expect(rawContactInsert).toBeDefined()
    expect(rawContactInsert).toContain('account_type:s:com.google')
    expect(rawContactInsert).toContain('account_name:s:debtnotificacoes@gmail.com')
  })

  it('falls back to Local Phone Account when no Google account present', async () => {
    const { mock, calls } = buildMockAdb(10, '')
    const engine = buildEngine(mock)

    await engine.registerContact('test-device', '5543912345678', 'FALLBACK PACIENTE')

    const rawContactInsert = calls.find((c) => c.includes('/raw_contacts') && c.startsWith('content insert'))
    expect(rawContactInsert).toBeDefined()
    expect(rawContactInsert).toContain('account_type:n:')
    expect(rawContactInsert).toContain('account_name:n:')
  })

  it('uses profile 0 when foreground user detection fails', async () => {
    const mock = {
      shell: vi.fn(async (_s: string, cmd: string) => {
        if (cmd === 'am get-current-user') throw new Error('unavailable')
        if (cmd === 'dumpsys account') return ''
        if (cmd.includes('phone_lookup')) return ''
        if (cmd.startsWith('content query') && cmd.includes('_id DESC LIMIT 1')) return 'Row: 0 _id=1'
        return ''
      }),
      screenshot: vi.fn(), discover: vi.fn(), forward: vi.fn(), pull: vi.fn(),
    } as unknown as AdbBridge
    const engine = buildEngine(mock)

    await engine.registerContact('test-device', '5543912345678', 'FALLBACK ZERO')

    const shellMock = mock.shell as ReturnType<typeof vi.fn>
    const calls = shellMock.mock.calls.map((c: unknown[]) => c[1] as string)
    const contentCalls = calls.filter((c) => c.startsWith('content '))
    for (const c of contentCalls) expect(c).toMatch(/--user 0\b/)
  })

  it('skips device insert when phone_lookup returns existing display_name', async () => {
    const mock = {
      shell: vi.fn(async (_s: string, cmd: string) => {
        if (cmd === 'am get-current-user') return '10\n'
        if (cmd === 'dumpsys account') return ''
        if (cmd.includes('phone_lookup')) return 'Row: 0 display_name=ROSANGELA DA SILVA, number=5543991938235'
        return ''
      }),
      screenshot: vi.fn(), discover: vi.fn(), forward: vi.fn(), pull: vi.fn(),
    } as unknown as AdbBridge
    const engine = buildEngine(mock)

    const result = await engine.registerContact('test-device', '5543991938235', 'ROSANGELA DA SILVA')
    expect(result).toBe('exists')
    const shellMock = mock.shell as ReturnType<typeof vi.fn>
    const calls = shellMock.mock.calls.map((c: unknown[]) => c[1] as string)
    const insertCalls = calls.filter((c) => c.startsWith('content insert'))
    expect(insertCalls).toHaveLength(0)
  })
})
