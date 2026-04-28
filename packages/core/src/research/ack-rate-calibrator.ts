/**
 * WAHA ack-rate calibrator.
 *
 * Replaces the original Frida-based method-counting calibration that was
 * blocked on the POCO C71 stack (Magisk 28.1 Zygisk regressions, no public
 * Zygisk-Frida reports on Unisoc T603, DenyList conflict between
 * Zygisk-Assistant and ZygiskFrida — see ADR 0001 / project memory
 * `project_ban_prediction_pivot.md`).
 *
 * Signal: rate of `read_acks / sent_total` per sender per time window.
 * A healthy WhatsApp account sees most messages get ack=3 (read) within
 * minutes / hours; a shadowbanned account sees ack=1 (sent to WAHA) but
 * recipients never receive — so `read_acks/sent_total` collapses.
 *
 * Output: P{percentile} of the per-window read-ratio distribution becomes
 * the recommended ban-prediction threshold. Pair with confidence score
 * (sample size + variance) to know whether the threshold can be trusted.
 */

export interface AckEvent {
  wahaMessageId: string
  ackLevel: number
  observedAt: number // ms since epoch
  senderPhone: string | null
}

export interface CalibrationInput {
  events: AckEvent[]
  windowMs: number
  minSampleSize: number
  percentile: number
}

export interface SenderCalibration {
  windowMs: number
  totalSent: number
  totalDelivered: number
  totalRead: number
  deliveryRatio: number
  readRatio: number
  recommendedThreshold: number
  sampleWindows: number
  confidence: number
  warnings: string[]
}

export interface CalibrationOutput {
  perSender: Map<string, SenderCalibration>
  globalWarnings: string[]
}

export function calibrateAckRate(input: CalibrationInput): CalibrationOutput {
  const { events, windowMs, minSampleSize, percentile } = input

  if (windowMs <= 0) {
    throw new Error(`windowMs must be > 0, got ${windowMs}`)
  }
  if (percentile <= 0 || percentile >= 1) {
    throw new Error(`percentile must be in (0, 1), got ${percentile}`)
  }

  const globalWarnings: string[] = []
  if (events.length === 0) {
    globalWarnings.push('No ack events provided — calibration cannot run.')
    return { perSender: new Map(), globalWarnings }
  }

  // Group events by sender, skipping NULL-sender (orphan) rows.
  const eventsBySender = new Map<string, AckEvent[]>()
  for (const e of events) {
    if (e.senderPhone === null) continue
    const list = eventsBySender.get(e.senderPhone) ?? []
    list.push(e)
    eventsBySender.set(e.senderPhone, list)
  }

  if (eventsBySender.size === 0) {
    globalWarnings.push(
      'All events have NULL sender_phone — no per-sender calibration possible. ' +
        'Verify that message_history is being populated before acks arrive.',
    )
  }

  const perSender = new Map<string, SenderCalibration>()
  let anySenderHasEnoughData = false

  for (const [sender, senderEvents] of eventsBySender.entries()) {
    const stats = computeSenderStats(sender, senderEvents, windowMs, minSampleSize, percentile)
    perSender.set(sender, stats)
    if (stats.sampleWindows >= minSampleSize) {
      anySenderHasEnoughData = true
    }
  }

  if (perSender.size > 0 && !anySenderHasEnoughData) {
    globalWarnings.push(
      `No sender has reached the minimum sample size of ${minSampleSize} windows. ` +
        'Calibration recommendations are LOW CONFIDENCE; collect more data before applying.',
    )
  }

  return { perSender, globalWarnings }
}

interface PerMessageState {
  sent: boolean
  delivered: boolean
  read: boolean
  /** Bucket index of the *first* ack we observed (used to avoid splitting one msg across buckets). */
  bucket: number
}

function computeSenderStats(
  sender: string,
  events: AckEvent[],
  windowMs: number,
  minSampleSize: number,
  percentile: number,
): SenderCalibration {
  // Per-message state, keyed by waha_message_id, so multiple ack levels of the
  // same message collapse to a single entry.
  const messages = new Map<string, PerMessageState>()
  for (const e of events) {
    const bucket = Math.floor(e.observedAt / windowMs)
    const state = messages.get(e.wahaMessageId) ?? {
      sent: false,
      delivered: false,
      read: false,
      bucket,
    }
    if (e.ackLevel >= 1) state.sent = true
    if (e.ackLevel >= 2) state.delivered = true
    if (e.ackLevel >= 3) state.read = true
    messages.set(e.wahaMessageId, state)
  }

  // Bucket aggregation: sent/delivered/read counts per window.
  const buckets = new Map<number, { sent: number; delivered: number; read: number }>()
  let totalSent = 0
  let totalDelivered = 0
  let totalRead = 0

  for (const state of messages.values()) {
    if (!state.sent) continue
    totalSent++
    if (state.delivered) totalDelivered++
    if (state.read) totalRead++

    const b = buckets.get(state.bucket) ?? { sent: 0, delivered: 0, read: 0 }
    b.sent++
    if (state.delivered) b.delivered++
    if (state.read) b.read++
    buckets.set(state.bucket, b)
  }

  const sampleWindows = buckets.size

  // Overall ratios across the entire range.
  const deliveryRatio = totalSent > 0 ? totalDelivered / totalSent : 0
  const readRatio = totalSent > 0 ? totalRead / totalSent : 0

  // Per-window read ratios → P{percentile} → recommended threshold.
  const perWindowReadRatios: number[] = []
  for (const b of buckets.values()) {
    if (b.sent === 0) continue
    perWindowReadRatios.push(b.read / b.sent)
  }
  const recommendedThreshold = computePercentile(perWindowReadRatios, percentile)

  // Confidence: scales with sample size, penalised by variance.
  // Bounded in [0, 1].
  const sampleFactor = Math.min(1, sampleWindows / 30)
  const variance = computeVariance(perWindowReadRatios)
  // Variance of [0,1] ratios is at most 0.25 (Bernoulli max). Normalize.
  const normalizedVariance = Math.min(1, variance / 0.25)
  const confidence = Math.max(0, sampleFactor * (1 - normalizedVariance))

  const warnings: string[] = []
  if (sampleWindows < minSampleSize) {
    warnings.push(
      `Sparse sample for ${sender}: ${sampleWindows} window(s) < minSampleSize=${minSampleSize}. ` +
        'Threshold is provisional.',
    )
  }
  if (totalSent < 50) {
    warnings.push(
      `Low absolute volume for ${sender}: ${totalSent} message(s). Calibration may not be representative.`,
    )
  }
  if (variance > 0.05 && sampleWindows >= minSampleSize) {
    warnings.push(
      `High variance (${variance.toFixed(3)}) in per-window read ratios for ${sender}. ` +
        'Distribution is unstable — investigate before applying threshold.',
    )
  }

  return {
    windowMs,
    totalSent,
    totalDelivered,
    totalRead,
    deliveryRatio,
    readRatio,
    recommendedThreshold,
    sampleWindows,
    confidence,
    warnings,
  }
}

/**
 * Linear-interpolation percentile (R type 7, the default in numpy / pandas).
 * Returns 0 for an empty input.
 */
function computePercentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = (sorted.length - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]
  const frac = idx - lo
  return sorted[lo] * (1 - frac) + sorted[hi] * frac
}

function computeVariance(values: number[]): number {
  if (values.length === 0) return 0
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const sqDiff = values.reduce((acc, v) => acc + (v - mean) ** 2, 0)
  return sqDiff / values.length
}
