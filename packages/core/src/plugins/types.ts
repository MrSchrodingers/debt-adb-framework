// Plugin System Types — Phase 7
// Interfaces only, no implementation

import type { DispatchEventName } from '../events/index.js'

// ── Plugin Interface (what plugins implement) ──

export interface DispatchPlugin {
  name: string
  version: string
  events: DispatchEventName[]
  webhookUrl: string

  init(ctx: PluginContext): Promise<void>
  destroy(): Promise<void>
}

// ── PluginContext (restricted API surface for plugins) ──

export interface PluginContext {
  enqueue(msgs: PluginEnqueueParams[]): PluginMessage[]
  getMessageStatus(id: string): PluginMessage | null
  getQueueStats(): QueueStats
  on(event: DispatchEventName, handler: (data: unknown) => Promise<void>): void
  registerRoute(method: HttpMethod, path: string, handler: RouteHandler): void
  logger: PluginLogger
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
export type RouteHandler = (request: unknown, reply: unknown) => Promise<unknown>

export interface PluginLogger {
  info(msg: string, data?: Record<string, unknown>): void
  warn(msg: string, data?: Record<string, unknown>): void
  error(msg: string, data?: Record<string, unknown>): void
  debug(msg: string, data?: Record<string, unknown>): void
}

// ── Plugin Record (SQLite row) ──

export interface PluginRecord {
  name: string
  version: string
  webhook_url: string
  api_key: string
  hmac_secret: string
  events: string // JSON array of DispatchEventName
  enabled: number // 0 or 1
  status: string // 'active' | 'error' | 'disabled'
  created_at: string
  updated_at: string
}

// ── Enqueue Params (plugin → core) ──

export interface PluginEnqueueParams {
  idempotencyKey: string
  correlationId?: string
  patient: {
    phone: string
    name: string
    patientId?: string
  }
  message: {
    text: string
    templateId?: string
  }
  senders: SenderConfig[]
  context?: Record<string, unknown>
  sendOptions?: {
    maxRetries?: number
    priority?: 'normal' | 'high'
  }
}

export interface SenderConfig {
  phone: string
  session: string
  pair: string
  role: 'primary' | 'backup' | 'overflow' | 'reserve'
}

// ── Plugin Message (core → plugin response) ──

export interface PluginMessage {
  id: string
  idempotencyKey: string
  toNumber: string
  body: string
  senderNumber: string
  status: string
  pluginName: string
  createdAt: string
}

// ── Queue Stats ──

export interface QueueStats {
  pending: number
  processing: number
  failedLastHour: number
  oldestPendingAgeSeconds: number | null
}

// ── Callback Payloads (core → plugin webhook) ──

export interface ResultCallback {
  idempotency_key: string
  correlation_id?: string
  status: 'sent' | 'failed'
  sent_at: string | null
  delivery: DeliveryInfo | null
  error: CallbackError | null
  fallback_reason?: FallbackReason
  context?: Record<string, unknown>
}

export interface DeliveryInfo {
  message_id: string | null
  provider: string
  sender_phone: string
  sender_session: string
  pair_used: string
  used_fallback: boolean
  elapsed_ms: number
}

export interface CallbackError {
  code: string
  message: string
  details?: Record<string, unknown>
  retryable: boolean
  retry_after_seconds?: number
}

export interface FallbackReason {
  original_error: string
  original_session: string
  quarantined: boolean
}

export interface AckCallback {
  idempotency_key: string
  message_id: string
  event: 'ack_update'
  ack: {
    level: number
    level_name: string
    delivered_at: string | null
    read_at: string | null
  }
}

export interface ResponseCallback {
  idempotency_key: string
  message_id: string
  event: 'patient_response'
  response: {
    body: string
    received_at: string
    from_number: string
    has_media: boolean
  }
}

// ── Failed Callback Record (SQLite) ──

export interface FailedCallbackRecord {
  id: string
  plugin_name: string
  message_id: string
  callback_type: string // 'result' | 'ack' | 'response'
  payload: string // JSON
  webhook_url: string
  attempts: number
  last_error: string
  created_at: string
  last_attempt_at: string
}

// ── Plugin Config (dispatch.config.json) ──

export interface DispatchPluginConfig {
  plugins: string[]
}
