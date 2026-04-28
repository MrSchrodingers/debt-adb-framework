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
    // Trim by window
    const cutoff = now - this.config.windowMs
    const fresh = list.filter((t) => t >= cutoff)
    this.suspectSignals.set(serial, fresh)

    if (fresh.length >= this.config.suspectThreshold) {
      this.circuitBreaker.recordFailure(serial, `ban_prediction: ${fresh.length} suspect signals in window`)
      this.suspectSignals.set(serial, [])
      this.emitter.emit('ban_prediction:triggered', {
        serial,
        suspectCount: fresh.length,
        windowMs: this.config.windowMs,
      })
    }
  }
}
