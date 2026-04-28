import type Database from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'

export interface AnomalyResult {
  active: boolean
  latency_30min_ms: number
  latency_24h_ms: number
  delta_pct: number
  started_at: string | null
}

/**
 * Compute rolling median latency for a window of sent messages.
 *
 * Latency = (julianday(updated_at) - julianday(created_at)) * 86400000 ms
 * Returns 0 if no rows match.
 */
function rollingMedian(db: Database.Database, cutoff: string): number {
  const rows = db.prepare(`
    SELECT
      (julianday(updated_at) - julianday(created_at)) * 86400000 AS latency_ms
    FROM messages
    WHERE status = 'sent'
      AND created_at >= ?
      AND updated_at IS NOT NULL
    ORDER BY latency_ms
  `).all(cutoff) as { latency_ms: number }[]

  if (rows.length === 0) return 0

  const mid = Math.floor(rows.length / 2)
  if (rows.length % 2 === 1) {
    return rows[mid]!.latency_ms
  }
  return (rows[mid - 1]!.latency_ms + rows[mid]!.latency_ms) / 2
}

/**
 * Threshold: if 30-minute median > 24-hour median by more than DELTA_THRESHOLD,
 * an anomaly is active.
 */
const DELTA_THRESHOLD = 0.30 // 30%

/** Minimum data points required before we trust the median values */
const MIN_DATA_POINTS = 3

export function detectAnomaly(db: Database.Database): AnomalyResult {
  const now = Date.now()
  const cutoff30min = new Date(now - 30 * 60 * 1000).toISOString()
  const cutoff24h = new Date(now - 24 * 60 * 60 * 1000).toISOString()

  const count30min = (db.prepare(
    `SELECT COUNT(*) AS cnt FROM messages WHERE status = 'sent' AND created_at >= ?`
  ).get(cutoff30min) as { cnt: number }).cnt

  const count24h = (db.prepare(
    `SELECT COUNT(*) AS cnt FROM messages WHERE status = 'sent' AND created_at >= ?`
  ).get(cutoff24h) as { cnt: number }).cnt

  if (count30min < MIN_DATA_POINTS || count24h < MIN_DATA_POINTS) {
    return {
      active: false,
      latency_30min_ms: 0,
      latency_24h_ms: 0,
      delta_pct: 0,
      started_at: null,
    }
  }

  const median30min = rollingMedian(db, cutoff30min)
  const median24h = rollingMedian(db, cutoff24h)

  if (median24h === 0) {
    return {
      active: false,
      latency_30min_ms: Math.round(median30min),
      latency_24h_ms: 0,
      delta_pct: 0,
      started_at: null,
    }
  }

  const deltaPct = (median30min - median24h) / median24h
  const active = deltaPct > DELTA_THRESHOLD

  // Estimate started_at: first sent message in 30min window that exceeds 24h median * (1 + threshold)
  let startedAt: string | null = null
  if (active) {
    const anomalyThresholdMs = median24h * (1 + DELTA_THRESHOLD)
    const firstAnomaly = db.prepare(`
      SELECT created_at
      FROM messages
      WHERE status = 'sent'
        AND created_at >= ?
        AND (julianday(updated_at) - julianday(created_at)) * 86400000 > ?
      ORDER BY created_at ASC
      LIMIT 1
    `).get(cutoff30min, anomalyThresholdMs) as { created_at: string } | undefined

    startedAt = firstAnomaly?.created_at ?? new Date(now - 30 * 60 * 1000).toISOString()
  }

  return {
    active,
    latency_30min_ms: Math.round(median30min),
    latency_24h_ms: Math.round(median24h),
    delta_pct: Math.round(deltaPct * 1000) / 10, // 1 decimal place
    started_at: startedAt,
  }
}

export function registerAnomalyRoutes(
  server: FastifyInstance,
  db: Database.Database,
): void {
  server.get('/api/v1/anomalies/current', async () => {
    return detectAnomaly(db)
  })
}
