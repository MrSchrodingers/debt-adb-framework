import type { RetryConfig } from './types.js'
import type { Message } from '../queue/types.js'

export interface RetryDecision {
  shouldRetry: boolean
  backoffMs: number
  reason: string
}

export class RetryManager {
  constructor(private config: RetryConfig) {}

  /** Decide whether a failed message should be retried */
  shouldRetry(_message: Message, _attempts: number): boolean {
    throw new Error('Not implemented')
  }

  /** Calculate backoff delay for a given attempt number (1-indexed) */
  getBackoffDelay(_attemptNumber: number): number {
    throw new Error('Not implemented')
  }

  /** Prepare a message for retry: increment attempts, calculate delay */
  prepareRetry(_message: Message, _attempts: number): RetryDecision {
    throw new Error('Not implemented')
  }
}
