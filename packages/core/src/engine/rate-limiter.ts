import type { RateLimitConfig, RateLimitStore, CanSendResult } from './types.js'

export class RateLimiter {
  private lastSendAt = new Map<string, number>()

  constructor(
    private store: RateLimitStore,
    private config: RateLimitConfig,
    private now: () => number = Date.now,
  ) {}

  async getVolumeScale(senderNumber: string): Promise<number> {
    const count = await this.store.getSendCount(senderNumber)
    if (count < this.config.volumeScaleThreshold) return 1.0
    const blocks = Math.floor(count / this.config.volumeScaleThreshold)
    return Math.pow(this.config.volumeScaleFactor, blocks)
  }

  async calculateScaledDelay(senderNumber: string): Promise<number> {
    const scale = await this.getVolumeScale(senderNumber)
    const base = this.randomBetween(
      this.config.baseMinDelayS * 1000,
      this.config.baseMaxDelayS * 1000,
    )
    return Math.min(base * scale, this.config.volumeMaxDelayS * 1000)
  }

  applyJitter(scaledDelayMs: number): number {
    const factor = this.randomBetween(this.config.jitterMin, this.config.jitterMax)
    const jittered = scaledDelayMs * factor
    return Math.max(
      this.config.finalDelayFloorS * 1000,
      Math.min(jittered, this.config.finalDelayCapS * 1000),
    )
  }

  async checkPairLimit(senderNumber: string, toNumber: string): Promise<CanSendResult> {
    const lastPair = await this.store.getLastPairSend(senderNumber, toNumber)
    if (lastPair === null) return { canSend: true, waitMs: 0 }

    const elapsed = this.now() - lastPair
    const required = this.config.pairRateLimitS * 1000
    if (elapsed >= required) return { canSend: true, waitMs: 0 }

    return { canSend: false, waitMs: required - elapsed }
  }

  async canSend(senderNumber: string, toNumber: string): Promise<CanSendResult> {
    // Check global cooldown (last send from this number)
    const lastSend = this.lastSendAt.get(senderNumber)
    if (lastSend !== undefined) {
      const scaledDelay = await this.calculateScaledDelay(senderNumber)
      const elapsed = this.now() - lastSend
      if (elapsed < scaledDelay) {
        return { canSend: false, waitMs: scaledDelay - elapsed }
      }
    }

    // Check pair rate limit
    const pairCheck = await this.checkPairLimit(senderNumber, toNumber)
    if (!pairCheck.canSend) return pairCheck

    return { canSend: true, waitMs: 0 }
  }

  async recordSend(senderNumber: string, toNumber: string): Promise<void> {
    const timestamp = this.now()
    await this.store.addSendTimestamp(senderNumber, timestamp)
    await this.store.setLastPairSend(senderNumber, toNumber, timestamp)
    this.lastSendAt.set(senderNumber, timestamp)
  }

  async cleanExpiredTimestamps(senderNumber: string): Promise<void> {
    const windowMs = this.config.volumeWindowMinutes * 60 * 1000
    await this.store.cleanExpiredTimestamps(senderNumber, windowMs)
  }

  private randomBetween(min: number, max: number): number {
    return min + Math.random() * (max - min)
  }
}
