import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { CallbackDelivery } from './callback-delivery.js'
import { PluginRegistry } from './plugin-registry.js'
import type { ResultCallback, AckCallback, ResponseCallback, FailedCallbackRecord, DeliveryInfo } from './types.js'

/** Default delivery info with all required audit fields */
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
  screenshot_url: '/api/v1/messages/msg-1/screenshot',
  dialogs_dismissed: 0,
  user_switched: false,
}

describe('CallbackDelivery', () => {
  let db: Database.Database
  let registry: PluginRegistry
  let delivery: CallbackDelivery
  let mockFetch: ReturnType<typeof vi.fn>

  const registerOralsin = () => {
    registry.register({
      name: 'oralsin',
      version: '1.0.0',
      webhookUrl: 'https://oralsin.example.com/api/webhooks/dispatch/',
      apiKey: 'key-1',
      hmacSecret: 'test-hmac-secret',
      events: ['message:sent', 'message:failed'],
    })
  }

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    registry = new PluginRegistry(db)
    registry.initialize()

    mockFetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>()
    delivery = new CallbackDelivery(db, registry, mockFetch)
  })

  afterEach(() => {
    db.close()
  })

  describe('sendResultCallback', () => {
    it('sends callback to plugin webhook_url on success', async () => {
      registerOralsin()
      mockFetch.mockResolvedValueOnce(new Response('OK', { status: 200 }))

      const payload: ResultCallback = {
        idempotency_key: 'oralsin-sched-abc123',
        correlation_id: 'pipeline-run-1',
        status: 'sent',
        sent_at: '2026-04-02T15:48:57.354Z',
        delivery: {
          ...baseDelivery,
          message_id: 'true_553788165296@c.us_3EB04863460F86E8B5FC44',
          elapsed_ms: 29739,
          contact_registered: true,
        },
        error: null,
        context: { clinic_id: 'uuid-1', schedule_id: 'uuid-2' },
      }

      await delivery.sendResultCallback('oralsin', 'msg-1', payload)

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const [url] = mockFetch.mock.calls[0]
      expect(url).toBe('https://oralsin.example.com/api/webhooks/dispatch/')
    })

    it('sends callback on failure status', async () => {
      registerOralsin()
      mockFetch.mockResolvedValueOnce(new Response('OK', { status: 200 }))

      const payload: ResultCallback = {
        idempotency_key: 'oralsin-sched-abc123',
        status: 'failed',
        sent_at: null,
        delivery: null,
        error: {
          code: 'all_providers_unavailable',
          message: 'Primary banned, fallback quarantined',
          retryable: true,
          retry_after_seconds: 1800,
        },
      }

      await delivery.sendResultCallback('oralsin', 'msg-1', payload)

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const [, init] = mockFetch.mock.calls[0]
      const body = JSON.parse(init.body as string)
      expect(body.status).toBe('failed')
      expect(body.error.code).toBe('all_providers_unavailable')
    })

    it('includes HMAC signature header', async () => {
      registerOralsin()
      mockFetch.mockResolvedValueOnce(new Response('OK', { status: 200 }))

      await delivery.sendResultCallback('oralsin', 'msg-1', {
        idempotency_key: 'test-key',
        status: 'sent',
        sent_at: '2026-04-02T15:00:00Z',
        delivery: { ...baseDelivery },
        error: null,
      })

      const [, init] = mockFetch.mock.calls[0]
      const headers = init.headers as Record<string, string>
      expect(headers['X-Dispatch-Signature']).toBeDefined()
      expect(headers['X-Dispatch-Signature'].length).toBeGreaterThan(0)
    })

    it('includes context pass-through in callback body', async () => {
      registerOralsin()
      mockFetch.mockResolvedValueOnce(new Response('OK', { status: 200 }))

      const context = { clinic_id: 'uuid-clinic', schedule_id: 'uuid-sched', flow_step: 13 }

      await delivery.sendResultCallback('oralsin', 'msg-1', {
        idempotency_key: 'test-key',
        status: 'sent',
        sent_at: '2026-04-02T15:00:00Z',
        delivery: { ...baseDelivery },
        error: null,
        context,
      })

      const [, init] = mockFetch.mock.calls[0]
      const body = JSON.parse(init.body as string)
      expect(body.context).toEqual(context)
    })
  })

  describe('retry logic', () => {
    it('retries 4 times on failure', async () => {
      vi.useFakeTimers()
      registerOralsin()
      mockFetch
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))

      const promise = delivery.sendResultCallback('oralsin', 'msg-1', {
        idempotency_key: 'test-key',
        status: 'sent',
        sent_at: '2026-04-02T15:00:00Z',
        delivery: { ...baseDelivery },
        error: null,
      })
      // Advance timers for backoff delays (5s + 30s + 120s)
      await vi.advanceTimersByTimeAsync(5_000)
      await vi.advanceTimersByTimeAsync(30_000)
      await vi.advanceTimersByTimeAsync(120_000)
      await promise

      expect(mockFetch).toHaveBeenCalledTimes(4)
      vi.useRealTimers()
    })

    it('succeeds on second retry', async () => {
      vi.useFakeTimers()
      registerOralsin()
      mockFetch
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValueOnce(new Response('OK', { status: 200 }))

      const promise = delivery.sendResultCallback('oralsin', 'msg-1', {
        idempotency_key: 'test-key',
        status: 'sent',
        sent_at: '2026-04-02T15:00:00Z',
        delivery: { ...baseDelivery },
        error: null,
      })
      // Advance timer for first backoff (5s before attempt 2)
      await vi.advanceTimersByTimeAsync(5_000)
      await promise

      expect(mockFetch).toHaveBeenCalledTimes(2)
      vi.useRealTimers()
    })

    it('persists in failed_callbacks after 4 failures', async () => {
      vi.useFakeTimers()
      registerOralsin()
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'))

      const promise = delivery.sendResultCallback('oralsin', 'msg-1', {
        idempotency_key: 'test-key',
        status: 'sent',
        sent_at: '2026-04-02T15:00:00Z',
        delivery: { ...baseDelivery },
        error: null,
      })
      await vi.advanceTimersByTimeAsync(5_000)
      await vi.advanceTimersByTimeAsync(30_000)
      await vi.advanceTimersByTimeAsync(120_000)
      await promise

      const failed = delivery.listFailedCallbacks()
      expect(failed).toHaveLength(1)
      expect(failed[0].plugin_name).toBe('oralsin')
      expect(failed[0].message_id).toBe('msg-1')
      expect(failed[0].callback_type).toBe('result')
      expect(failed[0].attempts).toBe(4)
      vi.useRealTimers()
    })

    it('applies exponential backoff delays between retries', async () => {
      vi.useFakeTimers()
      registerOralsin()
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'))

      const promise = delivery.sendResultCallback('oralsin', 'msg-1', {
        idempotency_key: 'test-key',
        status: 'sent',
        sent_at: '2026-04-02T15:00:00Z',
        delivery: { ...baseDelivery },
        error: null,
      })

      // Attempt 1 fires immediately
      await vi.advanceTimersByTimeAsync(0)
      expect(mockFetch).toHaveBeenCalledTimes(1)

      // Before 5s, attempt 2 should NOT have fired
      await vi.advanceTimersByTimeAsync(4_999)
      expect(mockFetch).toHaveBeenCalledTimes(1)

      // At 5s, attempt 2 fires
      await vi.advanceTimersByTimeAsync(1)
      expect(mockFetch).toHaveBeenCalledTimes(2)

      // Before 30s more, attempt 3 should NOT have fired
      await vi.advanceTimersByTimeAsync(29_999)
      expect(mockFetch).toHaveBeenCalledTimes(2)

      // At 30s, attempt 3 fires
      await vi.advanceTimersByTimeAsync(1)
      expect(mockFetch).toHaveBeenCalledTimes(3)

      // Before 120s more, attempt 4 should NOT have fired
      await vi.advanceTimersByTimeAsync(119_999)
      expect(mockFetch).toHaveBeenCalledTimes(3)

      // At 120s, attempt 4 fires
      await vi.advanceTimersByTimeAsync(1)
      await promise
      expect(mockFetch).toHaveBeenCalledTimes(4)

      vi.useRealTimers()
    })
  })

  describe('sendAckCallback', () => {
    it('sends ACK callback to plugin', async () => {
      registerOralsin()
      mockFetch.mockResolvedValueOnce(new Response('OK', { status: 200 }))

      const payload: AckCallback = {
        idempotency_key: 'oralsin-sched-abc123',
        message_id: 'true_553788165296@c.us_3EB04863460F86E8B5FC44',
        event: 'ack_update',
        ack: {
          level: 3,
          level_name: 'read',
          delivered_at: '2026-04-02T15:49:00.007Z',
          read_at: '2026-04-02T16:15:22.000Z',
        },
      }

      await delivery.sendAckCallback('oralsin', 'msg-1', payload)

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const [, init] = mockFetch.mock.calls[0]
      const body = JSON.parse(init.body as string)
      expect(body.event).toBe('ack_update')
      expect(body.ack.level).toBe(3)
    })
  })

  describe('sendResponseCallback', () => {
    it('sends patient response callback to plugin', async () => {
      registerOralsin()
      mockFetch.mockResolvedValueOnce(new Response('OK', { status: 200 }))

      const payload: ResponseCallback = {
        idempotency_key: 'oralsin-sched-abc123',
        message_id: 'true_553788165296@c.us_3EB04863460F86E8B5FC44',
        event: 'patient_response',
        response: {
          body: 'Vou pagar semana que vem',
          received_at: '2026-04-02T16:32:00.000Z',
          from_number: '5543919382350',
          has_media: false,
        },
      }

      await delivery.sendResponseCallback('oralsin', 'msg-1', payload)

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const [, init] = mockFetch.mock.calls[0]
      const body = JSON.parse(init.body as string)
      expect(body.event).toBe('patient_response')
      expect(body.response.from_number).toBe('5543919382350')
    })
  })

  describe('no callback for manual messages', () => {
    it('does not send callback for messages without plugin_name', async () => {
      await delivery.sendResultCallback(null as unknown as string, 'msg-1', {
        idempotency_key: 'manual-send',
        status: 'sent',
        sent_at: '2026-04-02T15:00:00Z',
        delivery: {
          message_id: null,
          provider: 'adb',
          sender_phone: '5537999001122',
          sender_session: 'manual',
          pair_used: 'manual',
          used_fallback: false,
          elapsed_ms: 5000,
        },
        error: null,
      })

      expect(mockFetch).not.toHaveBeenCalled()
    })
  })

  describe('listFailedCallbacks', () => {
    it('returns empty array when no failures', () => {
      const failed = delivery.listFailedCallbacks()
      expect(failed).toHaveLength(0)
    })
  })

  describe('retryFailedCallback', () => {
    it('retries a specific failed callback', async () => {
      vi.useFakeTimers()
      registerOralsin()
      // First: create a failed callback
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'))
      const promise = delivery.sendResultCallback('oralsin', 'msg-1', {
        idempotency_key: 'test-key',
        status: 'sent',
        sent_at: '2026-04-02T15:00:00Z',
        delivery: { ...baseDelivery },
        error: null,
      })
      await vi.advanceTimersByTimeAsync(155_000)
      await promise
      mockFetch.mockReset()
      vi.useRealTimers()

      // Then: retry succeeds (retryFailedCallback has no backoff)
      mockFetch.mockResolvedValueOnce(new Response('OK', { status: 200 }))
      const failed = delivery.listFailedCallbacks()
      await delivery.retryFailedCallback(failed[0].id)

      expect(mockFetch).toHaveBeenCalledTimes(1)
      // Should be removed from failed list
      const remaining = delivery.listFailedCallbacks()
      expect(remaining).toHaveLength(0)
    })
  })
})
