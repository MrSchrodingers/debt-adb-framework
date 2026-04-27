import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { DeviceCircuitBreaker } from './device-circuit-breaker.js'
import { DispatchEmitter } from '../events/dispatch-emitter.js'

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  return db
}

function makeBreaker(
  db: Database.Database,
  emitter: DispatchEmitter,
  opts?: { failureThreshold?: number; cooldownMs?: number; now?: () => number },
) {
  const breaker = new DeviceCircuitBreaker(db, emitter, {
    failureThreshold: opts?.failureThreshold ?? 5,
    cooldownMs: opts?.cooldownMs ?? 300_000,
    now: opts?.now,
  })
  breaker.initialize()
  return breaker
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('DeviceCircuitBreaker (SQLite-persistent)', () => {
  let db: Database.Database
  let emitter: DispatchEmitter

  beforeEach(() => {
    db = makeDb()
    emitter = new DispatchEmitter()
  })

  afterEach(() => {
    db.close()
  })

  // 1. Fresh device -> canUse === true (closed by default)
  it('fresh device: canUse returns true (no row exists)', () => {
    const breaker = makeBreaker(db, emitter)
    expect(breaker.canUse('device-1')).toBe(true)
    expect(breaker.getState('device-1')).toBeNull()
  })

  // 2. Below threshold: 4 failures (threshold=5) keep state closed, canUse true
  it('stays closed and allows use below the failure threshold', () => {
    const breaker = makeBreaker(db, emitter, { failureThreshold: 5 })
    breaker.recordFailure('device-1', 'err')
    breaker.recordFailure('device-1', 'err')
    breaker.recordFailure('device-1', 'err')
    breaker.recordFailure('device-1', 'err')

    const state = breaker.getState('device-1')
    expect(state?.state).toBe('closed')
    expect(state?.consecutiveFailures).toBe(4)
    expect(breaker.canUse('device-1')).toBe(true)
  })

  // 3. At threshold: 5th failure opens the circuit, canUse returns false
  it('opens circuit at failureThreshold and blocks subsequent canUse', () => {
    const emittedEvents: unknown[] = []
    emitter.on('device:circuit:opened', (data) => emittedEvents.push(data))

    const now = () => 1_000_000
    const breaker = makeBreaker(db, emitter, { failureThreshold: 5, cooldownMs: 300_000, now })

    for (let i = 0; i < 5; i++) {
      breaker.recordFailure('device-1', 'connection refused')
    }

    expect(breaker.canUse('device-1')).toBe(false)

    const state = breaker.getState('device-1')
    expect(state?.state).toBe('open')
    expect(state?.consecutiveFailures).toBe(5)

    expect(emittedEvents).toHaveLength(1)
    const evt = emittedEvents[0] as { serial: string; reason: string; consecutiveFailures: number }
    expect(evt.serial).toBe('device-1')
    expect(evt.reason).toBe('connection refused')
    expect(evt.consecutiveFailures).toBe(5)
  })

  // 4. Cooldown elapsed: canUse returns true AND state transitions to half_open
  it('transitions open -> half_open when cooldown elapses, emits device:circuit:half_open', () => {
    const halfOpenEvents: unknown[] = []
    emitter.on('device:circuit:half_open', (data) => halfOpenEvents.push(data))

    let mockNow = 1_000_000
    const breaker = makeBreaker(db, emitter, { failureThreshold: 5, cooldownMs: 300_000, now: () => mockNow })

    for (let i = 0; i < 5; i++) breaker.recordFailure('device-1', 'err')

    expect(breaker.canUse('device-1')).toBe(false)

    // Advance clock past cooldown
    mockNow += 300_001

    expect(breaker.canUse('device-1')).toBe(true)
    expect(breaker.getState('device-1')?.state).toBe('half_open')
    expect(halfOpenEvents).toHaveLength(1)
    expect((halfOpenEvents[0] as { serial: string }).serial).toBe('device-1')
  })

  // 5. Half-open success: transitions to closed, resets consecutive_failures, emits device:circuit:closed
  it('half-open success: closes circuit, resets failures, emits device:circuit:closed', () => {
    const closedEvents: unknown[] = []
    emitter.on('device:circuit:closed', (data) => closedEvents.push(data))

    let mockNow = 1_000_000
    const breaker = makeBreaker(db, emitter, { failureThreshold: 5, cooldownMs: 300_000, now: () => mockNow })

    for (let i = 0; i < 5; i++) breaker.recordFailure('device-1', 'err')

    mockNow += 300_001
    breaker.canUse('device-1') // triggers open -> half_open

    breaker.recordSuccess('device-1')

    const state = breaker.getState('device-1')
    expect(state?.state).toBe('closed')
    expect(state?.consecutiveFailures).toBe(0)

    expect(closedEvents).toHaveLength(1)
    expect((closedEvents[0] as { serial: string }).serial).toBe('device-1')
  })

  // 6. Half-open failure: re-opens with new cooldown window
  it('half-open failure: re-opens circuit with updated next_attempt_at', () => {
    const openedEvents: { nextAttemptAt: string }[] = []
    emitter.on('device:circuit:opened', (data) => openedEvents.push(data as { nextAttemptAt: string }))

    let mockNow = 1_000_000
    const cooldownMs = 300_000
    const breaker = makeBreaker(db, emitter, { failureThreshold: 5, cooldownMs, now: () => mockNow })

    for (let i = 0; i < 5; i++) breaker.recordFailure('device-1', 'initial err')

    mockNow += 300_001
    breaker.canUse('device-1') // open -> half_open

    // Advance time a bit more then fail
    mockNow += 10_000
    breaker.recordFailure('device-1', 're-open reason')

    const state = breaker.getState('device-1')
    expect(state?.state).toBe('open')

    // next_attempt_at should be based on the new mockNow
    const expectedNext = new Date(mockNow + cooldownMs).toISOString()
    expect(state?.nextAttemptAt).toBe(expectedNext)

    // Two opened events: initial open + re-open
    expect(openedEvents).toHaveLength(2)
    expect(openedEvents[1].nextAttemptAt).toBe(expectedNext)
  })

  // 7. recordSuccess in closed state resets consecutive_failures to 0
  it('recordSuccess in closed state resets failure counter', () => {
    const breaker = makeBreaker(db, emitter, { failureThreshold: 5 })

    breaker.recordFailure('device-1', 'e')
    breaker.recordFailure('device-1', 'e')
    breaker.recordFailure('device-1', 'e')

    expect(breaker.getState('device-1')?.consecutiveFailures).toBe(3)

    breaker.recordSuccess('device-1')

    const state = breaker.getState('device-1')
    expect(state?.state).toBe('closed')
    expect(state?.consecutiveFailures).toBe(0)
  })

  // 8. Persistence: state survives creating a new breaker on the same db
  it('state persists across breaker instances (simulates process restart)', () => {
    let mockNow = 1_000_000
    const breaker1 = makeBreaker(db, emitter, { failureThreshold: 5, cooldownMs: 300_000, now: () => mockNow })

    for (let i = 0; i < 5; i++) breaker1.recordFailure('device-1', 'err')

    // Simulate restart: new breaker on same db
    const breaker2 = makeBreaker(db, new DispatchEmitter(), { failureThreshold: 5, cooldownMs: 300_000, now: () => mockNow })

    expect(breaker2.canUse('device-1')).toBe(false)
    expect(breaker2.getState('device-1')?.state).toBe('open')
  })

  // 9. Reason field is captured in getState
  it('reason field is captured in getState', () => {
    const breaker = makeBreaker(db, emitter, { failureThreshold: 1 })

    breaker.recordFailure('device-1', 'WAHA returned 400')

    const state = breaker.getState('device-1')
    expect(state?.reason).toBe('WAHA returned 400')
  })

  // 10. Reason truncation: reasons longer than 500 chars are truncated
  it('truncates reason field to 500 chars', () => {
    const breaker = makeBreaker(db, emitter, { failureThreshold: 1 })
    const longReason = 'x'.repeat(600)

    breaker.recordFailure('device-1', longReason)

    const state = breaker.getState('device-1')
    expect(state?.reason?.length).toBeLessThanOrEqual(500)
  })

  // 11. Idempotent initialize(): calling twice does not throw
  it('initialize() is idempotent — calling twice does not throw', () => {
    const breaker = new DeviceCircuitBreaker(db, emitter, { failureThreshold: 5, cooldownMs: 300_000 })

    expect(() => {
      breaker.initialize()
      breaker.initialize()
    }).not.toThrow()
  })

  // 12. canExecute() is a backward-compatible alias for canUse()
  it('canExecute() is a backward-compatible alias for canUse()', () => {
    const breaker = makeBreaker(db, emitter, { failureThreshold: 5 })

    expect(breaker.canExecute('device-1')).toBe(true)

    for (let i = 0; i < 5; i++) breaker.recordFailure('device-1', 'err')

    expect(breaker.canExecute('device-1')).toBe(false)
  })

  // 13. No-db mode: canUse always true, no errors thrown
  it('no-db mode: canUse always returns true and no methods throw', () => {
    const noDbBreaker = new DeviceCircuitBreaker(undefined, undefined, { failureThreshold: 5, cooldownMs: 300_000 })
    noDbBreaker.initialize()

    expect(noDbBreaker.canUse('device-1')).toBe(true)
    expect(() => noDbBreaker.recordFailure('device-1', 'err')).not.toThrow()
    expect(() => noDbBreaker.recordSuccess('device-1')).not.toThrow()
    expect(noDbBreaker.getState('device-1')).toBeNull()
  })

  // 14. device:circuit:opened contains correct payload shape
  it('device:circuit:opened payload contains all required fields', () => {
    let mockNow = 2_000_000
    const cooldownMs = 300_000
    const events: unknown[] = []
    emitter.on('device:circuit:opened', (data) => events.push(data))

    const breaker = makeBreaker(db, emitter, { failureThreshold: 5, cooldownMs, now: () => mockNow })

    for (let i = 0; i < 5; i++) breaker.recordFailure('device-1', 'ADB timeout')

    expect(events).toHaveLength(1)
    const payload = events[0] as {
      serial: string
      reason: string
      openedAt: string
      nextAttemptAt: string
      consecutiveFailures: number
    }
    expect(payload.serial).toBe('device-1')
    expect(payload.reason).toBe('ADB timeout')
    expect(payload.consecutiveFailures).toBe(5)
    expect(new Date(payload.openedAt).getTime()).toBe(mockNow)
    expect(new Date(payload.nextAttemptAt).getTime()).toBe(mockNow + cooldownMs)
  })
})
