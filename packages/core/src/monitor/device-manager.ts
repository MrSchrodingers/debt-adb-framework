import type Database from 'better-sqlite3'
import type { DispatchEmitter } from '../events/index.js'
import type { DeviceInfo } from '../adb/types.js'
import type { DeviceRecord } from './types.js'

interface DiscoverFn {
  discover: () => Promise<DeviceInfo[]>
}

export class DeviceManager {
  private db: Database.Database
  private emitter: DispatchEmitter
  private adb: DiscoverFn
  private pollInterval: ReturnType<typeof setInterval> | null = null

  constructor(db: Database.Database, emitter: DispatchEmitter, adb: DiscoverFn) {
    this.db = db
    this.emitter = emitter
    this.adb = adb
  }

  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS devices (
        serial TEXT PRIMARY KEY,
        brand TEXT,
        model TEXT,
        status TEXT NOT NULL DEFAULT 'offline',
        last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        alert_thresholds TEXT
      )
    `)
  }

  async poll(): Promise<void> {
    const discovered = await this.adb.discover()
    const discoveredSerials = new Set(discovered.map((d) => d.serial))

    // Mark missing devices as offline
    const known = this.db
      .prepare("SELECT serial, status FROM devices WHERE status != 'offline'")
      .all() as { serial: string; status: string }[]

    for (const row of known) {
      if (!discoveredSerials.has(row.serial)) {
        this.db
          .prepare("UPDATE devices SET status = 'offline' WHERE serial = ?")
          .run(row.serial)
        this.emitter.emit('device:disconnected', { serial: row.serial })
      }
    }

    // Upsert discovered devices
    for (const device of discovered) {
      const status = device.type === 'device' ? 'online' : device.type === 'unauthorized' ? 'unauthorized' : 'offline'
      const existing = this.db
        .prepare('SELECT serial, status FROM devices WHERE serial = ?')
        .get(device.serial) as { serial: string; status: string } | undefined

      if (existing) {
        this.db
          .prepare("UPDATE devices SET brand = COALESCE(?, brand), model = COALESCE(?, model), status = ?, last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE serial = ?")
          .run(device.brand ?? null, device.model ?? null, status, device.serial)

        if (status === 'online' && existing.status !== 'online') {
          this.emitter.emit('device:connected', {
            serial: device.serial,
            brand: device.brand,
            model: device.model,
          })
        }
      } else {
        this.db
          .prepare("INSERT INTO devices (serial, brand, model, status, last_seen_at) VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))")
          .run(device.serial, device.brand ?? null, device.model ?? null, status)

        if (status === 'online') {
          this.emitter.emit('device:connected', {
            serial: device.serial,
            brand: device.brand,
            model: device.model,
          })
        }
      }
    }
  }

  startPolling(intervalMs = 5000): void {
    this.pollInterval = setInterval(() => {
      this.poll().catch(() => {})
    }, intervalMs)
  }

  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval)
      this.pollInterval = null
    }
  }

  getDevices(): DeviceRecord[] {
    const rows = this.db.prepare('SELECT * FROM devices').all() as Record<string, unknown>[]
    return rows.map(rowToDevice)
  }

  getDevice(serial: string): DeviceRecord | null {
    const row = this.db
      .prepare('SELECT * FROM devices WHERE serial = ?')
      .get(serial) as Record<string, unknown> | undefined
    return row ? rowToDevice(row) : null
  }
}

function rowToDevice(row: Record<string, unknown>): DeviceRecord {
  return {
    serial: row.serial as string,
    brand: row.brand as string | null,
    model: row.model as string | null,
    status: row.status as DeviceRecord['status'],
    lastSeenAt: row.last_seen_at as string,
    alertThresholds: row.alert_thresholds as string | null,
  }
}
