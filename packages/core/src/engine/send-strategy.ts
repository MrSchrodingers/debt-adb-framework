export type ChatOpenMethod = 'prefill' | 'search' | 'typing'

export interface SendStrategyConfig {
  /** Weight for wa.me?text= pre-fill (fast, no typing indicator). Default: 50 */
  prefillWeight: number
  /** Weight for search-based open (types number in WA search bar). Default: 30 */
  searchWeight: number
  /** Weight for typing-based open (wa.me without text, types message). Default: 20 */
  typingWeight: number
}

const DEFAULT_CONFIG: SendStrategyConfig = {
  prefillWeight: 50,
  searchWeight: 30,
  typingWeight: 20,
}

export class SendStrategy {
  private config: SendStrategyConfig

  constructor(config?: Partial<SendStrategyConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  static fromEnv(env: Record<string, string | undefined>): SendStrategy {
    return new SendStrategy({
      prefillWeight: Number(env.SEND_STRATEGY_PREFILL_WEIGHT) || undefined,
      searchWeight: Number(env.SEND_STRATEGY_SEARCH_WEIGHT) || undefined,
      typingWeight: Number(env.SEND_STRATEGY_TYPING_WEIGHT) || undefined,
    })
  }

  selectMethod(bodyLength?: number): ChatOpenMethod {
    const { prefillWeight, searchWeight, typingWeight } = this.config

    // Short messages (<500 chars) strongly prefer prefill (faster, no typing needed)
    // Medium messages (500-1500) use normal configured weights
    // Long messages (>1500) reduce prefill (URL encoding makes deep link too long)
    // Never boost prefill if it's explicitly disabled (weight = 0)
    let adjustedPrefillWeight = prefillWeight
    if (bodyLength !== undefined && prefillWeight > 0) {
      if (bodyLength < 500) {
        adjustedPrefillWeight = Math.max(prefillWeight, 80)
      } else if (bodyLength > 1500) {
        adjustedPrefillWeight = Math.min(prefillWeight, 10)
      }
    }

    const total = adjustedPrefillWeight + searchWeight + typingWeight
    const roll = Math.random() * total

    if (roll < adjustedPrefillWeight) return 'prefill'
    if (roll < adjustedPrefillWeight + searchWeight) return 'search'
    return 'typing'
  }

  generatesTypingIndicator(method: ChatOpenMethod): boolean {
    return method !== 'prefill'
  }
}
