import { createHash } from 'node:crypto'
import { precheckPipeboardRequestTotal } from '../../config/metrics.js'
import type { DealKey, ProvConsultaRow, PrecheckScanParams } from './types.js'
import {
  NotSupportedByRestBackendError,
  PHONE_COLUMNS,
  type AppliedPhone,
  type DealInvalidationRequest,
  type DealInvalidationResponse,
  type DealLocalizationRequest,
  type DealLocalizationResponse,
  type DealLookupInvalidatedPhone,
  type DealLookupResult,
  type DealLookupStatus,
  type HealthcheckResult,
  type IPipeboardClient,
  type InvalidPhoneRecord,
} from './pipeboard-client.js'
import { extractDdd as extractDddFromRawPhone } from '../../util/ddd.js'

type RestOp = 'invalidate' | 'localize' | 'deals' | 'healthz' | 'lookup'

/** Server-side cap per spec — keep client requests under the limit. */
const LOOKUP_BATCH_LIMIT = 500

export interface PipeboardRestOpts {
  /** Full base URL including `/api/v1` and the tenant segment, e.g. http://pipeboard-router:18080/api/v1/adb */
  baseUrl: string
  /** API key to send via X-API-Key. Required. */
  apiKey: string
  /** Per-request timeout in ms (default 15000). */
  timeoutMs?: number
  /** Injectable fetch (default: globalThis.fetch). */
  fetchImpl?: typeof globalThis.fetch
  /** Identity passed as `fonte` when the scanner does not specify one. */
  defaultFonte?: 'dispatch_adb_precheck' | 'debt_adb_intern_admin'
}

/**
 * REST implementation of `IPipeboardClient`. Issues HTTP calls against
 * the Pipeboard router endpoints documented in
 * `docs/api/pipeboard-precheck.openapi.yaml`.
 *
 * Currently live: `applyDealInvalidation`. The rest of the surface
 * throws `NotYetSupportedError` until Pipeboard ships the roadmap
 * endpoints (GET /deals, GET /healthz, POST /deals/localize). The
 * scanner runs in hybrid mode in the meantime: reads via
 * `PipeboardPg`, writes via `PipeboardRest`.
 *
 * Idempotency: the key for `applyDealInvalidation` is
 * `sha256(jobId + dealKey + payloadHash)` — deterministic, so retries
 * after timeouts replay the same request and Pipeboard returns the
 * original response with `idempotent: true`.
 *
 * Mutual exclusion: the Pipeboard guardrail trigger silently zeros
 * any SQL UPDATE that would reintroduce a blocked phone. Operating
 * REST and SQL backends concurrently against the same tenant is
 * unsafe — the env flag `PLUGIN_ADB_PRECHECK_BACKEND` MUST select
 * exactly one.
 */
export class PipeboardRest implements IPipeboardClient {
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly defaultFonte: NonNullable<PipeboardRestOpts['defaultFonte']>

  /** In-process cache for the DDD distribution. Refreshed every 5min. */
  private dddCache: { buckets: Record<string, number>; fetchedAt: number } | null = null
  private dddFetchInFlight: Promise<Record<string, number>> | null = null

  constructor(opts: PipeboardRestOpts) {
    if (!opts.apiKey) throw new Error('PipeboardRest requires apiKey')
    if (!opts.baseUrl) throw new Error('PipeboardRest requires baseUrl')
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.apiKey = opts.apiKey
    this.timeoutMs = opts.timeoutMs ?? 15_000
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch
    this.defaultFonte = opts.defaultFonte ?? 'dispatch_adb_precheck'
  }

  async close(): Promise<void> {
    // No persistent resources — fetch is request-scoped.
  }

  // --- Live endpoints --------------------------------------------------

  async applyDealInvalidation(
    key: DealKey,
    payload: DealInvalidationRequest,
  ): Promise<DealInvalidationResponse> {
    const body = {
      fonte: payload.fonte ?? this.defaultFonte,
      deal_id: key.deal_id,
      pasta: key.pasta,
      contato_tipo: key.contato_tipo,
      contato_id: key.contato_id,
      motivo: payload.motivo,
      job_id: payload.jobId,
      phones: payload.phones.map((p) => ({
        telefone: p.telefone,
        coluna_origem: p.colunaOrigem,
        confidence: p.confidence,
      })),
      archive_if_empty: payload.archiveIfEmpty,
      // Pipeboard's Temporal worker used to emit a per-deal Pipedrive
      // activity titled "📵 Telefones invalidados — N números removidos
      // do deal" after every successful invalidate. The wording confused
      // CRM operators (the phones were removed from prov_consultas, not
      // from Pipedrive) and we keep only the per-pasta `pasta_summary`
      // from the Dispatch side. The router team added this flag (along
      // with /deals/count) to suppress the emission per request — older
      // routers ignore it, so it's safe to send unconditionally.
      emit_pipedrive_deal_summary: false,
    }
    const idempotencyKey = buildIdempotencyKey(payload.jobId, key, body)
    const res = await this.request('POST', '/precheck/phones/invalidate', body, {
      'Idempotency-Key': idempotencyKey,
    })
    const json = (await res.json()) as {
      request_id: string
      idempotent: boolean
      applied: Array<{
        telefone: string
        status: AppliedPhone['status']
        cleared_from?: string[]
      }>
      // Pipeboard returns `deal_archived` in its current response;
      // accept the legacy `archived` alias defensively.
      deal_archived?: boolean
      archived?: boolean
      cleared_columns?: string[]
      pipedrive?: { scenario?: string; workflow_id?: string }
    }
    const applied: AppliedPhone[] = (json.applied ?? []).map((p) => ({
      telefone: p.telefone,
      status: p.status,
      clearedFrom: p.cleared_from ?? [],
    }))
    // Aggregate cleared_from across phones for the legacy
    // clearedColumns top-level field, falling back to the deprecated
    // server-side `cleared_columns` if no per-phone data exists.
    const aggregatedCleared = new Set<string>()
    for (const p of applied) {
      for (const c of p.clearedFrom ?? []) aggregatedCleared.add(c)
    }
    const clearedColumns = aggregatedCleared.size > 0
      ? [...aggregatedCleared]
      : (json.cleared_columns ?? [])
    return {
      requestId: json.request_id,
      idempotent: Boolean(json.idempotent),
      applied,
      archived: Boolean(json.deal_archived ?? json.archived),
      clearedColumns,
    }
  }

  // --- Live endpoints (read + localize) --------------------------------

  async healthcheck(): Promise<HealthcheckResult> {
    try {
      const res = await this.request('GET', '/precheck/healthz', null, {}, /*noAuth*/ true)
      const json = (await res.json()) as {
        status: string
        db_latency_ms?: number
        version?: string
      }
      const ok = json.status === 'ok'
      return ok
        ? { ok: true, server_time: new Date().toISOString() }
        : { ok: false, error: `pipeboard status=${json.status}` }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  /**
   * Pool size from Pipeboard's `GET /precheck/deals/count`. Pipeboard
   * returns `{ total_estimate: number, method: string, last_analyze:
   * string }` — `method` is typically `pg_class.reltuples` (cheap, ±10%
   * accuracy) or `count_exact` if/when they enable the precise path.
   *
   * Returning `-1` keeps the legacy "unknown" contract so the scanner
   * and the /stats/global endpoint fall back to absolute counts when
   * the route is missing (older Pipeboard build) or the request fails
   * — the UI already collapses denominators to `null` in that path.
   */
  async countPool(_params: PrecheckScanParams): Promise<number> {
    try {
      const res = await this.request('GET', '/precheck/deals/count', null)
      const json = (await res.json()) as { total_estimate?: number }
      const n = json.total_estimate
      if (typeof n === 'number' && Number.isFinite(n) && n >= 0) return n
      return -1
    } catch {
      // 404 (older router), network blip, parse error — degrade to
      // "unknown" instead of throwing into the scan pipeline.
      return -1
    }
  }

  /**
   * Stream deals page by page. Cursor is opaque base64url; we pass it
   * verbatim as `cursor=` on the next call. Iteration stops when
   * Pipeboard returns `next_cursor: null`.
   */
  async *iterateDeals(
    params: PrecheckScanParams,
    pageSize = 200,
  ): AsyncGenerator<ProvConsultaRow[], void, void> {
    let cursor: string | null = null
    while (true) {
      const qs = this.buildDealsQuery(params, cursor, pageSize)
      const res = await this.request('GET', `/precheck/deals?${qs}`, null)
      const json = (await res.json()) as {
        items: ProvConsultaRow[]
        next_cursor: string | null
        has_more?: boolean
      }
      if (json.items.length === 0) return
      yield json.items
      // Pipeboard returns `next_cursor: null` on the last page; some
      // historical responses use `has_more: false` as the same signal.
      if (!json.next_cursor || json.has_more === false) return
      cursor = json.next_cursor
    }
  }

  async applyDealLocalization(
    key: DealKey,
    payload: DealLocalizationRequest,
  ): Promise<DealLocalizationResponse> {
    const body = {
      fonte: payload.fonte ?? this.defaultFonte,
      deal_id: key.deal_id,
      pasta: key.pasta,
      contato_tipo: key.contato_tipo,
      contato_id: key.contato_id,
      telefone: payload.telefone,
      source: payload.source,
      job_id: payload.jobId,
    }
    const idempotencyKey = buildIdempotencyKey(payload.jobId, key, body)
    const res = await this.request('POST', '/precheck/deals/localize', body, {
      'Idempotency-Key': idempotencyKey,
    })
    const json = (await res.json()) as {
      request_id: string
      idempotent: boolean
      status?: 'applied' | 'noop_already_localized'
      applied?: boolean
    }
    const applied = json.status
      ? json.status === 'applied'
      : Boolean(json.applied)
    return {
      requestId: json.request_id,
      idempotent: Boolean(json.idempotent),
      applied,
    }
  }

  /**
   * Batch point-lookup against `POST /precheck/deals/lookup`. Chunks
   * client-side at 500 keys (server hard-cap, see Pipeboard spec §2).
   * Preserves input order across chunks so callers can zip results
   * back to their key list by index.
   *
   * The response shape uses snake_case from the wire (`last_modified_at`,
   * `active_phones`, `invalidated_phones`); we remap to the camelCase
   * `DealLookupResult` so consumers stay TypeScript-idiomatic.
   */
  async lookupDeals(keys: DealKey[]): Promise<DealLookupResult[]> {
    if (keys.length === 0) return []
    const out: DealLookupResult[] = []
    for (let i = 0; i < keys.length; i += LOOKUP_BATCH_LIMIT) {
      const chunk = keys.slice(i, i + LOOKUP_BATCH_LIMIT)
      const res = await this.request('POST', '/precheck/deals/lookup', { keys: chunk })
      const json = (await res.json()) as {
        results: Array<{
          key: DealKey
          status: DealLookupStatus
          last_modified_at: string | null
          deleted_at?: string | null
          active_phones: Record<string, string | null> | null
          invalidated_phones?: Array<{
            telefone: string
            coluna_origem: string | null
            motivo: string
            fonte: string
            invalidado_em: string
          }> | null
        }>
      }
      for (const r of json.results) {
        out.push({
          key: r.key,
          status: r.status,
          lastModifiedAt: r.last_modified_at,
          deletedAt: r.deleted_at ?? null,
          activePhones: r.active_phones,
          invalidatedPhones: (r.invalidated_phones ?? []).map<DealLookupInvalidatedPhone>((p) => ({
            telefone: p.telefone,
            colunaOrigem: p.coluna_origem,
            motivo: p.motivo,
            fonte: p.fonte,
            invalidadoEm: p.invalidado_em,
          })),
        })
      }
    }
    return out
  }

  // --- Legacy SQL-only methods (refuse explicitly) ---------------------

  async writeInvalid(_key: DealKey, _motivo: string): Promise<number> {
    throw new NotSupportedByRestBackendError('writeInvalid')
  }
  async clearInvalidPhone(_key: DealKey, _rawPhone: string): Promise<number> {
    throw new NotSupportedByRestBackendError('clearInvalidPhone')
  }
  async clearLocalizadoIfMatches(_key: DealKey, _rawPhone: string): Promise<number> {
    throw new NotSupportedByRestBackendError('clearLocalizadoIfMatches')
  }
  async recordInvalidPhone(_key: DealKey, _record: InvalidPhoneRecord): Promise<void> {
    throw new NotSupportedByRestBackendError('recordInvalidPhone')
  }
  async archiveDealIfEmpty(_key: DealKey, _motivo: string): Promise<boolean> {
    throw new NotSupportedByRestBackendError('archiveDealIfEmpty')
  }
  async writeLocalizado(_key: DealKey, _phone: string, _source: string): Promise<void> {
    throw new NotSupportedByRestBackendError('writeLocalizado')
  }

  /**
   * Aggregate phone counts by Brazilian DDD across the whole Pipeboard
   * pool. Pipeboard REST doesn't expose a dedicated aggregation endpoint,
   * so we iterate the deal pages client-side and count locally.
   *
   * Caches the result for 5 minutes — pool shape doesn't change fast.
   * In-flight calls are coalesced so concurrent view loads share one fetch.
   */
  async aggregatePhoneDddDistribution(): Promise<Record<string, number>> {
    const CACHE_TTL_MS = 5 * 60_000
    const now = Date.now()
    if (this.dddCache && now - this.dddCache.fetchedAt < CACHE_TTL_MS) {
      return this.dddCache.buckets
    }
    if (this.dddFetchInFlight) return this.dddFetchInFlight
    this.dddFetchInFlight = this.fetchDddDistribution()
      .then((buckets) => {
        this.dddCache = { buckets, fetchedAt: Date.now() }
        return buckets
      })
      .finally(() => {
        this.dddFetchInFlight = null
      })
    return this.dddFetchInFlight
  }

  private async fetchDddDistribution(): Promise<Record<string, number>> {
    const buckets: Record<string, number> = {}
    for await (const page of this.iterateDeals({}, 500)) {
      for (const row of page) {
        for (const col of PHONE_COLUMNS) {
          const value = (row as unknown as Record<string, unknown>)[col]
          if (typeof value !== 'string' || value.length === 0) continue
          const ddd = extractDddFromRawPhone(value)
          if (ddd) buckets[ddd] = (buckets[ddd] ?? 0) + 1
        }
      }
    }
    return buckets
  }

  // --- Internal helpers ------------------------------------------------

  private async request(
    method: 'POST' | 'GET',
    path: string,
    body: unknown,
    extraHeaders: Record<string, string> = {},
    noAuth = false,
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`
    const op = pathToOp(path)
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), this.timeoutMs)
    try {
      const headers: Record<string, string> = {
        ...extraHeaders,
      }
      if (!noAuth) headers['X-API-Key'] = this.apiKey
      if (method !== 'GET') headers['Content-Type'] = 'application/json'
      let res: Response
      try {
        res = await this.fetchImpl(url, {
          method,
          headers,
          body: method === 'GET' ? undefined : JSON.stringify(body),
          signal: ac.signal,
        })
      } catch (e) {
        const status =
          e instanceof Error && e.name === 'AbortError' ? 'timeout' : 'network_error'
        precheckPipeboardRequestTotal.inc({ op, status })
        throw e
      }
      precheckPipeboardRequestTotal.inc({ op, status: String(res.status) })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new PipeboardRestError(res.status, method, path, text)
      }
      return res
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Build the query-string for `GET /precheck/deals`. Cursor and
   * filters are simply serialized; the cursor is opaque so we never
   * touch its internals.
   */
  private buildDealsQuery(
    params: PrecheckScanParams,
    cursor: string | null,
    limit: number,
  ): string {
    const qp = new URLSearchParams()
    if (params.pasta_prefix) qp.set('pasta_prefix', params.pasta_prefix)
    if (params.pipeline_nome) qp.set('pipeline_nome', params.pipeline_nome)
    // recheck_after_days → exclude_after timestamp (server-side filter).
    // Scanner-side `excluded_keys` has no REST equivalent — server uses
    // exclude_after as the freshness gate.
    if (params.recheck_after_days != null) {
      const since = new Date(Date.now() - params.recheck_after_days * 86_400_000)
      qp.set('exclude_after', since.toISOString())
    }
    if (cursor) qp.set('cursor', cursor)
    qp.set('limit', String(limit))
    return qp.toString()
  }
}

export class PipeboardRestError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly body: string,
  ) {
    super(`Pipeboard ${method} ${path} → ${status}: ${body.slice(0, 200)}`)
    this.name = 'PipeboardRestError'
  }

  /** True when the failure is permanent and should not be retried. */
  get isPermanent(): boolean {
    return this.status === 400 || this.status === 401 || this.status === 403 || this.status === 409
  }

  /** True when the caller should back off and retry later. */
  get isRetryable(): boolean {
    return this.status === 429 || this.status >= 500
  }

  /**
   * Discriminates the two flavours of 409 returned by /deals/localize:
   * collision on Idempotency-Key vs. guardrail rejection (phone is in
   * the blocklist). Returns 'collision' for invalidate's only 409 case.
   */
  get conflictKind(): 'collision' | 'guardrail_blocked' | 'unknown' {
    if (this.status !== 409) return 'unknown'
    if (this.body.includes('prov_telefones_invalidos')) return 'guardrail_blocked'
    if (this.body.includes('Idempotency-Key')) return 'collision'
    return 'unknown'
  }
}

/**
 * Build the deterministic Idempotency-Key for a deal-level
 * invalidation. Same (jobId, dealKey, body) always yields the same
 * key — Pipeboard returns the original response on replay.
 */
function pathToOp(path: string): RestOp {
  if (path.startsWith('/precheck/phones/invalidate')) return 'invalidate'
  if (path.startsWith('/precheck/deals/localize'))    return 'localize'
  if (path.startsWith('/precheck/deals/lookup'))      return 'lookup'
  if (path.startsWith('/precheck/deals'))             return 'deals'
  if (path.startsWith('/precheck/healthz'))           return 'healthz'
  return 'invalidate'
}

function buildIdempotencyKey(
  jobId: string | null,
  key: DealKey,
  body: unknown,
): string {
  const h = createHash('sha256')
  h.update(jobId ?? '')
  h.update('|')
  h.update(`${key.pasta}|${key.deal_id}|${key.contato_tipo}|${key.contato_id}`)
  h.update('|')
  h.update(JSON.stringify(body))
  return h.digest('hex')
}
