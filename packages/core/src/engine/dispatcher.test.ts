import { describe, it, expect, beforeEach } from 'vitest'
import { Dispatcher } from './dispatcher.js'
import type { SenderState } from './types.js'

function makeSender(overrides: Partial<SenderState> & { senderNumber: string }): SenderState {
  return {
    banned: false,
    banExpiresAt: null,
    sendCountInWindow: 0,
    lastSendAt: null,
    cooldownExpiresAt: null,
    ...overrides,
  }
}

describe('Dispatcher', () => {
  let dispatcher: Dispatcher
  let currentTime: number

  beforeEach(() => {
    currentTime = 1000000
    dispatcher = new Dispatcher(() => currentTime)
  })

  describe('selectSender', () => {
    it('selects the number with fewest sends in window', async () => {
      const senders = [
        makeSender({ senderNumber: '5543999990001', sendCountInWindow: 15 }),
        makeSender({ senderNumber: '5543999990002', sendCountInWindow: 5 }),
        makeSender({ senderNumber: '5543999990003', sendCountInWindow: 10 }),
      ]

      const decision = await dispatcher.selectSender(senders)
      expect(decision).not.toBeNull()
      expect(decision!.senderNumber).toBe('5543999990002')
    })

    it('returns null when no senders have expired cooldown', async () => {
      const future = currentTime + 60_000
      const senders = [
        makeSender({ senderNumber: '5543999990001', cooldownExpiresAt: future }),
        makeSender({ senderNumber: '5543999990002', cooldownExpiresAt: future }),
      ]

      const decision = await dispatcher.selectSender(senders)
      expect(decision).toBeNull()
    })

    it('skips banned numbers', async () => {
      const senders = [
        makeSender({ senderNumber: '5543999990001', banned: true, banExpiresAt: Date.parse('2026-04-03T00:00:00Z') }),
        makeSender({ senderNumber: '5543999990002', sendCountInWindow: 10 }),
      ]

      const decision = await dispatcher.selectSender(senders)
      expect(decision).not.toBeNull()
      expect(decision!.senderNumber).toBe('5543999990002')
    })

    it('returns null when all numbers are banned', async () => {
      const senders = [
        makeSender({ senderNumber: '5543999990001', banned: true }),
        makeSender({ senderNumber: '5543999990002', banned: true }),
      ]

      const decision = await dispatcher.selectSender(senders)
      expect(decision).toBeNull()
    })

    it('selects sender with expired cooldown over one still cooling', async () => {
      const senders = [
        makeSender({ senderNumber: '5543999990001', cooldownExpiresAt: currentTime - 1000, sendCountInWindow: 10 }),
        makeSender({ senderNumber: '5543999990002', cooldownExpiresAt: currentTime + 5000, sendCountInWindow: 2 }),
      ]

      const decision = await dispatcher.selectSender(senders)
      expect(decision).not.toBeNull()
      expect(decision!.senderNumber).toBe('5543999990001')
    })
  })

  describe('getNextDispatchTime', () => {
    it('returns earliest cooldown expiry across all numbers', async () => {
      const senders = [
        makeSender({ senderNumber: '5543999990001', cooldownExpiresAt: currentTime + 30_000 }),
        makeSender({ senderNumber: '5543999990002', cooldownExpiresAt: currentTime + 10_000 }),
        makeSender({ senderNumber: '5543999990003', cooldownExpiresAt: currentTime + 20_000 }),
      ]

      const nextTime = await dispatcher.getNextDispatchTime(senders)
      expect(nextTime).toBe(currentTime + 10_000)
    })

    it('returns null when no numbers available (all banned)', async () => {
      const senders = [
        makeSender({ senderNumber: '5543999990001', banned: true }),
      ]

      const nextTime = await dispatcher.getNextDispatchTime(senders)
      expect(nextTime).toBeNull()
    })

    it('returns current time when a number has no cooldown', async () => {
      const senders = [
        makeSender({ senderNumber: '5543999990001', cooldownExpiresAt: null }),
      ]

      const nextTime = await dispatcher.getNextDispatchTime(senders)
      expect(nextTime).toBeLessThanOrEqual(currentTime)
    })
  })

  describe('isAllBanned', () => {
    it('returns false when at least one number is active', () => {
      const senders = [
        makeSender({ senderNumber: '5543999990001', banned: true }),
        makeSender({ senderNumber: '5543999990002', banned: false }),
      ]
      expect(dispatcher.isAllBanned(senders)).toBe(false)
    })

    it('returns true when all numbers are banned', () => {
      const senders = [
        makeSender({ senderNumber: '5543999990001', banned: true }),
        makeSender({ senderNumber: '5543999990002', banned: true }),
      ]
      expect(dispatcher.isAllBanned(senders)).toBe(true)
    })

    it('returns true for empty array', () => {
      expect(dispatcher.isAllBanned([])).toBe(true)
    })
  })

})
