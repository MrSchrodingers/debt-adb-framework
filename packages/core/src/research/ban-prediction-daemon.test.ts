import { describe, it, expect, vi, beforeEach } from 'vitest'
import { BanPredictionDaemon } from './ban-prediction-daemon.js'
import type { DispatchEmitter } from '../events/dispatch-emitter.js'
import type { DeviceCircuitBreaker } from '../engine/device-circuit-breaker.js'

// ── Minimal mocks ──────────────────────────────────────────────────────────

function makeEmitter(): DispatchEmitter {
  return { emit: vi.fn() } as unknown as DispatchEmitter
}

function makeCircuitBreaker(): DeviceCircuitBreaker {
  return { recordFailure: vi.fn() } as unknown as DeviceCircuitBreaker
}

function makeDaemon(
  emitter: DispatchEmitter,
  cb: DeviceCircuitBreaker,
  overrides: { suspectThreshold?: number; windowMs?: number } = {},
) {
  return new BanPredictionDaemon(emitter, cb, {
    port: 9871,
    suspectThreshold: overrides.suspectThreshold ?? 3,
    windowMs: overrides.windowMs ?? 60_000,
  })
}

// Reach private handleLine() without needing a real TCP socket.
// We cast to access private — intentional for unit-testing the pure logic.
function sendLine(daemon: BanPredictionDaemon, line: string): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(daemon as any).handleLine(line)
}

function suspectLine(serial: string, className = 'com.whatsapp.security.AntiTamper'): string {
  return JSON.stringify({ event: 'method_call', class: className, method: 'check', args: [], serial })
}

function nonSuspectLine(serial: string): string {
  return JSON.stringify({ event: 'method_call', class: 'com.whatsapp.client.ClientUtils', method: 'buildVersion', args: [], serial })
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('BanPredictionDaemon', () => {
  describe('threshold not reached', () => {
    it('does NOT trigger circuit breaker when suspect signals are below threshold', () => {
      const emitter = makeEmitter()
      const cb = makeCircuitBreaker()
      const daemon = makeDaemon(emitter, cb, { suspectThreshold: 3 })

      sendLine(daemon, suspectLine('device-A'))
      sendLine(daemon, suspectLine('device-A'))
      // Only 2 signals, threshold is 3

      expect(cb.recordFailure).not.toHaveBeenCalled()
      expect(emitter.emit).not.toHaveBeenCalled()
    })
  })

  describe('threshold reached within window', () => {
    it('calls circuitBreaker.recordFailure and emits ban_prediction:triggered', () => {
      const emitter = makeEmitter()
      const cb = makeCircuitBreaker()
      const daemon = makeDaemon(emitter, cb, { suspectThreshold: 3 })

      sendLine(daemon, suspectLine('device-A'))
      sendLine(daemon, suspectLine('device-A'))
      sendLine(daemon, suspectLine('device-A'))

      expect(cb.recordFailure).toHaveBeenCalledOnce()
      expect(cb.recordFailure).toHaveBeenCalledWith(
        'device-A',
        expect.stringContaining('ban_prediction'),
      )
      expect(emitter.emit).toHaveBeenCalledWith('ban_prediction:triggered', {
        serial: 'device-A',
        suspectCount: 3,
        windowMs: 60_000,
      })
    })

    it('resets the suspect counter after triggering so repeat bursts fire again', () => {
      const emitter = makeEmitter()
      const cb = makeCircuitBreaker()
      const daemon = makeDaemon(emitter, cb, { suspectThreshold: 3 })

      // First burst
      sendLine(daemon, suspectLine('device-A'))
      sendLine(daemon, suspectLine('device-A'))
      sendLine(daemon, suspectLine('device-A'))
      expect(cb.recordFailure).toHaveBeenCalledTimes(1)

      // Second burst — counter was reset, should trigger again
      sendLine(daemon, suspectLine('device-A'))
      sendLine(daemon, suspectLine('device-A'))
      sendLine(daemon, suspectLine('device-A'))
      expect(cb.recordFailure).toHaveBeenCalledTimes(2)
    })
  })

  describe('window pruning', () => {
    it('prunes signals outside the sliding window so old signals do not count', () => {
      const emitter = makeEmitter()
      const cb = makeCircuitBreaker()
      const WINDOW_MS = 5_000
      const daemon = makeDaemon(emitter, cb, { suspectThreshold: 3, windowMs: WINDOW_MS })

      const realNow = Date.now
      let fakeNow = 1_000_000

      try {
        // Inject 2 signals at t=0
        vi.spyOn(Date, 'now').mockImplementation(() => fakeNow)
        sendLine(daemon, suspectLine('device-B'))
        sendLine(daemon, suspectLine('device-B'))

        // Advance clock past the window — those 2 signals are now expired
        fakeNow += WINDOW_MS + 1

        // One new signal — only 1 fresh signal; threshold 3 not met
        sendLine(daemon, suspectLine('device-B'))

        expect(cb.recordFailure).not.toHaveBeenCalled()
      } finally {
        vi.spyOn(Date, 'now').mockImplementation(realNow)
        vi.restoreAllMocks()
      }
    })
  })

  describe('device isolation', () => {
    it('tracks suspect signals per device independently', () => {
      const emitter = makeEmitter()
      const cb = makeCircuitBreaker()
      const daemon = makeDaemon(emitter, cb, { suspectThreshold: 3 })

      // 2 signals on device-X, 3 on device-Y
      sendLine(daemon, suspectLine('device-X'))
      sendLine(daemon, suspectLine('device-X'))
      sendLine(daemon, suspectLine('device-Y'))
      sendLine(daemon, suspectLine('device-Y'))
      sendLine(daemon, suspectLine('device-Y'))

      // Only device-Y should have triggered
      expect(cb.recordFailure).toHaveBeenCalledOnce()
      expect(cb.recordFailure).toHaveBeenCalledWith('device-Y', expect.any(String))
      expect(emitter.emit).toHaveBeenCalledWith(
        'ban_prediction:triggered',
        expect.objectContaining({ serial: 'device-Y' }),
      )
    })
  })

  describe('non-suspect events', () => {
    it('ignores calls to classes not matching the suspect pattern', () => {
      const emitter = makeEmitter()
      const cb = makeCircuitBreaker()
      const daemon = makeDaemon(emitter, cb, { suspectThreshold: 1 })

      // ClientUtils is NOT in the suspect pattern (see isSuspect)
      sendLine(daemon, nonSuspectLine('device-C'))
      sendLine(daemon, nonSuspectLine('device-C'))
      sendLine(daemon, nonSuspectLine('device-C'))

      expect(cb.recordFailure).not.toHaveBeenCalled()
      expect(emitter.emit).not.toHaveBeenCalled()
    })
  })

  describe('malformed JSON', () => {
    it('silently drops malformed JSON lines without throwing', () => {
      const emitter = makeEmitter()
      const cb = makeCircuitBreaker()
      const daemon = makeDaemon(emitter, cb)

      expect(() => {
        sendLine(daemon, '{not valid json')
        sendLine(daemon, '')
        sendLine(daemon, '   ')
        sendLine(daemon, 'null')
        sendLine(daemon, '42')
      }).not.toThrow()

      expect(cb.recordFailure).not.toHaveBeenCalled()
      expect(emitter.emit).not.toHaveBeenCalled()
    })

    it('drops lines that are valid JSON but lack serial or class fields', () => {
      const emitter = makeEmitter()
      const cb = makeCircuitBreaker()
      const daemon = makeDaemon(emitter, cb, { suspectThreshold: 1 })

      // Missing serial
      sendLine(daemon, JSON.stringify({ event: 'method_call', class: 'com.whatsapp.security.AntiTamper' }))
      // Missing class
      sendLine(daemon, JSON.stringify({ event: 'method_call', serial: 'device-D' }))

      expect(cb.recordFailure).not.toHaveBeenCalled()
    })
  })
})
