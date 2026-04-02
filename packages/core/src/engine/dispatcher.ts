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
    private now: () => number = Date.now,
  ) {}

  async selectSender(availableNumbers: SenderState[]): Promise<DispatchDecision | null> {
    const currentTime = this.now()

    const eligible = availableNumbers.filter(s => {
      if (s.banned) return false
      if (s.cooldownExpiresAt !== null && s.cooldownExpiresAt > currentTime) return false
      return true
    })

    if (eligible.length === 0) return null

    // Active rebalancing: pick sender with fewest sends in window
    eligible.sort((a, b) => a.sendCountInWindow - b.sendCountInWindow)

    const selected = eligible[0]
    return {
      senderNumber: selected.senderNumber,
      deviceSerial: selected.deviceSerial ?? '',
      profileId: selected.profileId ?? 0,
    }
  }

  async getNextDispatchTime(availableNumbers: SenderState[]): Promise<number | null> {
    const nonBanned = availableNumbers.filter(s => !s.banned)
    if (nonBanned.length === 0) return null

    // If any number has no cooldown, it's ready now
    const ready = nonBanned.find(s => s.cooldownExpiresAt === null)
    if (ready) return this.now()

    // Find earliest cooldown expiry
    let earliest = Infinity
    for (const s of nonBanned) {
      if (s.cooldownExpiresAt !== null && s.cooldownExpiresAt < earliest) {
        earliest = s.cooldownExpiresAt
      }
    }

    return earliest === Infinity ? null : earliest
  }

  isAllBanned(senderStates: SenderState[]): boolean {
    if (senderStates.length === 0) return true
    return senderStates.every(s => s.banned)
  }

}
