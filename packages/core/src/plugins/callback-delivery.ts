import { createHmac } from 'node:crypto'
import type Database from 'better-sqlite3'
import { nanoid } from 'nanoid'
import type { PluginRegistry } from './plugin-registry.js'
import type { ResultCallback, AckCallback, ResponseCallback, FailedCallbackRecord } from './types.js'

type FetchFn = (url: string, init: RequestInit) => Promise<Response>

const MAX_RETRIES = 3

/** Delays in ms before each attempt: attempt 1 = 0 (immediate), attempt 2 = 5s, attempt 3 = 15s */
const BACKOFF_DELAYS_MS = [0, 5_000, 15_000] as const

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class CallbackDelivery {
  constructor(
    private db: Database.Database,
    private registry: PluginRegistry,
    private fetchFn: FetchFn,
  ) {}

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

  listFailedCallbacks(): FailedCallbackRecord[] {
    return this.db.prepare(
      'SELECT * FROM failed_callbacks ORDER BY created_at DESC',
    ).all() as FailedCallbackRecord[]
  }

  async retryFailedCallback(failedId: string): Promise<void> {
    const record = this.db.prepare(
      'SELECT * FROM failed_callbacks WHERE id = ?',
    ).get(failedId) as FailedCallbackRecord | undefined

    if (!record) throw new Error(`Failed callback not found: ${failedId}`)

    const plugin = this.registry.getPlugin(record.plugin_name)
    if (!plugin) throw new Error(`Plugin not found: ${record.plugin_name}`)

    const body = record.payload
    const signature = this.sign(body, plugin.hmac_secret)

    try {
      const response = await this.fetchFn(plugin.webhook_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Dispatch-Signature': signature,
        },
        body,
      })
      if (response.ok) {
        this.db.prepare('DELETE FROM failed_callbacks WHERE id = ?').run(failedId)
      }
    } catch {
      this.db.prepare(
        "UPDATE failed_callbacks SET attempts = attempts + 1, last_attempt_at = datetime('now') WHERE id = ?",
      ).run(failedId)
    }
  }

  private async sendCallback(
    pluginName: string,
    messageId: string,
    callbackType: string,
    payload: ResultCallback | AckCallback | ResponseCallback,
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
        const response = await this.fetchFn(plugin.webhook_url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Dispatch-Signature': signature,
          },
          body,
        })
        if (response.ok) return
        lastError = `HTTP ${response.status}`
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
      }
    }

    // All retries failed — persist to failed_callbacks
    this.db.prepare(`
      INSERT INTO failed_callbacks (id, plugin_name, message_id, callback_type, payload, webhook_url, attempts, last_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
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

  private sign(body: string, secret: string): string {
    return createHmac('sha256', secret).update(body).digest('hex')
  }
}
