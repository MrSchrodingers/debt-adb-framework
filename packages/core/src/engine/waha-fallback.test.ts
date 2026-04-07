import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { WahaFallback } from './waha-fallback.js'
import { SenderMapping } from './sender-mapping.js'
import { MessageQueue } from '../queue/message-queue.js'

describe('WahaFallback', () => {
  let db: Database.Database
  let senderMapping: SenderMapping
  let queue: MessageQueue
  let mockFetch: ReturnType<typeof vi.fn>
  let fallback: WahaFallback

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    senderMapping = new SenderMapping(db)
    senderMapping.initialize()
    queue = new MessageQueue(db)
    queue.initialize()

    mockFetch = vi.fn()
    fallback = new WahaFallback(senderMapping, queue, mockFetch)

    // Create a mapping with WAHA credentials
    senderMapping.create({
      phoneNumber: '+554396837945',
      deviceSerial: '9b01005930533036',
      profileId: 0,
      appPackage: 'com.whatsapp',
      wahaSession: 'oralsin_1_4',
      wahaApiUrl: 'https://gows-chat.debt.com.br',
    })
  })

  afterEach(() => {
    db.close()
  })

  it('sends via WAHA API with correct session', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'waha-msg-001' }),
    })

    const msg = queue.enqueue({
      to: '5543991938235',
      body: 'Teste fallback',
      idempotencyKey: 'fb-test-1',
      senderNumber: '+554396837945',
      sendersConfig: JSON.stringify([
        { phone: '+554396837945', session: 'oralsin_1_4', pair: 'oralsin-1-4', role: 'primary' },
      ]),
    })

    const result = await fallback.send(msg)

    expect(result.success).toBe(true)
    expect(result.wahaMessageId).toBe('waha-msg-001')
    expect(mockFetch).toHaveBeenCalledOnce()

    // Verify the WAHA API was called correctly
    const [url, options] = mockFetch.mock.calls[0]
    expect(url).toBe('https://gows-chat.debt.com.br/api/sendText')
    expect(JSON.parse(options.body)).toMatchObject({
      session: 'oralsin_1_4',
      chatId: '554391938235@c.us',
      text: 'Teste fallback',
    })
  })

  it('returns message_id from WAHA response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'waha-generated-id-xyz' }),
    })

    const msg = queue.enqueue({
      to: '5543991938235',
      body: 'Test',
      idempotencyKey: 'fb-test-2',
      senderNumber: '+554396837945',
      sendersConfig: JSON.stringify([
        { phone: '+554396837945', session: 'oralsin_1_4', pair: 'oralsin-1-4', role: 'primary' },
      ]),
    })

    const result = await fallback.send(msg)
    expect(result.wahaMessageId).toBe('waha-generated-id-xyz')
  })

  it('throws on WAHA API error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    })

    const msg = queue.enqueue({
      to: '5543991938235',
      body: 'Test',
      idempotencyKey: 'fb-test-3',
      senderNumber: '+554396837945',
      sendersConfig: JSON.stringify([
        { phone: '+554396837945', session: 'oralsin_1_4', pair: 'oralsin-1-4', role: 'primary' },
      ]),
    })

    await expect(fallback.send(msg)).rejects.toThrow(/WAHA API error/)
  })

  it('throws when no sender mapping for sender number', async () => {
    const msg = queue.enqueue({
      to: '5543991938235',
      body: 'Test',
      idempotencyKey: 'fb-test-4',
      senderNumber: '+559999999999',
      sendersConfig: JSON.stringify([
        { phone: '+559999999999', session: 'unknown', pair: 'unknown', role: 'primary' },
      ]),
    })

    await expect(fallback.send(msg)).rejects.toThrow(/No WAHA session/)
  })

  it('throws when sender mapping has no WAHA session', async () => {
    senderMapping.create({
      phoneNumber: '+554399887766',
      deviceSerial: '9b01005930533036',
      profileId: 0,
      appPackage: 'com.whatsapp',
      // No wahaSession or wahaApiUrl
    })

    const msg = queue.enqueue({
      to: '5543991938235',
      body: 'Test',
      idempotencyKey: 'fb-test-5',
      senderNumber: '+554399887766',
      sendersConfig: JSON.stringify([
        { phone: '+554399887766', session: '', pair: 'test', role: 'primary' },
      ]),
    })

    await expect(fallback.send(msg)).rejects.toThrow(/No WAHA session/)
  })

  it('marks message with fallback_used and fallback_provider', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'waha-msg-002' }),
    })

    const msg = queue.enqueue({
      to: '5543991938235',
      body: 'Test',
      idempotencyKey: 'fb-test-6',
      senderNumber: '+554396837945',
      sendersConfig: JSON.stringify([
        { phone: '+554396837945', session: 'oralsin_1_4', pair: 'oralsin-1-4', role: 'primary' },
      ]),
    })

    await fallback.send(msg)

    const updated = queue.getById(msg.id)
    expect(updated!.fallbackUsed).toBe(1)
    expect(updated!.fallbackProvider).toBe('waha')
  })

  it('normalizes 13-digit BR phone to WAHA chatId format', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'waha-msg-003' }),
    })

    const msg = queue.enqueue({
      to: '5543991938235', // 13 digits
      body: 'Test',
      idempotencyKey: 'fb-test-7',
      senderNumber: '+554396837945',
      sendersConfig: JSON.stringify([
        { phone: '+554396837945', session: 'oralsin_1_4', pair: 'oralsin-1-4', role: 'primary' },
      ]),
    })

    await fallback.send(msg)

    const [, options] = mockFetch.mock.calls[0]
    const body = JSON.parse(options.body)
    // Should be normalized to 12-digit + @c.us
    expect(body.chatId).toBe('554391938235@c.us')
  })
})
