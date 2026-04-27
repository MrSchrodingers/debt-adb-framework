import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import Database from 'better-sqlite3'
import { PluginRegistry } from '../plugins/plugin-registry.js'
import { CallbackDelivery } from '../plugins/callback-delivery.js'
import { AuditLogger } from '../config/audit-logger.js'
import { registerApiAuth } from './api-auth.js'
import type { DeliveryInfo } from '../plugins/types.js'

const API_KEY = 'test-admin-key'

const baseDelivery: DeliveryInfo = {
  message_id: null,
  provider: 'adb',
  sender_phone: '5537999001122',
  sender_session: 'oralsin-1-4',
  pair_used: 'MG-Guaxupé',
  used_fallback: false,
  elapsed_ms: 5000,
  device_serial: '9b01005930533036340030832250ac',
  profile_id: 0,
  char_count: 120,
  contact_registered: false,
  screenshot_url: null,
  dialogs_dismissed: 0,
  user_switched: false,
}

describe('Admin Callbacks API', () => {
  let app: FastifyInstance
  let db: Database.Database
  let registry: PluginRegistry
  let delivery: CallbackDelivery
  let auditLogger: AuditLogger
  let mockFetch: ReturnType<typeof vi.fn>

  const authHeaders = { 'x-api-key': API_KEY }

  const registerOralsin = () => {
    registry.register({
      name: 'oralsin',
      version: '1.0.0',
      webhookUrl: 'https://oralsin.example.com/api/webhooks/dispatch/',
      apiKey: 'plugin-key-1',
      hmacSecret: 'test-hmac-secret',
      events: ['message:sent'],
    })
  }

  const createAbandonedCallback = async (): Promise<string> => {
    vi.useFakeTimers()
    registerOralsin()
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'))

    const promise = delivery.sendResultCallback('oralsin', 'msg-admin-test', {
      idempotency_key: 'admin-test-key',
      status: 'sent',
      sent_at: '2026-04-27T10:00:00Z',
      delivery: { ...baseDelivery },
      error: null,
    })
    await vi.advanceTimersByTimeAsync(155_000)
    await promise
    mockFetch.mockReset()
    vi.useRealTimers()

    const [record] = delivery.listFailedCallbacks()
    mockFetch.mockRejectedValue(new Error('ETIMEDOUT'))
    for (let i = 0; i < 6; i++) {
      await delivery.retryFailedCallback(record.id)
    }
    mockFetch.mockReset()

    return record.id
  }

  beforeEach(async () => {
    db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor TEXT NOT NULL DEFAULT 'api',
        action TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT,
        before_state TEXT,
        after_state TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      )
    `)

    registry = new PluginRegistry(db)
    registry.initialize()
    auditLogger = new AuditLogger(db)
    mockFetch = vi.fn()
    delivery = new CallbackDelivery(db, registry, mockFetch)

    app = Fastify()
    registerApiAuth(app, { apiKey: API_KEY })

    app.get('/api/v1/admin/callbacks/dead-letter', async (_req, reply) => {
      return reply.send(delivery.listAbandonedCallbacks())
    })

    app.post('/api/v1/admin/callbacks/:id/retry', async (req, reply) => {
      const { id } = (req.params as { id: string })
      const abandoned = delivery.listAbandonedCallbacks()
      const record = abandoned.find((r) => r.id === id)
      if (!record) return reply.status(404).send({ error: 'Dead-letter record not found' })

      const beforeState = {
        attempts: record.attempts,
        abandoned_at: record.abandoned_at,
        abandoned_reason: record.abandoned_reason,
      }

      delivery.clearAbandoned(id, 0)
      await delivery.retryFailedCallback(id)

      const afterRecord = delivery.getCallback(id)
      const afterState = afterRecord
        ? { attempts: afterRecord.attempts, abandoned_at: afterRecord.abandoned_at, abandoned_reason: afterRecord.abandoned_reason }
        : { deleted: true }
      const result = afterRecord ? 'still_failing' : 'deleted'

      auditLogger.log({
        action: 'callback_dead_letter_retry',
        resourceType: 'failed_callback',
        resourceId: id,
        beforeState,
        afterState,
      })

      return reply.send({ id, result })
    })

    await app.ready()
  })

  afterEach(async () => {
    await app.close()
    db.close()
  })

  describe('GET /api/v1/admin/callbacks/dead-letter — auth', () => {
    it('returns 401 without API key', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/callbacks/dead-letter',
      })
      expect(res.statusCode).toBe(401)
    })

    it('returns 401 with wrong API key', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/callbacks/dead-letter',
        headers: { 'x-api-key': 'wrong-key' },
      })
      expect(res.statusCode).toBe(401)
    })
  })

  describe('POST /api/v1/admin/callbacks/:id/retry — auth', () => {
    it('returns 401 without API key', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/callbacks/some-id/retry',
      })
      expect(res.statusCode).toBe(401)
    })
  })

  describe('GET /api/v1/admin/callbacks/dead-letter', () => {
    it('returns empty array when no abandoned callbacks', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/callbacks/dead-letter',
        headers: authHeaders,
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual([])
    })

    it('returns only abandoned callbacks', async () => {
      const abandonedId = await createAbandonedCallback()

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/callbacks/dead-letter',
        headers: authHeaders,
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as Array<{ id: string; abandoned_at: string; abandoned_reason: string }>
      expect(body).toHaveLength(1)
      expect(body[0].id).toBe(abandonedId)
      expect(body[0].abandoned_at).toBeTruthy()
      expect(body[0].abandoned_reason).toBe('max_attempts_exceeded')
    })
  })

  describe('POST /api/v1/admin/callbacks/:id/retry', () => {
    it('returns 404 when id not found', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/callbacks/nonexistent-id/retry',
        headers: authHeaders,
      })
      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({ error: 'Dead-letter record not found' })
    })

    it('returns deleted result when retry succeeds', async () => {
      const abandonedId = await createAbandonedCallback()
      mockFetch.mockResolvedValueOnce(new Response('OK', { status: 200 }))

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/callbacks/${abandonedId}/retry`,
        headers: authHeaders,
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { id: string; result: string }
      expect(body.id).toBe(abandonedId)
      expect(body.result).toBe('deleted')

      expect(delivery.listAbandonedCallbacks()).toHaveLength(0)
      expect(delivery.listFailedCallbacks()).toHaveLength(0)
    })

    it('returns still_failing result when retry fails', async () => {
      const abandonedId = await createAbandonedCallback()
      mockFetch.mockRejectedValueOnce(new Error('still down'))

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/callbacks/${abandonedId}/retry`,
        headers: authHeaders,
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { id: string; result: string }
      expect(body.id).toBe(abandonedId)
      expect(body.result).toBe('still_failing')
    })

    it('generates audit log entry on retry', async () => {
      const abandonedId = await createAbandonedCallback()
      mockFetch.mockResolvedValueOnce(new Response('OK', { status: 200 }))

      await app.inject({
        method: 'POST',
        url: `/api/v1/admin/callbacks/${abandonedId}/retry`,
        headers: authHeaders,
      })

      const { entries } = auditLogger.query({ action: 'callback_dead_letter_retry', resourceId: abandonedId })
      expect(entries).toHaveLength(1)
      expect(entries[0].action).toBe('callback_dead_letter_retry')
      expect(entries[0].resourceType).toBe('failed_callback')
      expect(entries[0].resourceId).toBe(abandonedId)
      const before = entries[0].beforeState as { abandoned_reason: string }
      expect(before.abandoned_reason).toBe('max_attempts_exceeded')
    })
  })
})
