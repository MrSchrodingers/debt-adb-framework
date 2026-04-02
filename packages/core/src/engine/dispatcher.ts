import type { RateLimiter } from './rate-limiter.js'
import type { RateLimitStore, SenderState } from './types.js'

export interface DispatchDecision {
  senderNumber: string
  deviceSerial: string
  profileId: number
}

export class Dispatcher {
  constructor(
    private rateLimiter: RateLimiter,
    private store: RateLimitStore,
  ) {}

  /** Select the optimal sender number from available numbers */
  selectSender(_availableNumbers: SenderState[]): Promise<DispatchDecision | null> {
    throw new Error('Not implemented')
  }

  /** Get the earliest time any sender can dispatch */
  getNextDispatchTime(_availableNumbers: SenderState[]): Promise<number | null> {
    throw new Error('Not implemented')
  }

  /** Check if all sender numbers are banned */
  isAllBanned(_senderStates: SenderState[]): boolean {
    throw new Error('Not implemented')
  }

  /** Register a ban for a sender number */
  registerBan(_senderNumber: string, _expiresAt: string): void {
    throw new Error('Not implemented')
  }

  /** Clear a ban, making number available again */
  clearBan(_senderNumber: string): void {
    throw new Error('Not implemented')
  }
}
