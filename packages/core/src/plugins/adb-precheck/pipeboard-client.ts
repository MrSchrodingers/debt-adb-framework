import type { ProvConsultaRow, DealKey, PrecheckScanParams } from './types.js'

/**
 * Columns in tenant_adb.prov_consultas that can hold a phone. Kept in sync
 * with PHONE_COLUMNS in phone-extractor.ts. Used as a whitelist for any
 * dynamic SQL composition so the column list is never user-controlled.
 */
export const PHONE_COLUMNS = [
  'whatsapp_hot',
  'telefone_hot_1',
  'telefone_hot_2',
  'telefone_1',
  'telefone_2',
  'telefone_3',
  'telefone_4',
  'telefone_5',
  'telefone_6',
] as const
export type PhoneColumn = (typeof PHONE_COLUMNS)[number]

/** Healthcheck result returned by every backend. */
export type HealthcheckResult =
  | { ok: true; server_time: string }
  | { ok: false; error: string }

/** Per-phone payload accepted by `recordInvalidPhone`. */
export interface InvalidPhoneRecord {
  telefone: string
  motivo: string
  colunaOrigem: string | null
  invalidadoPor: string
  jobId: string | null
  confidence: number | null
}

/**
 * Source identifier — matches the `fonte` enum on the Pipeboard side
 * (`router_api_keys.scopes` + `prov_telefones_invalidos` CHECK
 * constraint). Defaults to `dispatch_adb_precheck` when omitted.
 */
export type InvalidationFonte =
  | 'dispatch_adb_precheck'
  | 'debt_adb_intern_admin'
  | 'debt_adb_provider'
  | 'oralsin_callback'
  | 'manual_backfill'

/** Single phone in a batch invalidation. */
export interface BatchInvalidPhone {
  telefone: string
  colunaOrigem: PhoneColumn | null
  confidence: number | null
}

/** Payload for `applyDealInvalidation` — bates 1:1 com o endpoint. */
export interface DealInvalidationRequest {
  motivo: string
  jobId: string | null
  fonte: InvalidationFonte
  phones: BatchInvalidPhone[]
  archiveIfEmpty: boolean
}

/** Per-phone result returned by Pipeboard. */
export type AppliedPhoneStatus =
  | 'applied'
  | 'duplicate_already_moved'
  | 'rejected_invalid_input'
  | 'rejected_no_match'

export interface AppliedPhone {
  telefone: string
  status: AppliedPhoneStatus
  /**
   * `prov_consultas` columns NULLified for this phone (e.g.
   * `["telefone_3"]`). Empty when status != 'applied'. Mirrors the
   * server-side `cleared_from` field.
   */
  clearedFrom?: string[]
}

/** Successful response from `applyDealInvalidation`. */
export interface DealInvalidationResponse {
  requestId: string
  idempotent: boolean
  applied: AppliedPhone[]
  archived: boolean
  clearedColumns: string[]
}

/** Payload for `applyDealLocalization`. */
export interface DealLocalizationRequest {
  telefone: string
  source: 'cache' | 'adb' | 'waha' | 'manual'
  jobId: string | null
  fonte: InvalidationFonte
}

export interface DealLocalizationResponse {
  requestId: string
  idempotent: boolean
  applied: boolean
}

/**
 * Status returned per-key by `POST /precheck/deals/lookup` (Pipeboard
 * spec: `docs/pipeboard-spec/precheck-deals-lookup.md`).
 *
 *   - `active`     row exists in `prov_consultas` right now
 *   - `deleted`    row was in the pool and has been removed (snapshot
 *                  tombstone, ETL move, or only blocklist hits remain)
 *   - `not_found`  Pipeboard has no record of this key in any table
 */
export type DealLookupStatus = 'active' | 'deleted' | 'not_found'

/** Per-key invalidated phone history slice (capped @ 50 by Pipeboard). */
export interface DealLookupInvalidatedPhone {
  telefone: string
  colunaOrigem: string | null
  motivo: string
  fonte: string
  invalidadoEm: string
}

export interface DealLookupResult {
  key: DealKey
  status: DealLookupStatus
  /**
   * For `active` rows: `prov_consultas.update_time` (Pipedrive's
   * row-level update timestamp — there is no Pipeboard-side
   * `updated_at` column, see spec §4 Q1). For `deleted` rows: the
   * tombstone timestamp (mirrors `deleted_at`). For `not_found`: null.
   */
  lastModifiedAt: string | null
  /** Present only when `status='deleted'`. */
  deletedAt: string | null
  /** Full `telefone_*` map when active; null otherwise. */
  activePhones: Record<string, string | null> | null
  /** Capped at 50 per key on the Pipeboard side. */
  invalidatedPhones: DealLookupInvalidatedPhone[]
}

/**
 * Single contract for any Pipeboard backend (raw SQL via SSH tunnel,
 * REST over HTTPS, or test fakes). Both `PipeboardPg` and the upcoming
 * `PipeboardRest` MUST implement this interface so the scanner can swap
 * backends via env flag without code changes.
 *
 * Selection at boot:
 *   PLUGIN_ADB_PRECHECK_BACKEND=sql  → PipeboardPg (default until cutover)
 *   PLUGIN_ADB_PRECHECK_BACKEND=rest → PipeboardRest (after Pipeboard
 *                                       endpoints land + dual-write
 *                                       window completes)
 *
 * All write methods MUST be idempotent. Identical (key, payload) replays
 * are no-ops in SQL backends (ON CONFLICT, CASE WHEN guards) and return
 * the cached response in REST backends (Idempotency-Key replay).
 */
export interface IPipeboardClient {
  /** Connection liveness probe. Cheap; safe to call from healthchecks. */
  healthcheck(): Promise<HealthcheckResult>

  /** Release any held resources (pool connections, sockets). */
  close(): Promise<void>

  /** Count deals available to scan given the filter. */
  countPool(params: PrecheckScanParams): Promise<number>

  /**
   * Stream deals page by page. The scanner is responsible for breaking
   * out of the loop once `params.limit` deals have been actually
   * processed — backends do NOT enforce that ceiling because the
   * freshness filter happens scanner-side for sets > 5000 keys.
   */
  iterateDeals(
    params: PrecheckScanParams,
    pageSize?: number,
  ): AsyncGenerator<ProvConsultaRow[], void, void>

  /**
   * Apply all invalidations for a single deal in one atomic call.
   *
   * REST backend: maps to `POST /precheck/phones/invalidate` (live,
   * idempotent, transactional, fires Pipedrive workflow server-side).
   *
   * SQL backend: shim that calls the legacy per-phone methods in
   * sequence (recordInvalidPhone + clearInvalidPhone +
   * clearLocalizadoIfMatches + optional archiveDealIfEmpty). Behaviour
   * is preserved but is NOT atomic across phones — kept only as a
   * fallback during the transition.
   */
  applyDealInvalidation(
    key: DealKey,
    payload: DealInvalidationRequest,
  ): Promise<DealInvalidationResponse>

  /**
   * Mark the first valid phone found for a deal as `localizado`.
   *
   * REST backend: maps to `POST /precheck/deals/localize` (roadmap).
   * SQL backend: UPDATE prov_consultas (writeLocalizado).
   */
  applyDealLocalization(
    key: DealKey,
    payload: DealLocalizationRequest,
  ): Promise<DealLocalizationResponse>

  /**
   * Batch-lookup the current Pipeboard-side state of specific
   * `(pasta, deal_id, contato_tipo, contato_id)` tuples. Maps 1:1 to
   * `POST /precheck/deals/lookup` (see
   * `docs/pipeboard-spec/precheck-deals-lookup.md`). Up to 500 keys
   * per call; caller is responsible for batching larger sets.
   *
   * Used by reconciliation tooling (resolve `rejected_no_match`,
   * crash-recovery diagnostics, mid-scan drift detection). SQL backend
   * has no equivalent and throws `NotSupportedByRestBackendError`.
   */
  lookupDeals(keys: DealKey[]): Promise<DealLookupResult[]>

  /**
   * Aggregate phone counts by Brazilian DDD across the entire Pipeboard
   * pool. Returns `{ ddd: count }` covering every non-null phone in the
   * standard phone columns (`telefone_hot_*`, `telefone_*`). Phones with
   * a country-code prefix (55…) are stripped before extracting the DDD.
   *
   * Used by the geolocation tab to plot the global cohort, not just the
   * subset Dispatch has already scanned.
   *
   * Optional — backends that don't have a cheap aggregation primitive
   * (REST) may omit this method; callers should fall back to local data.
   */
  aggregatePhoneDddDistribution?(): Promise<Record<string, number>>

  // -----------------------------------------------------------------
  // Legacy per-operation methods. Kept on the SQL backend for backwards
  // compatibility with tests that exercise them directly. The REST
  // backend MUST throw `NotSupportedByRestBackendError` from these —
  // the scanner is expected to use the batch methods above.
  // -----------------------------------------------------------------

  /** @deprecated use applyDealInvalidation. SQL-only. */
  writeInvalid(key: DealKey, motivo: string): Promise<number>

  /** @deprecated use applyDealInvalidation. SQL-only. */
  clearInvalidPhone(key: DealKey, rawPhone: string): Promise<number>

  /** @deprecated use applyDealInvalidation. SQL-only. */
  clearLocalizadoIfMatches(key: DealKey, rawPhone: string): Promise<number>

  /** @deprecated use applyDealInvalidation. SQL-only. */
  recordInvalidPhone(key: DealKey, record: InvalidPhoneRecord): Promise<void>

  /** @deprecated use applyDealInvalidation with archiveIfEmpty=true. SQL-only. */
  archiveDealIfEmpty(key: DealKey, motivo: string): Promise<boolean>

  /** @deprecated use applyDealLocalization. SQL-only. */
  writeLocalizado(key: DealKey, phone: string, source: string): Promise<void>
}

/**
 * Thrown by `PipeboardRest` when a method that has no REST equivalent
 * yet (or a legacy SQL-only method) is invoked. The scanner must
 * route through the batch methods (`applyDealInvalidation`,
 * `applyDealLocalization`) when running with `BACKEND=rest`.
 */
export class NotSupportedByRestBackendError extends Error {
  constructor(operation: string) {
    super(
      `${operation} is not supported by the REST backend. ` +
        `Use applyDealInvalidation / applyDealLocalization instead.`,
    )
    this.name = 'NotSupportedByRestBackendError'
  }
}

/**
 * Thrown by `PipeboardRest` when an endpoint that the Pipeboard team
 * has on the roadmap but not yet shipped is called. Prevents silent
 * fallthrough to the SQL backend.
 */
export class NotYetSupportedError extends Error {
  constructor(operation: string) {
    super(`${operation} is on the Pipeboard roadmap but not yet live.`)
    this.name = 'NotYetSupportedError'
  }
}

/**
 * Mirror of {@link NotSupportedByRestBackendError} for the opposite
 * direction: operations that exist only on the REST backend (e.g.
 * `lookupDeals`, which depends on the `prov_consultas_snapshot` /
 * `prov_telefones_invalidos` joins the REST router materialises).
 * Callers must run with `PLUGIN_ADB_PRECHECK_BACKEND=rest`.
 */
export class NotSupportedBySqlBackendError extends Error {
  constructor(operation: string) {
    super(
      `${operation} is not supported by the SQL backend. ` +
        `Run Dispatch with PLUGIN_ADB_PRECHECK_BACKEND=rest to call it.`,
    )
    this.name = 'NotSupportedBySqlBackendError'
  }
}

/**
 * Boot-time backend selection. Defaults to `sql` so existing
 * deployments keep working unchanged.
 */
export type PipeboardBackend = 'sql' | 'rest'

export function resolvePipeboardBackend(env = process.env): PipeboardBackend {
  const v = (env.PLUGIN_ADB_PRECHECK_BACKEND ?? 'sql').toLowerCase()
  if (v === 'rest') return 'rest'
  if (v === 'sql') return 'sql'
  throw new Error(
    `PLUGIN_ADB_PRECHECK_BACKEND must be 'sql' or 'rest', got '${v}'`,
  )
}
