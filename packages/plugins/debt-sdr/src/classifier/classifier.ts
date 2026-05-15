import { regexClassify } from './regex-classifier.js'
import type { ClassificationCategory } from './regex-patterns.js'
import type {
  LlmClient,
  LlmClassification,
  ClassifierContext,
  ClassifierPhase,
} from './llm-client.js'

/**
 * Telemetry source tagging — sent to classifier_log + Prometheus.
 *  - regex          : stage-1 regex hit
 *  - llm            : stage-2 LLM hit (above confidence threshold)
 *  - llm_low_conf   : stage-2 returned a category but confidence < threshold
 *  - llm_error      : stage-2 threw (network / parse / timeout)
 *  - phase_gate     : a hit landed in a category not allowed by the phase
 *                     (e.g. 'interested' during identity_gate phase)
 */
export type ClassificationSource = 'regex' | 'llm' | 'llm_low_conf' | 'llm_error' | 'phase_gate'

export interface Classification {
  category: ClassificationCategory
  confidence: number
  source: ClassificationSource
  /** Latency of the full cascade, not just the LLM call. */
  latency_ms: number
  /** Optional cost (LLM only) — forwarded from LlmClient impls. */
  cost_usd?: number
  /** Optional original payload preserved for audit when we fall back to ambiguous. */
  raw?: LlmClassification | { matched_pattern?: string }
  /** Optional error text for llm_error rows. */
  error?: string
  /** Pass-through reason from the LLM provider (audit log + operator UI). */
  reason?: string
}

/** Categories that the identity-gate phase is allowed to surface. Other
 * categories during this phase are demoted to ambiguous so the gate
 * never advances on tangential noise (e.g. "interessante mas...") that
 * the LLM coincidentally tagged as `interested`. */
const IDENTITY_ALLOWED: ReadonlySet<ClassificationCategory> = new Set<ClassificationCategory>([
  'identity_confirm',
  'identity_deny',
  'opted_out',
])

/**
 * Cascade orchestrator: regex first (free, deterministic), LLM fallback
 * on miss, phase gating on the way out. Single entry point for callers
 * — the identity gate, response handler, and any future re-classifier
 * routes through here so the audit trail and metrics stay coherent.
 */
export class ResponseClassifier {
  constructor(
    private readonly llm: LlmClient,
    private readonly llmConfidenceThreshold = 0.7,
  ) {}

  async classify(text: string, ctx: ClassifierContext): Promise<Classification> {
    const t0 = Date.now()

    // Stage 1: regex.
    const regexHit = regexClassify(text)
    if (regexHit) {
      const category = this.applyPhaseGate(regexHit.category, ctx.phase)
      const latency_ms = Date.now() - t0
      return {
        category,
        confidence: category === 'ambiguous' ? regexHit.confidence : 1.0,
        source: category === regexHit.category ? 'regex' : 'phase_gate',
        latency_ms,
        raw: { matched_pattern: regexHit.matched_pattern },
      }
    }

    // Stage 2: LLM (provider plugged in via LlmClient impl).
    let llmResult: LlmClassification
    try {
      llmResult = await this.llm.classify(text, ctx)
    } catch (err) {
      return {
        category: 'ambiguous',
        confidence: 0,
        source: 'llm_error',
        latency_ms: Date.now() - t0,
        error: err instanceof Error ? err.message : String(err),
      }
    }

    const latency_ms = Date.now() - t0

    if (llmResult.confidence < this.llmConfidenceThreshold) {
      return {
        category: 'ambiguous',
        confidence: llmResult.confidence,
        source: 'llm_low_conf',
        latency_ms,
        raw: llmResult,
        reason: llmResult.reason,
        cost_usd: llmResult.cost_usd,
      }
    }

    const gated = this.applyPhaseGate(llmResult.category, ctx.phase)
    return {
      category: gated,
      confidence: llmResult.confidence,
      source: gated === llmResult.category ? 'llm' : 'phase_gate',
      latency_ms,
      raw: llmResult,
      reason: llmResult.reason,
      cost_usd: llmResult.cost_usd,
    }
  }

  private applyPhaseGate(
    category: ClassificationCategory,
    phase: ClassifierPhase,
  ): ClassificationCategory {
    if (phase === 'identity_gate' && !IDENTITY_ALLOWED.has(category)) {
      return 'ambiguous'
    }
    return category
  }
}
