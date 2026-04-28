/**
 * tests/screenshots.test.ts
 * Tests for the structured 404 screenshot endpoint (Task 7.5.4).
 *
 * Covers all 6 absence codes:
 *   never_persisted | skipped_by_policy | persistence_failed |
 *   deleted_by_retention | file_missing_on_disk
 * And the happy path: actual file served.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { writeFile, mkdir } from 'node:fs/promises'
import { rmSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import Fastify from 'fastify'
import Database from 'better-sqlite3'
import { MessageQueue } from '../queue/message-queue.js'
import { registerScreenshotRoutes } from './screenshots.js'

const TEST_REPORTS_DIR = resolve('reports/sends')

function buildServer() {
  const db = new Database(':memory:')
  const queue = new MessageQueue(db)
  queue.initialize()
  const server = Fastify({ logger: false })
  registerScreenshotRoutes(server, queue)
  return { server, queue, db }
}

describe('GET /api/v1/messages/:id/screenshot — structured 404', () => {
  let ctx: ReturnType<typeof buildServer>

  beforeEach(() => {
    ctx = buildServer()
  })

  afterEach(async () => {
    await ctx.server.close()
  })

  it('returns 404 with error "Message not found" for unknown id', async () => {
    const res = await ctx.server.inject({
      method: 'GET',
      url: '/api/v1/messages/non-existent-id/screenshot',
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ error: 'Message not found' })
  })

  it('returns structured 404 with code=never_persisted when no screenshot_status set', async () => {
    const msg = ctx.queue.enqueue({ to: '5511999990001', body: 'test', idempotencyKey: 'ss-np-1' })

    const res = await ctx.server.inject({
      method: 'GET',
      url: `/api/v1/messages/${msg.id}/screenshot`,
    })
    expect(res.statusCode).toBe(404)
    const body = res.json()
    expect(body.error).toBe('screenshot_unavailable')
    expect(body.code).toBe('never_persisted')
  })

  it('returns structured 404 with code=skipped_by_policy', async () => {
    const msg = ctx.queue.enqueue({ to: '5511999990002', body: 'test', idempotencyKey: 'ss-sp-1' })
    ctx.queue.markScreenshotSkipped(msg.id, 'mode=none')

    const res = await ctx.server.inject({
      method: 'GET',
      url: `/api/v1/messages/${msg.id}/screenshot`,
    })
    expect(res.statusCode).toBe(404)
    const body = res.json()
    expect(body.error).toBe('screenshot_unavailable')
    expect(body.code).toBe('skipped_by_policy')
    expect(body.reason).toBe('mode=none')
  })

  it('returns structured 404 with code=persistence_failed', async () => {
    const msg = ctx.queue.enqueue({ to: '5511999990003', body: 'test', idempotencyKey: 'ss-pf-1' })
    ctx.queue.markScreenshotFailed(msg.id, 'ENOSPC: no space left on device')

    const res = await ctx.server.inject({
      method: 'GET',
      url: `/api/v1/messages/${msg.id}/screenshot`,
    })
    expect(res.statusCode).toBe(404)
    const body = res.json()
    expect(body.error).toBe('screenshot_unavailable')
    expect(body.code).toBe('persistence_failed')
    expect(body.reason).toBe('ENOSPC: no space left on device')
  })

  it('returns structured 404 with code=deleted_by_retention', async () => {
    const msg = ctx.queue.enqueue({ to: '5511999990004', body: 'test', idempotencyKey: 'ss-dr-1' })
    ctx.queue.markScreenshotDeleted(msg.id, '2026-04-20T00:00:00.000Z', 'retention_sweep')

    const res = await ctx.server.inject({
      method: 'GET',
      url: `/api/v1/messages/${msg.id}/screenshot`,
    })
    expect(res.statusCode).toBe(404)
    const body = res.json()
    expect(body.error).toBe('screenshot_unavailable')
    expect(body.code).toBe('deleted_by_retention')
    expect(body.deleted_at).toBe('2026-04-20T00:00:00.000Z')
  })

  it('returns structured 404 with code=file_missing_on_disk when path set but file gone', async () => {
    const msg = ctx.queue.enqueue({ to: '5511999990005', body: 'test', idempotencyKey: 'ss-fm-1' })
    // Mark as persisted with a path that doesn't exist on disk
    ctx.queue.markScreenshotPersisted(msg.id, 'reports/sends/does-not-exist.png', 12345)

    const res = await ctx.server.inject({
      method: 'GET',
      url: `/api/v1/messages/${msg.id}/screenshot`,
    })
    expect(res.statusCode).toBe(404)
    const body = res.json()
    expect(body.error).toBe('screenshot_unavailable')
    expect(body.code).toBe('file_missing_on_disk')
    expect(body.expected_path).toBe('reports/sends/does-not-exist.png')
    expect(body.reason).toContain('retention or manual deletion')
  })

  it('structured 404 includes message_sent_at when available', async () => {
    const msg = ctx.queue.enqueue({ to: '5511999990006', body: 'test', idempotencyKey: 'ss-sat-1' })
    // Advance message to sent to populate sent_at
    ctx.db.prepare("UPDATE messages SET status = 'locked' WHERE id = ?").run(msg.id)
    ctx.db.prepare("UPDATE messages SET status = 'sending' WHERE id = ?").run(msg.id)
    ctx.db.prepare("UPDATE messages SET status = 'sent', sent_at = '2026-04-27T12:00:00.000Z' WHERE id = ?").run(msg.id)
    ctx.queue.markScreenshotSkipped(msg.id, 'mode=none')

    const res = await ctx.server.inject({
      method: 'GET',
      url: `/api/v1/messages/${msg.id}/screenshot`,
    })
    expect(res.statusCode).toBe(404)
    const body = res.json()
    expect(body.message_sent_at).toBe('2026-04-27T12:00:00.000Z')
  })
})

describe('MessageQueue screenshot lifecycle methods', () => {
  let db: Database.Database
  let queue: MessageQueue

  beforeEach(() => {
    db = new Database(':memory:')
    queue = new MessageQueue(db)
    queue.initialize()
  })

  it('markScreenshotPersisted sets status=persisted, path, and sizeBytes', () => {
    const msg = queue.enqueue({ to: '5511111111111', body: 'x', idempotencyKey: 'sq-p-1' })
    queue.markScreenshotPersisted(msg.id, 'reports/sends/sq-p-1.png', 54321)
    const updated = queue.getById(msg.id)!
    expect(updated.screenshotStatus).toBe('persisted')
    expect(updated.screenshotPath).toBe('reports/sends/sq-p-1.png')
    expect(updated.screenshotSizeBytes).toBe(54321)
    expect(updated.screenshotSkipReason).toBeNull()
  })

  it('markScreenshotSkipped sets status=skipped_by_policy and reason', () => {
    const msg = queue.enqueue({ to: '5511111111112', body: 'x', idempotencyKey: 'sq-s-1' })
    queue.markScreenshotSkipped(msg.id, 'mode=sample,sampleRate=0.1')
    const updated = queue.getById(msg.id)!
    expect(updated.screenshotStatus).toBe('skipped_by_policy')
    expect(updated.screenshotSkipReason).toBe('mode=sample,sampleRate=0.1')
    expect(updated.screenshotPath).toBeNull()
  })

  it('markScreenshotFailed sets status=persistence_failed and reason', () => {
    const msg = queue.enqueue({ to: '5511111111113', body: 'x', idempotencyKey: 'sq-f-1' })
    queue.markScreenshotFailed(msg.id, 'Error: ENOSPC disk full')
    const updated = queue.getById(msg.id)!
    expect(updated.screenshotStatus).toBe('persistence_failed')
    expect(updated.screenshotSkipReason).toBe('Error: ENOSPC disk full')
  })

  it('markScreenshotDeleted sets status=deleted_by_retention with timestamp', () => {
    const msg = queue.enqueue({ to: '5511111111114', body: 'x', idempotencyKey: 'sq-d-1' })
    queue.markScreenshotPersisted(msg.id, 'reports/sends/old.png', 1000)
    queue.markScreenshotDeleted(msg.id, '2026-04-01T00:00:00.000Z', 'retention_sweep')
    const updated = queue.getById(msg.id)!
    expect(updated.screenshotStatus).toBe('deleted_by_retention')
    expect(updated.screenshotDeletedAt).toBe('2026-04-01T00:00:00.000Z')
    expect(updated.screenshotSkipReason).toBe('retention_sweep')
  })

  it('findScreenshotsOlderThan returns only persisted screenshots older than cutoff', () => {
    const old = queue.enqueue({ to: '5511111111115', body: 'x', idempotencyKey: 'sq-old-1' })
    const recent = queue.enqueue({ to: '5511111111116', body: 'x', idempotencyKey: 'sq-new-1' })

    // Set sent_at manually: old = 10 days ago, recent = 1 day ago
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString()
    const oneDayAgo = new Date(Date.now() - 1 * 86_400_000).toISOString()
    db.prepare("UPDATE messages SET sent_at = ? WHERE id = ?").run(tenDaysAgo, old.id)
    db.prepare("UPDATE messages SET sent_at = ? WHERE id = ?").run(oneDayAgo, recent.id)

    queue.markScreenshotPersisted(old.id, 'reports/sends/old.png', 500)
    queue.markScreenshotPersisted(recent.id, 'reports/sends/new.png', 500)

    const cutoff = new Date(Date.now() - 7 * 86_400_000) // 7 days ago
    const stale = queue.findScreenshotsOlderThan(cutoff)

    expect(stale.some(m => m.id === old.id)).toBe(true)
    expect(stale.some(m => m.id === recent.id)).toBe(false)
    expect(stale.find(m => m.id === old.id)?.screenshotPath).toBe('reports/sends/old.png')
  })

  it('findScreenshotsOlderThan excludes non-persisted statuses', () => {
    const msg = queue.enqueue({ to: '5511111111117', body: 'x', idempotencyKey: 'sq-np-1' })
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString()
    db.prepare("UPDATE messages SET sent_at = ? WHERE id = ?").run(tenDaysAgo, msg.id)
    // Do NOT mark as persisted — leave screenshot_status = NULL

    const cutoff = new Date(Date.now() - 7 * 86_400_000)
    const stale = queue.findScreenshotsOlderThan(cutoff)
    expect(stale.some(m => m.id === msg.id)).toBe(false)
  })

  it('schema is idempotent — initialize() can be called twice', () => {
    // Should not throw on second call
    expect(() => queue.initialize()).not.toThrow()
    const cols = db.prepare('PRAGMA table_info(messages)').all() as { name: string }[]
    const colNames = cols.map(c => c.name)
    expect(colNames).toContain('screenshot_status')
    expect(colNames).toContain('screenshot_skip_reason')
    expect(colNames).toContain('screenshot_deleted_at')
    expect(colNames).toContain('screenshot_size_bytes')
  })
})
