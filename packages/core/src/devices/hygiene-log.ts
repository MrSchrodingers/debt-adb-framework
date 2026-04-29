import type Database from 'better-sqlite3'
import { nanoid } from 'nanoid'

/**
 * Persistent audit log of every hygienize execution (manual + auto).
 *
 * Both the manual REST endpoint and the auto-trigger on device:connected
 * write here, so operators can answer "when was this device last
 * hygienized?" at a glance.
 *
 * Idempotency: each invocation creates a new row. Multiple in-flight calls
 * for the same device are prevented at the orchestration layer (mutex on
 * device_serial).
 */
export type HygieneTriggerSource =
  | 'auto:device_connected'
  | 'manual:operator'
  | 'manual:api'

export type HygieneStatus = 'running' | 'completed' | 'failed'

export interface HygieneLogRow {
  id: string
  device_serial: string
  triggered_by: HygieneTriggerSource
  started_at: string
  finished_at: string | null
  status: HygieneStatus
  profiles_processed_json: string | null
  bloat_removed_count: number | null
  per_profile_log_json: string | null
  survived_packages_json: string | null
  error_msg: string | null
}

export interface StartLogInput {
  device_serial: string
  triggered_by: HygieneTriggerSource
}

export interface FinishLogInput {
  status: HygieneStatus
  profiles_processed?: number[]
  bloat_removed_count?: number
  per_profile_log?: Record<number, string>
  survived_packages?: Record<number, string[]>
  error_msg?: string | null
}

export class HygieneLog {
  constructor(private db: Database.Database) {}

  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS device_hygiene_log (
        id TEXT PRIMARY KEY,
        device_serial TEXT NOT NULL,
        triggered_by TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL,
        profiles_processed_json TEXT,
        bloat_removed_count INTEGER,
        per_profile_log_json TEXT,
        survived_packages_json TEXT,
        error_msg TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_dhl_device ON device_hygiene_log(device_serial, finished_at);
      CREATE INDEX IF NOT EXISTS idx_dhl_status ON device_hygiene_log(status);
    `)

    const cols = this.db.prepare('PRAGMA table_info(device_hygiene_log)').all() as { name: string }[]
    if (!cols.some((c) => c.name === 'survived_packages_json')) {
      this.db.exec('ALTER TABLE device_hygiene_log ADD COLUMN survived_packages_json TEXT')
    }
  }

  start(input: StartLogInput): string {
    const id = nanoid()
    this.db
      .prepare(
        `INSERT INTO device_hygiene_log (
          id, device_serial, triggered_by, started_at, status
        ) VALUES (?, ?, ?, ?, 'running')`,
      )
      .run(id, input.device_serial, input.triggered_by, new Date().toISOString())
    return id
  }

  finish(id: string, input: FinishLogInput): void {
    this.db
      .prepare(
        `UPDATE device_hygiene_log SET
          finished_at = ?,
          status = ?,
          profiles_processed_json = ?,
          bloat_removed_count = ?,
          per_profile_log_json = ?,
          survived_packages_json = ?,
          error_msg = ?
         WHERE id = ?`,
      )
      .run(
        new Date().toISOString(),
        input.status,
        input.profiles_processed ? JSON.stringify(input.profiles_processed) : null,
        input.bloat_removed_count ?? null,
        input.per_profile_log ? JSON.stringify(input.per_profile_log) : null,
        input.survived_packages ? JSON.stringify(input.survived_packages) : null,
        input.error_msg ?? null,
        id,
      )
  }

  /** Last successful run for a device, if any. */
  getLastSuccess(device_serial: string): HygieneLogRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM device_hygiene_log
         WHERE device_serial = ? AND status = 'completed'
         ORDER BY finished_at DESC
         LIMIT 1`,
      )
      .get(device_serial) as HygieneLogRow | undefined
    return row ?? null
  }

  /** Most recent run regardless of status. */
  getLast(device_serial: string): HygieneLogRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM device_hygiene_log
         WHERE device_serial = ?
         ORDER BY started_at DESC
         LIMIT 1`,
      )
      .get(device_serial) as HygieneLogRow | undefined
    return row ?? null
  }

  list(device_serial: string, limit = 50): HygieneLogRow[] {
    return this.db
      .prepare(
        `SELECT * FROM device_hygiene_log
         WHERE device_serial = ?
         ORDER BY started_at DESC
         LIMIT ?`,
      )
      .all(device_serial, limit) as HygieneLogRow[]
  }

  /** Decide whether a device is due for re-hygiene. */
  isDue(device_serial: string, ttlDays: number, now: Date = new Date()): boolean {
    const last = this.getLastSuccess(device_serial)
    if (!last || !last.finished_at) return true
    const ageMs = now.getTime() - new Date(last.finished_at).getTime()
    return ageMs > ttlDays * 86_400_000
  }
}
