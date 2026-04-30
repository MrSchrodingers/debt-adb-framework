/**
 * Composite quality score per sender (0..100). Pure: no DB, no clock.
 *
 * Inputs are pre-computed by `quality-composer`. Weights are exported so the
 * UI can render component bars without redeclaring the formula.
 */

export interface QualityScoreInputs {
  /** P05 (or rolling avg) of read_acks/sent_total for this sender. */
  ackReadRatio: number
  /** Fleet-wide median read ratio at the same window — used as benchmark. */
  ackFleetMedianReadRatio: number
  /** Days since last ban event for this sender; null = never banned. */
  daysSinceLastBan: number | null
  /** Days since the WhatsApp account was first seen / acquired. */
  accountAgeDays: number
  /** Current warmup tier index (1..4). 0 = pre-activation. */
  warmupTier: number
  /** Highest tier defined in the warmup curve (used for normalization). */
  warmupTierMax: number
  /** Messages dispatched today via this sender. */
  volumeToday: number
  /** Effective daily cap for this sender (warmup-aware). */
  volumeDailyCap: number
  /** Days since fingerprint (IMEI/MAC/serial) was rotated for this chip. */
  daysSinceFingerprintRotation: number
  /** Rotation TTL — beyond this freshness drops to 0. */
  fingerprintTtlDays: number
  /** Incoming WhatsApp messages received by this sender in last 7d. */
  inboundLast7d: number
  /** Outgoing WhatsApp messages sent by this sender in last 7d. */
  outboundLast7d: number
}

export interface QualityScoreComponents {
  /** Read-rate normalized vs fleet median, clamped 0..1. */
  ackRate: number
  /** 1 - exp(-daysSinceLastBan / 30); 1 if never banned. */
  banHistory: number
  /** 1 - exp(-accountAgeDays / 90). */
  age: number
  /** warmupTier / warmupTierMax. */
  warmupCompletion: number
  /** Gaussian centered at dailyCap, sigma = cap/2. */
  volumeFit: number
  /** 1 - daysSinceFingerprintRotation / fingerprintTtlDays, clamped 0..1. */
  fingerprintFreshness: number
  /** inboundLast7d / outboundLast7d, clamped 0..1. */
  recipientResponse: number
}

export interface QualityScoreResult {
  total: number
  components: QualityScoreComponents
}

export const QUALITY_WEIGHTS = {
  ackRate: 0.30,
  banHistory: 0.20,
  age: 0.15,
  warmupCompletion: 0.10,
  volumeFit: 0.10,
  fingerprintFreshness: 0.10,
  recipientResponse: 0.05,
} as const

const WEIGHTS = QUALITY_WEIGHTS

export function computeQualityScore(input: QualityScoreInputs): QualityScoreResult {
  const components: QualityScoreComponents = {
    ackRate: ackRateScore(input.ackReadRatio, input.ackFleetMedianReadRatio),
    banHistory: banHistoryScore(input.daysSinceLastBan),
    age: ageScore(input.accountAgeDays),
    warmupCompletion: warmupScore(input.warmupTier, input.warmupTierMax),
    volumeFit: volumeFitScore(input.volumeToday, input.volumeDailyCap),
    fingerprintFreshness: fingerprintFreshnessScore(
      input.daysSinceFingerprintRotation,
      input.fingerprintTtlDays,
    ),
    recipientResponse: recipientResponseScore(input.inboundLast7d, input.outboundLast7d),
  }

  const weighted =
    WEIGHTS.ackRate * components.ackRate +
    WEIGHTS.banHistory * components.banHistory +
    WEIGHTS.age * components.age +
    WEIGHTS.warmupCompletion * components.warmupCompletion +
    WEIGHTS.volumeFit * components.volumeFit +
    WEIGHTS.fingerprintFreshness * components.fingerprintFreshness +
    WEIGHTS.recipientResponse * components.recipientResponse

  const total = clamp(0, 100, Math.round(weighted * 100))
  return { total, components }
}

function ackRateScore(readRatio: number, fleetMedian: number): number {
  if (fleetMedian <= 0) return clamp(0, 1, readRatio)
  return clamp(0, 1, readRatio / fleetMedian)
}

function banHistoryScore(daysSinceLastBan: number | null): number {
  if (daysSinceLastBan === null) return 1
  if (daysSinceLastBan < 0) return 0
  return 1 - Math.exp(-daysSinceLastBan / 30)
}

function ageScore(accountAgeDays: number): number {
  if (accountAgeDays <= 0) return 0
  return 1 - Math.exp(-accountAgeDays / 90)
}

function warmupScore(tier: number, tierMax: number): number {
  if (tierMax <= 0) return 0
  return clamp(0, 1, tier / tierMax)
}

function volumeFitScore(volumeToday: number, dailyCap: number): number {
  if (dailyCap <= 0) return 0
  const ratio = volumeToday / dailyCap
  // Gaussian centered at 1 (i.e. exact cap usage), sigma = 0.5.
  // At ratio=0.5 (under): exp(-0.5)=0.607
  // At ratio=2.0 (over):  exp(-2)=0.135
  const sigma = 0.5
  return Math.exp(-((ratio - 1) ** 2) / (2 * sigma * sigma))
}

function fingerprintFreshnessScore(daysSinceRotation: number, ttlDays: number): number {
  if (ttlDays <= 0) return 0
  if (daysSinceRotation < 0) return 1
  return clamp(0, 1, 1 - daysSinceRotation / ttlDays)
}

function recipientResponseScore(inbound: number, outbound: number): number {
  if (outbound <= 0) return 0
  return clamp(0, 1, inbound / outbound)
}

function clamp(min: number, max: number, value: number): number {
  if (value < min) return min
  if (value > max) return max
  return value
}
