import type Database from 'better-sqlite3'
import type { DispatchEmitter } from '../events/index.js'

// ── Public types ──────────────────────────────────────────────────────────────

export interface DeviceCircuitBreakerConfig {
  /** Number of consecutive failures that opens the circuit. Default: 5 */
  failureThreshold: number
  /** Cooldown in ms before transitioning open → half_open. Default: 300_000 (5 min) */
  cooldownMs: number
  /** Clock function — injectable for deterministic tests. Default: () => Date.now() */
  now?: () => number
}

/** Row shape as stored in SQLite */
interface CircuitRow {
  device_serial: string
  state: string
  consecutive_failures: number
  last_failure_at: string | null
  opened_at: string | null
  next_attempt_at: string | null
  reason: string | null
}

/** Full state returned by getState() */
export interface CircuitBreakerState {
  state: 'closed' | 'open' | 'half_open'
  consecutiveFailures: number
  lastFailureAt: string | null
  openedAt: string | null
  nextAttemptAt: string | null
  reason: string | null
}

/** Kept for backward compatibility with old in-memory API */
export type CircuitState = 'closed' | 'open' | 'half-open' | 'half_open'

/** Kept for backward compatibility with old in-memory config shape */
export interface CircuitBreakerConfig {
  failureThreshold: number
  resetTimeoutMs: number
  halfOpenMaxCalls: number
}

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: Required<DeviceCircuitBreakerConfig> = {
  failureThreshold: 5,
  cooldownMs: 300_000,
  now: () => Date.now(),
}

const MAX_REASON_LENGTH = 500

// ── Class ─────────────────────────────────────────────────────────────────────

/**
 * Per-device circuit breaker with SQLite-persistent state and DispatchEmitter events.
 *
 * State machine:
 *   closed    -> open       (after failureThreshold consecutive failures)
 *   open      -> half_open  (after cooldownMs elapsed — side-effect of canUse())
 *   half_open -> closed     (on recordSuccess)
 *   half_open -> open       (on recordFailure)
 *
 * Persistence: the device_circuit_state table is created inline by initialize().
 * Call initialize() once at bootstrap before the first canUse/recordSuccess/recordFailure call.
 *
 * Events emitted (all on DispatchEmitter):
 *   device:circuit:opened    — when circuit transitions to open
 *   device:circuit:half_open — when circuit transitions to half_open
 *   device:circuit:closed    — when circuit transitions to closed from half_open
 */
export class DeviceCircuitBreaker {
  private cfg: Required<DeviceCircuitBreakerConfig>

  // Prepared statements (set by initialize())
  private stmtUpsert!: Database.Statement
  private stmtSelect!: Database.Statement
  private stmtUpdate!: Database.Statement

  constructor(
    private readonly db?: Database.Database,
    private readonly emitter?: DispatchEmitter,
    config?: Partial<DeviceCircuitBreakerConfig>,
  ) {
    this.cfg = { ...DEFAULT_CONFIG, ...config }
    if (typeof this.cfg.now !== 'function') {
      this.cfg.now = DEFAULT_CONFIG.now
    }
  }

  /**
   * Hot-reload: update thresholds applied to future canUse/recordFailure calls.
   * The `now` clock and DB reference are not replaced.
   * In-flight circuit states (open/half_open rows) continue using previously
   * computed next_attempt_at timestamps — only new openings use the new cooldownMs.
   */
  reloadConfig(config: Pick<DeviceCircuitBreakerConfig, 'failureThreshold' | 'cooldownMs'>): void {
    this.cfg = { ...this.cfg, ...config }
  }

  /**
   * Create the device_circuit_state table and prepare reusable statements.
   * Idempotent — safe to call multiple times (uses CREATE TABLE IF NOT EXISTS).
   */
  initialize(): void {
    if (!this.db) return // no-op when running in legacy no-db mode

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS device_circuit_state (
        device_serial TEXT PRIMARY KEY,
        state TEXT NOT NULL DEFAULT 'closed',
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        last_failure_at TEXT,
        opened_at TEXT,
        next_attempt_at TEXT,
        reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_device_circuit_state_state ON device_circuit_state(state);
    `)

    this.stmtSelect = this.db.prepare(
      'SELECT * FROM device_circuit_state WHERE device_serial = ?',
    )
    this.stmtUpsert = this.db.prepare(`
      INSERT INTO device_circuit_state (device_serial, state, consecutive_failures, last_failure_at, opened_at, next_attempt_at, reason)
      VALUES (@device_serial, @state, @consecutive_failures, @last_failure_at, @opened_at, @next_attempt_at, @reason)
      ON CONFLICT(device_serial) DO UPDATE SET
        state = excluded.state,
        consecutive_failures = excluded.consecutive_failures,
        last_failure_at = excluded.last_failure_at,
        opened_at = excluded.opened_at,
        next_attempt_at = excluded.next_attempt_at,
        reason = excluded.reason
    `)
    this.stmtUpdate = this.db.prepare(`
      UPDATE device_circuit_state SET
        state = @state,
        consecutive_failures = @consecutive_failures,
        last_failure_at = @last_failure_at,
        opened_at = @opened_at,
        next_attempt_at = @next_attempt_at,
        reason = @reason
      WHERE device_serial = @device_serial
    `)
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Returns true if the device may be used for sending.
   * Returns false when state is 'open' and the cooldown has not yet elapsed.
   *
   * Side effect: when state is 'open' AND cooldown has elapsed, this call
   * transitions the circuit to 'half_open' and emits device:circuit:half_open.
   * This allows the next send to act as a probe.
   */
  canUse(deviceSerial: string): boolean {
    if (!this.db) return true // no-db mode: always allow

    const row = this.selectRow(deviceSerial)
    if (!row) return true // unknown device — default allow

    if (row.state === 'closed') return true

    if (row.state === 'open') {
      const nextAttempt = row.next_attempt_at ? new Date(row.next_attempt_at).getTime() : 0
      if (this.cfg.now() >= nextAttempt) {
        // Single-statement UPDATE — atomic per better-sqlite3 semantics;
        // concurrent safety provided by Node.js single-threaded event loop.
        this.stmtUpdate.run({
          device_serial: deviceSerial,
          state: 'half_open',
          consecutive_failures: row.consecutive_failures,
          last_failure_at: row.last_failure_at,
          opened_at: row.opened_at,
          next_attempt_at: row.next_attempt_at,
          reason: row.reason,
        })
        this.emitter?.emit('device:circuit:half_open', { serial: deviceSerial })
        return true
      }
      return false
    }

    // half_open — probe is in flight, allow
    return true
  }

  /**
   * Record a successful send for this device.
   * If circuit was half_open, transitions to closed and emits device:circuit:closed.
   * In closed state: resets consecutive_failures to 0.
   */
  recordSuccess(deviceSerial: string): void {
    if (!this.db) return

    const row = this.selectRow(deviceSerial)
    if (!row) {
      // Unknown device — upsert as closed with 0 failures (idempotent)
      this.stmtUpsert.run({
        device_serial: deviceSerial,
        state: 'closed',
        consecutive_failures: 0,
        last_failure_at: null,
        opened_at: null,
        next_attempt_at: null,
        reason: null,
      })
      return
    }

    const wasHalfOpen = row.state === 'half_open'
    this.stmtUpdate.run({
      device_serial: deviceSerial,
      state: 'closed',
      consecutive_failures: 0,
      last_failure_at: null,
      opened_at: null,
      next_attempt_at: null,
      reason: null,
    })

    if (wasHalfOpen) {
      this.emitter?.emit('device:circuit:closed', { serial: deviceSerial })
    }
  }

  /**
   * Record a failed send for this device.
   * Increments consecutive_failures.
   * When failures reach failureThreshold (or immediately in half_open), opens the circuit
   * and emits device:circuit:opened.
   */
  recordFailure(deviceSerial: string, reason: string): void {
    if (!this.db) return

    const truncatedReason = reason.slice(0, MAX_REASON_LENGTH)
    const now = this.cfg.now()
    const nowIso = new Date(now).toISOString()

    const row = this.selectRow(deviceSerial)

    if (!row) {
      // First failure — create row
      const newFailures = 1
      if (newFailures >= this.cfg.failureThreshold) {
        const openedAt = nowIso
        const nextAttemptAt = new Date(now + this.cfg.cooldownMs).toISOString()
        this.stmtUpsert.run({
          device_serial: deviceSerial,
          state: 'open',
          consecutive_failures: newFailures,
          last_failure_at: nowIso,
          opened_at: openedAt,
          next_attempt_at: nextAttemptAt,
          reason: truncatedReason,
        })
        this.emitter?.emit('device:circuit:opened', {
          serial: deviceSerial,
          reason: truncatedReason,
          openedAt,
          nextAttemptAt,
          consecutiveFailures: newFailures,
        })
      } else {
        this.stmtUpsert.run({
          device_serial: deviceSerial,
          state: 'closed',
          consecutive_failures: newFailures,
          last_failure_at: nowIso,
          opened_at: null,
          next_attempt_at: null,
          reason: truncatedReason,
        })
      }
      return
    }

    const newFailures = row.consecutive_failures + 1

    if (row.state === 'half_open' || newFailures >= this.cfg.failureThreshold) {
      // Open (or re-open) the circuit
      const openedAt = nowIso
      const nextAttemptAt = new Date(now + this.cfg.cooldownMs).toISOString()
      this.stmtUpdate.run({
        device_serial: deviceSerial,
        state: 'open',
        consecutive_failures: newFailures,
        last_failure_at: nowIso,
        opened_at: openedAt,
        next_attempt_at: nextAttemptAt,
        reason: truncatedReason,
      })
      this.emitter?.emit('device:circuit:opened', {
        serial: deviceSerial,
        reason: truncatedReason,
        openedAt,
        nextAttemptAt,
        consecutiveFailures: newFailures,
      })
    } else {
      // Still closed — accumulate failures
      this.stmtUpdate.run({
        device_serial: deviceSerial,
        state: 'closed',
        consecutive_failures: newFailures,
        last_failure_at: nowIso,
        opened_at: null,
        next_attempt_at: null,
        reason: truncatedReason,
      })
    }
  }

  /**
   * Inspect state for tests / admin endpoints.
   * Returns null if the device has no state row yet (i.e. fresh/unknown device).
   */
  getState(deviceSerial: string): CircuitBreakerState | null {
    if (!this.db) return null

    const row = this.selectRow(deviceSerial)
    if (!row) return null

    return {
      state: row.state as 'closed' | 'open' | 'half_open',
      consecutiveFailures: row.consecutive_failures,
      lastFailureAt: row.last_failure_at,
      openedAt: row.opened_at,
      nextAttemptAt: row.next_attempt_at,
      reason: row.reason,
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────────

  private selectRow(deviceSerial: string): CircuitRow | null {
    if (!this.stmtSelect) return null
    return (this.stmtSelect.get(deviceSerial) as CircuitRow) ?? null
  }
}
