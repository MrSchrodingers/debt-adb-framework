import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { AlertSystem } from './alert-system.js'
import { DispatchEmitter } from '../events/index.js'
import type { HealthSnapshot, AlertSeverity } from './types.js'

describe('AlertSystem', () => {
  let db: Database.Database
  let emitter: DispatchEmitter
  let alerts: AlertSystem

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    emitter = new DispatchEmitter()
    alerts = new AlertSystem(db, emitter)
    alerts.initialize()
  })

  afterEach(() => {
    db.close()
  })

  describe('initialize', () => {
    it('creates alerts table', () => {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='alerts'")
        .all()
      expect(tables).toHaveLength(1)
    })

    it('creates table with required columns', () => {
      const columns = db.prepare('PRAGMA table_info(alerts)').all() as { name: string }[]
      const names = columns.map((c) => c.name)
      expect(names).toContain('id')
      expect(names).toContain('device_serial')
      expect(names).toContain('severity')
      expect(names).toContain('type')
      expect(names).toContain('message')
      expect(names).toContain('resolved')
      expect(names).toContain('resolved_at')
    })
  })

  const makeSnapshot = (overrides: Partial<HealthSnapshot> = {}): HealthSnapshot => ({
    serial: 'ABC123',
    batteryPercent: 80,
    temperatureCelsius: 30,
    ramAvailableMb: 1024,
    storageFreeBytes: 2_000_000_000,
    wifiConnected: true,
    collectedAt: new Date().toISOString(),
    ...overrides,
  })

  describe('battery alerts', () => {
    it('generates high alert when battery < 15%', () => {
      alerts.evaluate(makeSnapshot({ batteryPercent: 14 }))

      const active = alerts.getActive('ABC123')
      expect(active).toHaveLength(1)
      expect(active[0].type).toBe('battery_low')
      expect(active[0].severity).toBe('high')
    })

    it('generates critical alert when battery < 5%', () => {
      alerts.evaluate(makeSnapshot({ batteryPercent: 4 }))

      const active = alerts.getActive('ABC123')
      const critical = active.filter((a) => a.severity === 'critical')
      expect(critical).toHaveLength(1)
      expect(critical[0].type).toBe('battery_critical')
    })

    it('does not generate alert when battery is normal', () => {
      alerts.evaluate(makeSnapshot({ batteryPercent: 80 }))

      const active = alerts.getActive('ABC123')
      expect(active).toHaveLength(0)
    })
  })

  describe('RAM alerts', () => {
    it('generates high alert when RAM < 200MB', () => {
      alerts.evaluate(makeSnapshot({ ramAvailableMb: 150 }))

      const active = alerts.getActive('ABC123')
      const ram = active.filter((a) => a.type === 'ram_low')
      expect(ram).toHaveLength(1)
      expect(ram[0].severity).toBe('high')
    })
  })

  describe('temperature alerts', () => {
    it('generates high alert when temp > 40°C', () => {
      alerts.evaluate(makeSnapshot({ temperatureCelsius: 41 }))

      const active = alerts.getActive('ABC123')
      const temp = active.filter((a) => a.type === 'temperature_high')
      expect(temp).toHaveLength(1)
      expect(temp[0].severity).toBe('high')
    })

    it('generates critical alert when temp > 45°C', () => {
      alerts.evaluate(makeSnapshot({ temperatureCelsius: 46 }))

      const active = alerts.getActive('ABC123')
      const critical = active.filter((a) => a.severity === 'critical')
      expect(critical).toHaveLength(1)
      expect(critical[0].type).toBe('temperature_critical')
    })
  })

  describe('storage alerts', () => {
    it('generates medium alert when storage < 500MB', () => {
      alerts.evaluate(makeSnapshot({ storageFreeBytes: 400_000_000 }))

      const active = alerts.getActive('ABC123')
      const storage = active.filter((a) => a.type === 'storage_low')
      expect(storage).toHaveLength(1)
      expect(storage[0].severity).toBe('medium')
    })
  })

  describe('device offline alert', () => {
    it('generates high alert for device offline', () => {
      alerts.evaluateOffline('ABC123')

      const active = alerts.getActive('ABC123')
      expect(active).toHaveLength(1)
      expect(active[0].type).toBe('device_offline')
      expect(active[0].severity).toBe('high')
    })
  })

  describe('auto-resolve', () => {
    it('resolves battery alert when battery returns to normal', () => {
      alerts.evaluate(makeSnapshot({ batteryPercent: 10 }))
      expect(alerts.getActive('ABC123')).toHaveLength(1)

      alerts.evaluate(makeSnapshot({ batteryPercent: 50 }))
      expect(alerts.getActive('ABC123')).toHaveLength(0)
    })

    it('resolves offline alert when device comes back', () => {
      alerts.evaluateOffline('ABC123')
      expect(alerts.getActive('ABC123')).toHaveLength(1)

      alerts.resolveByType('ABC123', 'device_offline')
      expect(alerts.getActive('ABC123')).toHaveLength(0)
    })

    it('sets resolved_at timestamp on auto-resolve', () => {
      alerts.evaluate(makeSnapshot({ batteryPercent: 10 }))
      alerts.evaluate(makeSnapshot({ batteryPercent: 50 }))

      const all = alerts.getAll('ABC123')
      expect(all).toHaveLength(1)
      expect(all[0].resolved).toBe(1)
      expect(all[0].resolvedAt).toBeDefined()
    })
  })

  describe('deduplication', () => {
    it('does not create duplicate active alert for same condition', () => {
      alerts.evaluate(makeSnapshot({ batteryPercent: 10 }))
      alerts.evaluate(makeSnapshot({ batteryPercent: 8 }))

      const active = alerts.getActive('ABC123')
      const battery = active.filter((a) => a.type === 'battery_low')
      expect(battery).toHaveLength(1)
    })
  })

  describe('per-device threshold override', () => {
    it('uses device-specific threshold when set', () => {
      alerts.setDeviceThresholds('ABC123', { battery_low: 10 })

      // 12% is below global 15% but above device override 10%
      alerts.evaluate(makeSnapshot({ batteryPercent: 12 }))

      const active = alerts.getActive('ABC123')
      expect(active).toHaveLength(0)
    })

    it('falls back to global threshold when device override not set', () => {
      alerts.evaluate(makeSnapshot({ batteryPercent: 12 }))

      const active = alerts.getActive('ABC123')
      expect(active).toHaveLength(1)
    })
  })

  describe('emitter integration', () => {
    it('emits alert:new when alert is created', () => {
      const events: unknown[] = []
      emitter.on('alert:new', (data) => events.push(data))

      alerts.evaluate(makeSnapshot({ batteryPercent: 10 }))

      expect(events).toHaveLength(1)
      expect(events[0]).toEqual(
        expect.objectContaining({ type: 'battery_low', severity: 'high' }),
      )
    })
  })

  describe('getAll', () => {
    it('returns both active and resolved alerts', () => {
      alerts.evaluate(makeSnapshot({ batteryPercent: 10 }))
      alerts.evaluate(makeSnapshot({ batteryPercent: 50 }))
      alerts.evaluate(makeSnapshot({ ramAvailableMb: 100 }))

      const all = alerts.getAll('ABC123')
      expect(all).toHaveLength(2)
    })
  })
})
