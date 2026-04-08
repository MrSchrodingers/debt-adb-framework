import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { SenderMapping } from '../engine/sender-mapping.js'
import { PluginRegistry } from './plugin-registry.js'
import { PluginEventBus } from './plugin-event-bus.js'
import { PluginLoader } from './plugin-loader.js'
import { DispatchEmitter } from '../events/index.js'
import { MessageQueue } from '../queue/message-queue.js'
import { OralsinPlugin } from './oralsin-plugin.js'

describe('OralsinPlugin sender resolution', () => {
  let db: Database.Database
  let senderMapping: SenderMapping
  let queue: MessageQueue
  let plugin: OralsinPlugin
  let registry: PluginRegistry
  let emitter: DispatchEmitter
  let eventBus: PluginEventBus
  let loader: PluginLoader

  beforeEach(async () => {
    db = new Database(':memory:')
    db.pragma('journal_mode = WAL')

    senderMapping = new SenderMapping(db)
    senderMapping.initialize()

    queue = new MessageQueue(db)
    queue.initialize()

    registry = new PluginRegistry(db)
    registry.initialize()

    emitter = new DispatchEmitter()
    eventBus = new PluginEventBus(registry, emitter)

    loader = new PluginLoader(registry, eventBus, queue, db, undefined, senderMapping)

    plugin = new OralsinPlugin('https://test.example.com/webhook')
    await loader.loadPlugin(plugin, 'test-key', 'test-secret')
  })

  afterEach(() => {
    eventBus.destroy()
    db.close()
  })

  function buildEnqueueRequest(senders: Array<{ phone: string; session: string; pair: string; role: string }>, overrides: Record<string, unknown> = {}) {
    return {
      idempotency_key: `test-${Date.now()}-${Math.random()}`,
      patient: { phone: '5543991938235', name: 'LEVI CORNELIO' },
      message: { text: 'Teste de cobranca' },
      senders,
      ...overrides,
    }
  }

  // Helper to call the plugin's enqueue route directly
  async function callEnqueue(body: unknown) {
    const routes = loader.getRegisteredRoutes()
    const enqueueRoute = routes.find((r) => r.path === '/enqueue' && r.method === 'POST')
    expect(enqueueRoute).toBeDefined()

    let responseCode = 0
    let responseBody: unknown = null

    const mockReply = {
      status: (code: number) => ({
        send: (data: unknown) => {
          responseCode = code
          responseBody = data
          return data
        },
      }),
    }

    await enqueueRoute!.handler(
      { body, headers: { 'x-api-key': 'test-key' } },
      mockReply,
    )

    return { code: responseCode, body: responseBody }
  }

  it('resolves primary sender when mapping exists', async () => {
    senderMapping.create({
      phoneNumber: '+554396837945',
      deviceSerial: '9b01005930533036',
      profileId: 0,
      appPackage: 'com.whatsapp',
      wahaSession: 'oralsin_1_4',
    })

    const response = await callEnqueue(
      buildEnqueueRequest([
        { phone: '+554396837945', session: 'oralsin_1_4', pair: 'oralsin-1-4', role: 'primary' },
        { phone: '+554396837844', session: 'oralsin_2_3', pair: 'oralsin-2-3', role: 'overflow' },
      ]),
    )

    expect(response.code).toBe(201)
    const data = response.body as { enqueued: number; messages: Array<{ id: string }> }
    expect(data.enqueued).toBe(1)

    // Verify sender_number was set to the primary
    const msg = db.prepare('SELECT sender_number FROM messages WHERE id = ?').get(data.messages[0].id) as { sender_number: string }
    expect(msg.sender_number).toBe('+554396837945')
  })

  it('falls back to overflow when primary has no mapping', async () => {
    // Only overflow has a mapping
    senderMapping.create({
      phoneNumber: '+554396837844',
      deviceSerial: '9b01005930533036',
      profileId: 0,
      appPackage: 'com.whatsapp',
      wahaSession: 'oralsin_2_3',
    })

    const response = await callEnqueue(
      buildEnqueueRequest([
        { phone: '+554396837945', session: 'oralsin_1_4', pair: 'oralsin-1-4', role: 'primary' },
        { phone: '+554396837844', session: 'oralsin_2_3', pair: 'oralsin-2-3', role: 'overflow' },
      ]),
    )

    expect(response.code).toBe(201)
    const data = response.body as { enqueued: number; messages: Array<{ id: string }> }

    const msg = db.prepare('SELECT sender_number FROM messages WHERE id = ?').get(data.messages[0].id) as { sender_number: string }
    expect(msg.sender_number).toBe('+554396837844')
  })

  it('falls back to backup when overflow also missing', async () => {
    senderMapping.create({
      phoneNumber: '+554399991111',
      deviceSerial: '9b01005930533036',
      profileId: 0,
      appPackage: 'com.whatsapp',
      wahaSession: 'oralsin_3_1',
    })

    const response = await callEnqueue(
      buildEnqueueRequest([
        { phone: '+554396837945', session: 'oralsin_1_4', pair: 'oralsin-1-4', role: 'primary' },
        { phone: '+554396837844', session: 'oralsin_2_3', pair: 'oralsin-2-3', role: 'overflow' },
        { phone: '+554399991111', session: 'oralsin_3_1', pair: 'oralsin-3-1', role: 'backup' },
      ]),
    )

    expect(response.code).toBe(201)
    const data = response.body as { enqueued: number; messages: Array<{ id: string }> }

    const msg = db.prepare('SELECT sender_number FROM messages WHERE id = ?').get(data.messages[0].id) as { sender_number: string }
    expect(msg.sender_number).toBe('+554399991111')
  })

  it('returns 422 when no sender can be resolved', async () => {
    // No mappings at all
    const response = await callEnqueue(
      buildEnqueueRequest([
        { phone: '+554396837945', session: 'oralsin_1_4', pair: 'oralsin-1-4', role: 'primary' },
        { phone: '+554396837844', session: 'oralsin_2_3', pair: 'oralsin-2-3', role: 'overflow' },
      ]),
    )

    expect(response.code).toBe(422)
    const data = response.body as { error: string; rejected: Array<{ index: number; idempotency_key: string; reason: string }> }
    expect(data.error).toContain('No messages could be enqueued')
    expect(data.rejected).toHaveLength(1)
    expect(data.rejected[0].index).toBe(0)
    expect(data.rejected[0].reason).toContain('+554396837945')
  })

  it('populates sender_number on enqueued message', async () => {
    senderMapping.create({
      phoneNumber: '+554396837945',
      deviceSerial: '9b01005930533036',
      profileId: 0,
      appPackage: 'com.whatsapp',
      wahaSession: 'oralsin_1_4',
    })

    const response = await callEnqueue(
      buildEnqueueRequest([
        { phone: '+554396837945', session: 'oralsin_1_4', pair: 'oralsin-1-4', role: 'primary' },
      ]),
    )

    expect(response.code).toBe(201)
    const data = response.body as { messages: Array<{ id: string }> }
    const msg = queue.getById(data.messages[0].id)
    expect(msg).not.toBeNull()
    expect(msg!.senderNumber).toBe('+554396837945')
  })

  it('stores senders_config as JSON for fallback use', async () => {
    senderMapping.create({
      phoneNumber: '+554396837945',
      deviceSerial: '9b01005930533036',
      profileId: 0,
      appPackage: 'com.whatsapp',
      wahaSession: 'oralsin_1_4',
    })

    const senders = [
      { phone: '+554396837945', session: 'oralsin_1_4', pair: 'oralsin-1-4', role: 'primary' },
      { phone: '+554396837844', session: 'oralsin_2_3', pair: 'oralsin-2-3', role: 'overflow' },
    ]

    const response = await callEnqueue(buildEnqueueRequest(senders))
    expect(response.code).toBe(201)

    const data = response.body as { messages: Array<{ id: string }> }
    const msg = queue.getById(data.messages[0].id)
    expect(msg!.sendersConfig).not.toBeNull()

    const stored = JSON.parse(msg!.sendersConfig!)
    expect(stored).toHaveLength(2)
    expect(stored[0].role).toBe('primary')
  })

  it('handles batch enqueue with mixed sender resolution', async () => {
    senderMapping.create({
      phoneNumber: '+554396837945',
      deviceSerial: '9b01005930533036',
      profileId: 0,
      appPackage: 'com.whatsapp',
      wahaSession: 'oralsin_1_4',
    })

    const batch = [
      buildEnqueueRequest(
        [{ phone: '+554396837945', session: 'oralsin_1_4', pair: 'oralsin-1-4', role: 'primary' }],
        { idempotency_key: 'batch-1', patient: { phone: '5543991938235', name: 'Patient 1' } },
      ),
      buildEnqueueRequest(
        [{ phone: '+554396837945', session: 'oralsin_1_4', pair: 'oralsin-1-4', role: 'primary' }],
        { idempotency_key: 'batch-2', patient: { phone: '5543999887766', name: 'Patient 2' } },
      ),
    ]

    const response = await callEnqueue(batch)
    expect(response.code).toBe(201)
    const data = response.body as { enqueued: number }
    expect(data.enqueued).toBe(2)
  })
})
