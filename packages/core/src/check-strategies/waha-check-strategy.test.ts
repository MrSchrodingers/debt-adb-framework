import { describe, it, expect, vi } from 'vitest'
import { WahaCheckStrategy } from './waha-check-strategy.js'

describe('WahaCheckStrategy', () => {
  it('returns exists with chat_id on successful checkExists', async () => {
    const client = {
      checkExists: vi.fn(async () => ({ numberExists: true, chatId: '5511987654321@c.us' })),
    }
    const s = new WahaCheckStrategy(client)
    const res = await s.probe('5511987654321', { wahaSession: 'acc-05' })
    expect(res.result).toBe('exists')
    expect(res.wa_chat_id).toBe('5511987654321@c.us')
    expect(res.confidence).toBe(1.0)
  })

  it('returns not_exists when numberExists is false', async () => {
    const client = {
      checkExists: vi.fn(async () => ({ numberExists: false, chatId: null })),
    }
    const s = new WahaCheckStrategy(client)
    const res = await s.probe('5599999999999', { wahaSession: 'acc-05' })
    expect(res.result).toBe('not_exists')
  })

  it('returns error on network/API failure', async () => {
    const client = {
      checkExists: vi.fn(async () => {
        throw new Error('HTTP 500')
      }),
    }
    const s = new WahaCheckStrategy(client)
    const res = await s.probe('5511987654321', { wahaSession: 'acc-05' })
    expect(res.result).toBe('error')
    expect((res.evidence as { error: string }).error).toContain('HTTP 500')
  })

  it('respects availability gate', async () => {
    const client = { checkExists: vi.fn() }
    const s = new WahaCheckStrategy(client, () => false)
    expect(s.available()).toBe(false)
  })
})
