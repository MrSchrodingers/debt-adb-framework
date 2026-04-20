import type { RetryConfig } from './types.js'
import type { Message } from '../queue/types.js'

export interface RetryDecision {
  shouldRetry: boolean
  backoffMs: number
  reason: string
}

export class RetryManager {
  constructor(private config: RetryConfig) {}

  shouldRetry(_message: Message, attempts: number): boolean {
    return attempts < this.config.maxAttempts
  }

  getBackoffDelay(attemptNumber: number): number {
    return this.config.backoffBaseS * 1000 *
      Math.pow(this.config.backoffMultiplier, attemptNumber - 1)
  }

  prepareRetry(message: Message, attempts: number): RetryDecision {
    if (!this.shouldRetry(message, attempts)) {
      return {
        shouldRetry: false,
        backoffMs: 0,
        reason: `max attempts (${this.config.maxAttempts}) reached`,
      }
    }

    return {
      shouldRetry: true,
      backoffMs: this.getBackoffDelay(attempts),
      reason: `retry ${attempts + 1}/${this.config.maxAttempts}`,
    }
  }
}
