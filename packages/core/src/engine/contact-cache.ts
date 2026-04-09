/**
 * ContactCache — in-memory TTL cache for verified contacts.
 *
 * Eliminates repeated ADB `content query` calls to check if a contact
 * exists on an Android device. Keyed by `device:phone` so the same
 * phone number on different devices is tracked independently.
 *
 * Default TTL: 1 hour. After expiry the next lookup triggers a fresh
 * ADB verification.
 */

export interface ContactCacheConfig {
  /** Time-to-live in milliseconds. Default: 3_600_000 (1 hour). */
  ttlMs: number
}

export class ContactCache {
  private cache = new Map<string, number>() // key → expireAt timestamp
  private hits = 0
  private misses = 0

  constructor(private config: ContactCacheConfig = { ttlMs: 3_600_000 }) {}

  private key(deviceSerial: string, phone: string): string {
    return `${deviceSerial}:${phone}`
  }

  /**
   * Check whether a contact was recently verified on the given device.
   * Returns false (and increments misses) if unknown or expired.
   */
  isVerified(deviceSerial: string, phone: string): boolean {
    const k = this.key(deviceSerial, phone)
    const expireAt = this.cache.get(k)

    if (expireAt === undefined) {
      this.misses++
      return false
    }

    if (Date.now() > expireAt) {
      this.cache.delete(k)
      this.misses++
      return false
    }

    this.hits++
    return true
  }

  /** Mark a contact as verified on the given device, resetting the TTL. */
  markVerified(deviceSerial: string, phone: string): void {
    this.cache.set(this.key(deviceSerial, phone), Date.now() + this.config.ttlMs)
  }

  /** Return cache statistics for observability. */
  getStats(): { hits: number; misses: number; size: number } {
    return { hits: this.hits, misses: this.misses, size: this.cache.size }
  }

  /** Remove all cached entries and reset counters. */
  clear(): void {
    this.cache.clear()
    this.hits = 0
    this.misses = 0
  }
}
