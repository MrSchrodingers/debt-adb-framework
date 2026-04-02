import { describe, it, expect, beforeEach } from 'vitest'
import { RateLimiter } from './rate-limiter.js'
import type { RateLimitConfig, RateLimitStore } from './types.js'
import { DEFAULT_RATE_LIMIT_CONFIG } from './types.js'

/** In-memory store for testing (replaces Redis) */
class InMemoryRateLimitStore implements RateLimitStore {
  private timestamps = new Map<string, number[]>()
  private pairSends = new Map<string, number>()

  async getSendTimestamps(senderNumber: string): Promise<number[]> {
    return this.timestamps.get(senderNumber) ?? []
  }

  async addSendTimestamp(senderNumber: string, timestamp: number): Promise<void> {
    const ts = this.timestamps.get(senderNumber) ?? []
    ts.push(timestamp)
    this.timestamps.set(senderNumber, ts)
  }

  async cleanExpiredTimestamps(senderNumber: string, windowMs: number): Promise<void> {
    const ts = this.timestamps.get(senderNumber) ?? []
    const cutoff = Date.now() - windowMs
    this.timestamps.set(senderNumber, ts.filter(t => t > cutoff))
  }

  async getLastPairSend(senderNumber: string, toNumber: string): Promise<number | null> {
    return this.pairSends.get(`${senderNumber}:${toNumber}`) ?? null
  }

  async setLastPairSend(senderNumber: string, toNumber: string, timestamp: number): Promise<void> {
    this.pairSends.set(`${senderNumber}:${toNumber}`, timestamp)
  }

  async getSendCount(senderNumber: string): Promise<number> {
    return (this.timestamps.get(senderNumber) ?? []).length
  }
}

describe('RateLimiter', () => {
  let store: InMemoryRateLimitStore
  let limiter: RateLimiter
  let currentTime: number

  beforeEach(() => {
    store = new InMemoryRateLimitStore()
    currentTime = 1000000
    limiter = new RateLimiter(store, DEFAULT_RATE_LIMIT_CONFIG, () => currentTime)
  })

  describe('getVolumeScale', () => {
    it('returns scale 1.0 when no messages in window', async () => {
      const scale = await limiter.getVolumeScale('5543999990001')
      expect(scale).toBe(1.0)
    })

    it('returns scale 1.0 when fewer than 10 messages in window', async () => {
      for (let i = 0; i < 9; i++) {
        await store.addSendTimestamp('5543999990001', currentTime - i * 1000)
      }
      const scale = await limiter.getVolumeScale('5543999990001')
      expect(scale).toBe(1.0)
    })

    it('returns scale 1.5 after 10 messages in window', async () => {
      for (let i = 0; i < 10; i++) {
        await store.addSendTimestamp('5543999990001', currentTime - i * 1000)
      }
      const scale = await limiter.getVolumeScale('5543999990001')
      expect(scale).toBe(1.5)
    })

    it('returns scale 2.25 (1.5^2) after 20 messages in window', async () => {
      for (let i = 0; i < 20; i++) {
        await store.addSendTimestamp('5543999990001', currentTime - i * 1000)
      }
      const scale = await limiter.getVolumeScale('5543999990001')
      expect(scale).toBe(2.25)
    })

    it('returns scale 3.375 (1.5^3) after 30 messages in window', async () => {
      for (let i = 0; i < 30; i++) {
        await store.addSendTimestamp('5543999990001', currentTime - i * 1000)
      }
      const scale = await limiter.getVolumeScale('5543999990001')
      expect(scale).toBeCloseTo(3.375)
    })
  })

  describe('calculateScaledDelay', () => {
    it('returns delay between 20s and 35s when volume scale is 1.0', async () => {
      const delay = await limiter.calculateScaledDelay('5543999990001')
      expect(delay).toBeGreaterThanOrEqual(20_000)
      expect(delay).toBeLessThanOrEqual(35_000)
    })

    it('scales delay by volume factor', async () => {
      // 10 msgs → scale 1.5
      for (let i = 0; i < 10; i++) {
        await store.addSendTimestamp('5543999990001', currentTime - i * 1000)
      }
      const delay = await limiter.calculateScaledDelay('5543999990001')
      // base 20-35s × 1.5 = 30-52.5s
      expect(delay).toBeGreaterThanOrEqual(30_000)
      expect(delay).toBeLessThanOrEqual(52_500)
    })

    it('caps scaled delay at 120s', async () => {
      // 50 msgs → scale = 1.5^5 = 7.59
      // 35s × 7.59 = 265s → capped at 120s
      for (let i = 0; i < 50; i++) {
        await store.addSendTimestamp('5543999990001', currentTime - i * 1000)
      }
      const delay = await limiter.calculateScaledDelay('5543999990001')
      expect(delay).toBeLessThanOrEqual(120_000)
    })
  })

  describe('applyJitter', () => {
    it('returns a value within 0.8x-1.5x of the input', () => {
      const results = new Set<number>()
      // Run many times to get distribution
      for (let i = 0; i < 100; i++) {
        results.add(limiter.applyJitter(50_000))
      }
      for (const result of results) {
        expect(result).toBeGreaterThanOrEqual(20_000) // floor
        expect(result).toBeLessThanOrEqual(300_000) // cap
      }
    })

    it('never returns below 20s floor', () => {
      // Small input × 0.8 could go below floor
      for (let i = 0; i < 50; i++) {
        const result = limiter.applyJitter(20_000)
        expect(result).toBeGreaterThanOrEqual(20_000)
      }
    })

    it('never returns above 300s cap', () => {
      // Large input × 1.5 could exceed cap
      for (let i = 0; i < 50; i++) {
        const result = limiter.applyJitter(250_000)
        expect(result).toBeLessThanOrEqual(300_000)
      }
    })
  })

  describe('checkPairLimit', () => {
    it('allows send when no previous send to this recipient', async () => {
      const result = await limiter.checkPairLimit('5543999990001', '5543991938235')
      expect(result.canSend).toBe(true)
      expect(result.waitMs).toBe(0)
    })

    it('blocks send within 6s of last send to same recipient', async () => {
      await store.setLastPairSend('5543999990001', '5543991938235', currentTime - 3000)
      const result = await limiter.checkPairLimit('5543999990001', '5543991938235')
      expect(result.canSend).toBe(false)
      expect(result.waitMs).toBeGreaterThan(0)
      expect(result.waitMs).toBeLessThanOrEqual(3000)
    })

    it('allows send after 6s to same recipient', async () => {
      await store.setLastPairSend('5543999990001', '5543991938235', currentTime - 7000)
      const result = await limiter.checkPairLimit('5543999990001', '5543991938235')
      expect(result.canSend).toBe(true)
    })

    it('allows immediate send to different recipient', async () => {
      await store.setLastPairSend('5543999990001', '5543991938235', currentTime)
      const result = await limiter.checkPairLimit('5543999990001', '5543999999999')
      expect(result.canSend).toBe(true)
    })
  })

  describe('canSend', () => {
    it('allows send when no recent activity', async () => {
      const result = await limiter.canSend('5543999990001', '5543991938235')
      expect(result.canSend).toBe(true)
    })

    it('blocks send when global cooldown active', async () => {
      // Record a recent send → cooldown should be active
      await limiter.recordSend('5543999990001', '5543991938235')
      const result = await limiter.canSend('5543999990001', '5543999999999')
      expect(result.canSend).toBe(false)
      expect(result.waitMs).toBeGreaterThan(0)
    })
  })

  describe('recordSend', () => {
    it('adds timestamp to volume window', async () => {
      await limiter.recordSend('5543999990001', '5543991938235')
      const timestamps = await store.getSendTimestamps('5543999990001')
      expect(timestamps).toHaveLength(1)
      expect(timestamps[0]).toBe(currentTime)
    })

    it('sets pair send timestamp', async () => {
      await limiter.recordSend('5543999990001', '5543991938235')
      const lastPair = await store.getLastPairSend('5543999990001', '5543991938235')
      expect(lastPair).toBe(currentTime)
    })

    it('increments volume count', async () => {
      await limiter.recordSend('5543999990001', '5543991938235')
      await limiter.recordSend('5543999990001', '5543999999999')
      const count = await store.getSendCount('5543999990001')
      expect(count).toBe(2)
    })
  })

  describe('cleanExpiredTimestamps', () => {
    it('removes timestamps older than volume window', async () => {
      const oldTime = currentTime - 61 * 60 * 1000 // 61 minutes ago
      await store.addSendTimestamp('5543999990001', oldTime)
      await store.addSendTimestamp('5543999990001', currentTime)

      await limiter.cleanExpiredTimestamps('5543999990001')

      const timestamps = await store.getSendTimestamps('5543999990001')
      expect(timestamps).toHaveLength(1)
      expect(timestamps[0]).toBe(currentTime)
    })
  })
})
