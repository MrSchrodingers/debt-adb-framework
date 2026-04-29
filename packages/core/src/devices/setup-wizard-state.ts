import type Database from 'better-sqlite3'

/**
 * Persistent state of the per-device Setup Wizard (POCO C71 root reproduction).
 *
 * One row per (device_serial). The wizard is re-entrant: rebooting the UI
 * mid-flow shows the operator the last completed sub-step and lets them
 * continue. JSON columns hold per-profile maps:
 *
 *   users_created            { "10": "Oralsin 2 1", ... }
 *   bypassed_profiles        { "10": "2026-04-29T17:33:00Z", ... }
 *   wa_installed_profiles    { "10": ["com.whatsapp"], ... }
 *   wa_registered_profiles   { "10": "+5543991938235", ... }
 *
 * Idempotency: every state mutation is an UPSERT keyed on `device_serial`,
 * never a DELETE-then-INSERT. The endpoints are safe to retry.
 */
export type WizardSubStep =
  | 'root_done'
  | 'users_created'
  | 'setup_wizard_bypassed'
  | 'wa_installed'
  | 'wa_registered'
  | 'extraction_complete'

export interface SetupWizardRow {
  device_serial: string
  root_done: 0 | 1
  users_created_json: string | null
  bypassed_profiles_json: string | null
  wa_installed_profiles_json: string | null
  wa_registered_profiles_json: string | null
  extraction_complete: 0 | 1
  current_step: WizardSubStep | null
  started_at: string | null
  updated_at: string
  finished_at: string | null
}

export interface WizardState {
  device_serial: string
  root_done: boolean
  users_created: Record<string, string>
  bypassed_profiles: Record<string, string>
  wa_installed_profiles: Record<string, string[]>
  wa_registered_profiles: Record<string, string>
  extraction_complete: boolean
  current_step: WizardSubStep | null
  started_at: string | null
  updated_at: string
  finished_at: string | null
}

function parseJson<T>(s: string | null, fallback: T): T {
  if (s == null || s.length === 0) return fallback
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}

function toState(row: SetupWizardRow): WizardState {
  return {
    device_serial: row.device_serial,
    root_done: row.root_done === 1,
    users_created: parseJson<Record<string, string>>(row.users_created_json, {}),
    bypassed_profiles: parseJson<Record<string, string>>(row.bypassed_profiles_json, {}),
    wa_installed_profiles: parseJson<Record<string, string[]>>(
      row.wa_installed_profiles_json,
      {},
    ),
    wa_registered_profiles: parseJson<Record<string, string>>(
      row.wa_registered_profiles_json,
      {},
    ),
    extraction_complete: row.extraction_complete === 1,
    current_step: row.current_step,
    started_at: row.started_at,
    updated_at: row.updated_at,
    finished_at: row.finished_at,
  }
}

export class SetupWizardStore {
  constructor(private db: Database.Database) {}

  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS device_setup_wizard_state (
        device_serial TEXT PRIMARY KEY,
        root_done INTEGER NOT NULL DEFAULT 0,
        users_created_json TEXT,
        bypassed_profiles_json TEXT,
        wa_installed_profiles_json TEXT,
        wa_registered_profiles_json TEXT,
        extraction_complete INTEGER NOT NULL DEFAULT 0,
        current_step TEXT,
        started_at TEXT,
        updated_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_dswz_updated ON device_setup_wizard_state(updated_at);
    `)
  }

  get(serial: string): WizardState | null {
    const row = this.db
      .prepare('SELECT * FROM device_setup_wizard_state WHERE device_serial = ?')
      .get(serial) as SetupWizardRow | undefined
    return row ? toState(row) : null
  }

  /**
   * Idempotent UPSERT. Pass only the deltas you want to write - undefined
   * fields are preserved. JSON-typed fields are merged shallowly so a
   * partial update of a single profile does not wipe sibling entries.
   */
  upsert(
    serial: string,
    delta: {
      root_done?: boolean
      users_created?: Record<string, string>
      bypassed_profiles?: Record<string, string>
      wa_installed_profiles?: Record<string, string[]>
      wa_registered_profiles?: Record<string, string>
      extraction_complete?: boolean
      current_step?: WizardSubStep | null
      finished_at?: string | null
    },
  ): WizardState {
    const now = new Date().toISOString()
    const existing = this.get(serial)
    const merged: WizardState = {
      device_serial: serial,
      root_done: delta.root_done ?? existing?.root_done ?? false,
      users_created: { ...(existing?.users_created ?? {}), ...(delta.users_created ?? {}) },
      bypassed_profiles: {
        ...(existing?.bypassed_profiles ?? {}),
        ...(delta.bypassed_profiles ?? {}),
      },
      wa_installed_profiles: {
        ...(existing?.wa_installed_profiles ?? {}),
        ...(delta.wa_installed_profiles ?? {}),
      },
      wa_registered_profiles: {
        ...(existing?.wa_registered_profiles ?? {}),
        ...(delta.wa_registered_profiles ?? {}),
      },
      extraction_complete: delta.extraction_complete ?? existing?.extraction_complete ?? false,
      current_step:
        delta.current_step !== undefined ? delta.current_step : existing?.current_step ?? null,
      started_at: existing?.started_at ?? now,
      updated_at: now,
      finished_at:
        delta.finished_at !== undefined ? delta.finished_at : existing?.finished_at ?? null,
    }

    this.db
      .prepare(
        `INSERT INTO device_setup_wizard_state (
           device_serial, root_done, users_created_json, bypassed_profiles_json,
           wa_installed_profiles_json, wa_registered_profiles_json,
           extraction_complete, current_step, started_at, updated_at, finished_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(device_serial) DO UPDATE SET
           root_done = excluded.root_done,
           users_created_json = excluded.users_created_json,
           bypassed_profiles_json = excluded.bypassed_profiles_json,
           wa_installed_profiles_json = excluded.wa_installed_profiles_json,
           wa_registered_profiles_json = excluded.wa_registered_profiles_json,
           extraction_complete = excluded.extraction_complete,
           current_step = excluded.current_step,
           updated_at = excluded.updated_at,
           finished_at = excluded.finished_at`,
      )
      .run(
        merged.device_serial,
        merged.root_done ? 1 : 0,
        JSON.stringify(merged.users_created),
        JSON.stringify(merged.bypassed_profiles),
        JSON.stringify(merged.wa_installed_profiles),
        JSON.stringify(merged.wa_registered_profiles),
        merged.extraction_complete ? 1 : 0,
        merged.current_step,
        merged.started_at,
        merged.updated_at,
        merged.finished_at,
      )
    return merged
  }

  reset(serial: string): void {
    this.db
      .prepare('DELETE FROM device_setup_wizard_state WHERE device_serial = ?')
      .run(serial)
  }
}
