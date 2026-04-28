import { createServer as createNetServer } from 'node:net'
import type { DispatchEmitter } from '../events/dispatch-emitter.js'
import type { DeviceCircuitBreaker } from '../engine/device-circuit-breaker.js'

export interface BanPredictionConfig {
  /** TCP port to listen on for Frida hook events. Default 9871. */
  port: number
  /** Number of suspect signals within `windowMs` that trigger a circuit-breaker preemptive open. */
  suspectThreshold: number
  /** Sliding window for suspect signal counting. */
  windowMs: number
}

/**
 * Optional per-sender threshold override resolver. When the daemon receives a
 * suspect event for a device, it asks the SerialResolver for the sender phone
 * mapped to that device, then asks the ThresholdProvider whether an
 * operator-applied threshold exists for that sender. If both resolve, the
 * override REPLACES the env-default `suspectThreshold` for that single
 * evaluation.
 *
 * The override is the per-sender ack-rate threshold (0..1). It is interpreted
 * as a count via `Math.max(1, ceil(threshold * windowSamples))` so that lower
 * ratios produce HIGHER trip-counts (more tolerance) and vice-versa — keeping
 * the unit-mismatch resolution local to the daemon and not leaking into the
 * persistence layer (see ADR 0001 — env mutation is forbidden).
 */
export interface SerialResolver {
  resolveSenderForSerial(serial: string): string | null
}

export interface ThresholdProvider {
  getActiveThreshold(senderPhone: string): { threshold: number; windowMs: number } | null
}

const DEFAULT_CONFIG: BanPredictionConfig = {
  port: 9871,
  suspectThreshold: 3,
  windowMs: 60_000,
}

/**
 * Listens on a local TCP socket for line-delimited JSON events from
 * frida hook scripts. Recognizes "suspect" patterns (calls to anti-automation
 * methods); when threshold within window, asks the circuit breaker to
 * preemptively open the circuit for the affected device.
 *
 * EXPERIMENTAL — Phase 12. Default off via DISPATCH_BAN_PREDICTION_ENABLED=false.
 */
export class BanPredictionDaemon {
  private server: ReturnType<typeof createNetServer> | null = null
  private suspectSignals = new Map<string, number[]>() // serial → timestamps

  constructor(
    private emitter: DispatchEmitter,
    private circuitBreaker: DeviceCircuitBreaker,
    private config: BanPredictionConfig = DEFAULT_CONFIG,
    private serialResolver: SerialResolver | null = null,
    private thresholdProvider: ThresholdProvider | null = null,
  ) {}

  start(): void {
    this.server = createNetServer((socket) => {
      let buffer = ''
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8')
        let nl = buffer.indexOf('\n')
        while (nl !== -1) {
          const line = buffer.slice(0, nl)
          buffer = buffer.slice(nl + 1)
          this.handleLine(line)
          nl = buffer.indexOf('\n')
        }
      })
    })
    this.server.listen(this.config.port, '127.0.0.1')
  }

  stop(): void {
    this.server?.close()
    this.server = null
  }

  private handleLine(line: string): void {
    if (!line.trim()) return
    let event: { class?: string; method?: string; serial?: string }
    try {
      const parsed: unknown = JSON.parse(line)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return
      event = parsed as { class?: string; method?: string; serial?: string }
    } catch {
      return
    }
    if (!event.serial || !event.class) return

    if (this.isSuspect(event.class, event.method)) {
      this.recordSuspect(event.serial)
    }
  }

  private isSuspect(className: string, _method?: string): boolean {
    return /AntiTamper|AutomationDetector|SignatureValidator/.test(className)
  }

  private recordSuspect(serial: string): void {
    const now = Date.now()
    const list = this.suspectSignals.get(serial) ?? []
    list.push(now)

    // Resolve effective threshold + window — per-sender override beats env-default.
    const { suspectThreshold, windowMs } = this.resolveThreshold(serial)

    // Trim by window
    const cutoff = now - windowMs
    const fresh = list.filter((t) => t >= cutoff)
    this.suspectSignals.set(serial, fresh)

    if (fresh.length >= suspectThreshold) {
      this.circuitBreaker.recordFailure(serial, `ban_prediction: ${fresh.length} suspect signals in window`)
      this.suspectSignals.set(serial, [])
      this.emitter.emit('ban_prediction:triggered', {
        serial,
        suspectCount: fresh.length,
        windowMs,
      })
    }
  }

  /**
   * Resolve the trip-threshold for `serial` honoring the per-sender override
   * table when both a sender mapping and an active threshold exist. Otherwise
   * fall back to the env-default config. Pure function over the injected
   * resolvers — easy to unit-test.
   */
  private resolveThreshold(serial: string): { suspectThreshold: number; windowMs: number } {
    if (!this.serialResolver || !this.thresholdProvider) {
      return { suspectThreshold: this.config.suspectThreshold, windowMs: this.config.windowMs }
    }
    const senderPhone = this.serialResolver.resolveSenderForSerial(serial)
    if (!senderPhone) {
      return { suspectThreshold: this.config.suspectThreshold, windowMs: this.config.windowMs }
    }
    const override = this.thresholdProvider.getActiveThreshold(senderPhone)
    if (!override) {
      return { suspectThreshold: this.config.suspectThreshold, windowMs: this.config.windowMs }
    }
    // Translate the per-sender ack-rate threshold (0..1) into a suspect-count
    // count threshold by scaling the env-default. The semantics: a HIGHER ratio
    // means the operator expects a healthier account → trip on fewer suspect
    // events (less tolerance). Floor at 1 so the daemon stays useful at the
    // extremes. The override `windowMs` always wins because it is the operator's
    // explicit calibration window.
    const ratio = Math.min(1, Math.max(0, override.threshold))
    const scaled = Math.max(1, Math.ceil(this.config.suspectThreshold * (1 - ratio)))
    return { suspectThreshold: scaled, windowMs: override.windowMs }
  }
}
