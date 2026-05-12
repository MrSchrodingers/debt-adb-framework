import { describe, it, expect } from 'vitest'
import { extractDdd } from './ddd.js'

describe('extractDdd', () => {
  it('returns DDD from 13-digit phone with country code', () => {
    expect(extractDdd('5511987654321')).toBe('11')
  })

  it('returns DDD from 12-digit phone with country code (landline)', () => {
    expect(extractDdd('551133334444')).toBe('11')
  })

  it('returns DDD from 11-digit phone without country code', () => {
    expect(extractDdd('11987654321')).toBe('11')
  })

  it('returns DDD from 10-digit phone without country code (landline, no 9)', () => {
    expect(extractDdd('1133334444')).toBe('11')
  })

  it('returns null for invalid DDD (not in BR allocation)', () => {
    expect(extractDdd('5520987654321')).toBeNull()
  })

  it('returns null for phone shorter than 10 digits after strip', () => {
    expect(extractDdd('123456')).toBeNull()
  })

  it('handles +, spaces and hyphens', () => {
    expect(extractDdd('+55 (11) 98765-4321')).toBe('11')
  })

  it('returns null for empty string', () => {
    expect(extractDdd('')).toBeNull()
  })
})
