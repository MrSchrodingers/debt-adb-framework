import type Database from 'better-sqlite3'
import { nanoid } from 'nanoid'
import type { DispatchEmitter } from '../events/index.js'
import type { HealthSnapshot, Alert, AlertType, AlertSeverity } from './types.js'

interface ThresholdConfig {
  battery_low: number
  battery_critical: number
  ram_low: number
  temperature_high: number
  temperature_critical: number
  storage_low: number
}

const GLOBAL_THRESHOLDS: ThresholdConfig = {
  battery_low: 15,
  battery_critical: 5,
  ram_low: 200,
  temperature_high: 40,
  temperature_critical: 45,
  storage_low: 500_000_000,
}

interface ThresholdCheck {
  type: AlertType
  severity: AlertSeverity
  triggered: boolean
  message: string
}

export class AlertSystem {
  private db: Database.Database
  private emitter: DispatchEmitter
  private deviceOverrides = new Map<string, Partial<ThresholdConfig>>()

  constructor(db: Database.Database, emitter: DispatchEmitter) {
    this.db = db
    this.emitter = emitter
  }

  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS alerts (
        id TEXT PRIMARY KEY,
        device_serial TEXT NOT NULL,
        severity TEXT NOT NULL,
        type TEXT NOT NULL,
        message TEXT NOT NULL,
        resolved INTEGER NOT NULL DEFAULT 0,
        resolved_at TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE INDEX IF NOT EXISTS idx_alerts_device ON alerts(device_serial, resolved);
    `)
  }

  evaluate(snapshot: HealthSnapshot): void {
    const thresholds = this.getThresholds(snapshot.serial)

    const checks: ThresholdCheck[] = [
      {
        type: 'battery_low',
        severity: 'high',
        triggered: snapshot.batteryPercent < thresholds.battery_low,
        message: `Battery at ${snapshot.batteryPercent}%`,
      },
      {
        type: 'battery_critical',
        severity: 'critical',
        triggered: snapshot.batteryPercent < thresholds.battery_critical,
        message: `Battery critically low at ${snapshot.batteryPercent}%`,
      },
      {
        type: 'ram_low',
        severity: 'high',
        triggered: snapshot.ramAvailableMb < thresholds.ram_low,
        message: `RAM available: ${snapshot.ramAvailableMb}MB`,
      },
      {
        type: 'temperature_high',
        severity: 'high',
        triggered: snapshot.temperatureCelsius > thresholds.temperature_high,
        message: `Temperature: ${snapshot.temperatureCelsius}C`,
      },
      {
        type: 'temperature_critical',
        severity: 'critical',
        triggered: snapshot.temperatureCelsius > thresholds.temperature_critical,
        message: `Temperature critically high: ${snapshot.temperatureCelsius}C`,
      },
      {
        type: 'storage_low',
        severity: 'medium',
        triggered: snapshot.storageFreeBytes < thresholds.storage_low,
        message: `Storage free: ${Math.round(snapshot.storageFreeBytes / 1_000_000)}MB`,
      },
    ]

    for (const check of checks) {
      if (check.triggered) {
        this.createIfNotExists(snapshot.serial, check.type, check.severity, check.message)
      } else {
        this.resolveByType(snapshot.serial, check.type)
      }
    }
  }

  evaluateOffline(serial: string): void {
    this.createIfNotExists(serial, 'device_offline', 'high', `Device ${serial} is offline`)
  }

  resolveByType(serial: string, type: string): void {
    this.db
      .prepare(
        "UPDATE alerts SET resolved = 1, resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE device_serial = ? AND type = ? AND resolved = 0",
      )
      .run(serial, type)
  }

  getActive(serial: string): Alert[] {
    const rows = this.db
      .prepare('SELECT * FROM alerts WHERE device_serial = ? AND resolved = 0 ORDER BY created_at DESC')
      .all(serial) as Record<string, unknown>[]
    return rows.map(rowToAlert)
  }

  getAll(serial: string): Alert[] {
    const rows = this.db
      .prepare('SELECT * FROM alerts WHERE device_serial = ? ORDER BY created_at DESC')
      .all(serial) as Record<string, unknown>[]
    return rows.map(rowToAlert)
  }

  setDeviceThresholds(serial: string, overrides: Partial<ThresholdConfig>): void {
    this.deviceOverrides.set(serial, overrides)
  }

  private getThresholds(serial: string): ThresholdConfig {
    const overrides = this.deviceOverrides.get(serial)
    if (!overrides) return GLOBAL_THRESHOLDS
    return { ...GLOBAL_THRESHOLDS, ...overrides }
  }

  private createIfNotExists(serial: string, type: AlertType, severity: AlertSeverity, message: string): void {
    const existing = this.db
      .prepare('SELECT id FROM alerts WHERE device_serial = ? AND type = ? AND resolved = 0')
      .get(serial, type)

    if (existing) return

    const id = nanoid()
    this.db
      .prepare('INSERT INTO alerts (id, device_serial, severity, type, message) VALUES (?, ?, ?, ?, ?)')
      .run(id, serial, severity, type, message)

    this.emitter.emit('alert:new', { id, deviceSerial: serial, severity, type, message })
  }
}

function rowToAlert(row: Record<string, unknown>): Alert {
  return {
    id: row.id as string,
    deviceSerial: row.device_serial as string,
    severity: row.severity as AlertSeverity,
    type: row.type as AlertType,
    message: row.message as string,
    resolved: row.resolved as number,
    resolvedAt: row.resolved_at as string | null,
    createdAt: row.created_at as string,
  }
}
