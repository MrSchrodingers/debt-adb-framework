import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { createHmac } from 'node:crypto'
import { CallbackDelivery } from './callback-delivery.js'
import { PluginRegistry } from './plugin-registry.js'
import { PluginEventBus } from './plugin-event-bus.js'
import { DispatchEmitter } from '../events/index.js'
import { MessageQueue } from '../queue/message-queue.js'
import type { ResultCallback, DeliveryInfo } from './types.js'

/**
 * E2E Integration Test (T1) — Plugin Hardening Batch 9
 *
 * Tests the complete callback loop with mocked ADB:
 *   enqueue -> dequeueBySender -> process (mocked send) -> message:sent
 *   -> callback delivery with HMAC verification
 */
describe('Plugin E2E — Full Callback Loop', () => {
  let db: Database.Database
  let queue: MessageQueue
  let registry: PluginRegistry
  let emitter: DispatchEmitter
  let eventBus: PluginEventBus
  let callbackDelivery: CallbackDelivery
  let mockFetch: ReturnType<typeof vi.fn>

  const TEST_PLUGIN = 'oralsin'
  const TEST_HMAC_SECRET = 'e2e-test-hmac-secret-32bytes-long'
  const TEST_WEBHOOK_URL = 'https://oralsin.example.com/api/webhooks/dispatch/'
  const TEST_DEVICE_SERIAL = '9b01005930533036340030832250ac'

  const registerTestPlugin = () => {
    registry.register({
      name: TEST_PLUGIN,
      version: '1.0.0',
      webhookUrl: TEST_WEBHOOK_URL,
      apiKey: 'test-api-key-1',
      hmacSecret: TEST_HMAC_SECRET,
      events: ['message:sent', 'message:failed'],
    })
  }

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('journal_mode = WAL')

    // Initialize all modules on the same DB
    queue = new MessageQueue(db)
    queue.initialize()

    registry = new PluginRegistry(db)
    registry.initialize()

    emitter = new DispatchEmitter()

    eventBus = new PluginEventBus(registry, emitter)

    mockFetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>()
    callbackDelivery = new CallbackDelivery(db, registry, mockFetch)
  })

  afterEach(() => {
    eventBus.destroy()
    db.close()
  })

  it('enqueue -> dequeue -> status transitions -> message:sent -> callback with valid HMAC', async () => {
    // 1. Register plugin
    registerTestPlugin()

    // 2. Enqueue a message with plugin_name
    const msg = queue.enqueue({
      to: '5543991938235',
      body: 'Test E2E callback loop',
      idempotencyKey: 'oralsin-sched-e2e-001',
      pluginName: TEST_PLUGIN,
      correlationId: 'pipeline-e2e-1',
      senderNumber: '5537999001122',
    })
    expect(msg.status).toBe('queued')
    expect(msg.pluginName).toBe(TEST_PLUGIN)

    // 3. Dequeue (simulates worker picking up the message)
    const batch = queue.dequeueBySender(TEST_DEVICE_SERIAL)
    expect(batch).toHaveLength(1)
    expect(batch[0].id).toBe(msg.id)
    expect(batch[0].status).toBe('locked')

    // 4. Transition: locked -> sending
    const sending = queue.updateStatus(msg.id, 'locked', 'sending')
    expect(sending.status).toBe('sending')

    // 5. Transition: sending -> sent (simulates successful ADB send)
    const sent = queue.updateStatus(msg.id, 'sending', 'sent')
    expect(sent.status).toBe('sent')
    expect(sent.sentAt).toBeTruthy()

    // 6. Set up callback mock to capture the request
    mockFetch.mockResolvedValueOnce(new Response('OK', { status: 200 }))

    // 7. Build the callback payload (as the engine would)
    const deliveryInfo: DeliveryInfo = {
      message_id: null,
      provider: 'adb',
      sender_phone: '5537999001122',
      sender_session: 'oralsin-1-4',
      pair_used: 'MG-Guaxupe',
      used_fallback: false,
      elapsed_ms: 12345,
      device_serial: TEST_DEVICE_SERIAL,
      profile_id: 0,
      char_count: 22,
      contact_registered: false,
      screenshot_url: `/api/v1/messages/${msg.id}/screenshot`,
      dialogs_dismissed: 0,
      user_switched: false,
    }

    const resultPayload: ResultCallback = {
      idempotency_key: msg.idempotencyKey,
      correlation_id: 'pipeline-e2e-1',
      status: 'sent',
      sent_at: sent.sentAt!,
      delivery: deliveryInfo,
      error: null,
      context: { clinic_id: 'uuid-clinic', schedule_id: 'uuid-sched' },
    }

    // 8. Send callback (as the engine would after message:sent)
    await callbackDelivery.sendResultCallback(TEST_PLUGIN, msg.id, resultPayload)

    // 9. Verify: fetch was called once
    expect(mockFetch).toHaveBeenCalledTimes(1)

    // 10. Verify: URL is correct
    const [callUrl, callInit] = mockFetch.mock.calls[0]
    expect(callUrl).toBe(TEST_WEBHOOK_URL)

    // 11. Verify: payload is correct
    const callBody = JSON.parse(callInit.body as string)
    expect(callBody.idempotency_key).toBe('oralsin-sched-e2e-001')
    expect(callBody.correlation_id).toBe('pipeline-e2e-1')
    expect(callBody.status).toBe('sent')
    expect(callBody.delivery.provider).toBe('adb')
    expect(callBody.delivery.sender_phone).toBe('5537999001122')
    expect(callBody.delivery.device_serial).toBe(TEST_DEVICE_SERIAL)
    expect(callBody.context).toEqual({ clinic_id: 'uuid-clinic', schedule_id: 'uuid-sched' })

    // 12. Verify: HMAC is cryptographically correct
    const headers = callInit.headers as Record<string, string>
    const expectedHmac = createHmac('sha256', TEST_HMAC_SECRET)
      .update(callInit.body as string)
      .digest('hex')
    expect(headers['X-Dispatch-Signature']).toBe(expectedHmac)
  })

  it('enqueue batch -> dequeue -> mixed results -> callbacks for each', async () => {
    registerTestPlugin()
    mockFetch.mockResolvedValue(new Response('OK', { status: 200 }))

    // Enqueue batch of 2 messages
    const result = queue.enqueueBatch([
      {
        to: '5543991938235',
        body: 'Batch msg 1',
        idempotencyKey: 'oralsin-batch-001',
        pluginName: TEST_PLUGIN,
        senderNumber: '5537999001122',
      },
      {
        to: '5543991938236',
        body: 'Batch msg 2',
        idempotencyKey: 'oralsin-batch-002',
        pluginName: TEST_PLUGIN,
        senderNumber: '5537999001122',
      },
    ])
    expect(result.enqueued).toHaveLength(2)
    expect(result.skipped).toHaveLength(0)

    // Dequeue all by sender
    const batch = queue.dequeueBySender(TEST_DEVICE_SERIAL)
    expect(batch).toHaveLength(2)

    // Send first message successfully
    queue.updateStatus(batch[0].id, 'locked', 'sending')
    queue.updateStatus(batch[0].id, 'sending', 'sent')

    await callbackDelivery.sendResultCallback(TEST_PLUGIN, batch[0].id, {
      idempotency_key: 'oralsin-batch-001',
      status: 'sent',
      sent_at: new Date().toISOString(),
      delivery: {
        message_id: null,
        provider: 'adb',
        sender_phone: '5537999001122',
        sender_session: 'oralsin-1-4',
        pair_used: 'MG-Guaxupe',
        used_fallback: false,
        elapsed_ms: 8000,
        device_serial: TEST_DEVICE_SERIAL,
        profile_id: 0,
        char_count: 11,
        contact_registered: false,
        screenshot_url: null,
        dialogs_dismissed: 0,
        user_switched: false,
      },
      error: null,
    })

    // Second message fails
    queue.updateStatus(batch[1].id, 'locked', 'sending')
    queue.updateStatus(batch[1].id, 'sending', 'failed')

    await callbackDelivery.sendResultCallback(TEST_PLUGIN, batch[1].id, {
      idempotency_key: 'oralsin-batch-002',
      status: 'failed',
      sent_at: null,
      delivery: null,
      error: {
        code: 'adb_send_timeout',
        message: 'Typing timed out after 120s',
        retryable: true,
      },
    })

    // Both callbacks should have been sent
    expect(mockFetch).toHaveBeenCalledTimes(2)

    // Verify first callback is 'sent'
    const [, init1] = mockFetch.mock.calls[0]
    const body1 = JSON.parse(init1.body as string)
    expect(body1.status).toBe('sent')
    expect(body1.idempotency_key).toBe('oralsin-batch-001')

    // Verify second callback is 'failed'
    const [, init2] = mockFetch.mock.calls[1]
    const body2 = JSON.parse(init2.body as string)
    expect(body2.status).toBe('failed')
    expect(body2.idempotency_key).toBe('oralsin-batch-002')
    expect(body2.error.code).toBe('adb_send_timeout')
  })

  it('event bus triggers callback on message:sent event', async () => {
    registerTestPlugin()
    mockFetch.mockResolvedValue(new Response('OK', { status: 200 }))

    // Wire up the event bus handler that simulates what the engine does:
    // on message:sent -> send result callback
    eventBus.registerHandler(TEST_PLUGIN, 'message:sent', async (data) => {
      const eventData = data as { id: string; sentAt: string; durationMs: number }
      await callbackDelivery.sendResultCallback(TEST_PLUGIN, eventData.id, {
        idempotency_key: 'oralsin-event-001',
        status: 'sent',
        sent_at: eventData.sentAt,
        delivery: {
          message_id: null,
          provider: 'adb',
          sender_phone: '5537999001122',
          sender_session: 'oralsin-1-4',
          pair_used: 'MG-Guaxupe',
          used_fallback: false,
          elapsed_ms: eventData.durationMs,
          device_serial: TEST_DEVICE_SERIAL,
          profile_id: 0,
          char_count: 50,
          contact_registered: true,
          screenshot_url: null,
          dialogs_dismissed: 1,
          user_switched: false,
        },
        error: null,
      })
    })

    // Emit the event (simulates what engine does after successful send)
    emitter.emit('message:sent', {
      id: 'msg-event-1',
      sentAt: '2026-04-13T20:00:00.000Z',
      durationMs: 9500,
      deviceSerial: TEST_DEVICE_SERIAL,
      contactRegistered: true,
      dialogsDismissed: 1,
    })

    // Wait for the async dispatch
    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    // Verify HMAC on the callback
    const [, init] = mockFetch.mock.calls[0]
    const headers = init.headers as Record<string, string>
    const expectedHmac = createHmac('sha256', TEST_HMAC_SECRET)
      .update(init.body as string)
      .digest('hex')
    expect(headers['X-Dispatch-Signature']).toBe(expectedHmac)
  })

  it('no callback is sent for messages without plugin_name', async () => {
    // Enqueue a manual message (no plugin)
    const msg = queue.enqueue({
      to: '5543991938235',
      body: 'Manual message',
      idempotencyKey: 'manual-001',
    })

    // Process it
    const dequeued = queue.dequeue(TEST_DEVICE_SERIAL)
    expect(dequeued).not.toBeNull()
    queue.updateStatus(dequeued!.id, 'locked', 'sending')
    queue.updateStatus(dequeued!.id, 'sending', 'sent')

    // Attempt to send callback with null plugin — should no-op
    await callbackDelivery.sendResultCallback(null as unknown as string, msg.id, {
      idempotency_key: 'manual-001',
      status: 'sent',
      sent_at: new Date().toISOString(),
      delivery: {
        message_id: null,
        provider: 'adb',
        sender_phone: '5537999001122',
        sender_session: 'manual',
        pair_used: 'manual',
        used_fallback: false,
        elapsed_ms: 5000,
        device_serial: TEST_DEVICE_SERIAL,
        profile_id: 0,
        char_count: 14,
        contact_registered: false,
        screenshot_url: null,
        dialogs_dismissed: 0,
        user_switched: false,
      },
      error: null,
    })

    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('failed callback is persisted after all retries fail', async () => {
    vi.useFakeTimers()
    registerTestPlugin()
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'))

    const msg = queue.enqueue({
      to: '5543991938235',
      body: 'Will fail callback',
      idempotencyKey: 'oralsin-fail-001',
      pluginName: TEST_PLUGIN,
    })

    const promise = callbackDelivery.sendResultCallback(TEST_PLUGIN, msg.id, {
      idempotency_key: 'oralsin-fail-001',
      status: 'sent',
      sent_at: new Date().toISOString(),
      delivery: {
        message_id: null,
        provider: 'adb',
        sender_phone: '5537999001122',
        sender_session: 'oralsin-1-4',
        pair_used: 'MG-Guaxupe',
        used_fallback: false,
        elapsed_ms: 5000,
        device_serial: TEST_DEVICE_SERIAL,
        profile_id: 0,
        char_count: 18,
        contact_registered: false,
        screenshot_url: null,
        dialogs_dismissed: 0,
        user_switched: false,
      },
      error: null,
    })

    // Advance through all backoff delays: 0 + 5s + 30s + 120s
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.advanceTimersByTimeAsync(120_000)
    await promise

    // 4 attempts, all failed
    expect(mockFetch).toHaveBeenCalledTimes(4)

    // Persisted to failed_callbacks
    const failed = callbackDelivery.listFailedCallbacks()
    expect(failed).toHaveLength(1)
    expect(failed[0].plugin_name).toBe(TEST_PLUGIN)
    expect(failed[0].message_id).toBe(msg.id)
    expect(failed[0].callback_type).toBe('result')
    expect(failed[0].attempts).toBe(4)
    expect(failed[0].last_error).toBe('ECONNREFUSED')

    vi.useRealTimers()
  })

  it('idempotent enqueue — duplicate key is skipped in batch', async () => {
    registerTestPlugin()

    // First enqueue
    queue.enqueue({
      to: '5543991938235',
      body: 'Original message',
      idempotencyKey: 'oralsin-dedup-001',
      pluginName: TEST_PLUGIN,
      senderNumber: '5537999001122',
    })

    // Batch with duplicate + new
    const result = queue.enqueueBatch([
      {
        to: '5543991938235',
        body: 'Duplicate',
        idempotencyKey: 'oralsin-dedup-001',
        pluginName: TEST_PLUGIN,
        senderNumber: '5537999001122',
      },
      {
        to: '5543991938236',
        body: 'New message',
        idempotencyKey: 'oralsin-dedup-002',
        pluginName: TEST_PLUGIN,
        senderNumber: '5537999001122',
      },
    ])

    expect(result.enqueued).toHaveLength(1)
    expect(result.enqueued[0].idempotencyKey).toBe('oralsin-dedup-002')
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0].idempotencyKey).toBe('oralsin-dedup-001')
    expect(result.skipped[0].reason).toBe('duplicate')
  })
})
