import { describe, it, expect } from 'vitest'
import { normalizeBrPhone, extractLead } from './lead-extractor.js'
import type { PipedriveDeal } from './tenant-pipedrive-client.js'

describe('normalizeBrPhone', () => {
  it('accepts 13-digit with country code (mobile 9-digit)', () => {
    expect(normalizeBrPhone('5543991938235')).toBe('5543991938235')
  })

  it('accepts 12-digit with country code (landline 8-digit)', () => {
    expect(normalizeBrPhone('554333334444')).toBe('554333334444')
  })

  it('prepends 55 to 11-digit DDD+mobile', () => {
    expect(normalizeBrPhone('43991938235')).toBe('5543991938235')
  })

  it('prepends 55 to 10-digit DDD+landline', () => {
    expect(normalizeBrPhone('4333334444')).toBe('554333334444')
  })

  it('strips formatting: +55 (43) 99193-8235', () => {
    expect(normalizeBrPhone('+55 (43) 99193-8235')).toBe('5543991938235')
  })

  it('rejects too-short numbers', () => {
    expect(normalizeBrPhone('12345')).toBeNull()
    expect(normalizeBrPhone('99193823')).toBeNull()
  })

  it('rejects too-long numbers', () => {
    expect(normalizeBrPhone('554399193823555')).toBeNull()
  })

  it('rejects 12/13-digit non-BR (no 55 prefix)', () => {
    expect(normalizeBrPhone('123456789012')).toBeNull()
  })

  it('returns null for empty / null / undefined', () => {
    expect(normalizeBrPhone(null)).toBeNull()
    expect(normalizeBrPhone(undefined)).toBeNull()
    expect(normalizeBrPhone('')).toBeNull()
    expect(normalizeBrPhone('   ')).toBeNull()
  })
})

function deal(overrides: Partial<PipedriveDeal>): PipedriveDeal {
  return {
    id: 100,
    title: 'Some deal',
    stage_id: 5,
    person_id: { name: 'João da Silva' },
    phone: '+55 (43) 99193-8235',
    ...overrides,
  }
}

describe('extractLead', () => {
  it('extracts phone + name from the canonical shape', () => {
    const r = extractLead(deal({}), 'phone')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.lead.deal_id).toBe(100)
      expect(r.lead.contact_phone).toBe('5543991938235')
      expect(r.lead.contact_name).toBe('João da Silva')
    }
  })

  it('uses the configured phone_field_key when present', () => {
    const d = deal({ '0a1b2c': '+55 11 99999-0000', phone: undefined })
    const r = extractLead(d, '0a1b2c')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.lead.contact_phone).toBe('5511999990000')
  })

  it('falls back to deal.phone when the configured key is absent', () => {
    const d = deal({})
    const r = extractLead(d, 'custom_phone_key')
    expect(r.ok).toBe(true)
  })

  it('falls back to person_name when person_id.name is missing', () => {
    const d = deal({ person_id: null, person_name: 'Maria Santos' })
    const r = extractLead(d, 'phone')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.lead.contact_name).toBe('Maria Santos')
  })

  it('falls back to deal.title when no person name', () => {
    const d = deal({ person_id: null, person_name: null, title: 'Lead from website' })
    const r = extractLead(d, 'phone')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.lead.contact_name).toBe('Lead from website')
  })

  it('fails when phone is missing entirely', () => {
    const d = deal({ phone: undefined })
    const r = extractLead(d, 'phone')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failure.reason).toBe('no_phone')
  })

  it('fails when phone is present but cannot be normalized', () => {
    const d = deal({ phone: '12345' })
    const r = extractLead(d, 'phone')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failure.reason).toBe('invalid_phone')
      expect(r.failure.raw_phone).toBe('12345')
    }
  })

  it('fails when no usable name is present', () => {
    const d = deal({ person_id: null, person_name: null, title: '' })
    const r = extractLead(d, 'phone')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failure.reason).toBe('no_name')
  })

  it('trims whitespace from the extracted name', () => {
    const d = deal({ person_id: { name: '   João   ' } })
    const r = extractLead(d, 'phone')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.lead.contact_name).toBe('João')
  })
})
