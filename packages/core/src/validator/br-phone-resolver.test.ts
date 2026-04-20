import { describe, it, expect } from 'vitest'
import { normalizePhone, InvalidPhoneError } from './br-phone-resolver.js'

describe('normalizePhone', () => {
  it('strips +, spaces, parens and dashes from input (T1)', () => {
    const result = normalizePhone('+55 (43) 99193-8235')
    expect(result.normalized).toBe('5543991938235')
  })

  it('extracts DDD and countryCode for BR mobile (T2)', () => {
    const result = normalizePhone('+5543991938235')
    expect(result.countryCode).toBe('55')
    expect(result.ddd).toBe('43')
  })

  it('DDD 11 is non-ambiguous and returns single variant (T3)', () => {
    const result = normalizePhone('+5511987654321')
    expect(result.isAmbiguousDdd).toBe(false)
    expect(result.variants).toEqual(['5511987654321'])
  })

  it('DDD 43 is ambiguous — returns both with9 and without9 variants in order (T4)', () => {
    const result = normalizePhone('+5543991938235')
    expect(result.isAmbiguousDdd).toBe(true)
    expect(result.variants).toEqual(['5543991938235', '554391938235'])
  })

  it('throws InvalidPhoneError for inputs with wrong digit count (T5)', () => {
    expect(() => normalizePhone('123')).toThrow(InvalidPhoneError)
    expect(() => normalizePhone('+55439919')).toThrow(/length/i)
    expect(() => normalizePhone('55439919382358')).toThrow(InvalidPhoneError)
  })

  it('rejects non-BR country codes (I3)', () => {
    expect(() => normalizePhone('+19255551234')).toThrow(/length/i) // 11 digits
    expect(() => normalizePhone('541112345678')).toThrow(/non-BR country code/i)
    expect(() => normalizePhone('000000000000')).toThrow(/non-BR country code/i)
  })

  it('rejects invalid BR DDDs (I3)', () => {
    expect(() => normalizePhone('+552099999999')).toThrow(/invalid BR DDD/i) // 20 not allocated
    expect(() => normalizePhone('+555299999999')).toThrow(/invalid BR DDD/i) // 52 not allocated
  })

  it('rejects 13-digit BR mobile without leading 9 in subscriber block (I3)', () => {
    expect(() => normalizePhone('+5543891938235')).toThrow(/first subscriber digit/i)
  })
})
