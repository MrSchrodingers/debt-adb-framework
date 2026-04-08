import { describe, it, expect } from 'vitest'
import { SendStrategy, type ChatOpenMethod } from './send-strategy.js'

describe('SendStrategy', () => {
  describe('selectMethod', () => {
    it('returns a valid ChatOpenMethod', () => {
      const strategy = new SendStrategy()
      const method = strategy.selectMethod()
      expect(['prefill', 'search', 'typing']).toContain(method)
    })

    it('respects weight distribution over 1000 samples', () => {
      const strategy = new SendStrategy({ prefillWeight: 50, searchWeight: 30, typingWeight: 20 })
      const counts: Record<string, number> = { prefill: 0, search: 0, typing: 0 }
      for (let i = 0; i < 1000; i++) {
        counts[strategy.selectMethod()]++
      }
      expect(counts.prefill).toBeGreaterThan(400)
      expect(counts.prefill).toBeLessThan(600)
      expect(counts.search).toBeGreaterThan(200)
      expect(counts.search).toBeLessThan(400)
      expect(counts.typing).toBeGreaterThan(100)
      expect(counts.typing).toBeLessThan(300)
    })

    it('returns prefill when weights are 100/0/0', () => {
      const strategy = new SendStrategy({ prefillWeight: 100, searchWeight: 0, typingWeight: 0 })
      for (let i = 0; i < 100; i++) {
        expect(strategy.selectMethod()).toBe('prefill')
      }
    })
  })

  describe('generateTypingIndicator', () => {
    it('returns true for typing and search methods', () => {
      const strategy = new SendStrategy()
      expect(strategy.generatesTypingIndicator('typing')).toBe(true)
      expect(strategy.generatesTypingIndicator('search')).toBe(true)
      expect(strategy.generatesTypingIndicator('prefill')).toBe(false)
    })
  })
})
