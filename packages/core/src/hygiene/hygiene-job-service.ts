import type Database from 'better-sqlite3'
import { nanoid } from 'nanoid'
import type {
  HygieneJobRecord,
  HygieneJobItemRecord,
  CreateJobInput,
  CreateJobResult,
  HygieneItemStatus,
} from './types.js'
import { HygieneJobConflictError } from './types.js'

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS hygiene_jobs (
    id TEXT PRIMARY KEY,
    plugin_name TEXT NOT NULL,
    external_ref TEXT,
    status TEXT NOT NULL,
    total_items INTEGER NOT NULL,
    completed_items INTEGER NOT NULL DEFAULT 0,
    valid_items INTEGER NOT NULL DEFAULT 0,
    invalid_items INTEGER NOT NULL DEFAULT 0,
    error_items INTEGER NOT NULL DEFAULT 0,
    cache_hits INTEGER NOT NULL DEFAULT 0,
    priority TEXT NOT NULL DEFAULT 'normal',
    rate_profile TEXT NOT NULL DEFAULT 'default',
    callback_granularity TEXT NOT NULL DEFAULT 'per_item',
    callback_url TEXT,
    lawful_basis TEXT NOT NULL,
    purpose TEXT NOT NULL,
    data_controller TEXT NOT NULL,
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    requested_by TEXT,
    UNIQUE(plugin_name, external_ref)
  );
  CREATE INDEX IF NOT EXISTS idx_hygiene_jobs_status
    ON hygiene_jobs(status, created_at);
  CREATE INDEX IF NOT EXISTS idx_hygiene_jobs_plugin
    ON hygiene_jobs(plugin_name, created_at);

  CREATE TABLE IF NOT EXISTS hygiene_job_items (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    phone_input TEXT NOT NULL,
    phone_normalized TEXT,
    external_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    check_id TEXT,
    callback_sent INTEGER NOT NULL DEFAULT 0,
    callback_sent_at TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (job_id) REFERENCES hygiene_jobs(id)
  );
  CREATE INDEX IF NOT EXISTS idx_hygiene_items_status
    ON hygiene_job_items(job_id, status);
  CREATE INDEX IF NOT EXISTS idx_hygiene_items_external
    ON hygiene_job_items(external_id);
  CREATE INDEX IF NOT EXISTS idx_hygiene_items_ddd_updated
    ON hygiene_job_items(substr(phone_normalized, 3, 2), updated_at);
`

function runSchema(db: Database.Database): void {
  db.exec(SCHEMA_SQL)
}

export class HygieneJobService {
  constructor(private db: Database.Database) {}

  initialize(): void {
    runSchema(this.db)
  }

  create(input: CreateJobInput): CreateJobResult {
    if (input.external_ref) {
      const existing = this.db
        .prepare(`
          SELECT id, status, total_items FROM hygiene_jobs
          WHERE plugin_name = ? AND external_ref = ?
        `)
        .get(input.plugin_name, input.external_ref) as
        | { id: string; status: string; total_items: number }
        | undefined
      if (existing) {
        if (existing.total_items !== input.items.length) {
          throw new HygieneJobConflictError(input.external_ref)
        }
        return {
          job_id: existing.id,
          deduplicated: true,
          total_items: existing.total_items,
          status: existing.status as HygieneJobRecord['status'],
        }
      }
    }

    const jobId = nanoid()
    const now = new Date().toISOString()

    const insertJob = this.db.prepare(`
      INSERT INTO hygiene_jobs (
        id, plugin_name, external_ref, status, total_items,
        priority, rate_profile, callback_granularity, callback_url,
        lawful_basis, purpose, data_controller,
        created_at, requested_by
      )
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `)
    const insertItem = this.db.prepare(`
      INSERT INTO hygiene_job_items (
        id, job_id, phone_input, external_id, status, created_at, updated_at
      )
      VALUES (?,?,?,?, 'pending',?,?)
    `)

    const tx = this.db.transaction(() => {
      insertJob.run(
        jobId,
        input.plugin_name,
        input.external_ref ?? null,
        'queued',
        input.items.length,
        input.priority ?? 'normal',
        input.rate_profile ?? 'default',
        input.callback_granularity ?? 'per_item',
        input.callback_url ?? null,
        input.lgpd.lawful_basis,
        input.lgpd.purpose,
        input.lgpd.data_controller,
        now,
        input.requested_by ?? null,
      )
      for (const item of input.items) {
        insertItem.run(nanoid(), jobId, item.phone_input, item.external_id ?? null, now, now)
      }
    })
    tx()

    return {
      job_id: jobId,
      deduplicated: false,
      total_items: input.items.length,
      status: 'queued',
    }
  }

  get(jobId: string): HygieneJobRecord | null {
    const row = this.db
      .prepare('SELECT * FROM hygiene_jobs WHERE id = ?')
      .get(jobId) as HygieneJobRecord | undefined
    return row ?? null
  }

  list(params: { plugin_name?: string; status?: string; limit?: number } = {}): HygieneJobRecord[] {
    const conds: string[] = []
    const args: unknown[] = []
    if (params.plugin_name) {
      conds.push('plugin_name = ?')
      args.push(params.plugin_name)
    }
    if (params.status) {
      conds.push('status = ?')
      args.push(params.status)
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
    const limit = Math.min(params.limit ?? 100, 500)
    return this.db
      .prepare(`SELECT * FROM hygiene_jobs ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...args, limit) as HygieneJobRecord[]
  }

  getItems(
    jobId: string,
    params: { status?: HygieneItemStatus; limit?: number; offset?: number } = {},
  ): HygieneJobItemRecord[] {
    const conds = ['job_id = ?']
    const args: unknown[] = [jobId]
    if (params.status) {
      conds.push('status = ?')
      args.push(params.status)
    }
    const limit = Math.min(params.limit ?? 100, 1000)
    const offset = params.offset ?? 0
    return this.db
      .prepare(`
        SELECT * FROM hygiene_job_items
        WHERE ${conds.join(' AND ')}
        ORDER BY created_at ASC
        LIMIT ? OFFSET ?
      `)
      .all(...args, limit, offset) as HygieneJobItemRecord[]
  }

  cancel(jobId: string): boolean {
    const now = new Date().toISOString()
    const res = this.db
      .prepare(`
        UPDATE hygiene_jobs SET status = 'cancelled', completed_at = ?
        WHERE id = ? AND status IN ('queued', 'running')
      `)
      .run(now, jobId)
    return res.changes > 0
  }
}
