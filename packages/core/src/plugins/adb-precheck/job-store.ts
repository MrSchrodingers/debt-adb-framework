import type Database from 'better-sqlite3'
import { nanoid } from 'nanoid'
import type {
  DealKey,
  DealResult,
  PhoneResult,
  PrecheckJob,
  PrecheckJobStatus,
  PrecheckScanParams,
} from './types.js'

/**
 * Persistence for ADB pre-check plugin. Owns two tables, both prefixed
 * `adb_precheck_*` so they cannot collide with Oralsin or core tables.
 *
 * Idempotency contract:
 *   - jobs use nanoid PK; `createJob` is idempotent per `external_ref` when
 *     supplied.
 *   - deal cache uses composite PK with UPSERT, so re-running a job overwrites
 *     stale per-deal rows without duplicating them.
 */
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS adb_precheck_jobs (
    id TEXT PRIMARY KEY,
    external_ref TEXT UNIQUE,
    status TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    params_json TEXT NOT NULL,
    total_deals INTEGER,
    scanned_deals INTEGER NOT NULL DEFAULT 0,
    total_phones INTEGER NOT NULL DEFAULT 0,
    valid_phones INTEGER NOT NULL DEFAULT 0,
    invalid_phones INTEGER NOT NULL DEFAULT 0,
    error_phones INTEGER NOT NULL DEFAULT 0,
    cache_hits INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    pipedrive_enabled INTEGER NOT NULL DEFAULT 1,
    hygienization_mode INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_adb_precheck_jobs_status
    ON adb_precheck_jobs(status, created_at DESC);

  CREATE TABLE IF NOT EXISTS adb_precheck_deals (
    pasta TEXT NOT NULL,
    deal_id INTEGER NOT NULL,
    contato_tipo TEXT NOT NULL,
    contato_id INTEGER NOT NULL,
    last_job_id TEXT NOT NULL,
    valid_count INTEGER NOT NULL,
    invalid_count INTEGER NOT NULL,
    primary_valid_phone TEXT,
    phones_json TEXT NOT NULL,
    scanned_at TEXT NOT NULL,
    PRIMARY KEY (pasta, deal_id, contato_tipo, contato_id)
  );
  CREATE INDEX IF NOT EXISTS idx_adb_precheck_deals_job
    ON adb_precheck_deals(last_job_id);
  CREATE INDEX IF NOT EXISTS idx_adb_precheck_deals_primary_phone
    ON adb_precheck_deals(primary_valid_phone) WHERE primary_valid_phone IS NOT NULL;
`

export class PrecheckJobStore {
  constructor(private db: Database.Database) {}

  initialize(): void {
    this.db.exec(SCHEMA_SQL)
    // Idempotent column add for pre-existing databases. SQLite does not
    // support `ADD COLUMN IF NOT EXISTS`, so we probe pragma table_info first.
    const cols = this.db
      .prepare("PRAGMA table_info('adb_precheck_jobs')")
      .all() as Array<{ name: string }>
    if (!cols.some((c) => c.name === 'pipedrive_enabled')) {
      this.db.exec(
        "ALTER TABLE adb_precheck_jobs ADD COLUMN pipedrive_enabled INTEGER NOT NULL DEFAULT 1",
      )
    }
    if (!cols.some((c) => c.name === 'hygienization_mode')) {
      this.db.exec(
        "ALTER TABLE adb_precheck_jobs ADD COLUMN hygienization_mode INTEGER NOT NULL DEFAULT 0",
      )
    }
    // A6: triggered_by + parent_job_id (idempotent)
    if (!cols.some((c) => c.name === 'triggered_by')) {
      this.db.exec(
        "ALTER TABLE adb_precheck_jobs ADD COLUMN triggered_by TEXT NOT NULL DEFAULT 'manual'",
      )
    }
    if (!cols.some((c) => c.name === 'parent_job_id')) {
      this.db.exec(
        'ALTER TABLE adb_precheck_jobs ADD COLUMN parent_job_id TEXT REFERENCES adb_precheck_jobs(id)',
      )
    }
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_jobs_parent ON adb_precheck_jobs(parent_job_id)',
    )
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_jobs_trigger ON adb_precheck_jobs(triggered_by, created_at DESC)',
    )
  }

  /** Mark every job left in `running` state as failed. */
  reapOrphanedRunningJobs(reason = 'orphaned by service restart'): number {
    const result = this.db
      .prepare(
        `UPDATE adb_precheck_jobs
            SET status = 'failed',
                finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                last_error = ?
          WHERE status = 'running'`,
      )
      .run(reason)
    return result.changes ?? 0
  }

  createJob(
    params: PrecheckScanParams,
    externalRef?: string,
    opts?: {
      pipedriveEnabled?: boolean
      hygienizationMode?: boolean
      triggeredBy?: string
      parentJobId?: string
    },
  ): PrecheckJob {
    if (externalRef) {
      const existing = this.db
        .prepare('SELECT * FROM adb_precheck_jobs WHERE external_ref = ?')
        .get(externalRef) as PrecheckJob | undefined
      if (existing) return existing
    }
    const id = nanoid()
    const created_at = new Date().toISOString()
    const pipedriveEnabled = opts?.pipedriveEnabled === false ? 0 : 1
    const hygienizationMode = opts?.hygienizationMode === true ? 1 : 0
    const triggeredBy = opts?.triggeredBy ?? 'manual'
    const parentJobId = opts?.parentJobId ?? null
    this.db
      .prepare(
        `INSERT INTO adb_precheck_jobs (id, external_ref, status, params_json, created_at, pipedrive_enabled, hygienization_mode, triggered_by, parent_job_id)
         VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        externalRef ?? null,
        JSON.stringify(params),
        created_at,
        pipedriveEnabled,
        hygienizationMode,
        triggeredBy,
        parentJobId,
      )
    return this.getJob(id)!
  }

  getJob(id: string): PrecheckJob | null {
    return (this.db
      .prepare('SELECT * FROM adb_precheck_jobs WHERE id = ?')
      .get(id) as PrecheckJob | undefined) ?? null
  }

  listJobs(limit = 20): PrecheckJob[] {
    return this.db
      .prepare('SELECT * FROM adb_precheck_jobs ORDER BY created_at DESC LIMIT ?')
      .all(limit) as PrecheckJob[]
  }

  markStarted(id: string, totalDeals: number): void {
    this.db
      .prepare(
        `UPDATE adb_precheck_jobs
           SET status = 'running', started_at = ?, total_deals = ?
         WHERE id = ? AND status = 'queued'`,
      )
      .run(new Date().toISOString(), totalDeals, id)
  }

  bumpProgress(
    id: string,
    delta: {
      scanned_deals?: number
      total_phones?: number
      valid_phones?: number
      invalid_phones?: number
      error_phones?: number
      cache_hits?: number
    },
  ): void {
    this.db
      .prepare(
        `UPDATE adb_precheck_jobs
           SET scanned_deals = scanned_deals + ?,
               total_phones = total_phones + ?,
               valid_phones = valid_phones + ?,
               invalid_phones = invalid_phones + ?,
               error_phones = error_phones + ?,
               cache_hits = cache_hits + ?
         WHERE id = ?`,
      )
      .run(
        delta.scanned_deals ?? 0,
        delta.total_phones ?? 0,
        delta.valid_phones ?? 0,
        delta.invalid_phones ?? 0,
        delta.error_phones ?? 0,
        delta.cache_hits ?? 0,
        id,
      )
  }

  finishJob(id: string, status: PrecheckJobStatus, lastError?: string): void {
    this.db
      .prepare(
        `UPDATE adb_precheck_jobs
           SET status = ?, finished_at = ?, last_error = ?
         WHERE id = ?`,
      )
      .run(status, new Date().toISOString(), lastError ?? null, id)
  }

  requestCancel(id: string): void {
    this.db
      .prepare(
        `UPDATE adb_precheck_jobs
           SET cancel_requested = 1
         WHERE id = ? AND status IN ('queued','running')`,
      )
      .run(id)
  }

  isCancelRequested(id: string): boolean {
    const row = this.db
      .prepare('SELECT cancel_requested AS c FROM adb_precheck_jobs WHERE id = ?')
      .get(id) as { c: number } | undefined
    return Boolean(row?.c)
  }

  /**
   * Look up the cached `scanned_at` timestamp for a single deal key.
   * Returns `null` if the deal has never been scanned. Used by the scanner
   * to honour `params.recheck_after_days` — the freshness window check.
   */
  getDealLastScannedAt(key: DealKey): string | null {
    const row = this.db
      .prepare(
        `SELECT scanned_at FROM adb_precheck_deals
         WHERE pasta = ? AND deal_id = ? AND contato_tipo = ? AND contato_id = ?`,
      )
      .get(key.pasta, key.deal_id, key.contato_tipo, key.contato_id) as
      | { scanned_at: string }
      | undefined
    return row?.scanned_at ?? null
  }

  /**
   * Returns the set of deal keys whose `scanned_at` is on or after
   * `thresholdIso` (i.e. still within the recheck freshness window). Used by
   * the scanner to exclude those rows from the Postgres-side query when the
   * set is small enough to inline; larger sets fall back to scanner-side
   * filtering via `getDealLastScannedAt`.
   *
   * Bounded by `limit` so we never return an unbounded list — callers should
   * pass a value above the inline threshold and decide based on the result
   * length whether the optimisation is viable.
   */
  listRecentlyScannedKeys(thresholdIso: string, limit = 5001): DealKey[] {
    const rows = this.db
      .prepare(
        `SELECT pasta, deal_id, contato_tipo, contato_id FROM adb_precheck_deals
         WHERE scanned_at >= ?
         LIMIT ?`,
      )
      .all(thresholdIso, limit) as DealKey[]
    return rows
  }

  /**
   * Returns the count of distinct deals scanned at any time (entire history)
   * and the count scanned within the freshness window starting at
   * `thresholdIso`. Used by /stats/pool to expose the operator-facing view of
   * how many deals are still pending vs already covered.
   */
  countScannedSince(thresholdIso: string): { fresh: number; total: number } {
    const fresh = (this.db
      .prepare(`SELECT COUNT(*) AS n FROM adb_precheck_deals WHERE scanned_at >= ?`)
      .get(thresholdIso) as { n: number }).n
    const total = (this.db
      .prepare(`SELECT COUNT(*) AS n FROM adb_precheck_deals`)
      .get() as { n: number }).n
    return { fresh, total }
  }

  upsertDeal(jobId: string, result: DealResult): void {
    this.db
      .prepare(
        `INSERT INTO adb_precheck_deals (
           pasta, deal_id, contato_tipo, contato_id,
           last_job_id, valid_count, invalid_count, primary_valid_phone,
           phones_json, scanned_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT (pasta, deal_id, contato_tipo, contato_id) DO UPDATE SET
           last_job_id = excluded.last_job_id,
           valid_count = excluded.valid_count,
           invalid_count = excluded.invalid_count,
           primary_valid_phone = excluded.primary_valid_phone,
           phones_json = excluded.phones_json,
           scanned_at = excluded.scanned_at`,
      )
      .run(
        result.key.pasta,
        result.key.deal_id,
        result.key.contato_tipo,
        result.key.contato_id,
        jobId,
        result.valid_count,
        result.invalid_count,
        result.primary_valid_phone,
        JSON.stringify(result.phones),
        new Date().toISOString(),
      )
  }

  /**
   * Returns the deal cache rows for a job whose `phones_json` contains at
   * least one phone with `outcome:"error"`. Used by the end-of-scan retry
   * pass (D4) and the manual sweep entrypoint (E1) to identify which deals
   * still need work.
   *
   * Each row's `phones` array is the parsed `PhoneResult[]` ready to be
   * mutated and re-persisted via `upsertDeal`.
   */
  listDealsWithErrors(jobId: string): Array<{
    key: DealKey
    phones: PhoneResult[]
    valid_count: number
    invalid_count: number
    primary_valid_phone: string | null
  }> {
    const rows = this.db
      .prepare(`
        SELECT pasta, deal_id, contato_tipo, contato_id, phones_json
        FROM adb_precheck_deals
        WHERE last_job_id = ?
          AND EXISTS (
            SELECT 1 FROM json_each(phones_json)
            WHERE json_extract(value, '$.outcome') = 'error'
          )
      `)
      .all(jobId) as Array<{
        pasta: string; deal_id: number; contato_tipo: string; contato_id: number; phones_json: string
      }>
    return rows.map((r) => {
      const phones: PhoneResult[] = JSON.parse(r.phones_json) as PhoneResult[]
      const valid_count = phones.filter((p) => p.outcome === 'valid').length
      const invalid_count = phones.filter((p) => p.outcome === 'invalid').length
      const primary_valid_phone = phones.find((p) => p.outcome === 'valid')?.normalized ?? null
      return {
        key: { pasta: r.pasta, deal_id: r.deal_id, contato_tipo: r.contato_tipo, contato_id: r.contato_id },
        phones,
        valid_count,
        invalid_count,
        primary_valid_phone,
      }
    })
  }

  /**
   * Truth-set phone counts derived from the CURRENT state of
   * `adb_precheck_deals.phones_json`. Powers the "Visão Geral" panel —
   * the operator needs the actual number of distinct phone-rows we
   * are holding evidence for, not a running sum that inflates with
   * every retry pass.
   *
   * Why not SUM(adb_precheck_jobs.*_phones)? Each retry pipeline
   * (probe_recover, end-of-scan retry, manual sweep) creates a new
   * job whose counters add to the lifetime sum, even when those
   * retries operate on the SAME (pasta, deal, contato) and the
   * resolved outcome simply replaces the prior phones_json via
   * `upsertDeal`. The deals table is the only place where the row
   * count tracks the population we actually have data for.
   *
   * Edge case: a deal's `phones_json` may still hold a phone with
   * `outcome: 'error'` if all retry layers failed. Those are counted
   * under `phones_error` so the operator can see the unresolved
   * remainder (matches `listDealsWithErrors` semantics).
   */
  aggregatePhoneStatsTruth(): {
    phones_checked: number
    phones_valid: number
    phones_invalid: number
    phones_error: number
  } {
    const row = (this.db
      .prepare(
        `SELECT
           COUNT(*) AS phones_checked,
           SUM(CASE WHEN json_extract(je.value, '$.outcome') = 'valid'   THEN 1 ELSE 0 END) AS phones_valid,
           SUM(CASE WHEN json_extract(je.value, '$.outcome') = 'invalid' THEN 1 ELSE 0 END) AS phones_invalid,
           SUM(CASE WHEN json_extract(je.value, '$.outcome') = 'error'   THEN 1 ELSE 0 END) AS phones_error
         FROM adb_precheck_deals d, json_each(d.phones_json) je`,
      )
      .get() as
        | { phones_checked: number; phones_valid: number; phones_invalid: number; phones_error: number }
        | undefined) ?? { phones_checked: 0, phones_valid: 0, phones_invalid: 0, phones_error: 0 }
    // SUM over an empty set is NULL in SQLite; COALESCE each column.
    return {
      phones_checked: row.phones_checked ?? 0,
      phones_valid:   row.phones_valid   ?? 0,
      phones_invalid: row.phones_invalid ?? 0,
      phones_error:   row.phones_error   ?? 0,
    }
  }

  /**
   * Lists deals (across ALL prior jobs) that still have phones with
   * outcome='error', filtered by pasta and recency. Used by the sweep
   * entrypoint (E1) to identify which deals need a second pass without
   * being tied to a single source job_id.
   */
  listDealsWithErrorsByFilter(opts: {
    since_iso: string
    pasta: string | null
    limit: number
  }): Array<{
    key: DealKey
    phones: PhoneResult[]
    last_job_id: string
  }> {
    const rows = this.db
      .prepare(`
        SELECT pasta, deal_id, contato_tipo, contato_id, phones_json, last_job_id
        FROM adb_precheck_deals
        WHERE scanned_at >= ?
          AND EXISTS (
            SELECT 1 FROM json_each(phones_json)
            WHERE json_extract(value, '$.outcome') = 'error'
          )
          AND (? IS NULL OR pasta = ?)
        ORDER BY scanned_at DESC
        LIMIT ?
      `)
      .all(opts.since_iso, opts.pasta, opts.pasta, opts.limit) as Array<{
        pasta: string; deal_id: number; contato_tipo: string; contato_id: number;
        phones_json: string; last_job_id: string
      }>
    return rows.map((r) => ({
      key: { pasta: r.pasta, deal_id: r.deal_id, contato_tipo: r.contato_tipo, contato_id: r.contato_id },
      phones: JSON.parse(r.phones_json) as PhoneResult[],
      last_job_id: r.last_job_id,
    }))
  }

  /**
   * Returns all cached deal rows for a pasta, ordered by deal_id ascending.
   * Used by the sweep to re-aggregate pasta-level summaries after mutating
   * individual deal phone outcomes.
   */
  listDealsForPasta(pasta: string): Array<{
    key: DealKey
    phones: PhoneResult[]
    last_job_id: string
  }> {
    const rows = this.db
      .prepare(`
        SELECT pasta, deal_id, contato_tipo, contato_id, phones_json, last_job_id
        FROM adb_precheck_deals
        WHERE pasta = ?
        ORDER BY deal_id ASC
      `)
      .all(pasta) as Array<{
        pasta: string; deal_id: number; contato_tipo: string; contato_id: number;
        phones_json: string; last_job_id: string
      }>
    return rows.map((r) => ({
      key: { pasta: r.pasta, deal_id: r.deal_id, contato_tipo: r.contato_tipo, contato_id: r.contato_id },
      phones: JSON.parse(r.phones_json) as PhoneResult[],
      last_job_id: r.last_job_id,
    }))
  }

  /**
   * Retry-pass save rate for a job. Counts wa_contact_checks rows with
   * decisive results that came from probe_recover (Level 1) and scan_retry
   * (Level 2) attempt phases. Sweep_retry rows from a sweep job land in the
   * sweep job's stats, not the original — that's correct (sweep is its own
   * job entity).
   *
   * `remaining_errors` counts phones still flagged 'error' in the deal cache
   * for THIS job — these are candidates for the manual sweep entrypoint.
   */
  getRetryStats(jobId: string): {
    level_1_resolves: number
    level_2_resolves: number
    remaining_errors: number
  } {
    const dealsRows = this.db
      .prepare('SELECT phones_json FROM adb_precheck_deals WHERE last_job_id = ?')
      .all(jobId) as Array<{ phones_json: string }>
    let remaining_errors = 0
    for (const r of dealsRows) {
      try {
        const phones = JSON.parse(r.phones_json) as Array<{ outcome: string }>
        remaining_errors += phones.filter((p) => p.outcome === 'error').length
      } catch {
        // Malformed row — skip silently rather than crashing the stats query.
      }
    }

    // wa_contact_checks is owned by ContactRegistry — defensively handle the
    // case where the table hasn't been initialized yet (e.g. fresh boot, no
    // contacts module loaded in tests).
    let level_1 = 0
    let level_2 = 0
    try {
      level_1 = (this.db
        .prepare(`
          SELECT COUNT(*) AS n FROM wa_contact_checks
          WHERE attempt_phase = 'probe_recover' AND result IN ('exists','not_exists')
            AND checked_at >= COALESCE((SELECT created_at FROM adb_precheck_jobs WHERE id = ?), '1970-01-01')
            AND checked_at <= COALESCE((SELECT finished_at FROM adb_precheck_jobs WHERE id = ?), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        `)
        .get(jobId, jobId) as { n: number }).n
      level_2 = (this.db
        .prepare(`
          SELECT COUNT(*) AS n FROM wa_contact_checks
          WHERE attempt_phase = 'scan_retry' AND result IN ('exists','not_exists')
            AND checked_at >= COALESCE((SELECT created_at FROM adb_precheck_jobs WHERE id = ?), '1970-01-01')
            AND checked_at <= COALESCE((SELECT finished_at FROM adb_precheck_jobs WHERE id = ?), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        `)
        .get(jobId, jobId) as { n: number }).n
    } catch {
      // wa_contact_checks not initialized — return zeros.
    }

    return { level_1_resolves: level_1, level_2_resolves: level_2, remaining_errors }
  }

  /**
   * Distribution of UI states observed during the job's probe activity.
   * Counts wa_contact_checks rows from `adb_probe` source whose evidence
   * carries a `ui_state` field, scoped to the job's time window.
   */
  getUiStateDistribution(jobId: string): Record<string, number> {
    const out: Record<string, number> = {}
    // wa_contact_checks is owned by ContactRegistry — guard against fresh
    // deployments where the table hasn't been initialized yet.
    try {
      const rows = this.db
        .prepare(`
          SELECT json_extract(evidence,'$.ui_state') AS state, COUNT(*) AS n
          FROM wa_contact_checks
          WHERE source = 'adb_probe'
            AND json_extract(evidence,'$.ui_state') IS NOT NULL
            AND checked_at >= COALESCE((SELECT created_at FROM adb_precheck_jobs WHERE id = ?), '1970-01-01')
            AND checked_at <= COALESCE((SELECT finished_at FROM adb_precheck_jobs WHERE id = ?), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
          GROUP BY state
        `)
        .all(jobId, jobId) as Array<{ state: string; n: number }>
      for (const r of rows) out[r.state] = r.n
    } catch {
      // wa_contact_checks not initialized — return empty distribution.
    }
    return out
  }

  /**
   * Number of probe snapshots persisted to disk during this job. Reads
   * `evidence.snapshot_path` IS NOT NULL — present only when the writer
   * actually wrote a file (quota-aware).
   */
  getSnapshotsCaptured(jobId: string): number {
    // wa_contact_checks is owned by ContactRegistry — guard against fresh
    // deployments where the table hasn't been initialized yet.
    try {
      return (this.db
        .prepare(`
          SELECT COUNT(*) AS n FROM wa_contact_checks
          WHERE json_extract(evidence,'$.snapshot_path') IS NOT NULL
            AND checked_at >= COALESCE((SELECT created_at FROM adb_precheck_jobs WHERE id = ?), '1970-01-01')
            AND checked_at <= COALESCE((SELECT finished_at FROM adb_precheck_jobs WHERE id = ?), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        `)
        .get(jobId, jobId) as { n: number }).n
    } catch {
      // wa_contact_checks not initialized — return zero.
      return 0
    }
  }

  aggregateStats(): {
    deals_scanned: number
    deals_with_valid: number
    deals_all_invalid: number
    phones_checked_total: number
    last_scan_at: string | null
  } {
    // `deals_all_invalid` requires `invalid_count > 0` so zero-phone deals
    // (rows where the upstream prov_consultas had no telefone_* set, or
    // had every phone stripped before our scan) don't get reported as
    // "all invalid" in the UI's "nenhum telefone WhatsApp" card.
    const base = (this.db
      .prepare(
        `SELECT COUNT(*) AS deals_scanned,
                SUM(CASE WHEN valid_count > 0                          THEN 1 ELSE 0 END) AS deals_with_valid,
                SUM(CASE WHEN valid_count = 0 AND invalid_count > 0    THEN 1 ELSE 0 END) AS deals_all_invalid,
                MAX(scanned_at) AS last_scan_at
         FROM adb_precheck_deals`,
      )
      .get() as {
      deals_scanned: number
      deals_with_valid: number
      deals_all_invalid: number
      last_scan_at: string | null
    } | undefined) ?? {
      deals_scanned: 0,
      deals_with_valid: 0,
      deals_all_invalid: 0,
      last_scan_at: null,
    }
    // Truth-set, same rationale as `aggregatePhoneStatsTruth`. The legacy
    // SUM(adb_precheck_jobs.total_phones) double-counts every retry pass.
    const phones = this.aggregatePhoneStatsTruth()
    return {
      deals_scanned: base.deals_scanned ?? 0,
      deals_with_valid: base.deals_with_valid ?? 0,
      deals_all_invalid: base.deals_all_invalid ?? 0,
      phones_checked_total: phones.phones_checked,
      last_scan_at: base.last_scan_at,
    }
  }
}
