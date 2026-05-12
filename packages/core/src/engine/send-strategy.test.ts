import { describe, it, expect } from 'vitest'
import { SendStrategy, type ChatOpenMethod } from './send-strategy.js'

describe('SendStrategy', () => {
  describe('selectMethod', () => {
    it('returns a valid ChatOpenMethod', () => {
      const strategy = new SendStrategy()
      const method = strategy.selectMethod()
      expect(['prefill', 'search', 'typing', 'chatlist']).toContain(method)
    })

    it('chatlist is a valid ChatOpenMethod value', () => {
      const strategy = new SendStrategy({ prefillWeight: 0, searchWeight: 0, typingWeight: 0, chatlistWeight: 100 })
      for (let i = 0; i < 100; i++) {
        expect(strategy.selectMethod()).toBe('chatlist')
      }
    })

    it('respects default weight distribution (10/30/40/20) over 1000 samples', () => {
      const strategy = new SendStrategy()
      const counts: Record<string, number> = { prefill: 0, search: 0, typing: 0, chatlist: 0 }
      for (let i = 0; i < 1000; i++) {
        counts[strategy.selectMethod()]++
      }
      // prefill=10% → expect 50-150 range (10% of 1000 with statistical margin)
      expect(counts.prefill).toBeGreaterThan(30)
      expect(counts.prefill).toBeLessThan(200)
      // search=30% → expect 200-400
      expect(counts.search).toBeGreaterThan(200)
      expect(counts.search).toBeLessThan(400)
      // typing=40% → expect 300-500
      expect(counts.typing).toBeGreaterThan(300)
      expect(counts.typing).toBeLessThan(500)
      // chatlist=20% → expect 120-280
      expect(counts.chatlist).toBeGreaterThan(120)
      expect(counts.chatlist).toBeLessThan(280)
    })

    it('respects custom weight distribution over 1000 samples', () => {
      const strategy = new SendStrategy({ prefillWeight: 50, searchWeight: 30, typingWeight: 20, chatlistWeight: 0 })
      const counts: Record<string, number> = { prefill: 0, search: 0, typing: 0, chatlist: 0 }
      for (let i = 0; i < 1000; i++) {
        counts[strategy.selectMethod()]++
      }
      expect(counts.prefill).toBeGreaterThan(400)
      expect(counts.prefill).toBeLessThan(600)
      expect(counts.search).toBeGreaterThan(200)
      expect(counts.search).toBeLessThan(400)
      expect(counts.typing).toBeGreaterThan(100)
      expect(counts.typing).toBeLessThan(300)
      expect(counts.chatlist).toBe(0)
    })

    it('returns prefill when weights are 100/0/0/0', () => {
      const strategy = new SendStrategy({ prefillWeight: 100, searchWeight: 0, typingWeight: 0, chatlistWeight: 0 })
      for (let i = 0; i < 100; i++) {
        expect(strategy.selectMethod()).toBe('prefill')
      }
    })

    it('does NOT boost prefill for short messages (<500 chars)', () => {
      // With low prefill weight, short messages should NOT get a boost — prefill is fingerprint-risky
      const strategy = new SendStrategy({ prefillWeight: 10, searchWeight: 30, typingWeight: 40, chatlistWeight: 20 })
      const counts: Record<string, number> = { prefill: 0, search: 0, typing: 0, chatlist: 0 }
      for (let i = 0; i < 1000; i++) {
        counts[strategy.selectMethod(100)]++
      }
      // prefill should stay around 10% (no boost) — expect < 200 (well under old 350+ threshold)
      expect(counts.prefill).toBeLessThan(200)
    })

    it('reduces prefill for long messages (>1500 chars)', () => {
      // Even with high prefill weight config, long messages should cap at 10%
      const strategy = new SendStrategy({ prefillWeight: 80, searchWeight: 10, typingWeight: 10, chatlistWeight: 0 })
      const counts: Record<string, number> = { prefill: 0, search: 0, typing: 0, chatlist: 0 }
      for (let i = 0; i < 1000; i++) {
        counts[strategy.selectMethod(2000)]++
      }
      // With adjusted weight=10 out of total 10+10+10=30, prefill ~33%
      // Should be much less than the normal 80% base
      expect(counts.prefill).toBeLessThan(500)
    })

    it('distributes chatlist weight correctly over 1000 samples', () => {
      const strategy = new SendStrategy({ prefillWeight: 0, searchWeight: 0, typingWeight: 50, chatlistWeight: 50 })
      const counts: Record<string, number> = { prefill: 0, search: 0, typing: 0, chatlist: 0 }
      for (let i = 0; i < 1000; i++) {
        counts[strategy.selectMethod()]++
      }
      // 50/50 split → each should be ~500, allow 400-600
      expect(counts.typing).toBeGreaterThan(400)
      expect(counts.typing).toBeLessThan(600)
      expect(counts.chatlist).toBeGreaterThan(400)
      expect(counts.chatlist).toBeLessThan(600)
      expect(counts.prefill).toBe(0)
      expect(counts.search).toBe(0)
    })
  })

  describe('generateTypingIndicator', () => {
    it('returns true for typing, search, and chatlist methods', () => {
      const strategy = new SendStrategy()
      expect(strategy.generatesTypingIndicator('typing')).toBe(true)
      expect(strategy.generatesTypingIndicator('search')).toBe(true)
      expect(strategy.generatesTypingIndicator('chatlist')).toBe(true)
      expect(strategy.generatesTypingIndicator('prefill')).toBe(false)
    })
  })

  describe('isBodySafeForTyping', () => {
    it.each<[string, string, boolean]>([
      ['plain ASCII', 'Hello world', true],
      ['ASCII with digits + punctuation', 'Lembrete 123: pague.', true],
      ['empty string', '', true],
      ['emoji', 'Hello 👋', false],
      ['Portuguese accent ç', 'cobrança', false],
      ['Portuguese accent ã', 'manhã', false],
      ['Portuguese accent é', 'até logo', false],
      ['R$ alone is plain ASCII (safe)', 'Pague R$ 100,00', true],
      ['R$ with cedilla becomes unsafe', 'Pague R$ 100,00 (com correção)', false],
      ['newline', 'Linha 1\nLinha 2', false],
      ['tab', 'a\tb', false],
      ['tilde alone', 'a~b', true],
    ])('%s → %s', (_label, body, expected) => {
      expect(SendStrategy.isBodySafeForTyping(body)).toBe(expected)
    })
  })

  describe('selectEffectiveMethod', () => {
    it('returns strategy pick when body is safe to type', () => {
      const strategy = new SendStrategy({ prefillWeight: 0, searchWeight: 100, typingWeight: 0, chatlistWeight: 0 })
      const pick = strategy.selectEffectiveMethod('Hello world')
      expect(pick.method).toBe('search')
      expect(pick.selectedRaw).toBe('search')
      expect(pick.fallbackToPrefill).toBe(false)
    })

    it('falls back to prefill when body contains emoji', () => {
      const strategy = new SendStrategy({ prefillWeight: 0, searchWeight: 100, typingWeight: 0, chatlistWeight: 0 })
      const pick = strategy.selectEffectiveMethod('Hello 👋')
      expect(pick.method).toBe('prefill')
      expect(pick.selectedRaw).toBe('search')
      expect(pick.fallbackToPrefill).toBe(true)
    })

    it('falls back to prefill when body has Portuguese accent', () => {
      const strategy = new SendStrategy({ prefillWeight: 0, searchWeight: 0, typingWeight: 100, chatlistWeight: 0 })
      const pick = strategy.selectEffectiveMethod('Olá, sua cobrança vence amanhã')
      expect(pick.method).toBe('prefill')
      expect(pick.selectedRaw).toBe('typing')
      expect(pick.fallbackToPrefill).toBe(true)
    })

    it('falls back to prefill when body has newline', () => {
      const strategy = new SendStrategy({ prefillWeight: 0, searchWeight: 0, typingWeight: 0, chatlistWeight: 100 })
      const pick = strategy.selectEffectiveMethod('Linha 1\nLinha 2')
      expect(pick.method).toBe('prefill')
      expect(pick.selectedRaw).toBe('chatlist')
      expect(pick.fallbackToPrefill).toBe(true)
    })

    it('does not flag fallback when strategy already chose prefill', () => {
      const strategy = new SendStrategy({ prefillWeight: 100, searchWeight: 0, typingWeight: 0, chatlistWeight: 0 })
      const pick = strategy.selectEffectiveMethod('Hello 👋')
      expect(pick.method).toBe('prefill')
      expect(pick.selectedRaw).toBe('prefill')
      expect(pick.fallbackToPrefill).toBe(false)
    })
  })
})
