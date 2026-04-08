export interface SenderHealthConfig {
  quarantineAfterFailures: number
  quarantineDurationMs: number
}

const DEFAULTS: SenderHealthConfig = {
  quarantineAfterFailures: 3,
  quarantineDurationMs: 3_600_000, // 1 hour
}

export class SenderHealth {
  private failures = new Map<string, number>()
  private quarantinedUntil = new Map<string, number>()
  private config: SenderHealthConfig

  constructor(config?: Partial<SenderHealthConfig>) {
    this.config = { ...DEFAULTS, ...config }
  }

  recordSuccess(sender: string): void {
    this.failures.delete(sender)
  }

  recordFailure(sender: string): void {
    const count = (this.failures.get(sender) ?? 0) + 1
    this.failures.set(sender, count)
    if (count >= this.config.quarantineAfterFailures) {
      this.quarantinedUntil.set(sender, Date.now() + this.config.quarantineDurationMs)
    }
  }

  isQuarantined(sender: string): boolean {
    const until = this.quarantinedUntil.get(sender)
    if (!until) return false
    if (Date.now() > until) {
      this.quarantinedUntil.delete(sender)
      this.failures.delete(sender)
      return false
    }
    return true
  }
}
