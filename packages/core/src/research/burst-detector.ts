/**
 * BurstDetector — fleet-wide circuit breaker.
 *
 * Watches sender quarantine events. When >= threshold distinct senders enter
 * QUARANTINED inside a sliding window (default: 3 senders / 10 minutes), the
 * detector triggers a fleet-wide pause and emits a critical alert.
 *
 * Reset on global resume so a new burst can be detected after an operator
 * unpause.
 */

export interface BurstAlert {
  kind: 'fleet_burst'
  affected: string[]
  reason: string
}

export interface BurstDetectorDeps {
  threshold: number
  windowMs: number
  alert: (event: BurstAlert) => void
  pauseGlobal: (reason: string) => void
  isPausedGlobally: () => boolean
}

interface Entry {
  senderPhone: string
  ts: number
}

export class BurstDetector {
  private events: Entry[] = []

  constructor(private readonly deps: BurstDetectorDeps) {}

  observeQuarantine(senderPhone: string, atMs: number = Date.now()): void {
    if (this.deps.isPausedGlobally()) return
    this.pruneAndDedup(senderPhone, atMs)
    this.events.push({ senderPhone, ts: atMs })

    const distinctInWindow = new Set(
      this.events
        .filter((e) => atMs - e.ts <= this.deps.windowMs)
        .map((e) => e.senderPhone),
    )

    if (distinctInWindow.size >= this.deps.threshold) {
      const affected = [...distinctInWindow]
      const reason = `fleet burst: ${affected.length} senders quarantined within ${this.deps.windowMs / 60_000}min`
      this.deps.pauseGlobal(reason)
      this.deps.alert({ kind: 'fleet_burst', affected, reason })
      this.events = []
    }
  }

  reset(): void {
    this.events = []
  }

  private pruneAndDedup(senderPhone: string, atMs: number): void {
    const cutoff = atMs - this.deps.windowMs
    this.events = this.events.filter((e) => e.ts >= cutoff && e.senderPhone !== senderPhone)
  }
}
