import { describe, it, expect } from 'vitest'
// Side-effect import — loads both sequences.
import { SEQUENCES, getSequence } from './index.js'

describe('Sequence registry', () => {
  it('registers oralsin-cold-v1', () => {
    expect(SEQUENCES['oralsin-cold-v1']).toBeDefined()
    expect(SEQUENCES['oralsin-cold-v1'].version).toBe(1)
  })

  it('registers sicoob-cold-v1', () => {
    expect(SEQUENCES['sicoob-cold-v1']).toBeDefined()
    expect(SEQUENCES['sicoob-cold-v1'].version).toBe(1)
  })

  it('every sequence has exactly 3 steps with day_offsets 0, 2, 5', () => {
    for (const def of Object.values(SEQUENCES)) {
      expect(def.steps.length).toBe(3)
      expect(def.steps.map((s) => s.day_offset)).toEqual([0, 2, 5])
    }
  })

  it('only the last step is terminal', () => {
    for (const def of Object.values(SEQUENCES)) {
      const terminals = def.steps.filter((s) => s.terminal)
      expect(terminals).toHaveLength(1)
      expect(terminals[0].index).toBe(def.steps.length - 1)
    }
  })

  it('every template_pool has at least 2 entries (variation)', () => {
    for (const def of Object.values(SEQUENCES)) {
      for (const step of def.steps) {
        expect(step.template_pool.length).toBeGreaterThanOrEqual(2)
      }
    }
  })

  it('every template contains the {nome} placeholder', () => {
    for (const def of Object.values(SEQUENCES)) {
      for (const step of def.steps) {
        for (const t of step.template_pool) {
          expect(t).toContain('{nome}')
        }
      }
    }
  })

  it('getSequence throws on unknown id', () => {
    expect(() => getSequence('nonexistent-v9')).toThrow(/unknown sequence/)
  })

  it('step indices are 0-based and sequential', () => {
    for (const def of Object.values(SEQUENCES)) {
      def.steps.forEach((s, i) => {
        expect(s.index).toBe(i)
      })
    }
  })
})
