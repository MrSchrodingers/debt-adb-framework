import type { ContactRegistry } from '../contacts/contact-registry.js'
import type { CheckStrategy, StrategyResult } from '../check-strategies/types.js'
import type { TriggeredBy } from '../contacts/types.js'
import { normalizePhone, InvalidPhoneError } from './br-phone-resolver.js'

export interface ValidateOptions {
  triggered_by: TriggeredBy
  device_serial?: string
  waha_session?: string
  /**
   * Android user id that owns the WhatsApp account selected for the
   * probe. Resolved upstream from the operator's sender choice
   * (sender_mapping.profile_id keyed by waha_session phone). Without
   * it the probe runs in whatever user is in foreground.
   */
  profile_id?: number
  /** Include WAHA as tiebreaker for ambiguous DDDs (grill D8). Defaults to true. */
  useWahaTiebreaker?: boolean
}

export interface ValidateResult {
  phone_input: string
  phone_normalized: string
  exists_on_wa: 0 | 1 | null
  wa_chat_id: string | null
  source: StrategyResult['source']
  confidence: number | null
  attempts: StrategyResult[]
  from_cache: boolean
}

function isDecisive(r: StrategyResult): boolean {
  return r.result === 'exists' || r.result === 'not_exists'
}

/**
 * Orchestrates L1 (cache) → L3 (ADB) → L2 (WAHA tiebreaker) per grill decisions:
 *  - D2: ADB > WAHA > cache > syntactic (authority ranking)
 *  - D6: cache always consulted first; probe strategies may be skipped if caller opts out
 *  - D8: ambiguous DDD → test variant A, WAHA tiebreaker, then variant B as last resort
 */
export class ContactValidator {
  constructor(
    private registry: ContactRegistry,
    private adbStrategy: CheckStrategy,
    private wahaStrategy: CheckStrategy,
    private cacheStrategy: CheckStrategy,
  ) {}

  async validate(phone_input: string, opts: ValidateOptions): Promise<ValidateResult> {
    let norm
    try {
      norm = normalizePhone(phone_input)
    } catch (e) {
      if (e instanceof InvalidPhoneError) throw e
      throw e
    }

    const attempts: StrategyResult[] = []

    const cacheResult = await this.cacheStrategy.probe(norm.normalized)
    attempts.push(cacheResult)
    if (isDecisive(cacheResult)) {
      return {
        phone_input,
        phone_normalized: norm.normalized,
        exists_on_wa: cacheResult.result === 'exists' ? 1 : 0,
        wa_chat_id: cacheResult.wa_chat_id ?? null,
        source: 'cache',
        confidence: cacheResult.confidence,
        attempts,
        from_cache: true,
      }
    }

    const useWahaTiebreaker = opts.useWahaTiebreaker ?? true

    for (let i = 0; i < norm.variants.length; i++) {
      const variant = norm.variants[i]
      const adbResult = await this.adbStrategy.probe(variant, {
        deviceSerial: opts.device_serial,
        profileId: opts.profile_id,
      })
      attempts.push(adbResult)

      if (adbResult.result !== 'error') {
        this.recordCheck(norm.normalized, phone_input, adbResult, opts, norm.ddd)
      }

      if (isDecisive(adbResult)) {
        return this.finalize(phone_input, norm.normalized, adbResult, attempts)
      }

      const isLastVariant = i === norm.variants.length - 1
      const canUseWaha =
        useWahaTiebreaker && this.wahaStrategy.available() && opts.waha_session

      if (norm.isAmbiguousDdd && !isLastVariant && canUseWaha) {
        const wahaResult = await this.wahaStrategy.probe(norm.normalized, {
          wahaSession: opts.waha_session,
        })
        attempts.push(wahaResult)
        if (wahaResult.result !== 'error') {
          this.recordCheck(norm.normalized, phone_input, wahaResult, opts, norm.ddd)
        }
        if (isDecisive(wahaResult)) {
          return this.finalize(phone_input, norm.normalized, wahaResult, attempts)
        }
      }
    }

    const lastDecisive = [...attempts].reverse().find(isDecisive)
    if (lastDecisive) {
      return this.finalize(phone_input, norm.normalized, lastDecisive, attempts)
    }

    return {
      phone_input,
      phone_normalized: norm.normalized,
      exists_on_wa: null,
      wa_chat_id: null,
      source: attempts[attempts.length - 1]?.source ?? 'cache',
      confidence: null,
      attempts,
      from_cache: false,
    }
  }

  private recordCheck(
    phoneNormalized: string,
    phoneInput: string,
    result: StrategyResult,
    opts: ValidateOptions,
    ddd: string,
  ): void {
    this.registry.record(phoneNormalized, {
      phone_input: phoneInput,
      phone_variant_tried: result.variant_tried,
      source: result.source,
      result: result.result,
      confidence: result.confidence,
      evidence: result.evidence,
      device_serial: result.device_serial ?? opts.device_serial ?? null,
      waha_session: result.waha_session ?? opts.waha_session ?? null,
      triggered_by: opts.triggered_by,
      latency_ms: result.latency_ms,
      ddd,
      wa_chat_id: result.wa_chat_id ?? null,
    })
  }

  private finalize(
    phone_input: string,
    phone_normalized: string,
    winner: StrategyResult,
    attempts: StrategyResult[],
  ): ValidateResult {
    return {
      phone_input,
      phone_normalized,
      exists_on_wa: winner.result === 'exists' ? 1 : 0,
      wa_chat_id: winner.wa_chat_id ?? null,
      source: winner.source,
      confidence: winner.confidence,
      attempts,
      from_cache: false,
    }
  }
}
