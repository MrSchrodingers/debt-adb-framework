import type Database from 'better-sqlite3'

/**
 * SDR-owned tables. All idempotent (CREATE IF NOT EXISTS / unique indexes
 * on conflict-friendly columns). The plugin owns these — they live in the
 * core SQLite database but are namespaced with the `sdr_` prefix so core
 * migrations never touch them.
 *
 * Schema rationale (spec §5.3–§5.6):
 * - sdr_lead_queue: each pull-result row; UNIQUE(tenant, deal_id) makes
 *   the pull idempotent across cron ticks
 * - sdr_sequence_state: FSM per lead; processing_lock prevents two
 *   sequencer ticks from advancing the same lead concurrently
 * - sdr_contact_identity: identity-gate state per (tenant, sender,
 *   contact); composite PK enforces uniqueness per partition
 * - sdr_classifier_log: append-only audit trail of every classification
 *   call (regex hit, LLM call, low-confidence fallback)
 * - sdr_pending_writebacks: failed Pipedrive writebacks; retried with
 *   exponential backoff
 */
const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS sdr_lead_queue (
    id TEXT PRIMARY KEY,
    tenant TEXT NOT NULL,
    pipedrive_deal_id INTEGER NOT NULL,
    contact_phone TEXT NOT NULL,
    contact_name TEXT NOT NULL,
    pipedrive_context_json TEXT,
    pulled_at TEXT NOT NULL,
    state TEXT NOT NULL,
    stop_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(tenant, pipedrive_deal_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sdr_lead_state ON sdr_lead_queue(state, updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_sdr_lead_tenant ON sdr_lead_queue(tenant, state)`,

  `CREATE TABLE IF NOT EXISTS sdr_sequence_state (
    lead_id TEXT PRIMARY KEY REFERENCES sdr_lead_queue(id) ON DELETE CASCADE,
    sequence_id TEXT NOT NULL,
    sender_phone TEXT NOT NULL,
    current_step INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    next_action_at TEXT NOT NULL,
    last_message_id TEXT,
    last_message_sent_at TEXT,
    last_response_at TEXT,
    last_response_classification TEXT,
    attempts_total INTEGER NOT NULL DEFAULT 0,
    stop_reason TEXT,
    processing_lock TEXT,
    processing_lock_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sdr_seq_ready ON sdr_sequence_state(status, next_action_at)`,

  `CREATE TABLE IF NOT EXISTS sdr_contact_identity (
    tenant TEXT NOT NULL,
    sender_phone TEXT NOT NULL,
    contact_phone TEXT NOT NULL,
    state TEXT NOT NULL,
    intro_message_id TEXT,
    nudge_message_id TEXT,
    classification TEXT,
    classifier_confidence REAL,
    raw_response TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (tenant, sender_phone, contact_phone)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sdr_identity_pending ON sdr_contact_identity(state, updated_at) WHERE state = 'pending'`,

  `CREATE TABLE IF NOT EXISTS sdr_classifier_log (
    id TEXT PRIMARY KEY,
    lead_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    response_text TEXT NOT NULL,
    category TEXT NOT NULL,
    confidence REAL NOT NULL,
    source TEXT NOT NULL,
    llm_reason TEXT,
    latency_ms INTEGER NOT NULL,
    classified_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_classifier_lead ON sdr_classifier_log(lead_id)`,
  `CREATE INDEX IF NOT EXISTS idx_classifier_source ON sdr_classifier_log(source, classified_at)`,

  `CREATE TABLE IF NOT EXISTS sdr_pending_writebacks (
    id TEXT PRIMARY KEY,
    tenant TEXT NOT NULL,
    lead_id TEXT NOT NULL,
    action TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    next_attempt_at TEXT NOT NULL,
    abandoned_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_writeback_pending ON sdr_pending_writebacks(next_attempt_at, abandoned_at) WHERE abandoned_at IS NULL`,

  // C26: operator alerts queue — surfaced via admin route (Task 39).
  `CREATE TABLE IF NOT EXISTS sdr_operator_alerts (
    id TEXT PRIMARY KEY,
    tenant TEXT NOT NULL,
    lead_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    response_text TEXT NOT NULL,
    reason TEXT NOT NULL,
    llm_reason TEXT,
    raised_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    resolved_at TEXT,
    resolution TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_alerts_unresolved ON sdr_operator_alerts(raised_at) WHERE resolved_at IS NULL`,
  // Idempotency: one alert per (lead, message, reason) — repeated
  // classifier calls on the same response don't spam the queue.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_dedupe ON sdr_operator_alerts(lead_id, message_id, reason)`,
] as const

export function initSdrSchema(db: Database.Database): void {
  for (const stmt of STATEMENTS) {
    db.prepare(stmt).run()
  }
}

export const SDR_TABLES = [
  'sdr_lead_queue',
  'sdr_sequence_state',
  'sdr_contact_identity',
  'sdr_classifier_log',
  'sdr_pending_writebacks',
  'sdr_operator_alerts',
] as const
