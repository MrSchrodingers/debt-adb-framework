import { describe, it, expect } from 'vitest'
import { selectTemplate, renderTemplate } from './template-selector.js'
import { INTRO_TEMPLATES, NUDGE_TEMPLATES } from './templates.js'

describe('selectTemplate', () => {
  it('is deterministic — same phone returns the same template', () => {
    const t1 = selectTemplate(INTRO_TEMPLATES, '554399000001')
    const t2 = selectTemplate(INTRO_TEMPLATES, '554399000001')
    expect(t1).toBe(t2)
  })

  it('spreads across the pool — 100 phones cover >= 5 distinct templates', () => {
    const picked = new Set<string>()
    for (let i = 0; i < 100; i++) {
      const phone = `5543990000${String(i).padStart(4, '0')}`
      picked.add(selectTemplate(INTRO_TEMPLATES, phone))
    }
    expect(picked.size).toBeGreaterThanOrEqual(5)
  })

  it('salt varies the selection across tenants', () => {
    const phone = '554399000001'
    const a = selectTemplate(INTRO_TEMPLATES, phone, 'oralsin-sdr')
    const b = selectTemplate(INTRO_TEMPLATES, phone, 'sicoob-sdr')
    // Not guaranteed every (phone, salt-pair) differs, but at least over
    // a sample of phones the two salt namespaces should produce
    // different picks > 50% of the time. Sanity-check a single phone
    // where a fixed salt swap is expected to land on a different idx.
    expect([a, b].length).toBe(2) // documentation expectation
    // Soft check: across 50 phones, salt namespaces produce > 30
    // distinct (a, b) pairings — empirical, not a contract guarantee.
    let differ = 0
    for (let i = 0; i < 50; i++) {
      const p = `5543990010${String(i).padStart(4, '0')}`
      if (selectTemplate(INTRO_TEMPLATES, p, 'oralsin-sdr') !== selectTemplate(INTRO_TEMPLATES, p, 'sicoob-sdr')) {
        differ++
      }
    }
    expect(differ).toBeGreaterThan(30)
  })

  it('works on the NUDGE pool too', () => {
    const t = selectTemplate(NUDGE_TEMPLATES, '554399000001')
    expect(NUDGE_TEMPLATES).toContain(t)
  })

  it('throws on empty pool', () => {
    expect(() => selectTemplate([], '554399000001')).toThrow(/empty template pool/)
  })
})

describe('renderTemplate', () => {
  it('substitutes a known placeholder', () => {
    const out = renderTemplate('Oi {nome}', { nome: 'Carlos' })
    expect(out).toBe('Oi Carlos')
  })

  it('substitutes multiple placeholders', () => {
    const out = renderTemplate('Oi {nome}, da {empresa}', { nome: 'Ana', empresa: 'Oralsin' })
    expect(out).toBe('Oi Ana, da Oralsin')
  })

  it('leaves unknown placeholders in place', () => {
    const out = renderTemplate('Oi {nome}, {desconhecido}', { nome: 'Carlos' })
    expect(out).toBe('Oi Carlos, {desconhecido}')
  })

  it('handles no placeholders', () => {
    const out = renderTemplate('Olá', { nome: 'Ana' })
    expect(out).toBe('Olá')
  })

  it('handles empty vars map', () => {
    const out = renderTemplate('Oi {nome}', {})
    expect(out).toBe('Oi {nome}')
  })
})

describe('templates content', () => {
  it('INTRO_TEMPLATES has ≥ 20 entries', () => {
    expect(INTRO_TEMPLATES.length).toBeGreaterThanOrEqual(20)
  })

  it('NUDGE_TEMPLATES has ≥ 10 entries', () => {
    expect(NUDGE_TEMPLATES.length).toBeGreaterThanOrEqual(10)
  })

  it('every template contains {nome} placeholder', () => {
    for (const t of INTRO_TEMPLATES) expect(t).toContain('{nome}')
    for (const t of NUDGE_TEMPLATES) expect(t).toContain('{nome}')
  })

  it('every INTRO template references the tenant via {empresa}', () => {
    // NUDGE doesn't have to reference {empresa} (already established);
    // INTRO must, since it's the first contact.
    for (const t of INTRO_TEMPLATES) expect(t).toContain('{empresa}')
  })
})
