import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { PluginEventBus } from './plugin-event-bus.js'
import { PluginRegistry } from './plugin-registry.js'
import { DispatchEmitter } from '../events/index.js'
import type { DispatchEventName } from '../events/index.js'

describe('PluginEventBus', () => {
  let db: Database.Database
  let registry: PluginRegistry
  let emitter: DispatchEmitter
  let eventBus: PluginEventBus

  const registerOralsin = (events: DispatchEventName[] = ['message:sent', 'message:failed']) => {
    registry.register({
      name: 'oralsin',
      version: '1.0.0',
      webhookUrl: 'https://oralsin.example.com/webhook',
      apiKey: 'key-1',
      hmacSecret: 'secret-1',
      events,
    })
  }

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    registry = new PluginRegistry(db)
    registry.initialize()
    emitter = new DispatchEmitter()
    eventBus = new PluginEventBus(registry, emitter)
  })

  afterEach(() => {
    eventBus.destroy()
    db.close()
  })

  describe('event dispatch', () => {
    it('calls handler for subscribed plugin', async () => {
      registerOralsin(['message:sent'])
      const handler = vi.fn<(data: unknown) => Promise<void>>().mockResolvedValue(undefined)
      eventBus.registerHandler('oralsin', 'message:sent', handler)

      emitter.emit('message:sent', {
        id: 'msg-1',
        sentAt: '2026-04-02T15:00:00Z',
        durationMs: 5000,
      })

      // Allow async dispatch
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1))
    })

    it('does not call handler for unsubscribed event', async () => {
      registerOralsin(['message:sent'])
      const handler = vi.fn<(data: unknown) => Promise<void>>().mockResolvedValue(undefined)
      eventBus.registerHandler('oralsin', 'message:sent', handler)

      emitter.emit('message:failed', { id: 'msg-1', error: 'timeout' })

      await new Promise((r) => setTimeout(r, 50))
      expect(handler).not.toHaveBeenCalled()
    })

    it('does not dispatch to disabled plugin', async () => {
      registerOralsin(['message:sent'])
      const handler = vi.fn<(data: unknown) => Promise<void>>().mockResolvedValue(undefined)
      eventBus.registerHandler('oralsin', 'message:sent', handler)
      registry.disablePlugin('oralsin')

      emitter.emit('message:sent', {
        id: 'msg-1',
        sentAt: '2026-04-02T15:00:00Z',
        durationMs: 5000,
      })

      await new Promise((r) => setTimeout(r, 50))
      expect(handler).not.toHaveBeenCalled()
    })

    it('dispatches to multiple plugins subscribed to same event', async () => {
      registerOralsin(['message:sent'])
      registry.register({
        name: 'crm-app',
        version: '1.0.0',
        webhookUrl: 'https://crm.example.com/webhook',
        apiKey: 'key-2',
        hmacSecret: 'secret-2',
        events: ['message:sent'],
      })

      const handler1 = vi.fn<(data: unknown) => Promise<void>>().mockResolvedValue(undefined)
      const handler2 = vi.fn<(data: unknown) => Promise<void>>().mockResolvedValue(undefined)
      eventBus.registerHandler('oralsin', 'message:sent', handler1)
      eventBus.registerHandler('crm-app', 'message:sent', handler2)

      emitter.emit('message:sent', {
        id: 'msg-1',
        sentAt: '2026-04-02T15:00:00Z',
        durationMs: 5000,
      })

      await vi.waitFor(() => {
        expect(handler1).toHaveBeenCalledTimes(1)
        expect(handler2).toHaveBeenCalledTimes(1)
      })
    })
  })

  describe('error isolation', () => {
    it('isolates handler errors — plugin throws, core continues', async () => {
      registerOralsin(['message:sent'])
      registry.register({
        name: 'crm-app',
        version: '1.0.0',
        webhookUrl: 'https://crm.example.com/webhook',
        apiKey: 'key-2',
        hmacSecret: 'secret-2',
        events: ['message:sent'],
      })

      const throwingHandler = vi
        .fn<(data: unknown) => Promise<void>>()
        .mockRejectedValue(new Error('plugin crash'))
      const healthyHandler = vi.fn<(data: unknown) => Promise<void>>().mockResolvedValue(undefined)

      eventBus.registerHandler('oralsin', 'message:sent', throwingHandler)
      eventBus.registerHandler('crm-app', 'message:sent', healthyHandler)

      emitter.emit('message:sent', {
        id: 'msg-1',
        sentAt: '2026-04-02T15:00:00Z',
        durationMs: 5000,
      })

      await vi.waitFor(() => {
        expect(throwingHandler).toHaveBeenCalledTimes(1)
        expect(healthyHandler).toHaveBeenCalledTimes(1)
      })
    })

    it('times out handler after 5 seconds', async () => {
      registerOralsin(['message:sent'])
      const slowHandler = vi.fn<(data: unknown) => Promise<void>>().mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 10_000)), // 10s — exceeds 5s timeout
      )
      eventBus.registerHandler('oralsin', 'message:sent', slowHandler)

      const errors: { pluginName: string; event: string; error: Error }[] = []
      eventBus.onError((pluginName, event, err) => errors.push({ pluginName, event, error: err }))

      emitter.emit('message:sent', {
        id: 'msg-1',
        sentAt: '2026-04-02T15:00:00Z',
        durationMs: 5000,
      })

      await vi.waitFor(
        () => {
          expect(errors).toHaveLength(1)
          expect(errors[0].pluginName).toBe('oralsin')
          expect(errors[0].event).toBe('message:sent')
          expect(errors[0].error.message).toContain('timeout')
        },
        { timeout: 7000 },
      )
    }, 10_000)
  })

  describe('enriched events', () => {
    it('passes enriched event data to handler', async () => {
      registerOralsin(['message:sent'])
      let receivedData: unknown = null
      const handler = vi.fn<(data: unknown) => Promise<void>>().mockImplementation(async (data) => {
        receivedData = data
      })
      eventBus.registerHandler('oralsin', 'message:sent', handler)

      emitter.emit('message:sent', {
        id: 'msg-1',
        sentAt: '2026-04-02T15:00:00Z',
        durationMs: 5000,
        // Enriched fields (Phase 7):
        idempotencyKey: 'oralsin-sched-abc123',
        senderPhone: '5537999001122',
        senderSession: 'oralsin-1-4',
        pairUsed: 'MG-Guaxupé',
        pluginName: 'oralsin',
      })

      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1))

      const data = receivedData as Record<string, unknown>
      expect(data.idempotencyKey).toBe('oralsin-sched-abc123')
      expect(data.senderPhone).toBe('5537999001122')
      expect(data.pluginName).toBe('oralsin')
    })
  })
})
