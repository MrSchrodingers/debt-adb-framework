/**
 * Per-phone-number mutex to prevent simultaneous ADB+WAHA sends
 * for the same WhatsApp account.
 */
export class AccountMutex {
  private locks = new Map<string, { resolve: () => void }[]>()
  private held = new Set<string>()

  constructor(private timeoutMs = 60_000) {}

  /**
   * Acquire exclusive lock for a phone number.
   * Returns a release function. Rejects after timeout.
   */
  async acquire(phone: string): Promise<() => void> {
    if (!this.held.has(phone)) {
      this.held.add(phone)
      return () => this.release(phone)
    }

    return new Promise<() => void>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Remove from waiters
        const waiters = this.locks.get(phone)
        if (waiters) {
          const idx = waiters.findIndex((w) => w.resolve === onRelease)
          if (idx !== -1) waiters.splice(idx, 1)
        }
        reject(new Error(`AccountMutex timeout after ${this.timeoutMs}ms for ${phone}`))
      }, this.timeoutMs)

      const onRelease = () => {
        clearTimeout(timer)
        resolve(() => this.release(phone))
      }

      if (!this.locks.has(phone)) {
        this.locks.set(phone, [])
      }
      this.locks.get(phone)!.push({ resolve: onRelease })
    })
  }

  private release(phone: string): void {
    const waiters = this.locks.get(phone)
    if (waiters && waiters.length > 0) {
      const next = waiters.shift()!
      next.resolve()
    } else {
      this.held.delete(phone)
      this.locks.delete(phone)
    }
  }

  /** Release all locks (for testing/shutdown). */
  releaseAll(): void {
    this.held.clear()
    this.locks.clear()
  }
}
