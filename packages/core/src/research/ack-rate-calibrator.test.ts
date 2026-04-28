import { describe, it, expect } from 'vitest'
import { calibrateAckRate, type AckEvent } from './ack-rate-calibrator.js'

const HOUR_MS = 3_600_000

/**
 * Build a stream of healthy-looking ack events: every msg gets ack=3 (read).
 * Returns events spread evenly across the requested number of windows.
 */
function buildHealthyEvents(
  sender: string,
  windows: number,
  perWindow: number,
  startMs = 0,
): AckEvent[] {
  const events: AckEvent[] = []
  for (let w = 0; w < windows; w++) {
    for (let i = 0; i < perWindow; i++) {
      const id = `msg-${sender}-w${w}-i${i}`
      const baseTs = startMs + w * HOUR_MS + i * 1000
      // ackLevel 1 (sent) and 3 (read) — both observed
      events.push({
        wahaMessageId: id,
        ackLevel: 1,
        observedAt: baseTs,
        senderPhone: sender,
      })
      events.push({
        wahaMessageId: id,
        ackLevel: 3,
        observedAt: baseTs + 100,
        senderPhone: sender,
      })
    }
  }
  return events
}

/**
 * Build a stream where messages are accepted by WAHA (ack=1) but NEVER read
 * — the shadowban signature.
 */
function buildShadowbanEvents(
  sender: string,
  windows: number,
  perWindow: number,
  startMs = 0,
): AckEvent[] {
  const events: AckEvent[] = []
  for (let w = 0; w < windows; w++) {
    for (let i = 0; i < perWindow; i++) {
      const id = `msg-${sender}-w${w}-i${i}`
      const baseTs = startMs + w * HOUR_MS + i * 1000
      events.push({
        wahaMessageId: id,
        ackLevel: 1,
        observedAt: baseTs,
        senderPhone: sender,
      })
      // NO ack=3 — shadowban means no read receipts
    }
  }
  return events
}

describe('calibrateAckRate', () => {
  describe('healthy baseline', () => {
    it('reports a recommendedThreshold close to 1.0 when all messages are read', () => {
      const events = buildHealthyEvents('554300000001', 30, 10)

      const result = calibrateAckRate({
        events,
        windowMs: HOUR_MS,
        minSampleSize: 24,
        percentile: 0.05,
      })

      const stats = result.perSender.get('554300000001')
      expect(stats).toBeDefined()
      expect(stats!.totalSent).toBe(300) // 30 windows * 10 msgs
      expect(stats!.totalRead).toBe(300)
      expect(stats!.readRatio).toBeCloseTo(1.0, 2)
      // P05 of a perfectly healthy distribution → ~1.0
      expect(stats!.recommendedThreshold).toBeCloseTo(1.0, 2)
      expect(stats!.sampleWindows).toBe(30)
      expect(stats!.warnings).toHaveLength(0)
    })

    it('reports high confidence when sample is large and variance low', () => {
      const events = buildHealthyEvents('554300000002', 60, 10)
      const result = calibrateAckRate({
        events,
        windowMs: HOUR_MS,
        minSampleSize: 24,
        percentile: 0.05,
      })
      const stats = result.perSender.get('554300000002')!
      expect(stats.confidence).toBeGreaterThan(0.7)
    })
  })

  describe('shadowban scenario', () => {
    it('reports recommendedThreshold near 0 for sender that never gets read receipts', () => {
      const events = buildShadowbanEvents('554300000003', 30, 10)

      const result = calibrateAckRate({
        events,
        windowMs: HOUR_MS,
        minSampleSize: 24,
        percentile: 0.05,
      })

      const stats = result.perSender.get('554300000003')!
      expect(stats.totalSent).toBe(300)
      expect(stats.totalRead).toBe(0)
      expect(stats.readRatio).toBe(0)
      expect(stats.recommendedThreshold).toBe(0)
    })

    it('separates healthy and shadowbanned senders in the same dataset', () => {
      const events = [
        ...buildHealthyEvents('554300000004', 30, 10),
        ...buildShadowbanEvents('554300000005', 30, 10),
      ]

      const result = calibrateAckRate({
        events,
        windowMs: HOUR_MS,
        minSampleSize: 24,
        percentile: 0.05,
      })

      expect(result.perSender.get('554300000004')!.recommendedThreshold).toBeGreaterThan(0.9)
      expect(result.perSender.get('554300000005')!.recommendedThreshold).toBe(0)
    })
  })

  describe('sparse data', () => {
    it('warns when sample windows are below minSampleSize', () => {
      const events = buildHealthyEvents('554300000006', 5, 10) // only 5 windows

      const result = calibrateAckRate({
        events,
        windowMs: HOUR_MS,
        minSampleSize: 24,
        percentile: 0.05,
      })

      const stats = result.perSender.get('554300000006')!
      expect(stats.sampleWindows).toBe(5)
      expect(stats.warnings.length).toBeGreaterThan(0)
      expect(stats.warnings.some((w) => /sparse|insufficient|sample/i.test(w))).toBe(true)
      // Confidence should be low
      expect(stats.confidence).toBeLessThan(0.5)
    })

    it('emits global warning when no sender has enough data', () => {
      const events = buildHealthyEvents('554300000007', 3, 5)

      const result = calibrateAckRate({
        events,
        windowMs: HOUR_MS,
        minSampleSize: 24,
        percentile: 0.05,
      })

      expect(result.globalWarnings.length).toBeGreaterThan(0)
    })
  })

  describe('multi-sender', () => {
    it('computes independent per-sender stats for multiple senders', () => {
      const events = [
        ...buildHealthyEvents('554300001000', 30, 10),
        ...buildHealthyEvents('554300002000', 30, 5),
        ...buildShadowbanEvents('554300003000', 30, 8),
      ]

      const result = calibrateAckRate({
        events,
        windowMs: HOUR_MS,
        minSampleSize: 24,
        percentile: 0.05,
      })

      expect(result.perSender.size).toBe(3)
      expect(result.perSender.get('554300001000')!.totalSent).toBe(300)
      expect(result.perSender.get('554300002000')!.totalSent).toBe(150)
      expect(result.perSender.get('554300003000')!.totalSent).toBe(240)
    })
  })

  describe('NULL sender handling', () => {
    it('skips events with null senderPhone for per-sender stats', () => {
      const events: AckEvent[] = [
        ...buildHealthyEvents('554300004000', 30, 10),
        // Orphan ack — message_history was missing the join row
        { wahaMessageId: 'orphan-1', ackLevel: 1, observedAt: 1000, senderPhone: null },
        { wahaMessageId: 'orphan-1', ackLevel: 3, observedAt: 1100, senderPhone: null },
      ]

      const result = calibrateAckRate({
        events,
        windowMs: HOUR_MS,
        minSampleSize: 24,
        percentile: 0.05,
      })

      // Only one sender (the orphans are NOT counted as a separate sender)
      expect(result.perSender.size).toBe(1)
      expect(result.perSender.has('554300004000')).toBe(true)
    })
  })

  describe('delivery vs read ratios', () => {
    it('tracks delivery (ack>=2) and read (ack>=3) separately', () => {
      const events: AckEvent[] = []
      // 100 sent, 80 delivered, 40 read — partial-shadowban scenario
      for (let i = 0; i < 100; i++) {
        const id = `msg-${i}`
        const baseTs = (i % 30) * HOUR_MS + i * 100
        events.push({ wahaMessageId: id, ackLevel: 1, observedAt: baseTs, senderPhone: '554300005000' })
        if (i < 80) {
          events.push({ wahaMessageId: id, ackLevel: 2, observedAt: baseTs + 50, senderPhone: '554300005000' })
        }
        if (i < 40) {
          events.push({ wahaMessageId: id, ackLevel: 3, observedAt: baseTs + 100, senderPhone: '554300005000' })
        }
      }

      const result = calibrateAckRate({
        events,
        windowMs: HOUR_MS,
        minSampleSize: 24,
        percentile: 0.05,
      })

      const stats = result.perSender.get('554300005000')!
      expect(stats.totalSent).toBe(100)
      expect(stats.totalDelivered).toBe(80)
      expect(stats.totalRead).toBe(40)
      expect(stats.deliveryRatio).toBeGreaterThan(0)
      expect(stats.readRatio).toBeLessThan(stats.deliveryRatio)
    })
  })

  describe('input validation', () => {
    it('returns empty result for empty events', () => {
      const result = calibrateAckRate({
        events: [],
        windowMs: HOUR_MS,
        minSampleSize: 24,
        percentile: 0.05,
      })

      expect(result.perSender.size).toBe(0)
      expect(result.globalWarnings.length).toBeGreaterThan(0)
    })

    it('throws when windowMs <= 0', () => {
      expect(() =>
        calibrateAckRate({
          events: [],
          windowMs: 0,
          minSampleSize: 24,
          percentile: 0.05,
        }),
      ).toThrow()
    })

    it('throws when percentile is not in (0, 1)', () => {
      expect(() =>
        calibrateAckRate({
          events: [],
          windowMs: HOUR_MS,
          minSampleSize: 24,
          percentile: 0,
        }),
      ).toThrow()
      expect(() =>
        calibrateAckRate({
          events: [],
          windowMs: HOUR_MS,
          minSampleSize: 24,
          percentile: 1,
        }),
      ).toThrow()
    })
  })
})
