import { describe, it, expect, vi } from 'vitest'
import { normalizeBrPhone } from './phone-normalizer.js'

describe('normalizeBrPhone', () => {
  it('keeps a canonical 13-digit BR mobile unchanged', () => {
    const r = normalizeBrPhone('5543991938235')
    expect(r.phone).toBe('5543991938235')
    expect(r.alreadyCanonical).toBe(true)
    expect(r.upgraded).toBe(false)
  })

  it('keeps the canonical numbers found in the live POCO fleet', () => {
    for (const phone of [
      '5543996835100',
      '5543996835095',
      '5543996837813',
      '5543996835104',
      '5543996835102',
      '5543996837887',
      '5543996837945',
      '5543996837844',
    ]) {
      const r = normalizeBrPhone(phone)
      expect(r.phone).toBe(phone)
      expect(r.alreadyCanonical).toBe(true)
    }
  })

  it('upgrades a 12-digit BR mobile by injecting 9 after the DDD', () => {
    const r = normalizeBrPhone('554391938235')
    expect(r.phone).toBe('5543991938235')
    expect(r.alreadyCanonical).toBe(false)
    expect(r.upgraded).toBe(true)
  })

  it('upgrades 554396837813 → 5543996837813 (existing fleet legacy row)', () => {
    expect(normalizeBrPhone('554396837813').phone).toBe('5543996837813')
  })

  it('strips non-digit characters before normalizing', () => {
    expect(normalizeBrPhone('+55 (43) 9 9193-8235').phone).toBe('5543991938235')
    expect(normalizeBrPhone('55-43-9193-8235').phone).toBe('5543991938235')
  })

  it('returns the raw digits and logs a warning when the shape is unrecognized', () => {
    const logger = { warn: vi.fn() }
    const r = normalizeBrPhone('123', logger)
    expect(r.phone).toBe('123')
    expect(r.alreadyCanonical).toBe(false)
    expect(r.upgraded).toBe(false)
    expect(logger.warn).toHaveBeenCalledOnce()
  })

  it('handles null / undefined / empty inputs gracefully', () => {
    expect(normalizeBrPhone(null).phone).toBe('')
    expect(normalizeBrPhone(undefined).phone).toBe('')
    expect(normalizeBrPhone('').phone).toBe('')
  })

  it('does not auto-prefix country code (out of scope: keeps short numbers as-is)', () => {
    // 991938235 → 9 digits, no country code → return as-is, log warn
    const logger = { warn: vi.fn() }
    const r = normalizeBrPhone('991938235', logger)
    expect(r.phone).toBe('991938235')
    expect(r.upgraded).toBe(false)
    expect(logger.warn).toHaveBeenCalledOnce()
  })

  it('does not touch non-BR country codes', () => {
    const logger = { warn: vi.fn() }
    const r = normalizeBrPhone('14155551234', logger) // US number, 11 digits
    expect(r.phone).toBe('14155551234')
    expect(r.upgraded).toBe(false)
    expect(logger.warn).toHaveBeenCalledOnce()
  })
})
