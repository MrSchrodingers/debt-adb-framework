import { z } from 'zod'
import type { DispatchEmitter } from '../../events/dispatch-emitter.js'
import type { PluginLogger } from '../types.js'
import type { PipedriveOutgoingIntent } from './types.js'

/**
 * Token-bucket rate limiter for Pipedrive API.
 *
 * Pipedrive's documented limit is ~80-100 requests per 2s window. We cap at a
 * conservative 10 req/s ceiling with a small burst budget. The implementation
 * is monotonic-clock-aware (uses Date.now via injected `now`) and refills
 * proportionally to elapsed time so bursts can build up while idle.
 */
export interface TokenBucketOpts {
  /** Sustained rate, in tokens per second. */
  ratePerSec: number
  /** Maximum tokens bucket can hold (burst budget). */
  burst: number
  /** Injectable clock for tests (defaults to Date.now). */
  now?: () => number
  /** Injectable sleeper for tests. */
  sleep?: (ms: number) => Promise<void>
}

export class TokenBucket {
  private tokens: number
  private lastRefillMs: number
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly opts: TokenBucketOpts) {
    this.tokens = opts.burst
    this.now = opts.now ?? Date.now
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.lastRefillMs = this.now()
  }

  /** Block until 1 token is available, then consume it. */
  async take(): Promise<void> {
    while (true) {
      this.refill()
      if (this.tokens >= 1) {
        this.tokens -= 1
        return
      }
      // Wait roughly until 1 full token would refill.
      const need = 1 - this.tokens
      const waitMs = Math.ceil((need / this.opts.ratePerSec) * 1000)
      await this.sleep(Math.max(waitMs, 5))
    }
  }

  private refill(): void {
    const now = this.now()
    const elapsedSec = (now - this.lastRefillMs) / 1000
    if (elapsedSec <= 0) return
    this.tokens = Math.min(this.opts.burst, this.tokens + elapsedSec * this.opts.ratePerSec)
    this.lastRefillMs = now
  }
}

// ── Pipedrive API response schemas ───────────────────────────────────────

const pipedriveOkSchema = z.object({
  success: z.literal(true),
  data: z.unknown().nullable().optional(),
})

const pipedriveErrSchema = z.object({
  success: z.literal(false),
  error: z.string().optional(),
  error_info: z.string().optional(),
})

// ── PipedriveClient ──────────────────────────────────────────────────────

export interface PipedriveClientOpts {
  apiToken: string
  baseUrl?: string
  /** Sustained req/s ceiling (default: 10). */
  ratePerSec?: number
  /** Burst budget (default: 5). */
  burst?: number
  /** Max retry attempts on 429/5xx (default: 3). */
  maxRetries?: number
  /** Initial backoff in ms (default: 500). */
  retryBaseMs?: number
  /** Per-request timeout in ms (default: 15000). */
  timeoutMs?: number
  emitter?: Pick<DispatchEmitter, 'emit'>
  logger?: PluginLogger
  /** Injected fetch (default: globalThis.fetch). */
  fetchImpl?: typeof fetch
  /** Injected sleeper for tests. */
  sleep?: (ms: number) => Promise<void>
  /** Injected clock for tests. */
  now?: () => number
}

export interface PipedriveDispatchResult {
  ok: boolean
  status: number | null
  attempts: number
  error?: string
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504])

/**
 * Thin Pipedrive HTTP wrapper.
 *
 * Contract:
 *   - NEVER throws to the caller. On exhausted retries, emits
 *     `pipedrive:request_failed` and returns `{ok:false, ...}`.
 *   - All requests authenticated via `?api_token=` query param (Pipedrive's
 *     standard — they don't accept Bearer headers on most endpoints).
 *   - Token-bucket rate limited (10 req/s, burst 5 by default).
 *   - Retries with exponential backoff on 429 / 5xx / network errors.
 */
export class PipedriveClient {
  private readonly bucket: TokenBucket
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly opts: PipedriveClientOpts) {
    if (!opts.apiToken) throw new Error('PipedriveClient: apiToken is required')
    this.baseUrl = (opts.baseUrl ?? 'https://api.pipedrive.com/v1/').replace(/\/+$/, '/')
    this.bucket = new TokenBucket({
      ratePerSec: opts.ratePerSec ?? 10,
      burst: opts.burst ?? 5,
      now: opts.now,
      sleep: opts.sleep,
    })
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  }

  /** Dispatch an outgoing intent to Pipedrive. Never throws. */
  async dispatch(intent: PipedriveOutgoingIntent): Promise<PipedriveDispatchResult> {
    const path = intent.kind === 'note' ? 'notes' : 'activities'
    const dealId = intent.payload.deal_id
    return this.post(path, intent.payload, intent.kind, dealId)
  }

  private async post(
    path: string,
    body: unknown,
    kind: string,
    dealId: number | null,
  ): Promise<PipedriveDispatchResult> {
    const maxRetries = this.opts.maxRetries ?? 3
    const baseBackoff = this.opts.retryBaseMs ?? 500
    const url = `${this.baseUrl}${path}?api_token=${encodeURIComponent(this.opts.apiToken)}`

    let lastStatus: number | null = null
    let lastError = ''
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      await this.bucket.take()
      const ctrl = new AbortController()
      const timeoutMs = this.opts.timeoutMs ?? 15_000
      const tid = setTimeout(() => ctrl.abort(), timeoutMs)
      try {
        const res = await this.fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        })
        clearTimeout(tid)
        lastStatus = res.status
        if (res.ok) {
          // Pipedrive returns 200/201 with {success:true, data:...}; we tolerate a
          // missing body (unlikely but possible on edge endpoints).
          let parsed: unknown = null
          try {
            parsed = await res.json()
          } catch {
            parsed = null
          }
          if (parsed && typeof parsed === 'object') {
            const ok = pipedriveOkSchema.safeParse(parsed)
            if (ok.success) {
              return { ok: true, status: res.status, attempts: attempt }
            }
            const err = pipedriveErrSchema.safeParse(parsed)
            if (err.success) {
              lastError = err.data.error_info || err.data.error || 'pipedrive_returned_success_false'
              // success:false is NOT retryable — fall through to emit + return.
              break
            }
          }
          // Couldn't parse but HTTP says ok — accept it.
          return { ok: true, status: res.status, attempts: attempt }
        }

        const text = await res.text().catch(() => '')
        lastError = `http_${res.status}: ${text.slice(0, 200)}`

        if (!RETRYABLE_STATUS.has(res.status) || attempt === maxRetries) break

        // 429 may include Retry-After (seconds or HTTP date). Honor it.
        const retryAfter = res.headers.get('retry-after')
        const backoffMs = this.computeBackoff(attempt, baseBackoff, retryAfter)
        this.opts.logger?.warn('pipedrive retryable response', {
          attempt, status: res.status, backoffMs,
        })
        await this.sleep(backoffMs)
        continue
      } catch (e) {
        clearTimeout(tid)
        lastError = e instanceof Error ? e.message : String(e)
        if (attempt === maxRetries) break
        const backoffMs = this.computeBackoff(attempt, baseBackoff, null)
        this.opts.logger?.warn('pipedrive transport error', {
          attempt, error: lastError, backoffMs,
        })
        await this.sleep(backoffMs)
      }
    }

    // Exhausted retries — emit event, return failure.
    this.opts.emitter?.emit('pipedrive:request_failed', {
      kind,
      endpoint: `POST /v1/${path}`,
      status: lastStatus,
      error: lastError.slice(0, 500),
      attempts: maxRetries,
      deal_id: dealId,
    })
    return { ok: false, status: lastStatus, attempts: maxRetries, error: lastError }
  }

  private computeBackoff(attempt: number, base: number, retryAfter: string | null): number {
    if (retryAfter) {
      const asInt = parseInt(retryAfter, 10)
      if (Number.isFinite(asInt) && asInt > 0) return asInt * 1000
    }
    // exponential with full jitter (0..1)
    const expo = base * 2 ** (attempt - 1)
    return Math.floor(expo * (0.5 + Math.random() * 0.5))
  }
}
