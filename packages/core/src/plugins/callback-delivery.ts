import { createHmac } from 'node:crypto'
import type Database from 'better-sqlite3'
import { nanoid } from 'nanoid'
import type { PluginRegistry } from './plugin-registry.js'
import type { ResultCallback, AckCallback, ResponseCallback, InterimFailureCallback, ExpiredCallback, FailedCallbackRecord, CallbackType } from './types.js'

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
  private stmtGetFailed: Database.Statement | null = null
  private stmtDeleteFailed: Database.Statement | null = null
  private stmtUpdateFailed: Database.Statement | null = null
  private stmtInsertFailed: Database.Statement | null = null
  private httpTimeoutMs: number

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
        'SELECT * FROM failed_callbacks WHERE attempts < 10 ORDER BY created_at DESC',
      )
    }
    return this.stmtListFailed
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
      this.stmtUpdateFailed = this.db.prepare(
        "UPDATE failed_callbacks SET attempts = attempts + 1, last_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), last_error = ? WHERE id = ?",
      )
    }
    return this.stmtUpdateFailed
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

  listFailedCallbacks(): FailedCallbackRecord[] {
    return this.getStmtListFailed().all() as FailedCallbackRecord[]
  }

  async retryFailedCallback(failedId: string): Promise<void> {
    const record = this.getStmtGetFailed().get(failedId) as FailedCallbackRecord | undefined

    if (!record) throw new Error(`Failed callback not found: ${failedId}`)

    const plugin = this.registry.getPlugin(record.plugin_name)
    if (!plugin) throw new Error(`Plugin not found: ${record.plugin_name}`)

    const body = record.payload
    const signature = this.sign(body, plugin.hmac_secret)

    try {
      const response = await this.fetchWithTimeout(plugin.webhook_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Dispatch-Signature': signature,
        },
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
    payload: ResultCallback | AckCallback | ResponseCallback | InterimFailureCallback | ExpiredCallback,
  ): Promise<void> {
    const plugin = this.registry.getPlugin(pluginName)
    if (!plugin) return

    const body = JSON.stringify(payload)
    const signature = this.sign(body, plugin.hmac_secret)
    let lastError = ''

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const delay = BACKOFF_DELAYS_MS[attempt - 1] ?? 0
      await sleep(delay)

      try {
        const response = await this.fetchWithTimeout(plugin.webhook_url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Dispatch-Signature': signature,
          },
          body,
        })
        if (response.ok) return

        // A5: capture response body in last_error
        const bodyText = await response.text().catch(() => '')
        lastError = `HTTP ${response.status}: ${bodyText.slice(0, 500)}`

        // 4xx = client error (non-retryable)
        if (response.status >= 400 && response.status < 500) break

        // Decision #40: 503 is retryable with short backoff
        if (response.status === 503) {
          for (let retry503 = 1; retry503 < BACKOFF_503_MS.length; retry503++) {
            await sleep(BACKOFF_503_MS[retry503])
            const retryResponse = await this.fetchWithTimeout(plugin.webhook_url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-Dispatch-Signature': signature },
              body,
            })
            if (retryResponse.ok) return
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

  private sign(body: string, secret: string): string {
    if (!secret) return ''
    return createHmac('sha256', secret).update(body).digest('hex')
  }
}
