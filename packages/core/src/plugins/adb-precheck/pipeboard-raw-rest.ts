import type { DealKey, ProvConsultaRow, PrecheckScanParams } from './types.js'
import {
  type DealInvalidationRequest,
  type DealInvalidationResponse,
  type DealLocalizationRequest,
  type DealLocalizationResponse,
  type DealLookupResult,
  type HealthcheckResult,
  type IPipeboardClient,
  type InvalidPhoneRecord,
  PHONE_COLUMNS,
} from './pipeboard-client.js'
import { extractDdd as extractDddFromRawPhone } from '../../util/ddd.js'

export class NotSupportedByRawBackendError extends Error {
  constructor(op: string) {
    super(`${op} is not supported by the raw backend (sicoob/oralsin do not have prov_* tables)`)
    this.name = 'NotSupportedByRawBackendError'
  }
}

export interface PipeboardRawRestOpts {
  /** Full base URL including tenant segment, e.g. http://r/api/v1/sicoob */
  baseUrl: string
  apiKey: string
  /** Required filter for every iterateDeals call. */
  pipelineId: number
  /** Optional further restriction. */
  stageId?: number
  timeoutMs?: number
  fetchImpl?: typeof globalThis.fetch
}

export class PipeboardRawRest implements IPipeboardClient {
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly pipelineId: number
  private readonly stageId?: number
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof globalThis.fetch

  private dddCache: { buckets: Record<string, number>; fetchedAt: number } | null = null
  private dddFetchInFlight: Promise<Record<string, number>> | null = null

  constructor(opts: PipeboardRawRestOpts) {
    if (!opts.apiKey) throw new Error('PipeboardRawRest requires apiKey')
    if (!opts.baseUrl) throw new Error('PipeboardRawRest requires baseUrl')
    if (!opts.pipelineId || opts.pipelineId <= 0) throw new Error('PipeboardRawRest requires pipelineId > 0')
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.apiKey = opts.apiKey
    this.pipelineId = opts.pipelineId
    this.stageId = opts.stageId
    this.timeoutMs = opts.timeoutMs ?? 15_000
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch
  }

  async close(): Promise<void> {}

  async healthcheck(): Promise<HealthcheckResult> {
    try {
      const res = await this.request('GET', '/precheck-raw/healthz', null, /*noAuth*/ true)
      const json = (await res.json()) as { status: string }
      return json.status === 'ok'
        ? { ok: true, server_time: new Date().toISOString() }
        : { ok: false, error: `pipeboard status=${json.status}` }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  async countPool(params: PrecheckScanParams): Promise<number> {
    try {
      const qp = new URLSearchParams()
      qp.set('pipeline_id', String(this.pipelineId))
      if (this.stageId !== undefined) qp.set('stage_id', String(this.stageId))
      if (params.recheck_after_days != null) {
        const since = new Date(Date.now() - params.recheck_after_days * 86_400_000)
        qp.set('exclude_after', since.toISOString())
      }
      const res = await this.request('GET', `/precheck-raw/deals/count?${qp.toString()}`, null)
      const json = (await res.json()) as { count: number }
      return typeof json.count === 'number' ? json.count : -1
    } catch {
      // graceful degrade: surface "pool desconhecido" if router not yet updated
      return -1
    }
  }

  /**
   * Pool-level aggregate (deals + phones in one SQL roundtrip). Used by
   * the Stats panel so per_deal_avg + estimated_in_pool show real numbers
   * for raw tenants even when no scan has populated phones_checked yet.
   *
   * Returns null on network failure (graceful degrade to legacy "—" UI).
   */
  async aggregatePoolStats(
    params: PrecheckScanParams,
  ): Promise<{ dealsTotal: number; phonesTotal: number } | null> {
    try {
      const qp = new URLSearchParams()
      qp.set('pipeline_id', String(this.pipelineId))
      if (this.stageId !== undefined) qp.set('stage_id', String(this.stageId))
      if (params.recheck_after_days != null) {
        const since = new Date(Date.now() - params.recheck_after_days * 86_400_000)
        qp.set('exclude_after', since.toISOString())
      }
      const res = await this.request('GET', `/precheck-raw/deals/aggregate?${qp.toString()}`, null)
      const json = (await res.json()) as { deals_total: number; phones_total: number }
      if (typeof json.deals_total !== 'number' || typeof json.phones_total !== 'number') return null
      return { dealsTotal: json.deals_total, phonesTotal: json.phones_total }
    } catch {
      return null
    }
  }

  async *iterateDeals(
    params: PrecheckScanParams,
    pageSize = 200,
  ): AsyncGenerator<ProvConsultaRow[], void, void> {
    let cursor: string | null = null
    while (true) {
      const qp = new URLSearchParams()
      qp.set('pipeline_id', String(this.pipelineId))
      if (this.stageId !== undefined) qp.set('stage_id', String(this.stageId))
      if (params.recheck_after_days != null) {
        const since = new Date(Date.now() - params.recheck_after_days * 86_400_000)
        qp.set('exclude_after', since.toISOString())
      }
      if (cursor) qp.set('cursor', cursor)
      qp.set('limit', String(pageSize))

      const res = await this.request('GET', `/precheck-raw/deals?${qp.toString()}`, null)
      const json = (await res.json()) as {
        items: ProvConsultaRow[]
        next_cursor: string | null
        has_more: boolean
      }
      if (json.items.length === 0) return
      yield json.items
      if (!json.next_cursor || json.has_more === false) return
      cursor = json.next_cursor
    }
  }

  async aggregatePhoneDddDistribution(): Promise<Record<string, number>> {
    const CACHE_TTL_MS = 5 * 60_000
    const now = Date.now()
    if (this.dddCache && now - this.dddCache.fetchedAt < CACHE_TTL_MS) return this.dddCache.buckets
    if (this.dddFetchInFlight) return this.dddFetchInFlight
    this.dddFetchInFlight = this.fetchDddDistribution()
      .then((b) => {
        this.dddCache = { buckets: b, fetchedAt: Date.now() }
        return b
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
          const v = (row as unknown as Record<string, unknown>)[col]
          if (typeof v !== 'string' || v.length === 0) continue
          const ddd = extractDddFromRawPhone(v)
          if (ddd) buckets[ddd] = (buckets[ddd] ?? 0) + 1
        }
      }
    }
    return buckets
  }

  // ── Refused write ops ────────────────────────────────────────────────────
  async applyDealInvalidation(_k: DealKey, _p: DealInvalidationRequest): Promise<DealInvalidationResponse> { throw new NotSupportedByRawBackendError('applyDealInvalidation') }
  async applyDealLocalization(_k: DealKey, _p: DealLocalizationRequest): Promise<DealLocalizationResponse> { throw new NotSupportedByRawBackendError('applyDealLocalization') }
  async lookupDeals(_keys: DealKey[]): Promise<DealLookupResult[]> { throw new NotSupportedByRawBackendError('lookupDeals') }
  async writeInvalid(_k: DealKey, _m: string): Promise<number> { throw new NotSupportedByRawBackendError('writeInvalid') }
  async clearInvalidPhone(_k: DealKey, _p: string): Promise<number> { throw new NotSupportedByRawBackendError('clearInvalidPhone') }
  async clearLocalizadoIfMatches(_k: DealKey, _p: string): Promise<number> { throw new NotSupportedByRawBackendError('clearLocalizadoIfMatches') }
  async recordInvalidPhone(_k: DealKey, _r: InvalidPhoneRecord): Promise<void> { throw new NotSupportedByRawBackendError('recordInvalidPhone') }
  async archiveDealIfEmpty(_k: DealKey, _m: string): Promise<boolean> { throw new NotSupportedByRawBackendError('archiveDealIfEmpty') }
  async writeLocalizado(_k: DealKey, _p: string, _s: string): Promise<void> { throw new NotSupportedByRawBackendError('writeLocalizado') }

  // ── Internal ─────────────────────────────────────────────────────────────
  private async request(method: 'GET' | 'POST', path: string, body: unknown, noAuth = false): Promise<Response> {
    const url = `${this.baseUrl}${path}`
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), this.timeoutMs)
    try {
      const headers: Record<string, string> = {}
      if (!noAuth) headers['X-API-Key'] = this.apiKey
      if (method !== 'GET') headers['Content-Type'] = 'application/json'
      const res = await this.fetchImpl(url, {
        method,
        headers,
        body: method === 'GET' ? undefined : JSON.stringify(body),
        signal: ac.signal,
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`PipeboardRawRest ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`)
      }
      return res
    } finally {
      clearTimeout(timer)
    }
  }
}
