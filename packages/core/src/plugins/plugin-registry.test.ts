import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { PluginRegistry } from './plugin-registry.js'
import type { PluginRecord } from './types.js'

describe('PluginRegistry', () => {
  let db: Database.Database
  let registry: PluginRegistry

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    registry = new PluginRegistry(db)
    registry.initialize()
  })

  afterEach(() => {
    db.close()
  })

  describe('initialize', () => {
    it('creates plugins table', () => {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='plugins'")
        .all() as { name: string }[]
      expect(tables).toHaveLength(1)
    })

    it('creates failed_callbacks table', () => {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='failed_callbacks'")
        .all() as { name: string }[]
      expect(tables).toHaveLength(1)
    })
  })

  describe('register', () => {
    it('inserts a plugin record', () => {
      registry.register({
        name: 'oralsin',
        version: '1.0.0',
        webhookUrl: 'https://oralsin.debt.com.br/api/webhooks/dispatch/',
        apiKey: 'test-api-key',
        hmacSecret: 'test-hmac-secret',
        events: ['message:sent', 'message:failed'],
      })

      const plugin = registry.getPlugin('oralsin')
      expect(plugin).not.toBeNull()
      expect(plugin!.name).toBe('oralsin')
      expect(plugin!.version).toBe('1.0.0')
      expect(plugin!.webhook_url).toBe('https://oralsin.debt.com.br/api/webhooks/dispatch/')
      expect(plugin!.enabled).toBe(1)
      expect(plugin!.status).toBe('active')
    })

    it('upserts on duplicate name with new version', () => {
      registry.register({
        name: 'oralsin',
        version: '1.0.0',
        webhookUrl: 'https://oralsin.debt.com.br/api/webhooks/dispatch/',
        apiKey: 'key-1',
        hmacSecret: 'secret-1',
        events: ['message:sent'],
      })

      registry.register({
        name: 'oralsin',
        version: '1.1.0',
        webhookUrl: 'https://oralsin.debt.com.br/api/webhooks/dispatch/v2/',
        apiKey: 'key-1',
        hmacSecret: 'secret-1',
        events: ['message:sent', 'message:failed'],
      })

      const plugins = registry.listPlugins()
      expect(plugins).toHaveLength(1)
      expect(plugins[0].version).toBe('1.1.0')
    })
  })

  describe('getPlugin', () => {
    it('returns null for unknown plugin', () => {
      const plugin = registry.getPlugin('nonexistent')
      expect(plugin).toBeNull()
    })
  })

  describe('listPlugins', () => {
    it('returns all registered plugins', () => {
      registry.register({
        name: 'oralsin',
        version: '1.0.0',
        webhookUrl: 'https://oralsin.example.com/webhook',
        apiKey: 'key-1',
        hmacSecret: 'secret-1',
        events: ['message:sent'],
      })
      registry.register({
        name: 'crm-app',
        version: '0.5.0',
        webhookUrl: 'https://crm.example.com/webhook',
        apiKey: 'key-2',
        hmacSecret: 'secret-2',
        events: ['message:sent', 'message:failed'],
      })

      const plugins = registry.listPlugins()
      expect(plugins).toHaveLength(2)
    })
  })

  describe('updatePlugin', () => {
    it('updates webhook_url', () => {
      registry.register({
        name: 'oralsin',
        version: '1.0.0',
        webhookUrl: 'https://old.example.com/webhook',
        apiKey: 'key-1',
        hmacSecret: 'secret-1',
        events: ['message:sent'],
      })

      registry.updatePlugin('oralsin', { webhookUrl: 'https://new.example.com/webhook' })

      const plugin = registry.getPlugin('oralsin')
      expect(plugin!.webhook_url).toBe('https://new.example.com/webhook')
    })

    it('updates events list', () => {
      registry.register({
        name: 'oralsin',
        version: '1.0.0',
        webhookUrl: 'https://oralsin.example.com/webhook',
        apiKey: 'key-1',
        hmacSecret: 'secret-1',
        events: ['message:sent'],
      })

      registry.updatePlugin('oralsin', { events: ['message:sent', 'message:failed'] })

      const plugin = registry.getPlugin('oralsin')
      const events = JSON.parse(plugin!.events)
      expect(events).toContain('message:failed')
    })
  })

  describe('disablePlugin / enablePlugin', () => {
    it('disables a plugin', () => {
      registry.register({
        name: 'oralsin',
        version: '1.0.0',
        webhookUrl: 'https://oralsin.example.com/webhook',
        apiKey: 'key-1',
        hmacSecret: 'secret-1',
        events: ['message:sent'],
      })

      registry.disablePlugin('oralsin')

      const plugin = registry.getPlugin('oralsin')
      expect(plugin!.enabled).toBe(0)
      expect(plugin!.status).toBe('disabled')
    })

    it('enables a disabled plugin', () => {
      registry.register({
        name: 'oralsin',
        version: '1.0.0',
        webhookUrl: 'https://oralsin.example.com/webhook',
        apiKey: 'key-1',
        hmacSecret: 'secret-1',
        events: ['message:sent'],
      })
      registry.disablePlugin('oralsin')

      registry.enablePlugin('oralsin')

      const plugin = registry.getPlugin('oralsin')
      expect(plugin!.enabled).toBe(1)
      expect(plugin!.status).toBe('active')
    })
  })

  describe('deletePlugin', () => {
    it('removes plugin record', () => {
      registry.register({
        name: 'oralsin',
        version: '1.0.0',
        webhookUrl: 'https://oralsin.example.com/webhook',
        apiKey: 'key-1',
        hmacSecret: 'secret-1',
        events: ['message:sent'],
      })

      registry.deletePlugin('oralsin')

      const plugin = registry.getPlugin('oralsin')
      expect(plugin).toBeNull()
    })
  })

  describe('rotateApiKey', () => {
    it('generates a new API key', () => {
      registry.register({
        name: 'oralsin',
        version: '1.0.0',
        webhookUrl: 'https://oralsin.example.com/webhook',
        apiKey: 'old-key',
        hmacSecret: 'secret-1',
        events: ['message:sent'],
      })

      const newKey = registry.rotateApiKey('oralsin')

      expect(newKey).not.toBe('old-key')
      expect(newKey.length).toBeGreaterThan(0)

      const plugin = registry.getPlugin('oralsin')
      expect(plugin!.api_key).toBe(newKey)
    })
  })

  describe('setPluginStatus', () => {
    it('marks plugin as error', () => {
      registry.register({
        name: 'oralsin',
        version: '1.0.0',
        webhookUrl: 'https://oralsin.example.com/webhook',
        apiKey: 'key-1',
        hmacSecret: 'secret-1',
        events: ['message:sent'],
      })

      registry.setPluginStatus('oralsin', 'error')

      const plugin = registry.getPlugin('oralsin')
      expect(plugin!.status).toBe('error')
    })
  })

  describe('getPluginByApiKey', () => {
    it('returns plugin matching the API key', () => {
      registry.register({
        name: 'oralsin',
        version: '1.0.0',
        webhookUrl: 'https://oralsin.example.com/webhook',
        apiKey: 'my-secret-key',
        hmacSecret: 'secret-1',
        events: ['message:sent'],
      })

      const plugin = registry.getPluginByApiKey('my-secret-key')
      expect(plugin).not.toBeNull()
      expect(plugin!.name).toBe('oralsin')
    })

    it('returns null for unknown API key', () => {
      const plugin = registry.getPluginByApiKey('unknown-key')
      expect(plugin).toBeNull()
    })
  })

  describe('schema hardening (Batch 1)', () => {
    it('plugins timestamps use ISO 8601 with milliseconds', () => {
      registry.register({
        name: 'oralsin',
        version: '1.0.0',
        webhookUrl: 'https://oralsin.example.com/webhook',
        apiKey: 'key-1',
        hmacSecret: 'secret-1',
        events: ['message:sent'],
      })
      const plugin = registry.getPlugin('oralsin')
      expect(plugin!.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      expect(plugin!.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    })

    it('idx_failed_callbacks_retry index exists', () => {
      const indexes = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='failed_callbacks'",
      ).all() as { name: string }[]
      const names = indexes.map(i => i.name)
      expect(names).toContain('idx_failed_callbacks_retry')
    })
  })
})
