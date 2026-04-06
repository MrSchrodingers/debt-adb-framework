import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type Database from 'better-sqlite3'

// ── Types ──

export interface AuditListItem {
  id: string
  source: 'queue' | 'history'
  direction: 'incoming' | 'outgoing'
  fromNumber: string | null
  toNumber: string | null
  text: string | null
  status: string | null
  capturedVia: string | null
  pluginName: string | null
  correlationId: string | null
  createdAt: string
}

export interface AuditListResult {
  items: AuditListItem[]
  total: number
  limit: number
  offset: number
}

export interface TimelineEvent {
  event: string
  timestamp: string
  detail: string | null
}

export interface AuditListParams {
  limit?: number
  offset?: number
  phone?: string
  dateFrom?: string
  dateTo?: string
  status?: string
  direction?: 'incoming' | 'outgoing'
  plugin?: string
}

// ── Service ──

export class AuditService {
  constructor(private readonly db: Database.Database) {}

  listCombined(params: AuditListParams = {}): AuditListResult {
    const limit = params.limit ?? 50
    const offset = params.offset ?? 0

    // Build a UNION query combining messages (queue) and message_history
    // messages are always "outgoing" (they are ADB send queue entries)
    const conditions: string[] = []
    const countConditions: string[] = []
    const values: unknown[] = []
    const countValues: unknown[] = []

    let unionSql = `
      SELECT
        id,
        'queue' AS source,
        'outgoing' AS direction,
        sender_number AS from_number,
        to_number,
        body AS text,
        status,
        NULL AS captured_via,
        plugin_name,
        correlation_id,
        created_at
      FROM messages
      {WHERE_Q}

      UNION ALL

      SELECT
        id,
        'history' AS source,
        direction,
        from_number,
        to_number,
        text,
        NULL AS status,
        captured_via,
        NULL AS plugin_name,
        NULL AS correlation_id,
        created_at
      FROM message_history
      {WHERE_H}
    `

    // Build WHERE clause for messages table
    const qConditions: string[] = []
    const qValues: unknown[] = []

    // Build WHERE clause for message_history table
    const hConditions: string[] = []
    const hValues: unknown[] = []

    if (params.phone) {
      const phoneLike = `%${params.phone}%`
      qConditions.push('(to_number LIKE ? OR sender_number LIKE ?)')
      qValues.push(phoneLike, phoneLike)
      hConditions.push('(from_number LIKE ? OR to_number LIKE ?)')
      hValues.push(phoneLike, phoneLike)
    }

    if (params.dateFrom) {
      qConditions.push('created_at >= ?')
      qValues.push(params.dateFrom)
      hConditions.push('created_at >= ?')
      hValues.push(params.dateFrom)
    }

    if (params.dateTo) {
      // Include the full day
      const toDate = params.dateTo.includes('T') ? params.dateTo : `${params.dateTo}T23:59:59.999Z`
      qConditions.push('created_at <= ?')
      qValues.push(toDate)
      hConditions.push('created_at <= ?')
      hValues.push(toDate)
    }

    if (params.status) {
      qConditions.push('status = ?')
      qValues.push(params.status)
      // History entries don't have status — exclude them when filtering by status
      hConditions.push('1 = 0')
    }

    if (params.direction) {
      if (params.direction === 'incoming') {
        // Queue messages are always outgoing — exclude them
        qConditions.push('1 = 0')
        hConditions.push("direction = 'incoming'")
      } else {
        // outgoing: include queue messages + outgoing history entries
        hConditions.push("direction = 'outgoing'")
      }
    }

    if (params.plugin) {
      qConditions.push('plugin_name = ?')
      qValues.push(params.plugin)
      // History entries don't have plugin_name — exclude them when filtering by plugin
      hConditions.push('1 = 0')
    }

    const whereQ = qConditions.length > 0 ? `WHERE ${qConditions.join(' AND ')}` : ''
    const whereH = hConditions.length > 0 ? `WHERE ${hConditions.join(' AND ')}` : ''

    unionSql = unionSql.replace('{WHERE_Q}', whereQ).replace('{WHERE_H}', whereH)

    const allValues = [...qValues, ...hValues]

    // Count total
    const countSql = `SELECT COUNT(*) AS total FROM (${unionSql})`
    const countRow = this.db.prepare(countSql).get(...allValues) as { total: number }

    // Fetch page
    const pageSql = `
      SELECT * FROM (${unionSql})
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `
    const rows = this.db.prepare(pageSql).all(...allValues, limit, offset) as Array<Record<string, unknown>>

    return {
      items: rows.map(r => ({
        id: r.id as string,
        source: r.source as 'queue' | 'history',
        direction: r.direction as 'incoming' | 'outgoing',
        fromNumber: r.from_number as string | null,
        toNumber: r.to_number as string | null,
        text: r.text as string | null,
        status: r.status as string | null,
        capturedVia: r.captured_via as string | null,
        pluginName: r.plugin_name as string | null,
        correlationId: r.correlation_id as string | null,
        createdAt: r.created_at as string,
      })),
      total: countRow.total,
      limit,
      offset,
    }
  }

  getTimeline(messageId: string): TimelineEvent[] {
    // First check if this message exists in the queue
    const msg = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId) as Record<string, unknown> | undefined
    if (!msg) return []

    const events: TimelineEvent[] = []

    // Queue message events based on current status and timestamps
    events.push({
      event: 'queued',
      timestamp: msg.created_at as string,
      detail: null,
    })

    const status = msg.status as string
    const updatedAt = msg.updated_at as string
    const lockedAt = msg.locked_at as string | null

    if (['locked', 'sending', 'sent', 'failed', 'permanently_failed'].includes(status)) {
      events.push({
        event: 'locked',
        timestamp: lockedAt ?? updatedAt,
        detail: msg.locked_by as string | null,
      })
    }

    if (['sending', 'sent', 'failed', 'permanently_failed'].includes(status) && status !== 'locked') {
      events.push({
        event: status === 'sending' ? 'sending' : (status === 'sent' ? 'sent' : status),
        timestamp: updatedAt,
        detail: null,
      })
    }

    // Fetch related message_history entries
    const historyRows = this.db.prepare(
      'SELECT * FROM message_history WHERE message_id = ? ORDER BY created_at ASC',
    ).all(messageId) as Array<Record<string, unknown>>

    for (const row of historyRows) {
      const capturedVia = row.captured_via as string
      if (capturedVia === 'adb_send') {
        events.push({
          event: 'adb_send',
          timestamp: row.created_at as string,
          detail: row.device_serial as string | null,
        })
      } else if (capturedVia === 'waha_webhook') {
        events.push({
          event: 'waha_captured',
          timestamp: row.created_at as string,
          detail: row.waha_message_id as string | null,
        })
      } else {
        events.push({
          event: capturedVia,
          timestamp: row.created_at as string,
          detail: null,
        })
      }
    }

    // Sort by timestamp chronologically, with logical order as tiebreaker
    // Normalize timestamps: messages table uses strftime('%Y-%m-%dT%H:%M:%fZ'),
    // message_history uses datetime('now') with space separator and no ms.
    // Truncate to seconds and normalize separator for fair comparison.
    const normalizeTs = (ts: string): string =>
      ts.replace(' ', 'T').replace(/\.\d+Z$/, 'Z').replace(/Z$/, '')
    const eventOrder: Record<string, number> = {
      queued: 0,
      locked: 1,
      sending: 2,
      adb_send: 3,
      sent: 4,
      waha_captured: 5,
      chatwoot_reply: 6,
      failed: 7,
      permanently_failed: 8,
    }
    events.sort((a, b) => {
      const timeDiff = normalizeTs(a.timestamp).localeCompare(normalizeTs(b.timestamp))
      if (timeDiff !== 0) return timeDiff
      return (eventOrder[a.event] ?? 99) - (eventOrder[b.event] ?? 99)
    })

    return events
  }
}

// ── Route Registration ──

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  phone: z.string().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  status: z.string().optional(),
  direction: z.enum(['incoming', 'outgoing']).optional(),
  plugin: z.string().optional(),
})

export function registerAuditRoutes(server: FastifyInstance, db: Database.Database): void {
  const audit = new AuditService(db)

  server.get('/api/v1/audit/messages', async (request) => {
    const query = request.query as Record<string, string>
    const parsed = querySchema.safeParse(query)
    if (!parsed.success) {
      return { items: [], total: 0, limit: 50, offset: 0 }
    }
    return audit.listCombined(parsed.data)
  })

  server.get('/api/v1/audit/messages/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const timeline = audit.getTimeline(id)
    if (timeline.length === 0) {
      return reply.status(404).send({ error: 'Message not found' })
    }
    return timeline
  })
}
