import type { FastifyInstance } from 'fastify'
import type Database from 'better-sqlite3'

export interface HeatmapRow {
  sender: string
  label: string
  hours: number[] // 24 entries, index = UTC hour
}

export interface HeatmapResponse {
  rows: HeatmapRow[]
}

export interface ErrorHeatmapRow {
  signature: string
  hours: number[] // 24 entries
  examples: string[] // up to 3 message ids
}

export interface ErrorHeatmapResponse {
  rows: ErrorHeatmapRow[]
}

/**
 * Normalise an error string into a stable signature:
 * - truncate to 50 chars
 * - strip nano-id-like tokens (alphanum 10–26 chars with mixed case)
 * - strip ISO-8601 timestamps
 */
function normaliseError(raw: string): string {
  return raw
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.Z+-]+/g, '<ts>')
    .replace(/\b[a-zA-Z0-9_-]{10,26}\b/g, '<id>')
    .slice(0, 50)
    .trim()
}

export function getHeatmap(db: Database.Database, range: '24h' | '7d'): HeatmapResponse {
  const cutoffMs = range === '7d' ? 7 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000
  const cutoff = new Date(Date.now() - cutoffMs).toISOString()

  const rows = db.prepare(`
    SELECT
      sender_number,
      CAST(strftime('%H', sent_at) AS INTEGER) AS hour,
      COUNT(*) AS cnt
    FROM messages
    WHERE status = 'sent'
      AND sent_at IS NOT NULL
      AND sent_at >= ?
      AND sender_number IS NOT NULL
    GROUP BY sender_number, hour
  `).all(cutoff) as { sender_number: string; hour: number; cnt: number }[]

  // Build map: sender -> hours[24]
  const senderMap = new Map<string, number[]>()
  for (const r of rows) {
    if (!senderMap.has(r.sender_number)) {
      senderMap.set(r.sender_number, new Array(24).fill(0) as number[])
    }
    const arr = senderMap.get(r.sender_number)!
    arr[r.hour] = r.cnt
  }

  const result: HeatmapRow[] = []
  for (const [sender, hours] of senderMap) {
    const last4 = sender.slice(-4)
    result.push({ sender, label: `…${last4}`, hours })
  }

  return { rows: result }
}

export function getErrorHeatmap(db: Database.Database, range: '24h' | '7d'): ErrorHeatmapResponse {
  const cutoffMs = range === '7d' ? 7 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000
  const cutoff = new Date(Date.now() - cutoffMs).toISOString()

  // Failed messages with error from message_events
  const failedRows = db.prepare(`
    SELECT
      m.id,
      CAST(strftime('%H', m.updated_at) AS INTEGER) AS hour,
      me.metadata AS error_meta
    FROM messages m
    LEFT JOIN message_events me ON me.message_id = m.id AND me.event = 'send_failed'
    WHERE m.status IN ('failed', 'permanently_failed')
      AND m.updated_at >= ?
    ORDER BY m.updated_at DESC
  `).all(cutoff) as { id: string; hour: number; error_meta: string | null }[]

  // Also check failed_callbacks for errors (table may not exist yet)
  let cbRows: { id: string; hour: number; error_meta: string | null }[] = []
  try {
    cbRows = db.prepare(`
      SELECT
        id,
        CAST(strftime('%H', created_at) AS INTEGER) AS hour,
        last_error AS error_meta
      FROM failed_callbacks
      WHERE created_at >= ?
      ORDER BY created_at DESC
    `).all(cutoff) as { id: string; hour: number; error_meta: string | null }[]
  } catch {
    // Table doesn't exist or has no rows — ignore
  }

  // Build signature → hours[24] + examples
  const sigMap = new Map<string, { hours: number[]; examples: string[] }>()

  const processRow = (id: string, hour: number, rawError: string | null) => {
    const raw = rawError ? (() => {
      try {
        const parsed = JSON.parse(rawError) as { error?: string; message?: string }
        return parsed?.error ?? parsed?.message ?? rawError
      } catch {
        return rawError
      }
    })() : 'unknown_error'
    const sig = normaliseError(raw)
    if (!sigMap.has(sig)) {
      sigMap.set(sig, { hours: new Array(24).fill(0) as number[], examples: [] })
    }
    const entry = sigMap.get(sig)!
    entry.hours[hour] = (entry.hours[hour] ?? 0) + 1
    if (entry.examples.length < 3) entry.examples.push(id)
  }

  for (const r of failedRows) processRow(r.id, r.hour, r.error_meta)
  for (const r of cbRows) processRow(r.id, r.hour, r.error_meta)

  const result: ErrorHeatmapRow[] = []
  for (const [signature, data] of sigMap) {
    result.push({ signature, hours: data.hours, examples: data.examples })
  }

  return { rows: result }
}

export function registerInsightsHeatmapRoutes(
  server: FastifyInstance,
  db: Database.Database,
): void {
  server.get('/api/v1/insights/heatmap', async (request) => {
    const { range } = request.query as { range?: string }
    const r: '24h' | '7d' = range === '7d' ? '7d' : '24h'
    return getHeatmap(db, r)
  })

  server.get('/api/v1/insights/error-heatmap', async (request) => {
    const { range } = request.query as { range?: string }
    const r: '24h' | '7d' = range === '7d' ? '7d' : '24h'
    return getErrorHeatmap(db, r)
  })
}
