import type { FastifyInstance } from 'fastify'
import type Database from 'better-sqlite3'

export interface MetricsSummary {
  successRate: number
  avgLatencyMs: number
  totalToday: number
  totalFailed: number
}

export interface HourlyBucket {
  hour: number
  sent: number
  failed: number
  queued: number
}

export interface StatusCounts {
  queued: number
  sending: number
  sent: number
  failed: number
}

export interface PluginCount {
  plugin: string
  count: number
}

export function getMetricsSummary(db: Database.Database): MetricsSummary {
  const todayStart = new Date()
  todayStart.setUTCHours(0, 0, 0, 0)
  const todayIso = todayStart.toISOString()

  const row = db.prepare(`
    SELECT
      COUNT(*) FILTER (WHERE status IN ('sent', 'failed', 'permanently_failed')) AS terminal_count,
      COUNT(*) FILTER (WHERE status = 'sent') AS sent_count,
      COUNT(*) FILTER (WHERE status IN ('failed', 'permanently_failed')) AS failed_count,
      COUNT(*) AS total_today
    FROM messages
    WHERE created_at >= ?
  `).get(todayIso) as {
    terminal_count: number
    sent_count: number
    failed_count: number
    total_today: number
  }

  const successRate = row.terminal_count > 0
    ? (row.sent_count / row.terminal_count) * 100
    : 0

  // Average latency: diff between created_at and updated_at for sent messages today
  const latencyRow = db.prepare(`
    SELECT AVG(
      (julianday(updated_at) - julianday(created_at)) * 86400000
    ) AS avg_ms
    FROM messages
    WHERE status = 'sent' AND created_at >= ?
  `).get(todayIso) as { avg_ms: number | null }

  return {
    successRate: Math.round(successRate * 100) / 100,
    avgLatencyMs: Math.round(latencyRow.avg_ms ?? 0),
    totalToday: row.total_today,
    totalFailed: row.failed_count,
  }
}

export function getMetricsHourly(db: Database.Database): HourlyBucket[] {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  const rows = db.prepare(`
    SELECT
      CAST(strftime('%H', created_at) AS INTEGER) AS hour,
      COUNT(*) FILTER (WHERE status = 'sent') AS sent,
      COUNT(*) FILTER (WHERE status IN ('failed', 'permanently_failed')) AS failed,
      COUNT(*) FILTER (WHERE status = 'queued') AS queued
    FROM messages
    WHERE created_at >= ?
    GROUP BY hour
  `).all(cutoff) as { hour: number; sent: number; failed: number; queued: number }[]

  // Build full 24-hour array with zeros for missing hours
  const hourMap = new Map<number, HourlyBucket>()
  for (let h = 0; h < 24; h++) {
    hourMap.set(h, { hour: h, sent: 0, failed: 0, queued: 0 })
  }
  for (const row of rows) {
    hourMap.set(row.hour, { hour: row.hour, sent: row.sent, failed: row.failed, queued: row.queued })
  }

  return Array.from(hourMap.values()).sort((a, b) => a.hour - b.hour)
}

export function getMetricsByStatus(db: Database.Database): StatusCounts {
  const row = db.prepare(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'queued') AS queued,
      COUNT(*) FILTER (WHERE status IN ('sending', 'locked')) AS sending,
      COUNT(*) FILTER (WHERE status = 'sent') AS sent,
      COUNT(*) FILTER (WHERE status IN ('failed', 'permanently_failed')) AS failed
    FROM messages
  `).get() as { queued: number; sending: number; sent: number; failed: number }

  return {
    queued: row.queued,
    sending: row.sending,
    sent: row.sent,
    failed: row.failed,
  }
}

export function getMetricsByPlugin(db: Database.Database): PluginCount[] {
  const rows = db.prepare(`
    SELECT plugin_name AS plugin, COUNT(*) AS count
    FROM messages
    WHERE plugin_name IS NOT NULL
    GROUP BY plugin_name
    ORDER BY count DESC
  `).all() as { plugin: string; count: number }[]

  return rows
}

export function registerMetricsRoutes(
  server: FastifyInstance,
  db: Database.Database,
): void {
  server.get('/api/v1/metrics/summary', async () => {
    return getMetricsSummary(db)
  })

  server.get('/api/v1/metrics/hourly', async () => {
    return getMetricsHourly(db)
  })

  server.get('/api/v1/metrics/by-status', async () => {
    return getMetricsByStatus(db)
  })

  server.get('/api/v1/metrics/by-plugin', async () => {
    return getMetricsByPlugin(db)
  })
}
