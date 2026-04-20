import type { CheckStrategy, StrategyResult, CheckContext } from './types.js'

export interface WahaCheckClient {
  checkExists(
    session: string,
    phone: string,
  ): Promise<{ numberExists: boolean; chatId?: string | null }>
}

/**
 * WAHA check-exists — secondary oracle per grill D2/D8.
 * Used when ADB probe is inconclusive for ambiguous BR DDDs (D8 tiebreaker)
 * or when caller explicitly requests server-of-record confirmation.
 */
export class WahaCheckStrategy implements CheckStrategy {
  readonly source = 'waha' as const

  constructor(
    private client: WahaCheckClient,
    private isAvailable: () => boolean = () => true,
  ) {}

  available(): boolean {
    return this.isAvailable()
  }

  async probe(variant: string, ctx: CheckContext = {}): Promise<StrategyResult> {
    const session = ctx.wahaSession
    if (!session) {
      throw new Error('WahaCheckStrategy: wahaSession is required in context')
    }

    const started = Date.now()
    try {
      const res = await this.client.checkExists(session, variant)
      const latency_ms = Date.now() - started
      return {
        source: this.source,
        result: res.numberExists ? 'exists' : 'not_exists',
        confidence: 1.0,
        wa_chat_id: res.chatId ?? null,
        evidence: {
          endpoint: `GET /api/contacts/check-exists?phone=${variant}&session=${session}`,
          response: res,
        },
        latency_ms,
        variant_tried: variant,
        waha_session: session,
      }
    } catch (err) {
      const latency_ms = Date.now() - started
      return {
        source: this.source,
        result: 'error',
        confidence: null,
        evidence: {
          error: err instanceof Error ? err.message : String(err),
        },
        latency_ms,
        variant_tried: variant,
        waha_session: session,
      }
    }
  }
}
