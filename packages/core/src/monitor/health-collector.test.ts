import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { HealthCollector } from './health-collector.js'
import type { HealthSnapshot } from './types.js'

describe('HealthCollector', () => {
  let db: Database.Database
  let collector: HealthCollector

  const fakeShell = vi.fn<(serial: string, command: string) => Promise<string>>()

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    collector = new HealthCollector(db, { shell: fakeShell })
    collector.initialize()
    fakeShell.mockReset()
  })

  afterEach(() => {
    db.close()
  })

  describe('initialize', () => {
    it('creates health_snapshots table', () => {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='health_snapshots'")
        .all()
      expect(tables).toHaveLength(1)
    })
  })

  describe('collect', () => {
    it('returns health snapshot with all metrics', async () => {
      fakeShell.mockImplementation(async (_serial: string, cmd: string) => {
        if (cmd.includes('dumpsys battery')) return 'level: 72\ntemperature: 310'
        if (cmd.includes('/proc/meminfo')) return 'MemAvailable:   1024000 kB'
        if (cmd.includes('df /data')) return 'Filesystem  1K-blocks  Used  Available\n/dev/block  32000000  20000000  12000000'
        if (cmd.includes('dumpsys wifi')) return 'Wi-Fi is enabled\nmFrequencyBand: 0\nSSID: "MyWiFi"'
        return ''
      })

      const snapshot = await collector.collect('ABC123')

      expect(snapshot.serial).toBe('ABC123')
      expect(snapshot.batteryPercent).toBe(72)
      expect(snapshot.temperatureCelsius).toBeCloseTo(31.0)
      expect(snapshot.ramAvailableMb).toBeGreaterThan(0)
      expect(snapshot.storageFreeBytes).toBeGreaterThan(0)
      expect(snapshot.wifiConnected).toBe(true)
    })

    it('persists snapshot to SQLite', async () => {
      fakeShell.mockImplementation(async (_serial: string, cmd: string) => {
        if (cmd.includes('dumpsys battery')) return 'level: 85\ntemperature: 280'
        if (cmd.includes('/proc/meminfo')) return 'MemAvailable:   2048000 kB'
        if (cmd.includes('df /data')) return 'Filesystem  1K-blocks  Used  Available\n/dev/block  32000000  16000000  16000000'
        if (cmd.includes('dumpsys wifi')) return 'Wi-Fi is enabled'
        return ''
      })

      await collector.collect('ABC123')

      const rows = db
        .prepare('SELECT * FROM health_snapshots WHERE serial = ?')
        .all('ABC123')
      expect(rows).toHaveLength(1)
    })

    it('handles missing battery info gracefully', async () => {
      fakeShell.mockImplementation(async () => '')

      const snapshot = await collector.collect('ABC123')

      expect(snapshot.batteryPercent).toBe(-1)
      expect(snapshot.temperatureCelsius).toBe(-1)
    })
  })

  describe('getHistory', () => {
    it('returns snapshots for device within time range', async () => {
      // Insert 3 snapshots manually
      const stmt = db.prepare(`
        INSERT INTO health_snapshots (serial, battery_percent, temperature_celsius, ram_available_mb, storage_free_bytes, wifi_connected, collected_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      stmt.run('ABC123', 80, 30.0, 1024, 12000000000, 1, '2026-04-02T10:00:00Z')
      stmt.run('ABC123', 75, 31.0, 900, 11000000000, 1, '2026-04-02T11:00:00Z')
      stmt.run('ABC123', 70, 32.0, 800, 10000000000, 1, '2026-04-02T12:00:00Z')

      const history = collector.getHistory('ABC123', 24)

      expect(history).toHaveLength(3)
      expect(history[0].batteryPercent).toBe(80)
    })

    it('returns empty array for unknown device', () => {
      const history = collector.getHistory('UNKNOWN', 24)
      expect(history).toHaveLength(0)
    })

    it('excludes snapshots outside time range', async () => {
      const stmt = db.prepare(`
        INSERT INTO health_snapshots (serial, battery_percent, temperature_celsius, ram_available_mb, storage_free_bytes, wifi_connected, collected_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      stmt.run('ABC123', 80, 30.0, 1024, 12000000000, 1, '2026-03-01T10:00:00Z')
      stmt.run('ABC123', 75, 31.0, 900, 11000000000, 1, '2026-04-02T12:00:00Z')

      const history = collector.getHistory('ABC123', 24)

      expect(history).toHaveLength(1)
      expect(history[0].batteryPercent).toBe(75)
    })
  })

  describe('cleanup', () => {
    it('removes snapshots older than 7 days', () => {
      const stmt = db.prepare(`
        INSERT INTO health_snapshots (serial, battery_percent, temperature_celsius, ram_available_mb, storage_free_bytes, wifi_connected, collected_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      stmt.run('ABC123', 80, 30.0, 1024, 12000000000, 1, '2026-03-20T10:00:00Z')
      stmt.run('ABC123', 75, 31.0, 900, 11000000000, 1, '2026-04-02T12:00:00Z')

      const removed = collector.cleanup()

      expect(removed).toBe(1)
      const remaining = db.prepare('SELECT COUNT(*) as count FROM health_snapshots').get() as { count: number }
      expect(remaining.count).toBe(1)
    })
  })
})
