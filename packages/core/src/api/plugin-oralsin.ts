import type { FastifyInstance } from 'fastify'
import type Database from 'better-sqlite3'

// ── Types ──

export interface OralsinOverview {
  totalToday: number
  sentToday: number
  failedToday: number
  pendingNow: number
  deliveredToday: number
  readToday: number
  avgLatencyMs: number
  fallbackRate: number
  failedCallbacks: number
  hourly: OralsinHourlyBucket[]
}

export interface OralsinHourlyBucket {
  hour: number
  sent: number
  failed: number
}

export interface OralsinMessage {
  id: string
  toNumber: string
  body: string
  senderNumber: string | null
  status: string
  priority: number
  attempts: number
  fallbackUsed: boolean
  fallbackProvider: string | null
  correlationId: string | null
  context: Record<string, unknown> | null
  idempotencyKey: string
  wahaMessageId: string | null
  delivered: boolean
  read: boolean
  screenshotPath: string | null
  createdAt: string
  updatedAt: string
}

export interface OralsinMessagesResult {
  data: OralsinMessage[]
  total: number
}

export interface OralsinSenderStat {
  phoneNumber: string
  profileId: number
  deviceSerial: string
  wahaSession: string | null
  active: boolean
  total: number
  sent: number
  failed: number
  lastSentAt: string | null
  avgLatencyMs: number
}

export interface OralsinCallbackLogEntry {
  id: string
  pluginName: string
  messageId: string
  callbackType: string
  attempts: number
  lastError: string
  createdAt: string
  lastAttemptAt: string
}

// ── Today's ISO cutoff ──

function todayStartIso(): string {
  const d = new Date()
  d.setUTCHours(0, 0, 0, 0)
  return d.toISOString()
}

// ── Stats Builder (exported for testability) ──

export function buildOralsinStats(db: Database.Database) {
  function overview(): OralsinOverview {
    const todayStart = todayStartIso()

    // Main KPIs from messages table
    const kpiRow = db.prepare(`
      SELECT
        COUNT(*) FILTER (WHERE created_at >= ?) AS total_today,
        COUNT(*) FILTER (WHERE status = 'sent' AND created_at >= ?) AS sent_today,
        COUNT(*) FILTER (WHERE status IN ('failed', 'permanently_failed') AND created_at >= ?) AS failed_today,
        COUNT(*) FILTER (WHERE status IN ('queued', 'locked', 'sending')) AS pending_now,
        COUNT(*) FILTER (WHERE fallback_used = 1 AND created_at >= ?) AS fallback_count_today,
        AVG(
          CASE WHEN status = 'sent' AND created_at >= ?
            THEN (julianday(updated_at) - julianday(created_at)) * 86400000
            ELSE NULL
          END
        ) AS avg_latency_ms
      FROM messages
      WHERE plugin_name = 'oralsin'
    `).get(todayStart, todayStart, todayStart, todayStart, todayStart) as {
      total_today: number
      sent_today: number
      failed_today: number
      pending_now: number
      fallback_count_today: number
      avg_latency_ms: number | null
    }

    // Fallback rate: % of today's messages that used WAHA fallback
    const fallbackRate = kpiRow.total_today > 0
      ? (kpiRow.fallback_count_today / kpiRow.total_today) * 100
      : 0

    // Delivered and read counts via pending_correlations JOIN messages
    const correlRow = db.prepare(`
      SELECT
        COUNT(*) FILTER (WHERE pc.delivered_emitted = 1) AS delivered_today,
        COUNT(*) FILTER (WHERE pc.read_emitted = 1) AS read_today
      FROM pending_correlations pc
      INNER JOIN messages m ON m.id = pc.message_id
      WHERE m.plugin_name = 'oralsin'
        AND m.created_at >= ?
    `).get(todayStart) as {
      delivered_today: number
      read_today: number
    }

    // Failed callbacks count
    const cbRow = db.prepare(`
      SELECT COUNT(*) AS failed_callbacks
      FROM failed_callbacks
      WHERE plugin_name = 'oralsin'
    `).get() as { failed_callbacks: number }

    // Hourly buckets for today
    const hourlyRows = db.prepare(`
      SELECT
        CAST(strftime('%H', created_at) AS INTEGER) AS hour,
        COUNT(*) FILTER (WHERE status = 'sent') AS sent,
        COUNT(*) FILTER (WHERE status IN ('failed', 'permanently_failed')) AS failed
      FROM messages
      WHERE plugin_name = 'oralsin'
        AND created_at >= ?
      GROUP BY hour
    `).all(todayStart) as { hour: number; sent: number; failed: number }[]

    const hourMap = new Map<number, OralsinHourlyBucket>()
    for (let h = 0; h < 24; h++) {
      hourMap.set(h, { hour: h, sent: 0, failed: 0 })
    }
    for (const row of hourlyRows) {
      hourMap.set(row.hour, { hour: row.hour, sent: row.sent, failed: row.failed })
    }
    const hourly = Array.from(hourMap.values()).sort((a, b) => a.hour - b.hour)

    return {
      totalToday: kpiRow.total_today,
      sentToday: kpiRow.sent_today,
      failedToday: kpiRow.failed_today,
      pendingNow: kpiRow.pending_now,
      deliveredToday: correlRow.delivered_today,
      readToday: correlRow.read_today,
      avgLatencyMs: Math.round(kpiRow.avg_latency_ms ?? 0),
      fallbackRate: Math.round(fallbackRate * 100) / 100,
      failedCallbacks: cbRow.failed_callbacks,
      hourly,
    }
  }

  function messages(params: { limit?: number; offset?: number; status?: string } = {}): OralsinMessagesResult {
    const limit = params.limit ?? 50
    const offset = params.offset ?? 0

    const conditions = ["m.plugin_name = 'oralsin'"]
    const countConditions = ["plugin_name = 'oralsin'"]
    const queryParams: unknown[] = []
    const countParams: unknown[] = []

    if (params.status) {
      conditions.push('m.status = ?')
      countConditions.push('status = ?')
      queryParams.push(params.status)
      countParams.push(params.status)
    }

    const where = conditions.join(' AND ')
    const countWhere = countConditions.join(' AND ')

    const countRow = db.prepare(
      `SELECT COUNT(*) AS total FROM messages WHERE ${countWhere}`,
    ).get(...countParams) as { total: number }

    const rows = db.prepare(`
      SELECT
        m.id,
        m.to_number,
        m.body,
        m.sender_number,
        m.status,
        m.priority,
        m.attempts,
        m.fallback_used,
        m.fallback_provider,
        m.correlation_id,
        m.context,
        m.idempotency_key,
        m.waha_message_id,
        m.screenshot_path,
        m.created_at,
        m.updated_at,
        pc.delivered_emitted,
        pc.read_emitted
      FROM messages m
      LEFT JOIN pending_correlations pc ON pc.message_id = m.id
      WHERE ${where}
      ORDER BY m.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...queryParams, limit, offset) as Array<Record<string, unknown>>

    const data: OralsinMessage[] = rows.map((r) => {
      let context: Record<string, unknown> | null = null
      if (r.context && typeof r.context === 'string') {
        try { context = JSON.parse(r.context) as Record<string, unknown> } catch { /* malformed JSON — leave null */ }
      }

      return {
        id: r.id as string,
        toNumber: r.to_number as string,
        body: r.body as string,
        senderNumber: (r.sender_number as string) ?? null,
        status: r.status as string,
        priority: r.priority as number,
        attempts: r.attempts as number,
        fallbackUsed: (r.fallback_used as number) === 1,
        fallbackProvider: (r.fallback_provider as string) ?? null,
        correlationId: (r.correlation_id as string) ?? null,
        context,
        idempotencyKey: r.idempotency_key as string,
        wahaMessageId: (r.waha_message_id as string) ?? null,
        delivered: (r.delivered_emitted as number | null) === 1,
        read: (r.read_emitted as number | null) === 1,
        screenshotPath: (r.screenshot_path as string) ?? null,
        createdAt: r.created_at as string,
        updatedAt: r.updated_at as string,
      }
    })

    return { data, total: countRow.total }
  }

  function senderStats(): OralsinSenderStat[] {
    const rows = db.prepare(`
      SELECT
        sm.phone_number,
        sm.profile_id,
        sm.device_serial,
        sm.waha_session,
        sm.active,
        COUNT(m.id) AS total,
        COUNT(m.id) FILTER (WHERE m.status = 'sent') AS sent,
        COUNT(m.id) FILTER (WHERE m.status IN ('failed', 'permanently_failed')) AS failed,
        MAX(CASE WHEN m.status = 'sent' THEN m.updated_at ELSE NULL END) AS last_sent_at,
        AVG(
          CASE WHEN m.status = 'sent'
            THEN (julianday(m.updated_at) - julianday(m.created_at)) * 86400000
            ELSE NULL
          END
        ) AS avg_latency_ms
      FROM sender_mapping sm
      LEFT JOIN messages m
        ON m.sender_number = sm.phone_number
        AND m.plugin_name = 'oralsin'
      GROUP BY sm.phone_number
      ORDER BY sm.phone_number ASC
    `).all() as Array<Record<string, unknown>>

    return rows.map((r) => ({
      phoneNumber: r.phone_number as string,
      profileId: r.profile_id as number,
      deviceSerial: r.device_serial as string,
      wahaSession: (r.waha_session as string) ?? null,
      active: (r.active as number) === 1,
      total: (r.total as number) ?? 0,
      sent: (r.sent as number) ?? 0,
      failed: (r.failed as number) ?? 0,
      lastSentAt: (r.last_sent_at as string) ?? null,
      avgLatencyMs: Math.round((r.avg_latency_ms as number | null) ?? 0),
    }))
  }

  function callbackLog(): OralsinCallbackLogEntry[] {
    const rows = db.prepare(`
      SELECT id, plugin_name, message_id, callback_type, attempts, last_error, created_at, last_attempt_at
      FROM failed_callbacks
      WHERE plugin_name = 'oralsin'
      ORDER BY created_at DESC
    `).all() as Array<Record<string, unknown>>

    return rows.map((r) => ({
      id: r.id as string,
      pluginName: r.plugin_name as string,
      messageId: r.message_id as string,
      callbackType: r.callback_type as string,
      attempts: r.attempts as number,
      lastError: r.last_error as string,
      createdAt: r.created_at as string,
      lastAttemptAt: r.last_attempt_at as string,
    }))
  }

  return { overview, messages, senderStats, callbackLog }
}

// ── Route Registration ──

export function registerPluginOralsinRoutes(
  server: FastifyInstance,
  db: Database.Database,
): void {
  const stats = buildOralsinStats(db)

  server.get('/api/v1/monitoring/oralsin/overview', async () => {
    return stats.overview()
  })

  server.get('/api/v1/monitoring/oralsin/messages', async (request) => {
    const { limit, offset, status } = request.query as { limit?: string; offset?: string; status?: string }
    return stats.messages({
      limit: limit !== undefined ? Math.min(Math.max(Number(limit), 1), 200) : 50,
      offset: offset !== undefined ? Math.max(Number(offset), 0) : 0,
      status: status || undefined,
    })
  })

  server.get('/api/v1/monitoring/oralsin/senders', async () => {
    return stats.senderStats()
  })

  server.get('/api/v1/monitoring/oralsin/callbacks', async () => {
    return stats.callbackLog()
  })
}
