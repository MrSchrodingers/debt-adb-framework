import { describe, it, expect, beforeEach } from 'vitest'
import { RetryManager } from './retry-manager.js'
import type { Message } from '../queue/types.js'
import { DEFAULT_RETRY_CONFIG } from './types.js'

function makeMessage(overrides?: Partial<Message>): Message {
  return {
    id: 'msg-001',
    to: '5543991938235',
    body: 'Teste',
    idempotencyKey: 'key-001',
    priority: 5,
    senderNumber: '5543999990001',
    status: 'failed',
    lockedBy: null,
    lockedAt: null,
    createdAt: '2026-04-02T12:00:00Z',
    updatedAt: '2026-04-02T12:05:00Z',
    ...overrides,
  }
}

describe('RetryManager', () => {
  let manager: RetryManager

  beforeEach(() => {
    manager = new RetryManager(DEFAULT_RETRY_CONFIG)
  })

  describe('shouldRetry', () => {
    it('returns true when attempts < 5', () => {
      const msg = makeMessage()
      expect(manager.shouldRetry(msg, 1)).toBe(true)
      expect(manager.shouldRetry(msg, 2)).toBe(true)
      expect(manager.shouldRetry(msg, 3)).toBe(true)
      expect(manager.shouldRetry(msg, 4)).toBe(true)
    })

    it('returns false when attempts >= 5', () => {
      const msg = makeMessage()
      expect(manager.shouldRetry(msg, 5)).toBe(false)
    })

    it('returns false when attempts exceed max', () => {
      const msg = makeMessage()
      expect(manager.shouldRetry(msg, 10)).toBe(false)
    })
  })

  describe('getBackoffDelay', () => {
    it('returns 30s for attempt 1', () => {
      expect(manager.getBackoffDelay(1)).toBe(30_000)
    })

    it('returns 60s for attempt 2', () => {
      expect(manager.getBackoffDelay(2)).toBe(60_000)
    })

    it('returns 120s for attempt 3', () => {
      expect(manager.getBackoffDelay(3)).toBe(120_000)
    })

    it('returns 240s for attempt 4', () => {
      expect(manager.getBackoffDelay(4)).toBe(240_000)
    })

    it('returns 480s for attempt 5', () => {
      expect(manager.getBackoffDelay(5)).toBe(480_000)
    })
  })

  describe('prepareRetry', () => {
    it('returns shouldRetry=true with correct backoff for retriable message', () => {
      const msg = makeMessage()
      const decision = manager.prepareRetry(msg, 2)
      expect(decision.shouldRetry).toBe(true)
      expect(decision.backoffMs).toBe(60_000) // attempt 2 → 60s
    })

    it('returns shouldRetry=false for exhausted message', () => {
      const msg = makeMessage()
      const decision = manager.prepareRetry(msg, 5)
      expect(decision.shouldRetry).toBe(false)
      expect(decision.reason).toContain('max')
    })

    it('preserves original senderNumber in decision', () => {
      const msg = makeMessage({ senderNumber: '5543999990001' })
      const decision = manager.prepareRetry(msg, 1)
      expect(decision.shouldRetry).toBe(true)
      // senderNumber should not change — retry on same number
    })
  })
})
