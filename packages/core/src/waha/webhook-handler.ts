import type Database from 'better-sqlite3'
import type { DispatchEmitter } from '../events/index.js'
import type { MessageHistory } from './message-history.js'
import type { WahaWebhookPayload } from './types.js'

export interface WebhookHandlerConfig {
  hmacSecret?: string
}

export interface WebhookResult {
  processed: boolean
  historyId?: string
  event: string
  deduplicated?: boolean
}

export class WebhookHandler {
  constructor(
    private readonly db: Database.Database,
    private readonly emitter: DispatchEmitter,
    private readonly history: MessageHistory,
    private readonly config: WebhookHandlerConfig = {},
  ) {}

  validateHmac(body: string, signature: string): boolean {
    // TODO: HMAC SHA-512 validation
    return false
  }

  async processWebhook(payload: WahaWebhookPayload): Promise<WebhookResult> {
    // TODO: Process webhook event
    return { processed: false, event: payload.event }
  }
}
