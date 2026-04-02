import type { RateLimitConfig, RateLimitStore, CanSendResult } from './types.js'

export class RateLimiter {
  constructor(
    private store: RateLimitStore,
    private config: RateLimitConfig,
    private now: () => number = Date.now,
  ) {}

  /** Calculate volume scaling factor based on messages sent in the window */
  getVolumeScale(_senderNumber: string): Promise<number> {
    throw new Error('Not implemented')
  }

  /** Calculate the full delay (base × volume scale) before jitter */
  calculateScaledDelay(_senderNumber: string): Promise<number> {
    throw new Error('Not implemented')
  }

  /** Apply jitter to a scaled delay, clamped to floor/cap */
  applyJitter(_scaledDelayMs: number): number {
    throw new Error('Not implemented')
  }

  /** Check pair rate limit (min 6s between msgs to same recipient) */
  checkPairLimit(_senderNumber: string, _toNumber: string): Promise<CanSendResult> {
    throw new Error('Not implemented')
  }

  /** Full check: can this sender send right now? Returns wait time if not */
  canSend(_senderNumber: string, _toNumber: string): Promise<CanSendResult> {
    throw new Error('Not implemented')
  }

  /** Record a successful send (updates timestamps and counters) */
  recordSend(_senderNumber: string, _toNumber: string): Promise<void> {
    throw new Error('Not implemented')
  }

  /** Clean expired timestamps from volume window */
  cleanExpiredTimestamps(_senderNumber: string): Promise<void> {
    throw new Error('Not implemented')
  }
}
