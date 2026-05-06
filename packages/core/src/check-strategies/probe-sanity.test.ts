import { describe, it, expect } from 'vitest'
import { xmlContainsVariantDigits } from './probe-sanity.js'

describe('xmlContainsVariantDigits', () => {
  it('matches canonical 13-digit variant in XML', () => {
    const xml = '<hierarchy><node text="+55 12 98171-9662"/></hierarchy>'
    expect(xmlContainsVariantDigits(xml, '5512981719662')).toBe(true)
  })

  it('matches 12-digit form when XML strips the leading 9', () => {
    const xml = '<hierarchy><node text="+55 42 8837-5804"/></hierarchy>'
    expect(xmlContainsVariantDigits(xml, '5542988375804')).toBe(true)
  })

  it('matches when number is in raw concatenated form', () => {
    const xml = '<hierarchy><node text="5512981719662"/></hierarchy>'
    expect(xmlContainsVariantDigits(xml, '5512981719662')).toBe(true)
  })

  it('rejects when XML contains a different number', () => {
    const xml = '<hierarchy><node text="+55 41 93047-5390 não está no WhatsApp"/></hierarchy>'
    expect(xmlContainsVariantDigits(xml, '5512981719662')).toBe(false)
  })

  it('rejects when XML has no phone-like digit runs', () => {
    const xml = '<hierarchy><node text="Configurações"/></hierarchy>'
    expect(xmlContainsVariantDigits(xml, '5512981719662')).toBe(false)
  })

  it('matches with parens and hyphens around the number', () => {
    const xml = '<hierarchy><node text="(12) 98171-9662"/></hierarchy>'
    expect(xmlContainsVariantDigits(xml, '5512981719662')).toBe(true)
  })

  it('matches when number is mid-text in modal phrase', () => {
    const xml = '<hierarchy><node text="O número de telefone +55 12 98171-9662 não está no WhatsApp."/></hierarchy>'
    expect(xmlContainsVariantDigits(xml, '5512981719662')).toBe(true)
  })

  it('rejects short digit runs (avoids matching message counts)', () => {
    // The digit "5512981719662" partial contained in an unrelated short run.
    const xml = '<hierarchy><node text="55129"/><node text="81719662"/></hierarchy>'
    // The runs are 5 + 8 = neither contains the full 13-digit run, and the
    // 8-digit run alone (81719662) does not contain the prefix.
    expect(xmlContainsVariantDigits(xml, '5512981719662')).toBe(false)
  })

  it('handles XML with multiple phone numbers — match if probed is one of them', () => {
    const xml = '<hierarchy><node text="+55 41 93047-5390"/><node text="+55 12 98171-9662"/></hierarchy>'
    expect(xmlContainsVariantDigits(xml, '5512981719662')).toBe(true)
    expect(xmlContainsVariantDigits(xml, '5541930475390')).toBe(true)
    expect(xmlContainsVariantDigits(xml, '5599999999999')).toBe(false)
  })

  it('handles 12-digit landline variant (no leading 9)', () => {
    // Landlines have 8 subscriber digits (not 9). Variant length 12.
    const xml = '<hierarchy><node text="+55 11 3333-4444"/></hierarchy>'
    expect(xmlContainsVariantDigits(xml, '551133334444')).toBe(true)
  })
})
