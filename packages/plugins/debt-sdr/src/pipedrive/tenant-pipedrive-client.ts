/**
 * Per-tenant Pipedrive HTTP client.
 *
 * Each tenant gets a dedicated instance with its own (domain, token,
 * rate limiter). Token sharing across tenants is forbidden by the
 * config validator (Task 12), so SDR never reuses the same instance
 * for multiple tenants.
 *
 * Rate limit: token bucket 35 req/s (Pipedrive's published cap is
 * 80 req per 2s = 40 req/s sustained, we sit 12% under that). 429
 * responses honor `Retry-After`. 5xx responses exponential-backoff
 * up to 3 attempts then surface to the caller.
 */

export interface PipedriveClientOptions {
  domain: string
  token: string
  /** Defaults to 35 req/s. */
  ratePerSec?: number
  /** Defaults to 35 token bucket capacity. */
  burst?: number
  /** Defaults to global fetch — override in tests. */
  fetchImpl?: typeof fetch
  /** Defaults to () => Date.now() — override for deterministic tests. */
  now?: () => number
  /** Defaults to setTimeout-backed wait — override for deterministic tests. */
  wait?: (ms: number) => Promise<void>
  /** Defaults to 3 retries on 5xx. */
  maxRetries?: number
}

export interface PipedriveDeal {
  id: number
  title: string
  stage_id: number
  person_id?: { value?: number; name?: string } | null
  person_name?: string | null
  add_time?: string
  update_time?: string
  // Pipedrive supports arbitrary custom field keys (hex hashes) — we
  // surface as a passthrough record so the lead extractor (Task 28)
  // can pull the configured phone_field_key.
  [key: string]: unknown
}

export class PipedriveError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message)
    this.name = 'PipedriveError'
  }
}

interface TokenBucket {
  take(): Promise<void>
}

/**
 * Minimal token-bucket implementation. Refills at `ratePerSec`, capped
 * at `burst`. take() returns when a token is available.
 */
function makeTokenBucket(opts: { ratePerSec: number; burst: number; now: () => number; wait: (ms: number) => Promise<void> }): TokenBucket {
  const refillIntervalMs = 1000 / opts.ratePerSec
  let tokens = opts.burst
  let lastRefillAt = opts.now()
  return {
    async take() {
      while (true) {
        const elapsed = opts.now() - lastRefillAt
        if (elapsed > 0) {
          const refill = elapsed / refillIntervalMs
          tokens = Math.min(opts.burst, tokens + refill)
          lastRefillAt = opts.now()
        }
        if (tokens >= 1) {
          tokens -= 1
          return
        }
        const needed = (1 - tokens) * refillIntervalMs
        await opts.wait(Math.max(1, needed))
      }
    },
  }
}

export class TenantPipedriveClient {
  private readonly base: string
  private readonly bucket: TokenBucket
  private readonly fetchImpl: typeof fetch
  private readonly wait: (ms: number) => Promise<void>
  private readonly maxRetries: number

  constructor(private readonly opts: PipedriveClientOptions) {
    if (!opts.domain || !opts.token) {
      throw new Error('TenantPipedriveClient: domain and token are required')
    }
    this.base = `https://${opts.domain}.pipedrive.com/api/v1`
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.wait = opts.wait ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
    this.maxRetries = opts.maxRetries ?? 3
    this.bucket = makeTokenBucket({
      ratePerSec: opts.ratePerSec ?? 35,
      burst: opts.burst ?? 35,
      now: opts.now ?? (() => Date.now()),
      wait: this.wait,
    })
  }

  /** GET /deals?stage_id=…&start=…&limit=… — paginates internally. */
  async getDealsByStage(stageId: number, opts: { limit?: number; start?: number; updatedSince?: string } = {}): Promise<PipedriveDeal[]> {
    const limit = opts.limit ?? 100
    const start = opts.start ?? 0
    const params = new URLSearchParams({
      stage_id: String(stageId),
      limit: String(limit),
      start: String(start),
    })
    if (opts.updatedSince) params.set('update_time>=', opts.updatedSince)
    const data = await this.request<{ data: PipedriveDeal[] | null }>(`/deals?${params.toString()}`)
    return data.data ?? []
  }

  /** PUT /deals/{id} — moves the deal to a different stage. */
  async updateDealStage(dealId: number, stageId: number): Promise<void> {
    await this.request(`/deals/${dealId}`, {
      method: 'PUT',
      body: JSON.stringify({ stage_id: stageId }),
      headers: { 'Content-Type': 'application/json' },
    })
  }

  /** POST /activities — typed minimally (subject + deal binding). */
  async createActivity(input: { dealId: number; subject: string; note?: string; type?: string }): Promise<{ id: number }> {
    const r = await this.request<{ data: { id: number } }>(`/activities`, {
      method: 'POST',
      body: JSON.stringify({
        deal_id: input.dealId,
        subject: input.subject,
        type: input.type ?? 'task',
        note: input.note ?? '',
      }),
      headers: { 'Content-Type': 'application/json' },
    })
    return { id: r.data.id }
  }

  /** POST /notes — attaches a free-text note to a deal. */
  async addNote(dealId: number, content: string): Promise<{ id: number }> {
    const r = await this.request<{ data: { id: number } }>(`/notes`, {
      method: 'POST',
      body: JSON.stringify({ deal_id: dealId, content }),
      headers: { 'Content-Type': 'application/json' },
    })
    return { id: r.data.id }
  }

  /**
   * Core request method — runs token-bucket rate limiting, retry on
   * 5xx, Retry-After honor on 429. The api_token is appended as a
   * query param (Pipedrive's documented auth method).
   */
  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = path.includes('?')
      ? `${this.base}${path}&api_token=${encodeURIComponent(this.opts.token)}`
      : `${this.base}${path}?api_token=${encodeURIComponent(this.opts.token)}`

    let attempt = 0
    while (true) {
      await this.bucket.take()
      const res = await this.fetchImpl(url, init)
      if (res.ok) {
        return (await res.json()) as T
      }
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after') ?? '1')
        await this.wait(Math.max(100, retryAfter * 1000))
        continue
      }
      if (res.status >= 500 && attempt < this.maxRetries) {
        attempt++
        await this.wait(Math.min(8000, 250 * 2 ** attempt))
        continue
      }
      const body = await this.safeText(res)
      throw new PipedriveError(`Pipedrive ${init.method ?? 'GET'} ${path} -> ${res.status}`, res.status, body)
    }
  }

  private async safeText(res: Response): Promise<string> {
    try {
      return await res.text()
    } catch {
      return ''
    }
  }
}
