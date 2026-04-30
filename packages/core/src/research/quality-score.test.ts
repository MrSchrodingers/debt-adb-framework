import { describe, it, expect } from 'vitest'
import { computeQualityScore, type QualityScoreInputs } from './quality-score.js'

const baseInputs: QualityScoreInputs = {
  ackReadRatio: 0.9,
  ackFleetMedianReadRatio: 0.85,
  daysSinceLastBan: null,
  accountAgeDays: 120,
  warmupTier: 4,
  warmupTierMax: 4,
  volumeToday: 100,
  volumeDailyCap: 100,
  daysSinceFingerprintRotation: 7,
  fingerprintTtlDays: 30,
  inboundLast7d: 50,
  outboundLast7d: 200,
}

describe('computeQualityScore', () => {
  it('returns 0..100 integer total score', () => {
    const r = computeQualityScore(baseInputs)
    expect(r.total).toBeGreaterThanOrEqual(0)
    expect(r.total).toBeLessThanOrEqual(100)
    expect(Number.isInteger(r.total)).toBe(true)
  })

  it('returns components matching weighted formula', () => {
    const r = computeQualityScore(baseInputs)
    const sum =
      0.30 * r.components.ackRate +
      0.20 * r.components.banHistory +
      0.15 * r.components.age +
      0.10 * r.components.warmupCompletion +
      0.10 * r.components.volumeFit +
      0.10 * r.components.fingerprintFreshness +
      0.05 * r.components.recipientResponse
    expect(Math.round(sum * 100)).toBe(r.total)
  })

  it('healthy mature sender scores >= 70', () => {
    const r = computeQualityScore({
      ...baseInputs,
      ackReadRatio: 0.95,
      ackFleetMedianReadRatio: 0.85,
      daysSinceLastBan: 365,
      accountAgeDays: 365,
      warmupTier: 4,
      volumeToday: 80,
      volumeDailyCap: 100,
      daysSinceFingerprintRotation: 1,
      inboundLast7d: 80,
      outboundLast7d: 200,
    })
    expect(r.total).toBeGreaterThanOrEqual(70)
  })

  it('recently banned sender scores below 40', () => {
    const r = computeQualityScore({
      ...baseInputs,
      daysSinceLastBan: 1,
      accountAgeDays: 5,
      warmupTier: 1,
      ackReadRatio: 0.2,
    })
    expect(r.total).toBeLessThan(40)
  })

  it('null daysSinceLastBan treated as never banned (max banHistory)', () => {
    const r = computeQualityScore({ ...baseInputs, daysSinceLastBan: null })
    expect(r.components.banHistory).toBeCloseTo(1, 5)
  })

  it('volumeFit gaussian peaks at cap, drops at 2x and 0.1x', () => {
    const peak = computeQualityScore({ ...baseInputs, volumeToday: 100, volumeDailyCap: 100 })
    const over = computeQualityScore({ ...baseInputs, volumeToday: 200, volumeDailyCap: 100 })
    const under = computeQualityScore({ ...baseInputs, volumeToday: 10, volumeDailyCap: 100 })
    expect(peak.components.volumeFit).toBeGreaterThan(over.components.volumeFit)
    expect(peak.components.volumeFit).toBeGreaterThan(under.components.volumeFit)
  })

  it('fingerprintFreshness saturates to 0 when stale beyond TTL', () => {
    const r = computeQualityScore({ ...baseInputs, daysSinceFingerprintRotation: 60, fingerprintTtlDays: 30 })
    expect(r.components.fingerprintFreshness).toBe(0)
  })

  it('fingerprintFreshness = 1 when rotated today', () => {
    const r = computeQualityScore({ ...baseInputs, daysSinceFingerprintRotation: 0, fingerprintTtlDays: 30 })
    expect(r.components.fingerprintFreshness).toBe(1)
  })

  it('recipientResponse clamps to 1.0 even when inbound > outbound', () => {
    const r = computeQualityScore({ ...baseInputs, inboundLast7d: 500, outboundLast7d: 100 })
    expect(r.components.recipientResponse).toBe(1)
  })

  it('recipientResponse = 0 when no outbound in window', () => {
    const r = computeQualityScore({ ...baseInputs, inboundLast7d: 0, outboundLast7d: 0 })
    expect(r.components.recipientResponse).toBe(0)
  })

  it('warmupCompletion = tier/tierMax', () => {
    const r1 = computeQualityScore({ ...baseInputs, warmupTier: 1, warmupTierMax: 4 })
    expect(r1.components.warmupCompletion).toBeCloseTo(0.25, 5)
    const r4 = computeQualityScore({ ...baseInputs, warmupTier: 4, warmupTierMax: 4 })
    expect(r4.components.warmupCompletion).toBe(1)
  })

  it('ackRate normalized vs fleet median: above-median caps at 1, below-median scales linearly', () => {
    const above = computeQualityScore({ ...baseInputs, ackReadRatio: 0.95, ackFleetMedianReadRatio: 0.85 })
    const at = computeQualityScore({ ...baseInputs, ackReadRatio: 0.85, ackFleetMedianReadRatio: 0.85 })
    const below = computeQualityScore({ ...baseInputs, ackReadRatio: 0.425, ackFleetMedianReadRatio: 0.85 })
    expect(above.components.ackRate).toBe(1)
    expect(at.components.ackRate).toBe(1)
    expect(below.components.ackRate).toBeCloseTo(0.5, 2)
  })

  it('ackRate = 0 when fleet median = 0 and read ratio = 0 (degenerate fleet)', () => {
    const r = computeQualityScore({ ...baseInputs, ackReadRatio: 0, ackFleetMedianReadRatio: 0 })
    expect(r.components.ackRate).toBe(0)
  })

  it('all-zero inputs produce minimum score', () => {
    const r = computeQualityScore({
      ackReadRatio: 0,
      ackFleetMedianReadRatio: 0.85,
      daysSinceLastBan: 0,
      accountAgeDays: 0,
      warmupTier: 0,
      warmupTierMax: 4,
      volumeToday: 0,
      volumeDailyCap: 100,
      daysSinceFingerprintRotation: 365,
      fingerprintTtlDays: 30,
      inboundLast7d: 0,
      outboundLast7d: 0,
    })
    // Only volumeFit at 0 outbound is gaussian(0/100) — non-zero
    expect(r.total).toBeLessThan(20)
  })
})
