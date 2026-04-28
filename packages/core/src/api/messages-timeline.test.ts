import { describe, it, expect, beforeEach } from 'vitest'
import Fastify from 'fastify'
import Database from 'better-sqlite3'
import { MessageQueue } from '../queue/message-queue.js'
import { registerMessageTimelineRoutes } from './messages-timeline.js'

function buildServer() {
  const db = new Database(':memory:')
  const queue = new MessageQueue(db)
  queue.initialize()

  const server = Fastify({ logger: false })
  // Simple no-auth for tests
  registerMessageTimelineRoutes(server, queue, db)
  return { server, queue, db }
}

describe('GET /api/v1/messages/:id/timeline', () => {
  let ctx: ReturnType<typeof buildServer>

  beforeEach(() => {
    ctx = buildServer()
  })

  it('returns 404 for unknown message', async () => {
    const res = await ctx.server.inject({
      method: 'GET',
      url: '/api/v1/messages/no-such-id/timeline',
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ error: 'Message not found' })
  })

  it('returns correct shape for message with no events', async () => {
    const msg = ctx.queue.enqueue({
      to: '5511999990001',
      body: 'hello',
      idempotencyKey: 'ik-tl-1',
    })

    const res = await ctx.server.inject({
      method: 'GET',
      url: `/api/v1/messages/${msg.id}/timeline`,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      message: { id: string }
      events: unknown[]
      screenshot: { url: string | null; code: string | null }
      failedCallbacks: unknown[]
    }
    expect(body.message.id).toBe(msg.id)
    expect(Array.isArray(body.events)).toBe(true)
    expect(body.events).toHaveLength(0)
    expect(body.screenshot).toMatchObject({ url: null, code: expect.any(String) })
    expect(Array.isArray(body.failedCallbacks)).toBe(true)
  })

  it('returns events sorted ASC by id', async () => {
    const msg = ctx.queue.enqueue({
      to: '5511999990002',
      body: 'test',
      idempotencyKey: 'ik-tl-2',
    })

    // Insert events out of order
    ctx.db.prepare('INSERT INTO message_events (message_id, event, metadata) VALUES (?, ?, NULL)').run(msg.id, 'beta')
    ctx.db.prepare('INSERT INTO message_events (message_id, event, metadata) VALUES (?, ?, NULL)').run(msg.id, 'alpha')

    const res = await ctx.server.inject({
      method: 'GET',
      url: `/api/v1/messages/${msg.id}/timeline`,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { events: Array<{ type: string }> }
    expect(body.events).toHaveLength(2)
    // beta was inserted first (lower autoincrement id)
    expect(body.events[0].type).toBe('beta')
    expect(body.events[1].type).toBe('alpha')
  })

  it('returns events with metadata parsed as object', async () => {
    const msg = ctx.queue.enqueue({
      to: '5511999990003',
      body: 'test',
      idempotencyKey: 'ik-tl-3',
    })

    ctx.db.prepare('INSERT INTO message_events (message_id, event, metadata) VALUES (?, ?, ?)').run(
      msg.id, 'screenshot_saved', JSON.stringify({ path: 'reports/sends/x.png' }),
    )

    const res = await ctx.server.inject({
      method: 'GET',
      url: `/api/v1/messages/${msg.id}/timeline`,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { events: Array<{ type: string; metadata: { path?: string } | null }> }
    expect(body.events[0].metadata).toMatchObject({ path: 'reports/sends/x.png' })
  })

  it('returns screenshot url when screenshotPath is set', async () => {
    const msg = ctx.queue.enqueue({
      to: '5511999990004',
      body: 'test',
      idempotencyKey: 'ik-tl-4',
    })
    ctx.queue.updateScreenshotPath(msg.id, 'reports/sends/x.png')

    const res = await ctx.server.inject({
      method: 'GET',
      url: `/api/v1/messages/${msg.id}/timeline`,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { screenshot: { url: string | null; code: string | null } }
    expect(body.screenshot.url).toBe(`/api/v1/messages/${msg.id}/screenshot`)
    expect(body.screenshot.code).toBe('persisted')
  })
})
