export type ChatOpenMethod = 'prefill' | 'search' | 'typing' | 'chatlist'

export interface SendStrategyConfig {
  /** Weight for wa.me?text= pre-fill (strongest fingerprint — emergencies only). Default: 10 */
  prefillWeight: number
  /** Weight for search-based open (types number in WA search bar). Default: 30 */
  searchWeight: number
  /** Weight for typing-based open (wa.me without text, types message — generates typing indicator). Default: 40 */
  typingWeight: number
  /** Weight for chat-list open (taps existing chat from recent list). Default: 20 */
  chatlistWeight: number
}

const DEFAULT_CONFIG: SendStrategyConfig = {
  prefillWeight: 10,
  searchWeight: 30,
  typingWeight: 40,
  chatlistWeight: 20,
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
      chatlistWeight: Number(env.SEND_STRATEGY_CHATLIST_WEIGHT) || undefined,
    })
  }

  selectMethod(bodyLength?: number): ChatOpenMethod {
    const { prefillWeight, searchWeight, typingWeight, chatlistWeight } = this.config

    // Long messages (>1500) reduce prefill (URL encoding makes deep link too long)
    // Never boost prefill if it's explicitly disabled (weight = 0)
    let adjustedPrefillWeight = prefillWeight
    if (bodyLength !== undefined && prefillWeight > 0) {
      if (bodyLength > 1500) {
        adjustedPrefillWeight = Math.min(prefillWeight, 10)
      }
    }

    const total = adjustedPrefillWeight + searchWeight + typingWeight + chatlistWeight
    const roll = Math.random() * total

    if (roll < adjustedPrefillWeight) return 'prefill'
    if (roll < adjustedPrefillWeight + searchWeight) return 'search'
    if (roll < adjustedPrefillWeight + searchWeight + typingWeight) return 'typing'
    return 'chatlist'
  }

  generatesTypingIndicator(method: ChatOpenMethod): boolean {
    return method !== 'prefill'
  }
}
