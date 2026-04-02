import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import Database from 'better-sqlite3'
import { WebhookHandler } from './webhook-handler.js'
import { MessageHistory } from './message-history.js'
import { DispatchEmitter } from '../events/index.js'
import type { WahaWebhookPayload } from './types.js'

const HMAC_SECRET = 'test-webhook-secret'

function signPayload(body: string, secret: string): string {
  return createHmac('sha512', secret).update(body).digest('hex')
}

function makeMessagePayload(overrides: Partial<WahaWebhookPayload> = {}): WahaWebhookPayload {
  return {
    event: 'message.any',
    session: 'oralsin_main_1',
    me: { id: '554396835104@c.us', pushName: 'Oralsin' },
    payload: {
      id: 'true_5543991938235@c.us_AAAA',
      timestamp: Math.floor(Date.now() / 1000),
      from: '5543991938235@c.us',
      to: '554396835104@c.us',
      body: 'Hello from customer',
      hasMedia: false,
      media: null,
    },
    engine: 'GOWS',
    ...overrides,
  }
}

function makeOutgoingPayload(): WahaWebhookPayload {
  return {
    event: 'message.any',
    session: 'oralsin_main_1',
    me: { id: '554396835104@c.us', pushName: 'Oralsin' },
    payload: {
      id: 'true_554396835104@c.us_BBBB',
      timestamp: Math.floor(Date.now() / 1000),
      from: '554396835104@c.us',
      to: '5543991938235@c.us',
      body: 'Payment reminder',
      hasMedia: false,
      media: null,
    },
    engine: 'GOWS',
  }
}

describe('WebhookHandler', () => {
  let db: Database.Database
  let emitter: DispatchEmitter
  let history: MessageHistory
  let handler: WebhookHandler

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    emitter = new DispatchEmitter()
    history = new MessageHistory(db)
    history.initialize()
    handler = new WebhookHandler(db, emitter, history, { hmacSecret: HMAC_SECRET })
  })

  afterEach(() => {
    db.close()
  })

  describe('validateHmac', () => {
    it('returns true for valid HMAC SHA-512 signature', () => {
      const body = JSON.stringify(makeMessagePayload())
      const signature = signPayload(body, HMAC_SECRET)

      expect(handler.validateHmac(body, signature)).toBe(true)
    })

    it('returns false for invalid HMAC signature', () => {
      const body = JSON.stringify(makeMessagePayload())

      expect(handler.validateHmac(body, 'invalid-signature')).toBe(false)
    })

    it('returns false for tampered body', () => {
      const body = JSON.stringify(makeMessagePayload())
      const signature = signPayload(body, HMAC_SECRET)
      const tamperedBody = body.replace('Hello', 'Hacked')

      expect(handler.validateHmac(tamperedBody, signature)).toBe(false)
    })
  })

  describe('processWebhook — message.any (incoming)', () => {
    it('persists incoming message to message_history', async () => {
      const payload = makeMessagePayload()

      const result = await handler.processWebhook(payload)

      expect(result.processed).toBe(true)
      expect(result.historyId).toBeTruthy()

      const record = history.getById(result.historyId!)
      expect(record).not.toBeNull()
      expect(record!.direction).toBe('incoming')
      expect(record!.fromNumber).toBe('5543991938235')
      expect(record!.toNumber).toBe('554396835104')
      expect(record!.text).toBe('Hello from customer')
      expect(record!.wahaMessageId).toBe('true_5543991938235@c.us_AAAA')
      expect(record!.wahaSessionName).toBe('oralsin_main_1')
      expect(record!.capturedVia).toBe('waha_webhook')
    })

    it('emits waha:message_received event for incoming', async () => {
      const events: unknown[] = []
      emitter.on('waha:message_received' as 'alert:new', (data) => events.push(data))

      await handler.processWebhook(makeMessagePayload())

      expect(events).toHaveLength(1)
    })
  })

  describe('processWebhook — message.any (outgoing)', () => {
    it('persists outgoing message to message_history', async () => {
      const payload = makeOutgoingPayload()

      const result = await handler.processWebhook(payload)

      expect(result.processed).toBe(true)
      const record = history.getById(result.historyId!)
      expect(record!.direction).toBe('outgoing')
      expect(record!.fromNumber).toBe('554396835104')
      expect(record!.toNumber).toBe('5543991938235')
    })

    it('dedup: matches existing ADB send within ±30s and updates it', async () => {
      // Simulate ADB send already recorded
      const adbRecordId = history.insert({
        messageId: 'msg-dispatch-001',
        direction: 'outgoing',
        fromNumber: '554396835104',
        toNumber: '5543991938235',
        text: 'Payment reminder',
        deviceSerial: 'POCO-001',
        capturedVia: 'adb_send',
      })

      // WAHA webhook arrives for same message (multi-device sync)
      const payload = makeOutgoingPayload()
      const result = await handler.processWebhook(payload)

      expect(result.processed).toBe(true)
      expect(result.deduplicated).toBe(true)

      // Original record should be updated with waha_message_id, not a new one created
      const record = history.getById(adbRecordId)
      expect(record!.wahaMessageId).toBe('true_554396835104@c.us_BBBB')
    })

    it('dedup: creates new record when no ADB match within window', async () => {
      // No prior ADB send — this is an outgoing message sent from the phone directly
      const payload = makeOutgoingPayload()
      const result = await handler.processWebhook(payload)

      expect(result.processed).toBe(true)
      expect(result.deduplicated).toBe(false)

      const record = history.getById(result.historyId!)
      expect(record!.capturedVia).toBe('waha_webhook')
    })
  })

  describe('processWebhook — session.status', () => {
    it('processes session status change event', async () => {
      const payload: WahaWebhookPayload = {
        event: 'session.status',
        session: 'oralsin_main_1',
        me: { id: '554396835104@c.us', pushName: 'Oralsin' },
        payload: {
          status: 'FAILED',
          statuses: [
            { status: 'WORKING', timestamp: Date.now() - 60000 },
            { status: 'FAILED', timestamp: Date.now() },
          ],
        },
        engine: 'GOWS',
      }

      const events: unknown[] = []
      emitter.on('waha:session_status' as 'alert:new', (data) => events.push(data))

      const result = await handler.processWebhook(payload)

      expect(result.processed).toBe(true)
      expect(result.event).toBe('session.status')
      expect(events).toHaveLength(1)
    })
  })

  describe('processWebhook — message.ack', () => {
    it('processes message acknowledgement event', async () => {
      // First insert the message
      history.insert({
        direction: 'outgoing',
        fromNumber: '554396835104',
        toNumber: '5543991938235',
        text: 'Test',
        wahaMessageId: 'true_554396835104@c.us_DDDD',
        capturedVia: 'waha_webhook',
      })

      const payload: WahaWebhookPayload = {
        event: 'message.ack',
        session: 'oralsin_main_1',
        payload: {
          id: 'true_554396835104@c.us_DDDD',
          ack: 3, // read
        },
        engine: 'GOWS',
      }

      const result = await handler.processWebhook(payload)

      expect(result.processed).toBe(true)
      expect(result.event).toBe('message.ack')
    })
  })

  describe('processWebhook — media handling', () => {
    it('stores media metadata for messages with media', async () => {
      const payload = makeMessagePayload({
        payload: {
          id: 'true_5543991938235@c.us_MEDIA',
          timestamp: Math.floor(Date.now() / 1000),
          from: '5543991938235@c.us',
          to: '554396835104@c.us',
          body: '',
          hasMedia: true,
          media: {
            url: 'https://gows-chat.debt.com.br/api/files/true_5543991938235@c.us_MEDIA.jpg',
            mimetype: 'image/jpeg',
            filename: 'photo.jpg',
          },
        },
      })

      const result = await handler.processWebhook(payload)

      expect(result.processed).toBe(true)
      const record = history.getById(result.historyId!)
      expect(record!.mediaType).toBe('image/jpeg')
    })
  })

  describe('processWebhook — edge cases', () => {
    it('ignores unknown event types gracefully', async () => {
      const payload: WahaWebhookPayload = {
        event: 'unknown.event' as WahaWebhookPayload['event'],
        session: 'oralsin_main_1',
        payload: {},
        engine: 'GOWS',
      }

      const result = await handler.processWebhook(payload)

      expect(result.processed).toBe(false)
    })
  })
})
