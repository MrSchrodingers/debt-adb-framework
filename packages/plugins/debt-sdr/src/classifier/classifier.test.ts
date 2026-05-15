import { describe, it, expect, vi } from 'vitest'
import { ResponseClassifier } from './classifier.js'
import { StubLlmClient, type LlmClient, type ClassifierContext } from './llm-client.js'

function makeMockLlm(impl: LlmClient['classify']): LlmClient {
  return { name: 'mock', classify: impl }
}

const identityCtx: ClassifierContext = {
  phase: 'identity_gate',
  tenant: 'oralsin-sdr',
  leadId: 'L1',
}

const responseCtx: ClassifierContext = {
  phase: 'response_handling',
  tenant: 'oralsin-sdr',
  leadId: 'L1',
}

describe('ResponseClassifier — regex hits short-circuit', () => {
  it('regex hit returns immediately without calling LLM', async () => {
    const llmCall = vi.fn()
    const c = new ResponseClassifier(makeMockLlm(llmCall))
    const r = await c.classify('Sim', identityCtx)
    expect(r.category).toBe('identity_confirm')
    expect(r.source).toBe('regex')
    expect(r.confidence).toBe(1.0)
    expect(llmCall).not.toHaveBeenCalled()
  })

  it('regex hit on opt_out is preserved in response phase', async () => {
    const c = new ResponseClassifier(makeMockLlm(vi.fn()))
    const r = await c.classify('para de mandar', responseCtx)
    expect(r.category).toBe('opted_out')
    expect(r.source).toBe('regex')
  })

  it('regex hit on a non-identity category during identity phase is demoted', async () => {
    const c = new ResponseClassifier(makeMockLlm(vi.fn()))
    // 'quero saber mais' regex-hits 'interested', but identity phase
    // only allows confirm/deny/opted_out — should land ambiguous via
    // phase_gate.
    const r = await c.classify('quero saber mais', identityCtx)
    expect(r.category).toBe('ambiguous')
    expect(r.source).toBe('phase_gate')
  })
})

describe('ResponseClassifier — LLM fallback on regex miss', () => {
  it('falls through to LLM when no regex matches', async () => {
    const llm = makeMockLlm(async () => ({
      category: 'interested',
      confidence: 0.85,
      reason: 'mock_interested',
      source: 'mock',
    }))
    const c = new ResponseClassifier(llm)
    const r = await c.classify('me explica direito como vai funcionar essa parada', responseCtx)
    expect(r.category).toBe('interested')
    expect(r.source).toBe('llm')
    expect(r.confidence).toBe(0.85)
  })

  it('demotes high-confidence LLM hit to ambiguous when category violates phase', async () => {
    const llm = makeMockLlm(async () => ({
      category: 'interested',
      confidence: 0.95,
      reason: 'mock',
      source: 'mock',
    }))
    const c = new ResponseClassifier(llm)
    const r = await c.classify('algum-texto-nada-a-ver', identityCtx)
    expect(r.category).toBe('ambiguous')
    expect(r.source).toBe('phase_gate')
  })

  it('demotes LLM hit below confidence threshold to ambiguous', async () => {
    const llm = makeMockLlm(async () => ({
      category: 'interested',
      confidence: 0.4,
      reason: 'low_conf',
      source: 'mock',
    }))
    const c = new ResponseClassifier(llm, 0.7)
    const r = await c.classify('algum-texto-nada-a-ver', responseCtx)
    expect(r.category).toBe('ambiguous')
    expect(r.source).toBe('llm_low_conf')
    expect(r.confidence).toBe(0.4)
  })

  it('routes thrown errors from the LLM to ambiguous + llm_error', async () => {
    const llm = makeMockLlm(async () => {
      throw new Error('network exploded')
    })
    const c = new ResponseClassifier(llm)
    const r = await c.classify('algum-texto-nada-a-ver', responseCtx)
    expect(r.category).toBe('ambiguous')
    expect(r.source).toBe('llm_error')
    expect(r.error).toContain('network exploded')
  })
})

describe('ResponseClassifier — StubLlmClient default', () => {
  it('with the stub provider, every regex miss is ambiguous', async () => {
    const c = new ResponseClassifier(new StubLlmClient())
    const r = await c.classify('algum-texto-nada-a-ver', responseCtx)
    expect(r.category).toBe('ambiguous')
    // Stub returns confidence 0, which is below the default 0.7 threshold,
    // so it lands in the llm_low_conf branch.
    expect(r.source).toBe('llm_low_conf')
  })
})

describe('ResponseClassifier — telemetry slots', () => {
  it('forwards latency_ms', async () => {
    const c = new ResponseClassifier(makeMockLlm(vi.fn()))
    const r = await c.classify('Sim', identityCtx)
    expect(typeof r.latency_ms).toBe('number')
    expect(r.latency_ms).toBeGreaterThanOrEqual(0)
  })

  it('forwards cost_usd from LLM', async () => {
    const llm = makeMockLlm(async () => ({
      category: 'interested',
      confidence: 0.9,
      reason: 'ok',
      source: 'mock',
      cost_usd: 0.0012,
    }))
    const c = new ResponseClassifier(llm)
    const r = await c.classify('algum-texto-nada-a-ver', responseCtx)
    expect(r.cost_usd).toBe(0.0012)
  })
})
