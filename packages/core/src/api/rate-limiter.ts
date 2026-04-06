export interface IpRateLimiterConfig {
  maxRequests: number
  windowMs: number
}

export class IpRateLimiter {
  private readonly requests = new Map<string, number[]>()
  private readonly maxRequests: number
  private readonly windowMs: number
  private readonly cleanupTimer: ReturnType<typeof setInterval>

  constructor(config: IpRateLimiterConfig) {
    this.maxRequests = config.maxRequests
    this.windowMs = config.windowMs
    // Evict stale keys every 5 minutes
    this.cleanupTimer = setInterval(() => this.evictStale(), 300_000)
  }

  isAllowed(key: string): boolean {
    const now = Date.now()
    const cutoff = now - this.windowMs

    let timestamps = this.requests.get(key)
    if (!timestamps) {
      timestamps = []
      this.requests.set(key, timestamps)
    }

    const filtered = timestamps.filter(t => t > cutoff)
    this.requests.set(key, filtered)

    if (filtered.length >= this.maxRequests) {
      return false
    }

    filtered.push(now)
    return true
  }

  remaining(key: string): number {
    const now = Date.now()
    const cutoff = now - this.windowMs
    const timestamps = this.requests.get(key)
    if (!timestamps) return this.maxRequests
    const recent = timestamps.filter(t => t > cutoff)
    return Math.max(0, this.maxRequests - recent.length)
  }

  destroy(): void {
    clearInterval(this.cleanupTimer)
    this.requests.clear()
  }

  private evictStale(): void {
    const now = Date.now()
    const cutoff = now - this.windowMs
    for (const [key, timestamps] of this.requests) {
      const recent = timestamps.filter(t => t > cutoff)
      if (recent.length === 0) {
        this.requests.delete(key)
      } else {
        this.requests.set(key, recent)
      }
    }
  }
}
