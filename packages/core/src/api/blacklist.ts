import type { FastifyInstance } from 'fastify'
import type Database from 'better-sqlite3'

interface BlacklistRow {
  phone_number: string
  reason: string
  detected_message: string | null
  detected_pattern: string | null
  source_session: string | null
  created_at: string
}

export function registerBlacklistRoutes(server: FastifyInstance, db: Database.Database): void {
  // List all blacklisted numbers
  server.get('/api/v1/blacklist', async (request) => {
    const query = request.query as { limit?: string; offset?: string }
    const limit = Number(query.limit) || 50
    const offset = Number(query.offset) || 0

    const rows = db.prepare(
      'SELECT * FROM blacklist ORDER BY created_at DESC LIMIT ? OFFSET ?',
    ).all(limit, offset) as BlacklistRow[]
    const countRow = db.prepare('SELECT COUNT(*) as cnt FROM blacklist').get() as { cnt: number }

    return {
      entries: rows.map((r) => ({
        phoneNumber: r.phone_number,
        reason: r.reason,
        detectedMessage: r.detected_message,
        detectedPattern: r.detected_pattern,
        sourceSession: r.source_session,
        createdAt: r.created_at,
      })),
      total: countRow.cnt,
    }
  })

  // Check if a phone is blacklisted
  server.get('/api/v1/blacklist/:phone', async (request, reply) => {
    const { phone } = request.params as { phone: string }
    const row = db.prepare(
      'SELECT * FROM blacklist WHERE phone_number = ?',
    ).get(phone) as BlacklistRow | undefined
    if (!row) return reply.status(404).send({ blacklisted: false })
    return {
      blacklisted: true,
      phoneNumber: row.phone_number,
      reason: row.reason,
      detectedMessage: row.detected_message,
      detectedPattern: row.detected_pattern,
      sourceSession: row.source_session,
      createdAt: row.created_at,
    }
  })

  // Manually add to blacklist
  server.post('/api/v1/blacklist', async (request, reply) => {
    const body = request.body as { phone_number: string; reason?: string }
    if (!body.phone_number) return reply.status(400).send({ error: 'phone_number required' })

    db.prepare(
      'INSERT OR IGNORE INTO blacklist (phone_number, reason) VALUES (?, ?)',
    ).run(body.phone_number, body.reason ?? 'manual')

    return reply.status(201).send({ phoneNumber: body.phone_number, blacklisted: true })
  })

  // Remove from blacklist
  server.delete('/api/v1/blacklist/:phone', async (request, reply) => {
    const { phone } = request.params as { phone: string }
    db.prepare('DELETE FROM blacklist WHERE phone_number = ?').run(phone)
    return reply.status(204).send()
  })
}
