import { createHash } from 'node:crypto'
import { precheckPipeboardRequestTotal } from '../../config/metrics.js'
import type { DealKey, ProvConsultaRow, PrecheckScanParams } from './types.js'
import {
  NotSupportedByRestBackendError,
  type AppliedPhone,
  type DealInvalidationRequest,
  type DealInvalidationResponse,
  type DealLocalizationRequest,
  type DealLocalizationResponse,
  type HealthcheckResult,
  type IPipeboardClient,
  type InvalidPhoneRecord,
} from './pipeboard-client.js'

type RestOp = 'invalidate' | 'localize' | 'deals' | 'healthz'

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
    }
    const idempotencyKey = buildIdempotencyKey(payload.jobId, key, body)
    const res = await this.request('POST', '/precheck/phones/invalidate', body, {
      'Idempotency-Key': idempotencyKey,
    })
    const json = (await res.json()) as {
      request_id: string
      idempotent: boolean
      applied: AppliedPhone[]
      // Pipeboard returns `deal_archived` in its current response;
      // accept the legacy `archived` alias defensively.
      deal_archived?: boolean
      archived?: boolean
      cleared_columns?: string[]
      pipedrive?: { scenario?: string; workflow_id?: string }
    }
    return {
      requestId: json.request_id,
      idempotent: Boolean(json.idempotent),
      applied: json.applied ?? [],
      archived: Boolean(json.deal_archived ?? json.archived),
      clearedColumns: json.cleared_columns ?? [],
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
   * Pool count is not directly exposed by Pipeboard's REST surface —
   * `GET /deals` returns `has_more` (boolean) but no total. Returning
   * `-1` signals "unknown" so the scanner falls back to streaming the
   * keyset until exhausted instead of using the value for a progress
   * bar denominator.
   *
   * If a precise count is needed in the future, ask Pipeboard to add
   * a `total_estimate` field (cheap COUNT(*) over the same WHERE).
   */
  async countPool(_params: PrecheckScanParams): Promise<number> {
    return -1
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
  if (path.startsWith('/precheck/deals/localize')) return 'localize'
  if (path.startsWith('/precheck/deals')) return 'deals'
  if (path.startsWith('/precheck/healthz')) return 'healthz'
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
