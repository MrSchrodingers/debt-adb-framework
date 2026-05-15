import { describe, it, expect } from 'vitest'
import { StubLlmClient, type LlmClient, type ClassifierContext } from './llm-client.js'

const ctx: ClassifierContext = {
  phase: 'identity_gate',
  tenant: 'oralsin-sdr',
  leadId: 'lead-1',
}

describe('StubLlmClient', () => {
  it('has name "stub"', () => {
    const c = new StubLlmClient()
    expect(c.name).toBe('stub')
  })

  it('always returns ambiguous category', async () => {
    const c = new StubLlmClient()
    const r = await c.classify('anything', ctx)
    expect(r.category).toBe('ambiguous')
  })

  it('returns confidence 0', async () => {
    const c = new StubLlmClient()
    const r = await c.classify('anything', ctx)
    expect(r.confidence).toBe(0)
  })

  it('tags source as stub', async () => {
    const c = new StubLlmClient()
    const r = await c.classify('anything', ctx)
    expect(r.source).toBe('stub')
  })

  it('reports zero cost', async () => {
    const c = new StubLlmClient()
    const r = await c.classify('anything', ctx)
    expect(r.cost_usd).toBe(0)
  })

  it('embeds the phase in the reason field for audit traceability', async () => {
    const c = new StubLlmClient()
    const r = await c.classify('anything', { ...ctx, phase: 'response_handling' })
    expect(r.reason).toContain('phase=response_handling')
  })

  it('is replaceable via the LlmClient interface', async () => {
    class MockLlm implements LlmClient {
      readonly name = 'mock'
      async classify(): Promise<{ category: 'interested'; confidence: number; reason: string; source: string }> {
        return { category: 'interested', confidence: 0.9, reason: 'mock_ok', source: 'mock' }
      }
    }
    const client: LlmClient = new MockLlm()
    const r = await client.classify('quero saber mais', ctx)
    expect(r.category).toBe('interested')
    expect(r.source).toBe('mock')
  })
})
