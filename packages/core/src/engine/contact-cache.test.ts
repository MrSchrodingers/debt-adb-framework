import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ContactCache } from './contact-cache.js'

describe('ContactCache', () => {
  let cache: ContactCache

  beforeEach(() => {
    vi.useFakeTimers()
    cache = new ContactCache({ ttlMs: 3_600_000 }) // 1 hour
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('isVerified', () => {
    it('returns false for unknown contact', () => {
      expect(cache.isVerified('device1', '5543991938235')).toBe(false)
    })

    it('returns true after markVerified', () => {
      cache.markVerified('device1', '5543991938235')
      expect(cache.isVerified('device1', '5543991938235')).toBe(true)
    })

    it('returns false after TTL expires', () => {
      cache.markVerified('device1', '5543991938235')
      expect(cache.isVerified('device1', '5543991938235')).toBe(true)

      // Advance past TTL (1 hour + 1ms)
      vi.advanceTimersByTime(3_600_001)
      expect(cache.isVerified('device1', '5543991938235')).toBe(false)
    })

    it('returns true just before TTL expires', () => {
      cache.markVerified('device1', '5543991938235')

      // Advance to exactly TTL boundary (should still be valid)
      vi.advanceTimersByTime(3_600_000)
      expect(cache.isVerified('device1', '5543991938235')).toBe(true)
    })

    it('tracks per-device contacts separately', () => {
      cache.markVerified('device1', '5543991938235')
      cache.markVerified('device2', '5543999999999')

      // device1 has phone A but not phone B
      expect(cache.isVerified('device1', '5543991938235')).toBe(true)
      expect(cache.isVerified('device1', '5543999999999')).toBe(false)

      // device2 has phone B but not phone A
      expect(cache.isVerified('device2', '5543999999999')).toBe(true)
      expect(cache.isVerified('device2', '5543991938235')).toBe(false)
    })

    it('same phone on different devices are independent entries', () => {
      const phone = '5543991938235'
      cache.markVerified('device1', phone)

      expect(cache.isVerified('device1', phone)).toBe(true)
      expect(cache.isVerified('device2', phone)).toBe(false)

      cache.markVerified('device2', phone)
      expect(cache.isVerified('device2', phone)).toBe(true)

      // Expire device1 only by re-marking device2 later
      vi.advanceTimersByTime(3_500_000)
      cache.markVerified('device2', phone) // refresh device2's TTL

      vi.advanceTimersByTime(200_000) // total 3_700_000ms — device1 expired, device2 still valid
      expect(cache.isVerified('device1', phone)).toBe(false)
      expect(cache.isVerified('device2', phone)).toBe(true)
    })
  })

  describe('getStats', () => {
    it('returns zero counts initially', () => {
      const stats = cache.getStats()
      expect(stats).toEqual({ hits: 0, misses: 0, size: 0 })
    })

    it('tracks hits and misses', () => {
      cache.markVerified('device1', '5543991938235')

      cache.isVerified('device1', '5543991938235') // hit
      cache.isVerified('device1', '5543991938235') // hit
      cache.isVerified('device1', '5543999999999') // miss
      cache.isVerified('device2', '5543991938235') // miss

      const stats = cache.getStats()
      expect(stats.hits).toBe(2)
      expect(stats.misses).toBe(2)
      expect(stats.size).toBe(1)
    })

    it('counts expired lookups as misses', () => {
      cache.markVerified('device1', '5543991938235')
      cache.isVerified('device1', '5543991938235') // hit

      vi.advanceTimersByTime(3_600_001)
      cache.isVerified('device1', '5543991938235') // miss (expired)

      const stats = cache.getStats()
      expect(stats.hits).toBe(1)
      expect(stats.misses).toBe(1)
      // expired entry was evicted on lookup
      expect(stats.size).toBe(0)
    })
  })

  describe('clear', () => {
    it('removes all entries', () => {
      cache.markVerified('device1', '5543991938235')
      cache.markVerified('device2', '5543999999999')

      expect(cache.getStats().size).toBe(2)
      cache.clear()

      expect(cache.isVerified('device1', '5543991938235')).toBe(false)
      expect(cache.isVerified('device2', '5543999999999')).toBe(false)
      expect(cache.getStats().size).toBe(0)
    })

    it('resets hit/miss counters', () => {
      cache.markVerified('device1', '5543991938235')
      cache.isVerified('device1', '5543991938235') // hit
      cache.isVerified('device1', '5543999999999') // miss

      cache.clear()

      const stats = cache.getStats()
      expect(stats.hits).toBe(0)
      expect(stats.misses).toBe(0)
    })
  })

  describe('custom TTL', () => {
    it('respects shorter TTL', () => {
      const shortCache = new ContactCache({ ttlMs: 5_000 }) // 5 seconds
      shortCache.markVerified('device1', '5543991938235')

      expect(shortCache.isVerified('device1', '5543991938235')).toBe(true)
      vi.advanceTimersByTime(5_001)
      expect(shortCache.isVerified('device1', '5543991938235')).toBe(false)
    })
  })

  describe('default config', () => {
    it('uses 1 hour TTL when no config provided', () => {
      const defaultCache = new ContactCache()
      defaultCache.markVerified('device1', '5543991938235')

      vi.advanceTimersByTime(3_600_000)
      expect(defaultCache.isVerified('device1', '5543991938235')).toBe(true)

      vi.advanceTimersByTime(1)
      expect(defaultCache.isVerified('device1', '5543991938235')).toBe(false)
    })
  })
})
