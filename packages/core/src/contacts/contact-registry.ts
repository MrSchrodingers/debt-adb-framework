import type Database from 'better-sqlite3'
import { nanoid } from 'nanoid'
import type {
  WaContactRecord,
  WaContactCheck,
  CheckSource,
  CheckResult,
  TriggeredBy,
} from './types.js'

const SCHEMA_SQL = `
  -- Legacy contacts table (originally in MessageQueue.initialize).
  -- Declared here too so ContactRegistry works standalone (tests, tooling).
  CREATE TABLE IF NOT EXISTS contacts (
    phone TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    registered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE TABLE IF NOT EXISTS wa_contacts (
    phone_normalized TEXT PRIMARY KEY,
    phone_input_last TEXT NOT NULL,
    wa_chat_id TEXT,
    exists_on_wa INTEGER,
    last_check_source TEXT,
    last_check_confidence REAL,
    last_check_id TEXT,
    last_checked_at TEXT,
    recheck_due_at TEXT,
    check_count INTEGER NOT NULL DEFAULT 0,
    send_attempts INTEGER NOT NULL DEFAULT 0,
    send_successes INTEGER NOT NULL DEFAULT 0,
    first_seen_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    ddd TEXT,
    country_code TEXT NOT NULL DEFAULT '55',
    metadata TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_wa_contacts_validity
    ON wa_contacts(exists_on_wa, recheck_due_at);
  CREATE INDEX IF NOT EXISTS idx_wa_contacts_ddd
    ON wa_contacts(ddd, exists_on_wa);

  CREATE TABLE IF NOT EXISTS wa_contact_checks (
    id TEXT PRIMARY KEY,
    phone_normalized TEXT NOT NULL,
    phone_variant_tried TEXT NOT NULL,
    source TEXT NOT NULL,
    result TEXT NOT NULL,
    confidence REAL,
    evidence TEXT,
    device_serial TEXT,
    waha_session TEXT,
    triggered_by TEXT NOT NULL,
    latency_ms INTEGER,
    checked_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_wa_checks_phone_time
    ON wa_contact_checks(phone_normalized, checked_at DESC);
  CREATE INDEX IF NOT EXISTS idx_wa_checks_source
    ON wa_contact_checks(source, checked_at);
  CREATE INDEX IF NOT EXISTS idx_wa_checks_trigger
    ON wa_contact_checks(triggered_by);
  CREATE INDEX IF NOT EXISTS idx_wa_checks_ddd_checked
    ON wa_contact_checks(substr(phone_normalized, 3, 2), checked_at);
`

export interface CheckInput {
  phone_input: string
  phone_variant_tried: string
  source: CheckSource
  result: CheckResult
  confidence: number | null
  evidence: Record<string, unknown> | null
  device_serial: string | null
  waha_session: string | null
  triggered_by: TriggeredBy
  latency_ms: number | null
  ddd?: string
  wa_chat_id?: string | null
  attempt_phase?: 'probe_initial' | 'probe_recover' | 'scan_retry' | 'sweep_retry'
}

export interface RecordResult {
  contact: WaContactRecord
  checkId: string
}

function resultToExistsFlag(r: CheckResult): 0 | 1 | null {
  if (r === 'exists') return 1
  if (r === 'not_exists') return 0
  return null
}

export class ContactRegistry {
  constructor(private db: Database.Database) {}

  initialize(): void {
    this.db.exec(SCHEMA_SQL)
    // A5: idempotent column add for attempt_phase + supporting index.
    const checkCols = this.db
      .prepare("PRAGMA table_info('wa_contact_checks')")
      .all() as Array<{ name: string }>
    if (!checkCols.some((c) => c.name === 'attempt_phase')) {
      this.db.exec(
        "ALTER TABLE wa_contact_checks ADD COLUMN attempt_phase TEXT NOT NULL DEFAULT 'probe_initial'",
      )
    }
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_wa_checks_phase_time ON wa_contact_checks(attempt_phase, checked_at DESC)',
    )
  }

  lookup(phoneNormalized: string): WaContactRecord | null {
    const row = this.db
      .prepare(`
        SELECT wa.*, c.name AS name
        FROM wa_contacts wa
        LEFT JOIN contacts c ON c.phone = wa.phone_normalized
        WHERE wa.phone_normalized = ?
      `)
      .get(phoneNormalized) as WaContactRecord | undefined
    return row ?? null
  }

  record(phoneNormalized: string, input: CheckInput): RecordResult {
    const checkId = nanoid()
    const now = new Date().toISOString()
    const existsFlag = resultToExistsFlag(input.result)
    const evidenceJson = input.evidence ? JSON.stringify(input.evidence) : null
    const isDecisive = input.result === 'exists' || input.result === 'not_exists'
    const isError = input.result === 'error'

    const tx = this.db.transaction(() => {
      this.db
        .prepare(`
          INSERT INTO wa_contact_checks
            (id, phone_normalized, phone_variant_tried, source, result, confidence,
             evidence, device_serial, waha_session, triggered_by, latency_ms, attempt_phase, checked_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        `)
        .run(
          checkId,
          phoneNormalized,
          input.phone_variant_tried,
          input.source,
          input.result,
          input.confidence,
          evidenceJson,
          input.device_serial,
          input.waha_session,
          input.triggered_by,
          input.latency_ms,
          input.attempt_phase ?? 'probe_initial',
          now,
        )

      // M5 / D10: result='error' logs a check but MUST NOT touch wa_contacts
      // (preserves previous state; error != not_exists).
      if (isError) return

      // I2: clear recheck_due_at only when the new check is decisive
      // (exists | not_exists). Inconclusive/error preserve existing value.
      this.db
        .prepare(`
          INSERT INTO wa_contacts (
            phone_normalized, phone_input_last, wa_chat_id, exists_on_wa,
            last_check_source, last_check_confidence, last_check_id, last_checked_at,
            recheck_due_at,
            check_count, first_seen_at, updated_at, ddd, country_code
          )
          VALUES (?,?,?,?,?,?,?,?, NULL, 1,?,?,?,?)
          ON CONFLICT(phone_normalized) DO UPDATE SET
            phone_input_last = excluded.phone_input_last,
            wa_chat_id = COALESCE(excluded.wa_chat_id, wa_contacts.wa_chat_id),
            exists_on_wa = excluded.exists_on_wa,
            last_check_source = excluded.last_check_source,
            last_check_confidence = excluded.last_check_confidence,
            last_check_id = excluded.last_check_id,
            last_checked_at = excluded.last_checked_at,
            recheck_due_at = CASE WHEN ? THEN NULL ELSE wa_contacts.recheck_due_at END,
            check_count = wa_contacts.check_count + 1,
            updated_at = excluded.updated_at,
            ddd = COALESCE(excluded.ddd, wa_contacts.ddd)
        `)
        .run(
          phoneNormalized,
          input.phone_input,
          input.wa_chat_id ?? null,
          existsFlag,
          input.source,
          input.confidence,
          checkId,
          now,
          now,
          now,
          input.ddd ?? null,
          '55',
          isDecisive ? 1 : 0,
        )
    })

    tx()

    const contact = this.lookup(phoneNormalized)
    if (!contact) throw new Error('ContactRegistry: record failed to persist')
    return { contact, checkId }
  }

  list(params: {
    limit?: number
    offset?: number
    exists_on_wa?: 0 | 1 | null
    ddd?: string
    search?: string
  } = {}): { data: WaContactRecord[]; total: number } {
    const conds: string[] = []
    const condsJoined: string[] = []
    const args: unknown[] = []
    if (params.exists_on_wa !== undefined) {
      if (params.exists_on_wa === null) {
        conds.push('exists_on_wa IS NULL')
        condsJoined.push('wa.exists_on_wa IS NULL')
      } else {
        conds.push('exists_on_wa = ?')
        condsJoined.push('wa.exists_on_wa = ?')
        args.push(params.exists_on_wa)
      }
    }
    if (params.ddd) {
      conds.push('ddd = ?')
      condsJoined.push('wa.ddd = ?')
      args.push(params.ddd)
    }
    if (params.search) {
      conds.push('phone_normalized LIKE ?')
      condsJoined.push('(wa.phone_normalized LIKE ? OR c.name LIKE ?)')
      const term = `%${params.search.replace(/\D/g, '')}%`
      args.push(term)
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
    const whereJoined = condsJoined.length ? `WHERE ${condsJoined.join(' AND ')}` : ''
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 500)
    const offset = Math.max(params.offset ?? 0, 0)

    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM wa_contacts ${where}`).get(...args) as { n: number }).n

    // Extra arg for the OR c.name LIKE ? (search duplicated for name)
    const searchArgs = params.search ? [`%${params.search}%`] : []
    const data = this.db
      .prepare(`
        SELECT wa.*, c.name AS name
        FROM wa_contacts wa
        LEFT JOIN contacts c ON c.phone = wa.phone_normalized
        ${whereJoined}
        ORDER BY wa.updated_at DESC LIMIT ? OFFSET ?
      `)
      .all(...args, ...searchArgs, limit, offset) as WaContactRecord[]
    return { data, total }
  }

  history(phoneNormalized: string, opts: { limit?: number } = {}): WaContactCheck[] {
    const limit = opts.limit ?? 100
    return this.db
      .prepare(`
        SELECT * FROM wa_contact_checks
        WHERE phone_normalized = ?
        ORDER BY checked_at DESC, id DESC
        LIMIT ?
      `)
      .all(phoneNormalized, limit) as WaContactCheck[]
  }

  forceRecheckDue(phoneNormalized: string, reason: string): void {
    const now = new Date().toISOString()
    const checkId = nanoid()
    const tx = this.db.transaction(() => {
      // I1: update first — rollback if phone unknown, preventing orphan check rows
      const res = this.db
        .prepare(`
          UPDATE wa_contacts
          SET recheck_due_at = ?, updated_at = ?
          WHERE phone_normalized = ?
        `)
        .run(now, now, phoneNormalized)
      if (res.changes === 0) {
        throw new Error(`ContactRegistry.forceRecheckDue: unknown phone ${phoneNormalized}`)
      }
      this.db
        .prepare(`
          INSERT INTO wa_contact_checks
            (id, phone_normalized, phone_variant_tried, source, result, confidence,
             evidence, device_serial, waha_session, triggered_by, latency_ms, checked_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        `)
        .run(
          checkId,
          phoneNormalized,
          phoneNormalized,
          'manual_recheck',
          'inconclusive',
          null,
          JSON.stringify({ reason }),
          null,
          null,
          'manual',
          null,
          now,
        )
    })
    tx()
  }
}
