export interface RateLimiterConfig {
  maxRequests: number
  windowMs: number
}

export class RateLimiter {
  private readonly requests = new Map<string, number[]>()
  private readonly maxRequests: number
  private readonly windowMs: number

  constructor(config: RateLimiterConfig) {
    this.maxRequests = config.maxRequests
    this.windowMs = config.windowMs
  }

  isAllowed(key: string): boolean {
    const now = Date.now()
    const cutoff = now - this.windowMs

    let timestamps = this.requests.get(key)
    if (!timestamps) {
      timestamps = []
      this.requests.set(key, timestamps)
    }

    // Remove expired timestamps (sliding window)
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
}
