import { describe, it, expect, vi, beforeEach } from 'vitest'
import { BanPredictionDaemon, type SerialResolver, type ThresholdProvider } from './ban-prediction-daemon.js'
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

  describe('per-sender ack-rate threshold override', () => {
    function makeResolver(map: Record<string, string | null>): SerialResolver {
      return {
        resolveSenderForSerial: vi.fn((s: string) => map[s] ?? null),
      }
    }
    function makeProvider(
      map: Record<string, { threshold: number; windowMs: number } | null>,
    ): ThresholdProvider {
      return {
        getActiveThreshold: vi.fn((p: string) => map[p] ?? null),
      }
    }

    it('falls back to env-default suspect threshold when no override exists', () => {
      const emitter = makeEmitter()
      const cb = makeCircuitBreaker()
      const resolver = makeResolver({ 'device-A': '5511999' })
      const provider = makeProvider({ '5511999': null })
      const daemon = new BanPredictionDaemon(
        emitter,
        cb,
        { port: 9871, suspectThreshold: 3, windowMs: 60_000 },
        resolver,
        provider,
      )

      sendLine(daemon, suspectLine('device-A'))
      sendLine(daemon, suspectLine('device-A'))
      expect(cb.recordFailure).not.toHaveBeenCalled()

      sendLine(daemon, suspectLine('device-A'))
      expect(cb.recordFailure).toHaveBeenCalledOnce()
    })

    it('falls back to env-default when device has no sender mapping', () => {
      const emitter = makeEmitter()
      const cb = makeCircuitBreaker()
      const resolver = makeResolver({ 'device-A': null })
      const provider = makeProvider({})
      const daemon = new BanPredictionDaemon(
        emitter,
        cb,
        { port: 9871, suspectThreshold: 3, windowMs: 60_000 },
        resolver,
        provider,
      )

      sendLine(daemon, suspectLine('device-A'))
      sendLine(daemon, suspectLine('device-A'))
      expect(cb.recordFailure).not.toHaveBeenCalled()
      sendLine(daemon, suspectLine('device-A'))
      expect(cb.recordFailure).toHaveBeenCalledOnce()
    })

    it('uses override threshold to trip aggressively when ratio is high', () => {
      const emitter = makeEmitter()
      const cb = makeCircuitBreaker()
      const resolver = makeResolver({ 'device-A': '5511999' })
      // Ratio 0.9 → ceil(3 * (1 - 0.9)) = 1
      const provider = makeProvider({ '5511999': { threshold: 0.9, windowMs: 30_000 } })
      const daemon = new BanPredictionDaemon(
        emitter,
        cb,
        { port: 9871, suspectThreshold: 3, windowMs: 60_000 },
        resolver,
        provider,
      )

      sendLine(daemon, suspectLine('device-A'))
      expect(cb.recordFailure).toHaveBeenCalledOnce()
      // Override windowMs is propagated in the emitted event
      expect(emitter.emit).toHaveBeenCalledWith(
        'ban_prediction:triggered',
        expect.objectContaining({ windowMs: 30_000 }),
      )
    })

    it('honours override windowMs for the sliding window check', () => {
      const emitter = makeEmitter()
      const cb = makeCircuitBreaker()
      const resolver = makeResolver({ 'device-A': '5511999' })
      const provider = makeProvider({ '5511999': { threshold: 0.0, windowMs: 5_000 } })
      const daemon = new BanPredictionDaemon(
        emitter,
        cb,
        { port: 9871, suspectThreshold: 3, windowMs: 60_000 },
        resolver,
        provider,
      )

      const realNow = Date.now
      let fakeNow = 1_000_000
      try {
        vi.spyOn(Date, 'now').mockImplementation(() => fakeNow)
        sendLine(daemon, suspectLine('device-A'))
        sendLine(daemon, suspectLine('device-A'))
        // Advance past override window — older signals expire
        fakeNow += 5_001
        sendLine(daemon, suspectLine('device-A'))
        expect(cb.recordFailure).not.toHaveBeenCalled()
      } finally {
        vi.spyOn(Date, 'now').mockImplementation(realNow)
        vi.restoreAllMocks()
      }
    })

    it('floors the scaled count at 1 even when ratio is exactly 1.0', () => {
      const emitter = makeEmitter()
      const cb = makeCircuitBreaker()
      const resolver = makeResolver({ 'device-A': '5511999' })
      // Ratio 1.0 would naively scale to 0 — must floor at 1
      const provider = makeProvider({ '5511999': { threshold: 1.0, windowMs: 60_000 } })
      const daemon = new BanPredictionDaemon(
        emitter,
        cb,
        { port: 9871, suspectThreshold: 3, windowMs: 60_000 },
        resolver,
        provider,
      )

      sendLine(daemon, suspectLine('device-A'))
      expect(cb.recordFailure).toHaveBeenCalledOnce()
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
