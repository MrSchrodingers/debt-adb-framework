import type { ContactRegistry } from '../contacts/contact-registry.js'
import type { CheckStrategy, StrategyResult } from './types.js'

/**
 * L1 cache-only lookup (grill D6: always-on in pre-check path).
 * Returns exists/not_exists with confidence inherited from last recorded check,
 * or 'inconclusive' if registry has no record for this phone.
 */
export class CacheOnlyStrategy implements CheckStrategy {
  readonly source = 'cache' as const

  constructor(private registry: ContactRegistry) {}

  available(): boolean {
    return true
  }

  async probe(variant: string): Promise<StrategyResult> {
    const started = Date.now()
    const row = this.registry.lookup(variant)
    const latency_ms = Date.now() - started
    if (!row) {
      return {
        source: this.source,
        result: 'inconclusive',
        confidence: null,
        evidence: { lookup: 'miss' },
        latency_ms,
        variant_tried: variant,
      }
    }
    return {
      source: this.source,
      result: row.exists_on_wa === 1 ? 'exists' : row.exists_on_wa === 0 ? 'not_exists' : 'inconclusive',
      confidence: row.last_check_confidence,
      wa_chat_id: row.wa_chat_id,
      evidence: { lookup: 'hit', last_check_id: row.last_check_id },
      latency_ms,
      variant_tried: variant,
    }
  }
}
