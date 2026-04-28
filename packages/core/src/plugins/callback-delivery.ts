import { createHmac } from 'node:crypto'
import type Database from 'better-sqlite3'
import { nanoid } from 'nanoid'
import type { PluginRegistry } from './plugin-registry.js'
import type { ResultCallback, AckCallback, ResponseCallback, InterimFailureCallback, ExpiredCallback, NumberInvalidCallback, FailedCallbackRecord, CallbackType } from './types.js'
import { getTracer } from '../telemetry/tracer.js'
import { SpanStatusCode } from '@opentelemetry/api'

type FetchFn = (url: string, init: RequestInit) => Promise<Response>

const MAX_RETRIES = 4

/** Standard backoff: attempt 1 = 0 (immediate), 2 = 5s, 3 = 30s, 4 = 120s */
const BACKOFF_DELAYS_MS = [0, 5_000, 30_000, 120_000] as const

/** 503-specific short backoff: 0, 1s, 2s, 4s (Decision #40) */
const BACKOFF_503_MS = [0, 1_000, 2_000, 4_000] as const

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class CallbackDelivery {
  private stmtListFailed: Database.Statement | null = null
  private stmtListAbandoned: Database.Statement | null = null
  private stmtGetFailed: Database.Statement | null = null
  private stmtDeleteFailed: Database.Statement | null = null
  private stmtUpdateFailed: Database.Statement | null = null
  private stmtInsertFailed: Database.Statement | null = null
  private stmtClearAbandoned: Database.Statement | null = null
  private httpTimeoutMs: number
  /** Per-id in-flight mutex: coalesces concurrent retries on the same row */
  private inFlightRetries = new Map<string, Promise<void>>()

  constructor(
    private db: Database.Database,
    private registry: PluginRegistry,
    private fetchFn: FetchFn,
  ) {
    this.httpTimeoutMs = parseInt(process.env.DISPATCH_HTTP_TIMEOUT_MS ?? '10000', 10)
  }

  private getStmtListFailed(): Database.Statement {
    if (!this.stmtListFailed) {
      this.stmtListFailed = this.db.prepare(
        'SELECT * FROM failed_callbacks WHERE abandoned_at IS NULL ORDER BY created_at DESC',
      )
    }
    return this.stmtListFailed
  }

  private getStmtListAbandoned(): Database.Statement {
    if (!this.stmtListAbandoned) {
      this.stmtListAbandoned = this.db.prepare(
        'SELECT * FROM failed_callbacks WHERE abandoned_at IS NOT NULL ORDER BY abandoned_at DESC LIMIT 500',
      )
    }
    return this.stmtListAbandoned
  }

  private getStmtGetFailed(): Database.Statement {
    if (!this.stmtGetFailed) {
      this.stmtGetFailed = this.db.prepare(
        'SELECT * FROM failed_callbacks WHERE id = ?',
      )
    }
    return this.stmtGetFailed
  }

  private getStmtDeleteFailed(): Database.Statement {
    if (!this.stmtDeleteFailed) {
      this.stmtDeleteFailed = this.db.prepare(
        'DELETE FROM failed_callbacks WHERE id = ?',
      )
    }
    return this.stmtDeleteFailed
  }

  private getStmtUpdateFailed(): Database.Statement {
    if (!this.stmtUpdateFailed) {
      this.stmtUpdateFailed = this.db.prepare(`
        UPDATE failed_callbacks
        SET attempts = attempts + 1,
            last_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
            last_error = ?,
            abandoned_at = CASE WHEN attempts + 1 >= 10 THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE abandoned_at END,
            abandoned_reason = CASE WHEN attempts + 1 >= 10 THEN 'max_attempts_exceeded' ELSE abandoned_reason END
        WHERE id = ?
      `)
    }
    return this.stmtUpdateFailed
  }

  private getStmtClearAbandoned(): Database.Statement {
    if (!this.stmtClearAbandoned) {
      this.stmtClearAbandoned = this.db.prepare(
        "UPDATE failed_callbacks SET abandoned_at = NULL, abandoned_reason = NULL, attempts = ?, last_error = '' WHERE id = ?",
      )
    }
    return this.stmtClearAbandoned
  }

  private getStmtInsertFailed(): Database.Statement {
    if (!this.stmtInsertFailed) {
      this.stmtInsertFailed = this.db.prepare(`
        INSERT INTO failed_callbacks (id, plugin_name, message_id, callback_type, payload, webhook_url, attempts, last_error)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
    }
    return this.stmtInsertFailed
  }

  async sendResultCallback(pluginName: string, messageId: string, payload: ResultCallback): Promise<void> {
    if (!pluginName) return
    await this.sendCallback(pluginName, messageId, 'result', payload)
  }

  async sendAckCallback(pluginName: string, messageId: string, payload: AckCallback): Promise<void> {
    if (!pluginName) return
    await this.sendCallback(pluginName, messageId, 'ack', payload)
  }

  async sendResponseCallback(pluginName: string, messageId: string, payload: ResponseCallback): Promise<void> {
    if (!pluginName) return
    await this.sendCallback(pluginName, messageId, 'response', payload)
  }

  async sendInterimFailureCallback(pluginName: string, messageId: string, payload: InterimFailureCallback): Promise<void> {
    if (!pluginName) return
    await this.sendCallback(pluginName, messageId, 'interim_failure', payload)
  }

  async sendExpiredCallback(pluginName: string, messageId: string, payload: ExpiredCallback): Promise<void> {
    if (!pluginName) return
    await this.sendCallback(pluginName, messageId, 'expired', payload)
  }

  async sendNumberInvalidCallback(pluginName: string, messageId: string, payload: NumberInvalidCallback): Promise<void> {
    if (!pluginName) return
    await this.sendCallback(pluginName, messageId, 'number_invalid', payload)
  }

  listFailedCallbacks(): FailedCallbackRecord[] {
    return this.getStmtListFailed().all() as FailedCallbackRecord[]
  }

  listAbandonedCallbacks(): FailedCallbackRecord[] {
    return this.getStmtListAbandoned().all() as FailedCallbackRecord[]
  }

  getCallback(failedId: string): FailedCallbackRecord | null {
    const row = this.getStmtGetFailed().get(failedId) as FailedCallbackRecord | undefined
    return row ?? null
  }

  /**
   * Reset an abandoned callback so it can be retried via `retryFailedCallback`.
   * Clears abandoned_at / abandoned_reason and resets attempts to the given value
   * (default 0 = clean start).
   */
  clearAbandoned(failedId: string, resetAttemptsTo = 0): void {
    this.getStmtClearAbandoned().run(resetAttemptsTo, failedId)
  }

  async retryFailedCallback(failedId: string): Promise<void> {
    const existing = this.inFlightRetries.get(failedId)
    if (existing) {
      // Another caller is already retrying this id — coalesce: wait for it.
      return existing
    }
    const promise = this.doRetryFailedCallback(failedId).finally(() => {
      this.inFlightRetries.delete(failedId)
    })
    this.inFlightRetries.set(failedId, promise)
    return promise
  }

  private async doRetryFailedCallback(failedId: string): Promise<void> {
    const record = this.getStmtGetFailed().get(failedId) as FailedCallbackRecord | undefined

    if (!record) throw new Error(`Failed callback not found: ${failedId}`)

    const plugin = this.registry.getPlugin(record.plugin_name)
    if (!plugin) throw new Error(`Plugin not found: ${record.plugin_name}`)

    const body = record.payload
    const headers = this.buildHeaders(body, plugin.hmac_secret)

    try {
      const response = await this.fetchWithTimeout(plugin.webhook_url, {
        method: 'POST',
        headers,
        body,
      })
      if (response.ok) {
        this.getStmtDeleteFailed().run(failedId)
      } else {
        // A6: capture response body in last_error
        const bodyText = await response.text().catch(() => '')
        const lastError = `HTTP ${response.status}: ${bodyText.slice(0, 500)}`
        this.getStmtUpdateFailed().run(lastError, failedId)
      }
    } catch (err) {
      const lastError = err instanceof Error ? err.message : String(err)
      this.getStmtUpdateFailed().run(lastError, failedId)
    }
  }

  private async sendCallback(
    pluginName: string,
    messageId: string,
    callbackType: CallbackType,
    payload: ResultCallback | AckCallback | ResponseCallback | InterimFailureCallback | ExpiredCallback | NumberInvalidCallback,
  ): Promise<void> {
    const plugin = this.registry.getPlugin(pluginName)
    if (!plugin) return

    const body = JSON.stringify(payload)

    // Extract idempotency_key from the payload if present (all result/ack/response types carry it)
    const idempotencyKey = (payload as { idempotency_key?: string }).idempotency_key ?? ''

    const tracer = getTracer()
    return tracer.startActiveSpan('callback.send', async (span) => {
      span.setAttributes({
        'idempotency_key': idempotencyKey,
        'plugin_name': pluginName,
        'message.id': messageId,
        'callback.type': callbackType,
        'webhook.url': plugin.webhook_url,
      })

      try {
        const headers = this.buildHeaders(body, plugin.hmac_secret)
        let lastError = ''

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
          const delay = BACKOFF_DELAYS_MS[attempt - 1] ?? 0
          await sleep(delay)

          span.setAttribute('callback.attempt', attempt)

          try {
            const response = await this.fetchWithTimeout(plugin.webhook_url, {
              method: 'POST',
              headers,
              body,
            })
            if (response.ok) {
              span.setAttribute('callback.http_status', response.status)
              span.setStatus({ code: SpanStatusCode.OK })
              return
            }

            // A5: capture response body in last_error
            const bodyText = await response.text().catch(() => '')
            lastError = `HTTP ${response.status}: ${bodyText.slice(0, 500)}`
            span.setAttribute('callback.http_status', response.status)

            // 4xx = client error (non-retryable)
            if (response.status >= 400 && response.status < 500) break

            // Decision #40: 503 is retryable with short backoff
            if (response.status === 503) {
              for (let retry503 = 1; retry503 < BACKOFF_503_MS.length; retry503++) {
                await sleep(BACKOFF_503_MS[retry503])
                const retryResponse = await this.fetchWithTimeout(plugin.webhook_url, {
                  method: 'POST',
                  headers,
                  body,
                })
                if (retryResponse.ok) {
                  span.setAttribute('callback.http_status', retryResponse.status)
                  span.setStatus({ code: SpanStatusCode.OK })
                  return
                }
                const retryBodyText = await retryResponse.text().catch(() => '')
                lastError = `HTTP ${retryResponse.status}: ${retryBodyText.slice(0, 500)}`
              }
              break // 503 retries exhausted
            }
          } catch (err) {
            lastError = err instanceof Error ? err.message : String(err)
          }
        }

        // All retries failed — persist to failed_callbacks
        span.setAttribute('callback.failed', true)
        span.setStatus({ code: SpanStatusCode.ERROR, message: lastError })
        this.getStmtInsertFailed().run(
          nanoid(),
          pluginName,
          messageId,
          callbackType,
          body,
          plugin.webhook_url,
          MAX_RETRIES,
          lastError,
        )
      } catch (err) {
        span.recordException(err as Error)
        span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) })
        throw err
      } finally {
        span.end()
      }
    })
  }

  /** S15/R11: All outbound HTTP uses AbortSignal timeout */
  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), this.httpTimeoutMs)
    try {
      return await this.fetchFn(url, { ...init, signal: controller.signal })
    } finally {
      clearTimeout(timeoutId)
    }
  }

  /**
   * Build outbound headers, including HMAC signature when the plugin has a
   * shared secret. Format matches the inbound verifier in `server.ts`:
   *   X-Dispatch-Signature: sha256=<hex>
   * The header is omitted entirely when no secret is configured (Task 3.2 / B16).
   */
  private buildHeaders(body: string, secret: string | null | undefined): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (secret) {
      const sig = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')
      headers['X-Dispatch-Signature'] = sig
    }
    return headers
  }
}
