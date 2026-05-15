/** Shape of a row from tenant_adb.prov_consultas (Pipeboard pg). */
export interface ProvConsultaRow {
  pasta: string
  deal_id: number
  contato_tipo: string
  contato_id: number
  contato_nome: string | null
  contato_relacao: string | null
  stage_nome: string | null
  pipeline_nome: string | null
  whatsapp_hot: string | null
  telefone_hot_1: string | null
  telefone_hot_2: string | null
  telefone_1: string | null
  telefone_2: string | null
  telefone_3: string | null
  telefone_4: string | null
  telefone_5: string | null
  telefone_6: string | null
  localizado: boolean | null
  telefone_localizado: string | null
}

/** Composite primary key for a prov_consultas lead. */
export interface DealKey {
  pasta: string
  deal_id: number
  contato_tipo: string
  contato_id: number
}

export function dealKeyToString(k: DealKey): string {
  return `${k.pasta}|${k.deal_id}|${k.contato_tipo}|${k.contato_id}`
}

/** Outcome of a per-phone precheck within a job. */
export type PhoneOutcome = 'valid' | 'invalid' | 'error'

/** Matches `CheckSource` from contacts/types.ts (kept as string to avoid tight coupling). */
export type PhoneCheckSource = string

export interface PhoneResult {
  column: string
  raw: string
  normalized: string
  outcome: PhoneOutcome
  source: PhoneCheckSource
  confidence: number | null
  variant_tried: string | null
  error: string | null
}

export interface DealResult {
  key: DealKey
  phones: PhoneResult[]
  valid_count: number
  invalid_count: number
  primary_valid_phone: string | null
}

/** Job lifecycle state. */
export type PrecheckJobStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface PrecheckJob {
  id: string
  status: PrecheckJobStatus
  started_at: string | null
  finished_at: string | null
  cancel_requested: number
  params_json: string
  total_deals: number | null
  scanned_deals: number
  total_phones: number
  valid_phones: number
  invalid_phones: number
  error_phones: number
  cache_hits: number
  last_error: string | null
  created_at: string
  /**
   * Whether Pipedrive activity creation is enabled for this job.
   * 1 = enabled, 0 = disabled. Persisted alongside the params snapshot so
   * audit trails remain accurate even if the env flag flips later.
   */
  pipedrive_enabled: number
  /**
   * Whether the job ran (or is running) in "hygienization mode" — global
   * production sends paused for the duration, conservative rate limits.
   * 1 = enabled, 0 = disabled.
   */
  hygienization_mode: number
  /**
   * What triggered this job: 'manual' (operator-initiated via API),
   * 'retry-errors-sweep' (automatic retry of error_phones), or any
   * future automation label. Defaults to 'manual'.
   */
  triggered_by: string
  /**
   * ID of the job that spawned this one, when created automatically
   * (e.g. by the retry-errors-sweep). NULL for operator-initiated jobs.
   */
  parent_job_id: string | null
  /**
   * Tenant slug owning this job — 'adb' (default), 'sicoob', 'oralsin'.
   * Persisted as a NOT NULL column with default 'adb' for back-compat
   * with rows created before the multi-tenant migration. Optional on
   * the TS type because legacy in-memory fixtures may omit it.
   */
  tenant?: string
}

/** Params for a new scan run. */
export interface PrecheckScanParams {
  /** Max number of deals to scan in this run. Defaults to full pool. */
  limit?: number
  /** Only deals whose phones are older than this many days since last check. */
  recheck_after_days?: number
  /**
   * Which tenant this scan runs against. Determines writeback policy and read
   * client (PipeboardRest for adb, PipeboardRawRest for sicoob/oralsin).
   * Defaults to 'adb' for back-compat.
   */
  tenant?: 'adb' | 'sicoob' | 'oralsin'
  /** Filter by pasta prefix. */
  pasta_prefix?: string
  /** Filter by pipeline_nome. */
  pipeline_nome?: string
  /** If true, also write invalid phones back to prov_invalidos. */
  writeback_invalid?: boolean
  /**
   * @deprecated Removed from Dispatch's responsibility — "telefone
   * localizado" is decided by the provider (which holds the actual
   * delivery answer), not by the existence check Dispatch performs.
   * Kept on the type for back-compat with stored params_json blobs;
   * the scanner ignores it.
   */
  writeback_localizado?: boolean
  /**
   * Per-job opt-in for Pipedrive activity creation. When false the scanner
   * never produces Pipedrive intents for this job, even if the integration
   * is otherwise wired (PIPEDRIVE_API_TOKEN present). When undefined the
   * server falls back to "enabled if token is set" — preserving the old
   * env-only feature flag for compatibility.
   */
  pipedrive_enabled?: boolean
  /**
   * Internal-use only — populated by the scanner when `recheck_after_days`
   * is set. Carries the list of deal keys that were scanned within the
   * freshness window so the Postgres layer can exclude them at query time
   * (small N) or be skipped (large N, scanner-side filtering kicks in).
   *
   * Operators do NOT supply this directly — the API schema rejects it.
   */
  excluded_keys?: DealKey[]
  /**
   * "Hygienization mode" — when true, the scanner pauses the global circuit
   * breaker (`DispatchPauseState` scope='global') for the lifetime of the
   * job and overrides `recheck_after_days` to at least 30 days. The pause
   * is auto-resumed in the scanner's `finally` block, regardless of
   * cancel/error.
   *
   * Use case: large-fleet hygiene runs (>100 deals) where the operator wants
   * to hard-freeze production sends so no message goes out while the scanner
   * walks the pool with conservative rate limits.
   */
  hygienization_mode?: boolean
  /**
   * Per-job ADB device override. When set, the scanner routes the L3
   * probe to this serial instead of the plugin's default
   * (`PLUGIN_ADB_PRECHECK_DEVICE_SERIAL`). Useful when multiple devices
   * are connected and the operator wants the validation phone to come
   * from a specific WhatsApp account.
   */
  device_serial?: string
  /**
   * Per-job WAHA session override for the L2 tiebreaker. Pair with
   * `device_serial` when both legs of validation should target the
   * same WhatsApp account.
   */
  waha_session?: string
  /**
   * Run the end-of-scan retry pass (Level 2): after the main loop, re-validate
   * any phones that ended up `outcome: 'error'`. Defaults to true. Set to
   * false to disable (e.g. for fast scans where you want raw probe results).
   */
  retry_errors?: boolean
}

// ── Pipedrive integration intents ─────────────────────────────────────────
//
// Scanner emits these as fire-and-forget intents; the PipedrivePublisher
// dedups by (scenario, deal_id, phone, job_id) and dispatches via
// PipedriveClient with a token-bucket rate limiter.
//
// ─── Scope (post 2026-04-29) ─────────────────────────────────────────────
// We stopped emitting per-phone Activities (`phone_fail`) — the operator
// reported the deal timeline was too noisy. Active scenarios are now:
//   - `deal_all_fail`  → one Activity per archived deal (privacy-redacted,
//                         no phone numbers in body)
//   - `pasta_summary`  → one Note per pasta at job-completion
//
// The `PipedrivePhoneFailIntent` interface is retained ONLY so the database
// schema (which has historical `phone_fail` rows) and the cleanup script
// remain typeable. No active code path may emit one — if you need to
// repair/delete an old row, do it through the cleanup script.

/** Per-phone validation result fed to the formatter (Scenario B rows). */
export interface PipedrivePhoneEntry {
  phone: string
  column: string
  outcome: PhoneOutcome
  /** Where the validation came from (cache, adb, waha). */
  strategy: string
  confidence: number | null
}

/**
 * @deprecated 2026-04-29 — per-phone Activities removed (too noisy).
 * Type kept only for compatibility with historical `pipedrive_activities`
 * rows where `scenario='phone_fail'`. Do NOT emit new intents of this kind.
 */
export interface PipedrivePhoneFailIntent {
  scenario: 'phone_fail'
  deal_id: number
  pasta: string
  phone: string
  column: string
  /** Where the validation came from (cache, adb, waha). */
  strategy: string
  confidence: number | null
  job_id: string
  /** ISO8601 timestamp when validation completed. */
  occurred_at: string
  /** Cache TTL hint surfaced in the markdown footer (days). */
  cache_ttl_days?: number
}

/** Scenario B: every phone of the deal failed → archived to snapshot. */
export interface PipedriveDealAllFailIntent {
  scenario: 'deal_all_fail'
  deal_id: number
  pasta: string
  phones: PipedrivePhoneEntry[]
  motivo: string
  job_id: string
  occurred_at: string
}

/**
 * Per-deal phone-level breakdown surfaced inside a `pasta_summary` Note.
 *
 * Operators wanted the Pasta Note to spell out *which* phones were checked
 * for *which* deal — not just aggregate counts — so they can spot which
 * column was mistyped, which contact_id is stale, etc. Each row carries the
 * minimum data needed to render `<column> | <number> | ✅/❌/⚠️ | <strategy>`
 * inside the note.
 *
 * Phone numbers stored as the scanner saw them post-normalization (E.164
 * when the normalizer succeeded, raw otherwise) — the formatter pretty-prints
 * for display but always escapes before HTML interpolation.
 */
export interface PipedrivePastaDealRow {
  deal_id: number
  phones: Array<{
    /** Source column from prov_consultas (e.g. 'telefone_1', 'whatsapp_hot'). */
    column: string
    /** Phone as carried by the scanner result (post-normalization). */
    phone_normalized: string
    outcome: PhoneOutcome
    /** Lowercase strategy id ('adb' | 'waha' | 'cache'). */
    strategy: string
  }>
}

/** Scenario C: pasta-level summary posted as a Note on the first deal. */
export interface PipedrivePastaSummaryIntent {
  scenario: 'pasta_summary'
  pasta: string
  /** Pipedrive deal_id of the lowest deal_id row of this pasta within the job. */
  first_deal_id: number
  job_id: string
  job_started: string | null
  job_ended: string | null
  total_deals: number
  ok_deals: number
  archived_deals: number
  total_phones_checked: number
  ok_phones: number
  /** Counts grouped by validation strategy. */
  strategy_counts: {
    adb: number
    waha: number
    cache: number
  }
  /**
   * Per-deal breakdown for the visual "Detalhamento por deal" section.
   *
   * Optional for backwards-compatibility — when omitted the formatter
   * gracefully degrades (no per-deal section, only aggregate metrics). The
   * scanner always populates this; manual API callers and the backfill
   * resolver may pass an empty array when the data is unrecoverable.
   */
  deals?: PipedrivePastaDealRow[]
}

/** Outgoing Pipedrive Activity payload (`POST /v1/activities`). */
export interface PipedriveActivityIntent {
  kind: 'activity'
  /** Used for dedup at publisher level. */
  dedup_key: string
  payload: {
    subject: string
    type: string
    done: 0 | 1
    deal_id: number
    note: string
  }
}

/** Outgoing Pipedrive Note payload (`POST /v1/notes`). */
export interface PipedriveNoteIntent {
  kind: 'note'
  dedup_key: string
  payload: {
    deal_id: number
    content: string
  }
  /**
   * When set, dispatch performs `PUT /v1/notes/<update_target_id>` (update)
   * instead of `POST /v1/notes` (create). Used by the publisher when a prior
   * pasta_summary note exists for the same pasta. The string is the numeric
   * Pipedrive note id (carried as string for URL composition).
   */
  update_target_id?: string
}

export type PipedriveOutgoingIntent = PipedriveActivityIntent | PipedriveNoteIntent
