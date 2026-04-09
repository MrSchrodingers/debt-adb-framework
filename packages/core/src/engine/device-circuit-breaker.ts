export interface CircuitBreakerConfig {
  /** Failures before circuit opens. Default: 3 */
  failureThreshold: number
  /** Ms before half-open probe. Default: 30000 (30s) */
  resetTimeoutMs: number
  /** Max calls allowed in half-open state. Default: 1 */
  halfOpenMaxCalls: number
}

export type CircuitState = 'closed' | 'open' | 'half-open'

interface DeviceCircuit {
  state: CircuitState
  failureCount: number
  lastFailureAt: number
  halfOpenCalls: number
}

const DEFAULTS: CircuitBreakerConfig = {
  failureThreshold: 3,
  resetTimeoutMs: 30_000,
  halfOpenMaxCalls: 1,
}

/**
 * Per-device circuit breaker that prevents wasted ADB+WAHA failure cycles
 * when a device is offline or unreachable.
 *
 * State machine:
 *   closed  →  open       (after failureThreshold consecutive failures)
 *   open    →  half-open  (after resetTimeoutMs elapsed)
 *   half-open → closed    (on success — device recovered)
 *   half-open → open      (on failure — device still down)
 */
export class DeviceCircuitBreaker {
  private circuits = new Map<string, DeviceCircuit>()
  private config: CircuitBreakerConfig

  constructor(config?: Partial<CircuitBreakerConfig>) {
    this.config = { ...DEFAULTS, ...config }
  }

  private getOrCreate(deviceSerial: string): DeviceCircuit {
    let circuit = this.circuits.get(deviceSerial)
    if (!circuit) {
      circuit = { state: 'closed', failureCount: 0, lastFailureAt: 0, halfOpenCalls: 0 }
      this.circuits.set(deviceSerial, circuit)
    }
    return circuit
  }

  /**
   * Check whether a call to the given device should be allowed.
   * Transitions open → half-open when the reset timeout has elapsed.
   */
  canExecute(deviceSerial: string): boolean {
    const circuit = this.getOrCreate(deviceSerial)

    if (circuit.state === 'closed') return true

    if (circuit.state === 'open') {
      // Check if reset timeout has elapsed → transition to half-open
      if (Date.now() - circuit.lastFailureAt >= this.config.resetTimeoutMs) {
        circuit.state = 'half-open'
        circuit.halfOpenCalls = 0
        return true
      }
      return false
    }

    // half-open: allow limited calls
    return circuit.halfOpenCalls < this.config.halfOpenMaxCalls
  }

  /** Record a successful call — closes the circuit and resets failure count. */
  recordSuccess(deviceSerial: string): void {
    const circuit = this.getOrCreate(deviceSerial)
    circuit.failureCount = 0
    circuit.halfOpenCalls = 0
    circuit.state = 'closed'
  }

  /** Record a failed call — increments failure count, may open the circuit. */
  recordFailure(deviceSerial: string): void {
    const circuit = this.getOrCreate(deviceSerial)
    circuit.failureCount++
    circuit.lastFailureAt = Date.now()

    if (circuit.state === 'half-open') {
      // Half-open failure → re-open immediately
      circuit.state = 'open'
      return
    }

    if (circuit.failureCount >= this.config.failureThreshold) {
      circuit.state = 'open'
    }
  }

  /** Get the current state of a device's circuit (accounts for pending open→half-open transition). */
  getState(deviceSerial: string): CircuitState {
    const circuit = this.getOrCreate(deviceSerial)

    // Check for pending transition from open → half-open
    if (circuit.state === 'open' && Date.now() - circuit.lastFailureAt >= this.config.resetTimeoutMs) {
      return 'half-open'
    }

    return circuit.state
  }
}
