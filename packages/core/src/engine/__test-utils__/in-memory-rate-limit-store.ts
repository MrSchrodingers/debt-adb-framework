import type { RateLimitStore } from '../types.js'

export class InMemoryRateLimitStore implements RateLimitStore {
  private timestamps = new Map<string, number[]>()
  private pairSends = new Map<string, number>()

  constructor(private now: () => number = Date.now) {}

  async getSendTimestamps(senderNumber: string): Promise<number[]> {
    return this.timestamps.get(senderNumber) ?? []
  }

  async addSendTimestamp(senderNumber: string, timestamp: number): Promise<void> {
    const ts = this.timestamps.get(senderNumber) ?? []
    ts.push(timestamp)
    this.timestamps.set(senderNumber, ts)
  }

  async cleanExpiredTimestamps(senderNumber: string, windowMs: number): Promise<void> {
    const ts = this.timestamps.get(senderNumber) ?? []
    const cutoff = this.now() - windowMs
    this.timestamps.set(senderNumber, ts.filter(t => t > cutoff))
  }

  async getLastPairSend(senderNumber: string, toNumber: string): Promise<number | null> {
    return this.pairSends.get(`${senderNumber}:${toNumber}`) ?? null
  }

  async setLastPairSend(senderNumber: string, toNumber: string, timestamp: number): Promise<void> {
    this.pairSends.set(`${senderNumber}:${toNumber}`, timestamp)
  }

  async getSendCount(senderNumber: string): Promise<number> {
    return (this.timestamps.get(senderNumber) ?? []).length
  }
}
