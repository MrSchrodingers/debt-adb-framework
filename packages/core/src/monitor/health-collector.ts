import type Database from 'better-sqlite3'
import type { HealthSnapshot } from './types.js'

interface AdbShellAdapter {
  shell: (serial: string, command: string) => Promise<string>
}

export class HealthCollector {
  private db: Database.Database
  private adb: AdbShellAdapter

  constructor(db: Database.Database, adb: AdbShellAdapter) {
    this.db = db
    this.adb = adb
  }

  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS health_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        serial TEXT NOT NULL,
        battery_percent INTEGER NOT NULL,
        temperature_celsius REAL NOT NULL,
        ram_available_mb INTEGER NOT NULL,
        storage_free_bytes INTEGER NOT NULL,
        wifi_connected INTEGER NOT NULL DEFAULT 0,
        collected_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE INDEX IF NOT EXISTS idx_health_serial_time ON health_snapshots(serial, collected_at);
    `)
  }

  async collect(serial: string): Promise<HealthSnapshot> {
    const [battery, ram, storage, wifi] = await Promise.all([
      this.collectBattery(serial),
      this.collectRam(serial),
      this.collectStorage(serial),
      this.collectWifi(serial),
    ])

    const snapshot: HealthSnapshot = {
      serial,
      batteryPercent: battery.level,
      temperatureCelsius: battery.temperature,
      ramAvailableMb: ram,
      storageFreeBytes: storage,
      wifiConnected: wifi,
      collectedAt: new Date().toISOString(),
    }

    this.db
      .prepare(
        'INSERT INTO health_snapshots (serial, battery_percent, temperature_celsius, ram_available_mb, storage_free_bytes, wifi_connected) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(serial, snapshot.batteryPercent, snapshot.temperatureCelsius, snapshot.ramAvailableMb, snapshot.storageFreeBytes, snapshot.wifiConnected ? 1 : 0)

    return snapshot
  }

  getHistory(serial: string, hours: number): HealthSnapshot[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM health_snapshots WHERE serial = ? AND collected_at > datetime('now', ? || ' hours') ORDER BY collected_at ASC",
      )
      .all(serial, `-${hours}`) as Record<string, unknown>[]

    return rows.map(rowToSnapshot)
  }

  cleanup(): number {
    const result = this.db
      .prepare("DELETE FROM health_snapshots WHERE collected_at < datetime('now', '-7 days')")
      .run()
    return result.changes
  }

  private async collectBattery(serial: string): Promise<{ level: number; temperature: number }> {
    const output = await this.adb.shell(serial, 'dumpsys battery')
    const levelMatch = output.match(/level:\s*(\d+)/)
    const tempMatch = output.match(/temperature:\s*(\d+)/)
    return {
      level: levelMatch ? parseInt(levelMatch[1], 10) : -1,
      temperature: tempMatch ? parseInt(tempMatch[1], 10) / 10 : -1,
    }
  }

  private async collectRam(serial: string): Promise<number> {
    const output = await this.adb.shell(serial, 'cat /proc/meminfo')
    const match = output.match(/MemAvailable:\s*(\d+)\s*kB/)
    return match ? Math.round(parseInt(match[1], 10) / 1024) : 0
  }

  private async collectStorage(serial: string): Promise<number> {
    const output = await this.adb.shell(serial, 'df /data')
    const lines = output.split('\n')
    if (lines.length < 2) return 0
    const parts = lines[1].trim().split(/\s+/)
    // df output: Filesystem 1K-blocks Used Available ...
    return parts.length >= 4 ? parseInt(parts[3], 10) * 1024 : 0
  }

  private async collectWifi(serial: string): Promise<boolean> {
    const output = await this.adb.shell(serial, 'dumpsys wifi')
    return output.includes('Wi-Fi is enabled')
  }
}

function rowToSnapshot(row: Record<string, unknown>): HealthSnapshot {
  return {
    serial: row.serial as string,
    batteryPercent: row.battery_percent as number,
    temperatureCelsius: row.temperature_celsius as number,
    ramAvailableMb: row.ram_available_mb as number,
    storageFreeBytes: row.storage_free_bytes as number,
    wifiConnected: (row.wifi_connected as number) === 1,
    collectedAt: row.collected_at as string,
  }
}
