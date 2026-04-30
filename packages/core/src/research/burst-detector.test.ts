import { describe, it, expect, vi, beforeEach } from 'vitest'
import { BurstDetector } from './burst-detector.js'

interface Stub {
  alert: ReturnType<typeof vi.fn>
  pauseGlobal: ReturnType<typeof vi.fn>
  isPausedGlobally: ReturnType<typeof vi.fn>
}

function makeStub(opts: { alreadyPaused?: boolean } = {}): Stub {
  return {
    alert: vi.fn(),
    pauseGlobal: vi.fn(),
    isPausedGlobally: vi.fn(() => opts.alreadyPaused ?? false),
  }
}

describe('BurstDetector', () => {
  let stub: Stub
  let detector: BurstDetector
  const NOW = Date.parse('2026-04-30T12:00:00Z')

  beforeEach(() => {
    stub = makeStub()
    detector = new BurstDetector({
      threshold: 3,
      windowMs: 10 * 60_000,
      alert: stub.alert as unknown as (e: { kind: string; affected: string[]; reason: string }) => void,
      pauseGlobal: stub.pauseGlobal as unknown as (reason: string) => void,
      isPausedGlobally: stub.isPausedGlobally as unknown as () => boolean,
    })
  })

  it('does not trigger below threshold', () => {
    detector.observeQuarantine('551111', NOW)
    detector.observeQuarantine('552222', NOW + 1_000)
    expect(stub.pauseGlobal).not.toHaveBeenCalled()
    expect(stub.alert).not.toHaveBeenCalled()
  })

  it('triggers fleet-wide pause at threshold within window', () => {
    detector.observeQuarantine('551111', NOW)
    detector.observeQuarantine('552222', NOW + 60_000)
    detector.observeQuarantine('553333', NOW + 120_000)
    expect(stub.pauseGlobal).toHaveBeenCalledTimes(1)
    expect(stub.alert).toHaveBeenCalledTimes(1)
    const payload = stub.alert.mock.calls[0][0] as { kind: string; affected: string[] }
    expect(payload.kind).toBe('fleet_burst')
    expect(payload.affected.sort()).toEqual(['551111', '552222', '553333'])
  })

  it('expires events outside window', () => {
    detector.observeQuarantine('551111', NOW)
    detector.observeQuarantine('552222', NOW + 1_000)
    detector.observeQuarantine('553333', NOW + 11 * 60_000)
    expect(stub.pauseGlobal).not.toHaveBeenCalled()
  })

  it('dedups by sender (same sender quarantining twice does not double-count)', () => {
    detector.observeQuarantine('551111', NOW)
    detector.observeQuarantine('551111', NOW + 30_000)
    detector.observeQuarantine('552222', NOW + 60_000)
    expect(stub.pauseGlobal).not.toHaveBeenCalled()
  })

  it('does not re-trigger when already globally paused', () => {
    stub.isPausedGlobally.mockReturnValue(true)
    detector.observeQuarantine('551111', NOW)
    detector.observeQuarantine('552222', NOW + 30_000)
    detector.observeQuarantine('553333', NOW + 60_000)
    expect(stub.pauseGlobal).not.toHaveBeenCalled()
    expect(stub.alert).not.toHaveBeenCalled()
  })

  it('reset clears pending events', () => {
    detector.observeQuarantine('551111', NOW)
    detector.observeQuarantine('552222', NOW + 30_000)
    detector.reset()
    detector.observeQuarantine('553333', NOW + 60_000)
    expect(stub.pauseGlobal).not.toHaveBeenCalled()
  })
})
