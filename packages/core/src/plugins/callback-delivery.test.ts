import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { createHmac } from 'node:crypto'
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

    it('T3: HMAC signature matches exact cryptographic computation', async () => {
      registerOralsin()
      mockFetch.mockResolvedValueOnce(new Response('OK', { status: 200 }))

      const payload: ResultCallback = {
        idempotency_key: 'hmac-verify-key',
        status: 'sent',
        sent_at: '2026-04-13T20:00:00Z',
        delivery: { ...baseDelivery, elapsed_ms: 7777 },
        error: null,
        context: { clinic_id: 'uuid-1' },
      }

      await delivery.sendResultCallback('oralsin', 'msg-hmac', payload)

      const [, init] = mockFetch.mock.calls[0]
      const headers = init.headers as Record<string, string>
      const body = init.body as string

      // Compute expected HMAC independently
      const expectedHmac = createHmac('sha256', 'test-hmac-secret')
        .update(body)
        .digest('hex')

      expect(headers['X-Dispatch-Signature']).toBe(expectedHmac)
      // Verify it is a valid 64-char hex string (SHA-256 output)
      expect(headers['X-Dispatch-Signature']).toMatch(/^[a-f0-9]{64}$/)
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

    it('T9: stops retrying on 400 after first attempt (non-retryable)', async () => {
      vi.useFakeTimers()
      registerOralsin()
      mockFetch.mockResolvedValue(new Response('Bad Request', { status: 400 }))

      const promise = delivery.sendResultCallback('oralsin', 'msg-400', {
        idempotency_key: 'test-400',
        status: 'sent',
        sent_at: '2026-04-13T20:00:00Z',
        delivery: { ...baseDelivery },
        error: null,
      })

      // Advance past all possible backoff windows
      await vi.advanceTimersByTimeAsync(200_000)
      await promise

      // 400 = client error, should NOT retry after first attempt
      expect(mockFetch).toHaveBeenCalledTimes(1)

      // Should still be persisted as failed
      const failed = delivery.listFailedCallbacks()
      expect(failed).toHaveLength(1)
      expect(failed[0].last_error).toContain('HTTP 400')
      vi.useRealTimers()
    })

    it('T9: retries on 503 with short backoff [0, 1s, 2s, 4s] (Decision #40)', async () => {
      vi.useFakeTimers()
      registerOralsin()
      // First attempt returns 503, then 3 more 503 retries with short backoff
      mockFetch.mockResolvedValue(new Response('Service Unavailable', { status: 503 }))

      const promise = delivery.sendResultCallback('oralsin', 'msg-503', {
        idempotency_key: 'test-503',
        status: 'sent',
        sent_at: '2026-04-13T20:00:00Z',
        delivery: { ...baseDelivery },
        error: null,
      })

      // Attempt 1 fires immediately (backoff[0] = 0)
      await vi.advanceTimersByTimeAsync(0)
      expect(mockFetch).toHaveBeenCalledTimes(1)

      // 503 triggers short backoff inline: [0, 1s, 2s, 4s]
      // 503 retry 1 at +1s
      await vi.advanceTimersByTimeAsync(1_000)
      expect(mockFetch).toHaveBeenCalledTimes(2)

      // 503 retry 2 at +2s
      await vi.advanceTimersByTimeAsync(2_000)
      expect(mockFetch).toHaveBeenCalledTimes(3)

      // 503 retry 3 at +4s
      await vi.advanceTimersByTimeAsync(4_000)
      expect(mockFetch).toHaveBeenCalledTimes(4)

      // Advance remaining to drain — no more retries after 503 exhausted
      await vi.advanceTimersByTimeAsync(200_000)
      await promise

      // Total: 1 original + 3 short backoff retries = 4 calls
      expect(mockFetch).toHaveBeenCalledTimes(4)

      // Persisted as failed
      const failed = delivery.listFailedCallbacks()
      expect(failed).toHaveLength(1)
      expect(failed[0].last_error).toContain('HTTP 503')
      vi.useRealTimers()
    })

    it('T9: 503 succeeds on second short-backoff retry', async () => {
      vi.useFakeTimers()
      registerOralsin()
      mockFetch
        .mockResolvedValueOnce(new Response('Service Unavailable', { status: 503 })) // attempt 1
        .mockResolvedValueOnce(new Response('Service Unavailable', { status: 503 })) // 503 retry 1
        .mockResolvedValueOnce(new Response('OK', { status: 200 })) // 503 retry 2 succeeds

      const promise = delivery.sendResultCallback('oralsin', 'msg-503-ok', {
        idempotency_key: 'test-503-ok',
        status: 'sent',
        sent_at: '2026-04-13T20:00:00Z',
        delivery: { ...baseDelivery },
        error: null,
      })

      // Attempt 1 fires immediately
      await vi.advanceTimersByTimeAsync(0)
      // 503 retry 1 at +1s
      await vi.advanceTimersByTimeAsync(1_000)
      // 503 retry 2 at +2s
      await vi.advanceTimersByTimeAsync(2_000)
      await promise

      expect(mockFetch).toHaveBeenCalledTimes(3)

      // No failed callbacks — it succeeded
      const failed = delivery.listFailedCallbacks()
      expect(failed).toHaveLength(0)
      vi.useRealTimers()
    })

    it('retries all 4 times on 500 (server error)', async () => {
      vi.useFakeTimers()
      registerOralsin()
      mockFetch.mockResolvedValue(new Response('Internal Server Error', { status: 500 }))

      const promise = delivery.sendResultCallback('oralsin', 'msg-500', {
        idempotency_key: 'test-500',
        status: 'sent',
        sent_at: '2026-04-13T20:00:00Z',
        delivery: { ...baseDelivery },
        error: null,
      })

      await vi.advanceTimersByTimeAsync(5_000)
      await vi.advanceTimersByTimeAsync(30_000)
      await vi.advanceTimersByTimeAsync(120_000)
      await promise

      expect(mockFetch).toHaveBeenCalledTimes(4)

      const failed = delivery.listFailedCallbacks()
      expect(failed).toHaveLength(1)
      expect(failed[0].last_error).toContain('HTTP 500')
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
          ...baseDelivery,
          sender_session: 'manual',
          pair_used: 'manual',
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

    it('T12: increments attempts and updates last_error on failed retry', async () => {
      vi.useFakeTimers()
      registerOralsin()
      // Create a failed callback first
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'))
      const promise = delivery.sendResultCallback('oralsin', 'msg-retry-fail', {
        idempotency_key: 'test-retry-fail',
        status: 'sent',
        sent_at: '2026-04-13T20:00:00Z',
        delivery: { ...baseDelivery },
        error: null,
      })
      await vi.advanceTimersByTimeAsync(155_000)
      await promise
      mockFetch.mockReset()
      vi.useRealTimers()

      const failedBefore = delivery.listFailedCallbacks()
      expect(failedBefore).toHaveLength(1)
      const originalAttempts = failedBefore[0].attempts
      const failedId = failedBefore[0].id

      // Retry with a different error
      mockFetch.mockRejectedValueOnce(new Error('ETIMEDOUT'))
      await delivery.retryFailedCallback(failedId)

      // Verify: attempts incremented, last_error updated
      const failedAfter = delivery.listFailedCallbacks()
      expect(failedAfter).toHaveLength(1)
      expect(failedAfter[0].attempts).toBe(originalAttempts + 1)
      expect(failedAfter[0].last_error).toBe('ETIMEDOUT')
    })

    it('T12: updates last_error with HTTP status on non-ok response during retry', async () => {
      vi.useFakeTimers()
      registerOralsin()
      // Create a failed callback first
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'))
      const promise = delivery.sendResultCallback('oralsin', 'msg-retry-http', {
        idempotency_key: 'test-retry-http',
        status: 'sent',
        sent_at: '2026-04-13T20:00:00Z',
        delivery: { ...baseDelivery },
        error: null,
      })
      await vi.advanceTimersByTimeAsync(155_000)
      await promise
      mockFetch.mockReset()
      vi.useRealTimers()

      const failedBefore = delivery.listFailedCallbacks()
      const failedId = failedBefore[0].id

      // Retry returns 500
      mockFetch.mockResolvedValueOnce(new Response('Internal Server Error', { status: 500 }))
      await delivery.retryFailedCallback(failedId)

      const failedAfter = delivery.listFailedCallbacks()
      expect(failedAfter).toHaveLength(1)
      expect(failedAfter[0].last_error).toContain('HTTP 500')
      expect(failedAfter[0].last_error).toContain('Internal Server Error')
    })

    it('throws for non-existent failed callback id', async () => {
      await expect(
        delivery.retryFailedCallback('nonexistent-id'),
      ).rejects.toThrow('Failed callback not found: nonexistent-id')
    })
  })

  describe('AbortSignal timeout', () => {
    it('aborts fetch when it exceeds HTTP timeout', async () => {
      registerOralsin()

      // Mock fetch that captures the signal and hangs
      mockFetch.mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            // Listen for abort signal
            if (init.signal) {
              init.signal.addEventListener('abort', () => {
                reject(new DOMException('The operation was aborted', 'AbortError'))
              })
            }
          }),
      )

      // Create delivery with very short timeout for testing
      const env = process.env.DISPATCH_HTTP_TIMEOUT_MS
      process.env.DISPATCH_HTTP_TIMEOUT_MS = '50'
      const shortTimeoutDelivery = new CallbackDelivery(db, registry, mockFetch)

      // This should fail due to timeout and eventually persist to failed_callbacks
      vi.useFakeTimers()
      const promise = shortTimeoutDelivery.sendResultCallback('oralsin', 'msg-timeout', {
        idempotency_key: 'test-timeout',
        status: 'sent',
        sent_at: '2026-04-13T20:00:00Z',
        delivery: { ...baseDelivery },
        error: null,
      })

      // Each attempt times out at 50ms, then backoff delays
      // Advance enough for all 4 attempts + backoffs
      for (let i = 0; i < 20; i++) {
        await vi.advanceTimersByTimeAsync(50)
      }
      await vi.advanceTimersByTimeAsync(5_000)
      for (let i = 0; i < 20; i++) {
        await vi.advanceTimersByTimeAsync(50)
      }
      await vi.advanceTimersByTimeAsync(30_000)
      for (let i = 0; i < 20; i++) {
        await vi.advanceTimersByTimeAsync(50)
      }
      await vi.advanceTimersByTimeAsync(120_000)
      for (let i = 0; i < 20; i++) {
        await vi.advanceTimersByTimeAsync(50)
      }
      await promise

      // Verify: the AbortError was caught and propagated
      const failed = shortTimeoutDelivery.listFailedCallbacks()
      expect(failed).toHaveLength(1)
      expect(failed[0].last_error).toContain('abort')

      process.env.DISPATCH_HTTP_TIMEOUT_MS = env
      vi.useRealTimers()
    })

    it('passes AbortSignal to fetchFn', async () => {
      registerOralsin()
      mockFetch.mockResolvedValueOnce(new Response('OK', { status: 200 }))

      await delivery.sendResultCallback('oralsin', 'msg-signal', {
        idempotency_key: 'test-signal',
        status: 'sent',
        sent_at: '2026-04-13T20:00:00Z',
        delivery: { ...baseDelivery },
        error: null,
      })

      // Verify the fetch was called with a signal property
      const [, init] = mockFetch.mock.calls[0]
      expect(init.signal).toBeDefined()
      expect(init.signal).toBeInstanceOf(AbortSignal)
    })
  })
})
