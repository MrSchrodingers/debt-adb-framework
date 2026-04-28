import { describe, it, expect, beforeEach } from 'vitest'
import Fastify from 'fastify'
import Database from 'better-sqlite3'
import { MessageQueue } from '../queue/message-queue.js'
import { AuditLogger } from '../config/audit-logger.js'
import { registerAdminMessageRoutes } from './admin-messages.js'

function buildServer() {
  const db = new Database(':memory:')
  const queue = new MessageQueue(db)
  queue.initialize()
  const auditLogger = new AuditLogger(db)

  const server = Fastify({ logger: false })
  registerAdminMessageRoutes(server, queue, auditLogger)
  return { server, queue, db, auditLogger }
}

describe('POST /api/v1/admin/messages/bulk-retry', () => {
  let ctx: ReturnType<typeof buildServer>

  beforeEach(() => {
    ctx = buildServer()
  })

  it('returns 400 when message_ids is empty', async () => {
    const res = await ctx.server.inject({
      method: 'POST',
      url: '/api/v1/admin/messages/bulk-retry',
      body: JSON.stringify({ message_ids: [] }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('returns 400 when more than 500 ids provided', async () => {
    const ids = Array.from({ length: 501 }, (_, i) => `id-${i}`)
    const res = await ctx.server.inject({
      method: 'POST',
      url: '/api/v1/admin/messages/bulk-retry',
      body: JSON.stringify({ message_ids: ids }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('500')
  })

  it('retries permanently_failed messages', async () => {
    const msg = ctx.queue.enqueue({
      to: '5511999990001',
      body: 'hello',
      idempotencyKey: 'ik-br-1',
    })
    // Move to permanently_failed
    ctx.queue.updateStatus(msg.id, 'queued', 'locked')
    ctx.queue.markPermanentlyFailed(msg.id)

    const res = await ctx.server.inject({
      method: 'POST',
      url: '/api/v1/admin/messages/bulk-retry',
      body: JSON.stringify({ message_ids: [msg.id] }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { retried: number; failed: unknown[]; skipped: string[] }
    expect(body.retried).toBe(1)
    expect(body.failed).toHaveLength(0)
    expect(body.skipped).toHaveLength(0)

    // Message should be queued now
    const updated = ctx.queue.getById(msg.id)
    expect(updated?.status).toBe('queued')
    expect(updated?.attempts).toBe(0) // replay resets attempts
  })

  it('skips sent messages (allowSent=false)', async () => {
    const msg = ctx.queue.enqueue({
      to: '5511999990002',
      body: 'hi',
      idempotencyKey: 'ik-br-2',
    })
    ctx.queue.updateStatus(msg.id, 'queued', 'locked')
    ctx.queue.updateStatus(msg.id, 'locked', 'sending')
    ctx.queue.updateStatus(msg.id, 'sending', 'sent')

    const res = await ctx.server.inject({
      method: 'POST',
      url: '/api/v1/admin/messages/bulk-retry',
      body: JSON.stringify({ message_ids: [msg.id] }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { retried: number; skipped: string[] }
    expect(body.retried).toBe(0)
    expect(body.skipped).toContain(msg.id)
  })

  it('puts not-found ids in failed list', async () => {
    const res = await ctx.server.inject({
      method: 'POST',
      url: '/api/v1/admin/messages/bulk-retry',
      body: JSON.stringify({ message_ids: ['no-such-id'] }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { failed: Array<{ id: string; reason: string }> }
    expect(body.failed).toHaveLength(1)
    expect(body.failed[0].id).toBe('no-such-id')
  })

  it('writes an audit log entry', async () => {
    const msg = ctx.queue.enqueue({
      to: '5511999990003',
      body: 'test',
      idempotencyKey: 'ik-br-3',
    })
    ctx.queue.updateStatus(msg.id, 'queued', 'locked')
    ctx.queue.markPermanentlyFailed(msg.id)

    await ctx.server.inject({
      method: 'POST',
      url: '/api/v1/admin/messages/bulk-retry',
      body: JSON.stringify({ message_ids: [msg.id] }),
      headers: { 'content-type': 'application/json' },
    })

    const auditResult = ctx.auditLogger.query({ action: 'bulk_retry' })
    expect(auditResult.entries.length).toBeGreaterThan(0)
    expect(auditResult.entries[0].action).toBe('bulk_retry')
  })
})
