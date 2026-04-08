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

  selectMethod(): ChatOpenMethod {
    const { prefillWeight, searchWeight, typingWeight } = this.config
    const total = prefillWeight + searchWeight + typingWeight
    const roll = Math.random() * total

    if (roll < prefillWeight) return 'prefill'
    if (roll < prefillWeight + searchWeight) return 'search'
    return 'typing'
  }

  generatesTypingIndicator(method: ChatOpenMethod): boolean {
    return method !== 'prefill'
  }
}
