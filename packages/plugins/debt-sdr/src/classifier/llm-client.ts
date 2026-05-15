import type { ClassificationCategory } from './regex-patterns.js'

/**
 * Phase the LLM is being asked to classify for. The prompt template
 * differs slightly — identity-gate stage accepts only identity-related
 * categories, response-handling stage accepts the full taxonomy.
 */
export type ClassifierPhase = 'identity_gate' | 'response_handling'

export interface ClassifierContext {
  phase: ClassifierPhase
  tenant: string
  /** Optional outbound message text that triggered the response — helps disambiguate. */
  outbound?: string
  /** Lead ID for correlation in audit log. */
  leadId?: string
}

export interface LlmClassification {
  category: ClassificationCategory
  confidence: number
  reason: string
  /** Provider-tagged source so audit log can distinguish stub/gemini/anthropic/local. */
  source: 'stub' | 'gemini' | 'anthropic' | 'local' | string
  /** Optional cost telemetry — providers that bill per call can expose this for metrics. */
  cost_usd?: number
  /** Optional latency telemetry — orchestrator records its own latency anyway, but providers can include theirs. */
  latency_ms?: number
}

/**
 * Provider-neutral LLM classification interface. The cascade calls
 * classify() only on regex miss; the implementation decides whether to
 * actually hit a model, return a canned response (stub), or short-circuit
 * to ambiguous + operator alert.
 *
 * Swap implementations without touching the orchestrator: stub for dev /
 * pre-launch, Gemini for early testing, Anthropic Haiku/Sonnet for prod.
 * A future LocalLlmClient (Ollama / llama.cpp) could also implement this.
 */
export interface LlmClient {
  /** Friendly name used in logs + classifier_log.source. */
  readonly name: string
  classify(text: string, ctx: ClassifierContext): Promise<LlmClassification>
}

/**
 * No-op LLM client — always returns `ambiguous` and recommends an
 * operator alert. Use as default before a real provider is wired so the
 * cascade is exercised end-to-end without sending traffic to any API.
 *
 * Routing implication: every regex miss → ambiguous → operator alert
 * → manual classification. This is intentional during the pre-launch
 * window. When a provider is selected (Gemini, Anthropic, local), swap
 * this impl in the plugin's init() — no orchestrator change needed.
 */
export class StubLlmClient implements LlmClient {
  readonly name = 'stub'

  async classify(_text: string, ctx: ClassifierContext): Promise<LlmClassification> {
    return {
      category: 'ambiguous',
      confidence: 0,
      reason: `stub_llm_client_no_provider_configured (phase=${ctx.phase})`,
      source: 'stub',
      cost_usd: 0,
      latency_ms: 0,
    }
  }
}
