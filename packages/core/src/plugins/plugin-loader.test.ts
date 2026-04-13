import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { PluginLoader } from './plugin-loader.js'
import { PluginRegistry } from './plugin-registry.js'
import { PluginEventBus } from './plugin-event-bus.js'
import { DispatchEmitter } from '../events/index.js'
import { MessageQueue } from '../queue/message-queue.js'
import { SenderMapping } from '../engine/sender-mapping.js'
import type { SendEngine } from '../engine/send-engine.js'
import type { DispatchPlugin, PluginContext, PluginEnqueueParams } from './types.js'

// ── Test Helpers ──

function makePlugin(overrides: Partial<DispatchPlugin> = {}): DispatchPlugin {
  return {
    name: 'test-plugin',
    version: '1.0.0',
    events: ['message:sent', 'message:failed'],
    webhookUrl: 'https://test.example.com/webhook',
    init: vi.fn<(ctx: PluginContext) => Promise<void>>().mockResolvedValue(undefined),
    destroy: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    ...overrides,
  }
}

function makeEnqueueParams(overrides: Partial<PluginEnqueueParams> = {}): PluginEnqueueParams {
  return {
    idempotencyKey: `test-${Date.now()}`,
    correlationId: 'pipeline-run-1',
    patient: {
      phone: '5543991938235',
      name: 'LEVI CORNELIO MARTINS',
      patientId: 'patient-uuid-1',
    },
    message: {
      text: 'Olá LEVI, sua parcela de R$ 169,67 venceu.',
      templateId: 'overdue_reminder_v2',
    },
    senders: [
      { phone: '5537999001122', session: 'oralsin-1-4', pair: 'MG-Guaxupé', role: 'primary' },
      { phone: '5537999003344', session: 'oralsin-1-5', pair: 'MG-Backup', role: 'backup' },
    ],
    context: {
      clinic_id: 'uuid-clinic',
      schedule_id: 'uuid-sched',
      flow_step: 13,
      overdue_days: 331,
    },
    sendOptions: {
      maxRetries: 5,
      priority: 'high',
    },
    ...overrides,
  }
}

describe('PluginLoader', () => {
  let db: Database.Database
  let registry: PluginRegistry
  let emitter: DispatchEmitter
  let eventBus: PluginEventBus
  let queue: MessageQueue
  let loader: PluginLoader

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    registry = new PluginRegistry(db)
    registry.initialize()
    emitter = new DispatchEmitter()
    eventBus = new PluginEventBus(registry, emitter)
    queue = new MessageQueue(db)
    queue.initialize()
    loader = new PluginLoader(registry, eventBus, queue, db)
  })

  afterEach(() => {
    eventBus.destroy()
    db.close()
  })

  describe('loadPlugin', () => {
    it('calls init() with PluginContext', async () => {
      const plugin = makePlugin()

      await loader.loadPlugin(plugin, 'key-1', 'secret-1')

      expect(plugin.init).toHaveBeenCalledTimes(1)
      const ctx = (plugin.init as ReturnType<typeof vi.fn>).mock.calls[0][0] as PluginContext
      expect(ctx.enqueue).toBeDefined()
      expect(ctx.getMessageStatus).toBeDefined()
      expect(ctx.getQueueStats).toBeDefined()
      expect(ctx.on).toBeDefined()
      expect(ctx.registerRoute).toBeDefined()
      expect(ctx.logger).toBeDefined()
    })

    it('registers plugin in registry on load', async () => {
      const plugin = makePlugin({ name: 'oralsin' })

      await loader.loadPlugin(plugin, 'key-1', 'secret-1')

      const record = registry.getPlugin('oralsin')
      expect(record).not.toBeNull()
      expect(record!.name).toBe('oralsin')
      expect(record!.version).toBe('1.0.0')
      expect(record!.status).toBe('active')
    })

    it('core continues if plugin init() throws', async () => {
      const plugin = makePlugin({
        name: 'broken-plugin',
        init: vi.fn<(ctx: PluginContext) => Promise<void>>().mockRejectedValue(new Error('init crash')),
      })

      // Should not throw
      await loader.loadPlugin(plugin, 'key-1', 'secret-1')

      const record = registry.getPlugin('broken-plugin')
      expect(record!.status).toBe('error')
    })

    it('skips loading disabled plugins', async () => {
      const plugin = makePlugin({ name: 'oralsin' })
      // Pre-register as disabled
      registry.register({
        name: 'oralsin',
        version: '1.0.0',
        webhookUrl: 'https://test.example.com/webhook',
        apiKey: 'key-1',
        hmacSecret: 'secret-1',
        events: ['message:sent'],
      })
      registry.disablePlugin('oralsin')

      await loader.loadPlugin(plugin, 'key-1', 'secret-1')

      expect(plugin.init).not.toHaveBeenCalled()
    })
  })

  describe('unloadPlugin', () => {
    it('calls destroy() on shutdown', async () => {
      const plugin = makePlugin({ name: 'oralsin' })
      await loader.loadPlugin(plugin, 'key-1', 'secret-1')

      await loader.unloadPlugin('oralsin')

      expect(plugin.destroy).toHaveBeenCalledTimes(1)
    })
  })

  describe('PluginContext.enqueue', () => {
    it('bulk inserts messages with plugin_name', async () => {
      const plugin = makePlugin({ name: 'oralsin' })
      let capturedCtx: PluginContext | null = null
      ;(plugin.init as ReturnType<typeof vi.fn>).mockImplementation(async (ctx: PluginContext) => {
        capturedCtx = ctx
      })

      await loader.loadPlugin(plugin, 'key-1', 'secret-1')

      const params = [
        makeEnqueueParams({ idempotencyKey: 'batch-1' }),
        makeEnqueueParams({ idempotencyKey: 'batch-2' }),
        makeEnqueueParams({ idempotencyKey: 'batch-3' }),
      ]

      const results = capturedCtx!.enqueue(params)

      expect(results).toHaveLength(3)
      results.forEach((msg) => {
        expect(msg.pluginName).toBe('oralsin')
        expect(msg.status).toBe('queued')
      })
    })

    it('stores senders as JSON in messages', async () => {
      const plugin = makePlugin({ name: 'oralsin' })
      let capturedCtx: PluginContext | null = null
      ;(plugin.init as ReturnType<typeof vi.fn>).mockImplementation(async (ctx: PluginContext) => {
        capturedCtx = ctx
      })

      await loader.loadPlugin(plugin, 'key-1', 'secret-1')

      const params = makeEnqueueParams({
        idempotencyKey: 'senders-test',
        senders: [
          { phone: '5537999001122', session: 'oralsin-1-4', pair: 'MG-Guaxupé', role: 'primary' },
          { phone: '5537999003344', session: 'oralsin-1-5', pair: 'MG-Backup', role: 'backup' },
        ],
      })

      capturedCtx!.enqueue([params])

      // Verify in database
      const row = db.prepare('SELECT senders_config FROM messages WHERE idempotency_key = ?').get('senders-test') as {
        senders_config: string
      }
      const senders = JSON.parse(row.senders_config)
      expect(senders).toHaveLength(2)
      expect(senders[0].role).toBe('primary')
      expect(senders[1].role).toBe('backup')
    })

    it('stores context as pass-through JSON', async () => {
      const plugin = makePlugin({ name: 'oralsin' })
      let capturedCtx: PluginContext | null = null
      ;(plugin.init as ReturnType<typeof vi.fn>).mockImplementation(async (ctx: PluginContext) => {
        capturedCtx = ctx
      })

      await loader.loadPlugin(plugin, 'key-1', 'secret-1')

      const context = { clinic_id: 'uuid-1', schedule_id: 'uuid-2', flow_step: 13, overdue_days: 331 }
      capturedCtx!.enqueue([makeEnqueueParams({ idempotencyKey: 'context-test', context })])

      const row = db.prepare('SELECT context FROM messages WHERE idempotency_key = ?').get('context-test') as {
        context: string
      }
      expect(JSON.parse(row.context)).toEqual(context)
    })

    it('merges send_options with defaults (max_retries and priority only)', async () => {
      const plugin = makePlugin({ name: 'oralsin' })
      let capturedCtx: PluginContext | null = null
      ;(plugin.init as ReturnType<typeof vi.fn>).mockImplementation(async (ctx: PluginContext) => {
        capturedCtx = ctx
      })

      await loader.loadPlugin(plugin, 'key-1', 'secret-1')

      capturedCtx!.enqueue([
        makeEnqueueParams({
          idempotencyKey: 'options-test',
          sendOptions: { maxRetries: 5, priority: 'high' },
        }),
      ])

      const row = db
        .prepare('SELECT priority, max_retries FROM messages WHERE idempotency_key = ?')
        .get('options-test') as { priority: number; max_retries: number }

      // 'high' priority should map to a lower number (higher priority in queue)
      expect(row.priority).toBeLessThan(5) // default is 5, high should be lower
      expect(row.max_retries).toBe(5)
    })

    it('skips duplicate idempotency_key', async () => {
      const plugin = makePlugin({ name: 'oralsin' })
      let capturedCtx: PluginContext | null = null
      ;(plugin.init as ReturnType<typeof vi.fn>).mockImplementation(async (ctx: PluginContext) => {
        capturedCtx = ctx
      })

      await loader.loadPlugin(plugin, 'key-1', 'secret-1')

      const first = capturedCtx!.enqueue([makeEnqueueParams({ idempotencyKey: 'dup-key' })])
      expect(first).toHaveLength(1)

      const second = capturedCtx!.enqueue([makeEnqueueParams({ idempotencyKey: 'dup-key' })])
      expect(second).toHaveLength(0)
    })
  })

  describe('PluginContext.getQueueStats', () => {
    it('returns queue stats for plugin messages', async () => {
      const plugin = makePlugin({ name: 'oralsin' })
      let capturedCtx: PluginContext | null = null
      ;(plugin.init as ReturnType<typeof vi.fn>).mockImplementation(async (ctx: PluginContext) => {
        capturedCtx = ctx
      })

      await loader.loadPlugin(plugin, 'key-1', 'secret-1')

      // Enqueue some messages
      capturedCtx!.enqueue([
        makeEnqueueParams({ idempotencyKey: 'stats-1' }),
        makeEnqueueParams({ idempotencyKey: 'stats-2' }),
      ])

      const stats = capturedCtx!.getQueueStats()

      expect(stats.pending).toBe(2)
      expect(stats.processing).toBe(0)
      expect(stats.failedLastHour).toBe(0)
      expect(stats.oldestPendingAgeSeconds).toBeGreaterThanOrEqual(0)
    })
  })

  describe('PluginContext.registerContact', () => {
    it('routes to correct device via sender mapping and registers contact', async () => {
      const senderMapping = new SenderMapping(db)
      senderMapping.initialize()
      senderMapping.create({
        phoneNumber: '+5543996835100',
        deviceSerial: 'device-abc',
        profileId: 0,
        appPackage: 'com.whatsapp',
      })

      const mockEngine = {
        registerContact: vi.fn().mockResolvedValue('registered'),
      } as unknown as SendEngine

      const loaderWithEngine = new PluginLoader(registry, eventBus, queue, db, undefined, senderMapping, mockEngine)

      const plugin = makePlugin({ name: 'oralsin' })
      let capturedCtx: PluginContext | null = null
      ;(plugin.init as ReturnType<typeof vi.fn>).mockImplementation(async (ctx: PluginContext) => {
        capturedCtx = ctx
      })

      await loaderWithEngine.loadPlugin(plugin, 'key-1', 'secret-1')

      const result = await capturedCtx!.registerContact('+5543996835100', '5543991938235', 'Joao Silva')

      expect(result.status).toBe('registered')
      expect(mockEngine.registerContact).toHaveBeenCalledWith('device-abc', '5543991938235', 'Joao Silva')
    })

    it('returns exists when contact already on device', async () => {
      const senderMapping = new SenderMapping(db)
      senderMapping.initialize()
      senderMapping.create({
        phoneNumber: '+5543996835100',
        deviceSerial: 'device-abc',
        profileId: 0,
      })

      const mockEngine = {
        registerContact: vi.fn().mockResolvedValue('exists'),
      } as unknown as SendEngine

      const loaderWithEngine = new PluginLoader(registry, eventBus, queue, db, undefined, senderMapping, mockEngine)

      const plugin = makePlugin({ name: 'oralsin' })
      let capturedCtx: PluginContext | null = null
      ;(plugin.init as ReturnType<typeof vi.fn>).mockImplementation(async (ctx: PluginContext) => {
        capturedCtx = ctx
      })

      await loaderWithEngine.loadPlugin(plugin, 'key-1', 'secret-1')

      const result = await capturedCtx!.registerContact('+5543996835100', '5543991938235', 'Joao Silva')

      expect(result.status).toBe('exists')
    })

    it('returns error when sender has no mapping', async () => {
      const senderMapping = new SenderMapping(db)
      senderMapping.initialize()
      // No mapping created

      const mockEngine = { registerContact: vi.fn() } as unknown as SendEngine

      const loaderWithEngine = new PluginLoader(registry, eventBus, queue, db, undefined, senderMapping, mockEngine)

      const plugin = makePlugin({ name: 'oralsin' })
      let capturedCtx: PluginContext | null = null
      ;(plugin.init as ReturnType<typeof vi.fn>).mockImplementation(async (ctx: PluginContext) => {
        capturedCtx = ctx
      })

      await loaderWithEngine.loadPlugin(plugin, 'key-1', 'secret-1')

      const result = await capturedCtx!.registerContact('+5599999999999', '5543991938235', 'Joao Silva')

      expect(result.status).toBe('error')
      expect(result.error).toContain('No sender mapping')
      expect(mockEngine.registerContact).not.toHaveBeenCalled()
    })
  })
})
