import type { FastifyInstance } from 'fastify'
import type { MessageQueue } from '../queue/index.js'
import type Database from 'better-sqlite3'

export interface MessageEvent {
  id: number
  timestamp: string
  type: string
  metadata: Record<string, unknown> | null
}

export interface FailedCallback {
  id: number
  callbackType: string
  targetUrl: string
  statusCode: number | null
  lastAttemptAt: string
  createdAt: string
}

export interface MessageTimelineResponse {
  message: ReturnType<MessageQueue['getById']>
  events: MessageEvent[]
  screenshot: { url: string | null; code: string | null }
  failedCallbacks: FailedCallback[]
}

export function registerMessageTimelineRoutes(
  server: FastifyInstance,
  queue: MessageQueue,
  db: Database.Database,
): void {
  server.get('/api/v1/messages/:id/timeline', async (request, reply) => {
    const { id } = request.params as { id: string }

    const message = queue.getById(id)
    if (!message) {
      return reply.status(404).send({ error: 'Message not found' })
    }

    // Fetch message_events sorted ASC
    const eventRows = db.prepare(
      'SELECT id, created_at, event, metadata FROM message_events WHERE message_id = ? ORDER BY id ASC',
    ).all(id) as Array<{
      id: number
      created_at: string
      event: string
      metadata: string | null
    }>

    const events: MessageEvent[] = eventRows.map(row => ({
      id: row.id,
      timestamp: row.created_at,
      type: row.event,
      metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null,
    }))

    // Screenshot URL — if persisted and screenshotPath exists
    let screenshotUrl: string | null = null
    let screenshotCode: string | null = null

    if (message.screenshotPath) {
      screenshotUrl = `/api/v1/messages/${id}/screenshot`
      screenshotCode = message.screenshotStatus ?? 'persisted'
    } else {
      screenshotCode = message.screenshotStatus ?? 'never_persisted'
    }

    // Fetch linked failed_callbacks for this message (if table exists)
    let failedCallbacks: FailedCallback[] = []
    try {
      const cbRows = db.prepare(
        `SELECT id, callback_type, target_url, last_status_code, last_attempt_at, created_at
         FROM failed_callbacks
         WHERE message_id = ?
         ORDER BY id ASC`,
      ).all(id) as Array<{
        id: number
        callback_type: string
        target_url: string
        last_status_code: number | null
        last_attempt_at: string
        created_at: string
      }>
      failedCallbacks = cbRows.map(row => ({
        id: row.id,
        callbackType: row.callback_type,
        targetUrl: row.target_url,
        statusCode: row.last_status_code,
        lastAttemptAt: row.last_attempt_at,
        createdAt: row.created_at,
      }))
    } catch {
      // failed_callbacks table may not exist in all environments
    }

    const response: MessageTimelineResponse = {
      message,
      events,
      screenshot: { url: screenshotUrl, code: screenshotCode },
      failedCallbacks,
    }

    return response
  })
}
