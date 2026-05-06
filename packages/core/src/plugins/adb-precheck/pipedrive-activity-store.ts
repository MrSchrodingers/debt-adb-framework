import type Database from 'better-sqlite3'
import { nanoid } from 'nanoid'

/**
 * Persistence layer for outgoing Pipedrive activities/notes.
 *
 * One row per intent attempt — created BEFORE the HTTP call (status='retrying',
 * attempts=1) and updated AFTER (status='success'|'failed', http_status,
 * error_msg, completed_at). Re-tries via UI append a NEW row (preserving the
 * original audit trail) so the table is the canonical history of every
 * Pipedrive interaction the system performs.
 */
export type PipedriveScenario = 'phone_fail' | 'deal_all_fail' | 'pasta_summary'
export type PipedriveStatus = 'retrying' | 'success' | 'failed' | 'orphaned'

export interface PipedriveActivityInsert {
  scenario: PipedriveScenario
  deal_id: number
  pasta: string | null
  phone_normalized: string | null
  job_id: string | null
  pipedrive_endpoint: string
  pipedrive_payload_json: string
  manual?: boolean
  triggered_by?: string | null
  revises_row_id?: string
  http_verb?: 'POST' | 'PUT'
}

export interface PipedriveActivityRow {
  id: string
  scenario: PipedriveScenario
  deal_id: number
  pasta: string | null
  phone_normalized: string | null
  job_id: string | null
  pipedrive_endpoint: string
  pipedrive_payload_json: string
  pipedrive_response_id: number | null
  pipedrive_response_status: PipedriveStatus
  http_status: number | null
  error_msg: string | null
  attempts: number
  created_at: string
  completed_at: string | null
  manual: number
  triggered_by: string | null
}

export interface PipedriveListFilters {
  scenario?: PipedriveScenario
  status?: PipedriveStatus
  deal_id?: number
  pasta?: string
  since?: string
  until?: string
  limit?: number
  offset?: number
}

export interface PipedriveStatsRow {
  totalActivitiesCreated: number
  totalActivitiesCreated7d: number
  byScenario: { phone_fail: number; deal_all_fail: number; pasta_summary: number }
  byStatus: { success: number; failed: number; retrying: number }
  byPasta: Array<{ pasta: string; total: number; found: number; foundPct: number }>
  byStrategy: { adb: number; waha: number; cache: number }
  failureRate24h: number
  coveragePercent: number
  totalPhonesChecked: number
  totalPhonesFound: number
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS pipedrive_activities (
    id TEXT PRIMARY KEY,
    scenario TEXT NOT NULL,
    deal_id INTEGER NOT NULL,
    pasta TEXT,
    phone_normalized TEXT,
    job_id TEXT,
    pipedrive_endpoint TEXT NOT NULL,
    pipedrive_payload_json TEXT NOT NULL,
    pipedrive_response_id INTEGER,
    pipedrive_response_status TEXT NOT NULL,
    http_status INTEGER,
    error_msg TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    completed_at TEXT,
    manual INTEGER NOT NULL DEFAULT 0,
    triggered_by TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_pipedrive_deal
    ON pipedrive_activities(deal_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_pipedrive_status
    ON pipedrive_activities(pipedrive_response_status, created_at);
  CREATE INDEX IF NOT EXISTS idx_pipedrive_scenario
    ON pipedrive_activities(scenario, created_at);
  CREATE INDEX IF NOT EXISTS idx_pipedrive_idempotency
    ON pipedrive_activities(
      scenario, deal_id,
      COALESCE(pasta, ''),
      COALESCE(phone_normalized, ''),
      created_at
    );
`

export class PipedriveActivityStore {
  constructor(private db: Database.Database) {}

  initialize(): void {
    this.db.exec(SCHEMA_SQL)
    // A7: idempotent column adds for revises_row_id + http_verb,
    // plus partial indexes used by D1 (findCurrentPastaNote) and D3 (PUT path).
    const cols = this.db
      .prepare("PRAGMA table_info('pipedrive_activities')")
      .all() as Array<{ name: string }>
    if (!cols.some((c) => c.name === 'revises_row_id')) {
      this.db.exec(
        'ALTER TABLE pipedrive_activities ADD COLUMN revises_row_id TEXT REFERENCES pipedrive_activities(id)',
      )
    }
    if (!cols.some((c) => c.name === 'http_verb')) {
      this.db.exec(
        "ALTER TABLE pipedrive_activities ADD COLUMN http_verb TEXT NOT NULL DEFAULT 'POST'",
      )
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_pipedrive_pasta_current
        ON pipedrive_activities(pasta, scenario, created_at DESC)
        WHERE pipedrive_response_status = 'success'
    `)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_pipedrive_revises
        ON pipedrive_activities(revises_row_id) WHERE revises_row_id IS NOT NULL
    `)
  }

  insertPending(data: PipedriveActivityInsert): string {
    const id = nanoid()
    this.db
      .prepare(
        `INSERT INTO pipedrive_activities (
           id, scenario, deal_id, pasta, phone_normalized, job_id,
           pipedrive_endpoint, pipedrive_payload_json,
           pipedrive_response_status, attempts,
           manual, triggered_by, revises_row_id, http_verb
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        data.scenario,
        data.deal_id,
        data.pasta ?? null,
        data.phone_normalized ?? null,
        data.job_id ?? null,
        data.pipedrive_endpoint,
        data.pipedrive_payload_json,
        'retrying',
        1,
        data.manual ? 1 : 0,
        data.triggered_by ?? null,
        data.revises_row_id ?? null,
        data.http_verb ?? 'POST',
      )
    return id
  }

  updateResult(
    id: string,
    update: {
      status: PipedriveStatus
      pipedrive_response_id?: number | null
      http_status?: number | null
      error_msg?: string | null
      attempts: number
    },
  ): void {
    this.db
      .prepare(
        `UPDATE pipedrive_activities
            SET pipedrive_response_status = ?,
                pipedrive_response_id = COALESCE(?, pipedrive_response_id),
                http_status = COALESCE(?, http_status),
                error_msg = ?,
                attempts = MAX(attempts, ?),
                completed_at = CASE WHEN ? IN ('success','failed') THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE completed_at END
          WHERE id = ?`,
      )
      .run(
        update.status,
        update.pipedrive_response_id ?? null,
        update.http_status ?? null,
        update.error_msg ?? null,
        update.attempts,
        update.status,
        id,
      )
  }

  /**
   * Returns true when the same (scenario, deal_id, pasta, phone) tuple was
   * successfully published within the lookback window. Used by the publisher
   * to suppress duplicate Pipedrive activities across scan runs and process
   * restarts (formatter dedup_key includes job_id, which is per-scan, so the
   * publisher's in-memory Set cannot enforce cross-scan idempotency).
   */
  hasRecentSuccess(params: {
    scenario: string
    deal_id: number
    pasta: string | null
    phone_normalized: string | null
    sinceIso: string
  }): boolean {
    const row = this.db
      .prepare(`
        SELECT 1
        FROM pipedrive_activities
        WHERE scenario = ?
          AND deal_id = ?
          AND COALESCE(pasta, '') = COALESCE(?, '')
          AND COALESCE(phone_normalized, '') = COALESCE(?, '')
          AND pipedrive_response_status = 'success'
          AND created_at >= ?
        LIMIT 1
      `)
      .get(
        params.scenario,
        params.deal_id,
        params.pasta,
        params.phone_normalized,
        params.sinceIso,
      ) as { 1: number } | undefined
    return Boolean(row)
  }

  /**
   * Resolve the "current" Pipedrive note for a pasta — the most recent row
   * with scenario='pasta_summary', status='success', and a non-null Pipedrive
   * response id. Used by the publisher to switch from POST to PUT on
   * subsequent scans of the same pasta.
   *
   * Returns null when no successful note has been published yet, OR when the
   * previous note was orphaned (e.g. deleted upstream by an operator).
   */
  findCurrentPastaNote(pasta: string): { row_id: string; pipedrive_response_id: number; created_at: string } | null {
    const row = this.db
      .prepare(`
        SELECT id AS row_id, pipedrive_response_id, created_at
        FROM pipedrive_activities
        WHERE scenario = 'pasta_summary'
          AND pasta = ?
          AND pipedrive_response_status = 'success'
          AND pipedrive_response_id IS NOT NULL
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `)
      .get(pasta) as
      | { row_id: string; pipedrive_response_id: number; created_at: string }
      | undefined
    return row ?? null
  }

  /**
   * Mark a row as orphaned — its Pipedrive entity was deleted upstream. The
   * publisher uses this when a PUT returns 404, so subsequent
   * `findCurrentPastaNote` calls skip it and the next publish creates a fresh
   * note. Records the failure reason in `error_msg` for audit.
   */
  markOrphaned(rowId: string, reason: string): void {
    this.db
      .prepare(`
        UPDATE pipedrive_activities
           SET pipedrive_response_status = 'orphaned',
               error_msg = ?
         WHERE id = ?
      `)
      .run(reason, rowId)
  }

  getById(id: string): PipedriveActivityRow | null {
    return (
      (this.db
        .prepare('SELECT * FROM pipedrive_activities WHERE id = ?')
        .get(id) as PipedriveActivityRow | undefined) ?? null
    )
  }

  list(filters: PipedriveListFilters): { items: PipedriveActivityRow[]; total: number } {
    const conds: string[] = []
    const args: unknown[] = []
    if (filters.scenario) {
      conds.push('scenario = ?')
      args.push(filters.scenario)
    }
    if (filters.status) {
      conds.push('pipedrive_response_status = ?')
      args.push(filters.status)
    }
    if (typeof filters.deal_id === 'number') {
      conds.push('deal_id = ?')
      args.push(filters.deal_id)
    }
    if (filters.pasta) {
      conds.push('pasta = ?')
      args.push(filters.pasta)
    }
    if (filters.since) {
      conds.push('created_at >= ?')
      args.push(filters.since)
    }
    if (filters.until) {
      conds.push('created_at <= ?')
      args.push(filters.until)
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : ''
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 500)
    const offset = Math.max(filters.offset ?? 0, 0)
    const items = this.db
      .prepare(
        `SELECT * FROM pipedrive_activities ${where}
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, offset) as PipedriveActivityRow[]
    const total = (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM pipedrive_activities ${where}`)
        .get(...args) as { n: number }
    ).n
    return { items, total }
  }

  /**
   * Aggregate stats. `coveragePercent` numerator/denominator come from
   * `adb_precheck_deals.phones_json` — the local, time-stamped, per-strategy
   * cache the scanner already produces. Chosen over Pipeboard PG because:
   *   - bounded fast SQLite query (no PG round-trip)
   *   - has the temporal dimension via `scanned_at`
   *   - already aggregates per-strategy attribution
   */
  stats(period: 'today' | '7d' | '30d' | 'all' = 'all', now = Date.now()): PipedriveStatsRow {
    const sinceIso = (() => {
      if (period === 'today') {
        const d = new Date(now)
        d.setUTCHours(0, 0, 0, 0)
        return d.toISOString()
      }
      if (period === '7d') return new Date(now - 7 * 86_400_000).toISOString()
      if (period === '30d') return new Date(now - 30 * 86_400_000).toISOString()
      return null
    })()
    const periodWhere = sinceIso ? 'WHERE created_at >= ?' : ''
    const periodArgs: unknown[] = sinceIso ? [sinceIso] : []

    const scenarioRows = this.db
      .prepare(
        `SELECT scenario, COUNT(*) AS n
         FROM pipedrive_activities ${periodWhere}
         GROUP BY scenario`,
      )
      .all(...periodArgs) as Array<{ scenario: string; n: number }>
    const byScenario = { phone_fail: 0, deal_all_fail: 0, pasta_summary: 0 }
    for (const r of scenarioRows) {
      if (r.scenario in byScenario) {
        byScenario[r.scenario as keyof typeof byScenario] = r.n
      }
    }

    const statusRows = this.db
      .prepare(
        `SELECT pipedrive_response_status AS s, COUNT(*) AS n
         FROM pipedrive_activities ${periodWhere}
         GROUP BY pipedrive_response_status`,
      )
      .all(...periodArgs) as Array<{ s: string; n: number }>
    const byStatus = { success: 0, failed: 0, retrying: 0 }
    for (const r of statusRows) {
      if (r.s in byStatus) byStatus[r.s as keyof typeof byStatus] = r.n
    }

    const totalActivitiesCreated = (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM pipedrive_activities ${periodWhere}`)
        .get(...periodArgs) as { n: number }
    ).n
    const totalActivitiesCreated7d = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM pipedrive_activities
            WHERE created_at >= ?`,
        )
        .get(new Date(now - 7 * 86_400_000).toISOString()) as { n: number }
    ).n

    const failed24h = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM pipedrive_activities
            WHERE created_at >= ? AND pipedrive_response_status = 'failed'`,
        )
        .get(new Date(now - 86_400_000).toISOString()) as { n: number }
    ).n
    const total24h = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM pipedrive_activities
            WHERE created_at >= ?`,
        )
        .get(new Date(now - 86_400_000).toISOString()) as { n: number }
    ).n
    const failureRate24h = total24h > 0 ? failed24h / total24h : 0

    const dealsWhere = sinceIso ? 'WHERE scanned_at >= ?' : ''
    const dealsArgs: unknown[] = sinceIso ? [sinceIso] : []
    const dealRows = (() => {
      try {
        return this.db
          .prepare(
            `SELECT pasta, valid_count, invalid_count, phones_json
             FROM adb_precheck_deals
             ${dealsWhere}`,
          )
          .all(...dealsArgs) as Array<{
          pasta: string
          valid_count: number
          invalid_count: number
          phones_json: string
        }>
      } catch {
        // Table may not exist yet in tests that only initialize this store.
        return []
      }
    })()

    const byPastaMap = new Map<string, { total: number; found: number }>()
    let totalPhonesChecked = 0
    let totalPhonesFound = 0
    const byStrategy = { adb: 0, waha: 0, cache: 0 }
    for (const r of dealRows) {
      let phones: Array<{ outcome?: string; source?: string }> = []
      try {
        const parsed = JSON.parse(r.phones_json) as unknown
        if (Array.isArray(parsed)) phones = parsed as Array<{ outcome?: string; source?: string }>
      } catch {
        // ignore corrupt rows
      }
      const cur = byPastaMap.get(r.pasta) ?? { total: 0, found: 0 }
      cur.total += phones.length
      let found = 0
      for (const p of phones) {
        if (p.outcome === 'valid') {
          found++
          totalPhonesFound++
        }
        totalPhonesChecked++
        const src = (p.source ?? '').toLowerCase()
        if (src.includes('adb')) byStrategy.adb++
        else if (src.includes('waha')) byStrategy.waha++
        else byStrategy.cache++
      }
      cur.found += found
      byPastaMap.set(r.pasta, cur)
    }
    const byPasta = [...byPastaMap.entries()]
      .map(([pasta, v]) => ({
        pasta,
        total: v.total,
        found: v.found,
        foundPct: v.total > 0 ? (v.found / v.total) * 100 : 0,
      }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 20)
    const coveragePercent = totalPhonesChecked > 0 ? (totalPhonesFound / totalPhonesChecked) * 100 : 0

    return {
      totalActivitiesCreated,
      totalActivitiesCreated7d,
      byScenario,
      byStatus,
      byPasta,
      byStrategy,
      failureRate24h,
      coveragePercent,
      totalPhonesChecked,
      totalPhonesFound,
    }
  }
}
