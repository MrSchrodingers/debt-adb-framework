import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { DeviceManager } from './device-manager.js'
import { DispatchEmitter } from '../events/index.js'
import type { DeviceInfo } from '../adb/types.js'

describe('DeviceManager', () => {
  let db: Database.Database
  let emitter: DispatchEmitter
  let manager: DeviceManager

  const fakeDiscover = vi.fn<() => Promise<DeviceInfo[]>>()

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    emitter = new DispatchEmitter()
    manager = new DeviceManager(db, emitter, { discover: fakeDiscover })
    manager.initialize()
    fakeDiscover.mockReset()
  })

  afterEach(() => {
    manager.stop()
    db.close()
  })

  describe('initialize', () => {
    it('creates devices table in SQLite', () => {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='devices'")
        .all()
      expect(tables).toHaveLength(1)
    })

    it('creates devices table with required columns', () => {
      const columns = db.prepare('PRAGMA table_info(devices)').all() as { name: string }[]
      const names = columns.map((c) => c.name)
      expect(names).toContain('serial')
      expect(names).toContain('brand')
      expect(names).toContain('model')
      expect(names).toContain('status')
      expect(names).toContain('last_seen_at')
      expect(names).toContain('alert_thresholds')
    })
  })

  describe('poll', () => {
    it('stores discovered device in SQLite', async () => {
      fakeDiscover.mockResolvedValueOnce([
        { serial: 'ABC123', type: 'device', brand: 'Xiaomi', model: 'POCO' },
      ])

      await manager.poll()

      const row = db
        .prepare('SELECT * FROM devices WHERE serial = ?')
        .get('ABC123') as Record<string, unknown>
      expect(row).toBeDefined()
      expect(row.brand).toBe('Xiaomi')
      expect(row.status).toBe('online')
    })

    it('emits device:connected for new device', async () => {
      const events: unknown[] = []
      emitter.on('device:connected', (data) => events.push(data))

      fakeDiscover.mockResolvedValueOnce([
        { serial: 'ABC123', type: 'device', brand: 'Xiaomi', model: 'POCO' },
      ])

      await manager.poll()

      expect(events).toHaveLength(1)
      expect(events[0]).toEqual(
        expect.objectContaining({ serial: 'ABC123', brand: 'Xiaomi' }),
      )
    })

    it('emits device:disconnected when device disappears', async () => {
      fakeDiscover.mockResolvedValueOnce([
        { serial: 'ABC123', type: 'device', brand: 'Xiaomi', model: 'POCO' },
      ])
      await manager.poll()

      const events: unknown[] = []
      emitter.on('device:disconnected', (data) => events.push(data))

      fakeDiscover.mockResolvedValueOnce([])
      await manager.poll()

      expect(events).toHaveLength(1)
      expect(events[0]).toEqual(expect.objectContaining({ serial: 'ABC123' }))
    })

    it('does not emit device:connected for already-known online device', async () => {
      fakeDiscover.mockResolvedValue([
        { serial: 'ABC123', type: 'device', brand: 'Xiaomi', model: 'POCO' },
      ])

      await manager.poll()

      const events: unknown[] = []
      emitter.on('device:connected', (data) => events.push(data))
      await manager.poll()

      expect(events).toHaveLength(0)
    })

    it('handles unauthorized device without emitting connected', async () => {
      const events: unknown[] = []
      emitter.on('device:connected', (data) => events.push(data))

      fakeDiscover.mockResolvedValueOnce([
        { serial: 'XYZ789', type: 'unauthorized' },
      ])

      await manager.poll()

      expect(events).toHaveLength(0)
      const row = db
        .prepare('SELECT * FROM devices WHERE serial = ?')
        .get('XYZ789') as Record<string, unknown>
      expect(row).toBeDefined()
      expect(row.status).toBe('unauthorized')
    })

    it('updates status to offline when device disconnects', async () => {
      fakeDiscover.mockResolvedValueOnce([
        { serial: 'ABC123', type: 'device', brand: 'Xiaomi', model: 'POCO' },
      ])
      await manager.poll()

      fakeDiscover.mockResolvedValueOnce([])
      await manager.poll()

      const row = db
        .prepare('SELECT * FROM devices WHERE serial = ?')
        .get('ABC123') as Record<string, unknown>
      expect(row.status).toBe('offline')
    })

    it('re-emits device:connected when offline device comes back', async () => {
      fakeDiscover.mockResolvedValueOnce([
        { serial: 'ABC123', type: 'device', brand: 'Xiaomi', model: 'POCO' },
      ])
      await manager.poll()

      fakeDiscover.mockResolvedValueOnce([])
      await manager.poll()

      const events: unknown[] = []
      emitter.on('device:connected', (data) => events.push(data))

      fakeDiscover.mockResolvedValueOnce([
        { serial: 'ABC123', type: 'device', brand: 'Xiaomi', model: 'POCO' },
      ])
      await manager.poll()

      expect(events).toHaveLength(1)
    })
  })

  describe('getDevices', () => {
    it('returns all known devices', async () => {
      fakeDiscover.mockResolvedValueOnce([
        { serial: 'DEV1', type: 'device', brand: 'Xiaomi', model: 'POCO' },
        { serial: 'DEV2', type: 'device', brand: 'Samsung', model: 'Galaxy' },
      ])
      await manager.poll()

      const devices = manager.getDevices()
      expect(devices).toHaveLength(2)
    })

    it('returns empty array when no devices', () => {
      const devices = manager.getDevices()
      expect(devices).toHaveLength(0)
    })
  })

  describe('getDevice', () => {
    it('returns device by serial', async () => {
      fakeDiscover.mockResolvedValueOnce([
        { serial: 'ABC123', type: 'device', brand: 'Xiaomi', model: 'POCO' },
      ])
      await manager.poll()

      const device = manager.getDevice('ABC123')
      expect(device).toBeDefined()
      expect(device!.serial).toBe('ABC123')
    })

    it('returns null for unknown serial', () => {
      const device = manager.getDevice('UNKNOWN')
      expect(device).toBeNull()
    })
  })
})
