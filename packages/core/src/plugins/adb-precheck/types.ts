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
}

/** Params for a new scan run. */
export interface PrecheckScanParams {
  /** Max number of deals to scan in this run. Defaults to full pool. */
  limit?: number
  /** Only deals whose phones are older than this many days since last check. */
  recheck_after_days?: number
  /** Filter by pasta prefix. */
  pasta_prefix?: string
  /** Filter by pipeline_nome. */
  pipeline_nome?: string
  /** If true, also write invalid phones back to prov_invalidos. */
  writeback_invalid?: boolean
  /** If true, update prov_consultas.telefone_localizado / localizado. */
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
}

// ── Pipedrive integration intents ─────────────────────────────────────────
//
// Scanner emits these as fire-and-forget intents; the PipedrivePublisher
// dedups by (scenario, deal_id, phone, job_id) and dispatches via
// PipedriveClient with a token-bucket rate limiter.

/** Per-phone validation result fed to the formatter (Scenario A & B rows). */
export interface PipedrivePhoneEntry {
  phone: string
  column: string
  outcome: PhoneOutcome
  /** Where the validation came from (cache, adb, waha). */
  strategy: string
  confidence: number | null
}

/** Scenario A: a single phone failed WhatsApp validation. */
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
}

export type PipedriveOutgoingIntent = PipedriveActivityIntent | PipedriveNoteIntent
