// Plugin System Types — Phase 7
// Interfaces only, no implementation

import type { DispatchEventName } from '../events/index.js'
import type { SenderMappingRecord, ResolvedSender, SenderConfig } from '../engine/sender-mapping.js'

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
  getSenderMapping(phone: string): SenderMappingRecord | null
  resolveSenderChain(senders: SenderConfig[]): ResolvedSender | null
  /** Register a contact on the Android device without sending a message (for contact aging) */
  registerContact(senderPhone: string, patientPhone: string, patientName: string): Promise<{ status: 'registered' | 'exists' | 'error'; error?: string }>
  on(event: DispatchEventName, handler: (data: unknown) => Promise<void>): void
  registerRoute(method: HttpMethod, path: string, handler: RouteHandler): void
  logger: PluginLogger
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
// NOTE: `any` is intentional here — plugins register handlers with
// either fully-typed Fastify-like request/reply shapes or plain `unknown`.
// Using `any` keeps both styles assignable via parameter bivariance
// without forcing every plugin to cast.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RouteHandler = (request: any, reply: any) => Promise<unknown>

export interface PluginLogger {
  info(msg: string, data?: Record<string, unknown>): void
  warn(msg: string, data?: Record<string, unknown>): void
  error(msg: string, data?: Record<string, unknown>): void
  debug(msg: string, data?: Record<string, unknown>): void
}

export type PluginStatus = 'active' | 'error' | 'disabled'
export type CallbackType =
  | 'result'
  | 'ack'
  | 'response'
  | 'interim_failure'
  | 'expired'
  | 'number_invalid'
  | 'hygiene_item'
  | 'hygiene_completed'

// ── Plugin Record (SQLite row) ──

export interface PluginRecord {
  name: string
  version: string
  webhook_url: string
  api_key: string
  hmac_secret: string
  events: string // JSON array of DispatchEventName
  enabled: number // 0 or 1
  status: PluginStatus
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
  /** Phone number resolved from sender mapping (set by plugin after resolveSenderChain) */
  resolvedSenderPhone?: string
}

// Re-exported from engine/sender-mapping.ts (single source of truth)
export type { SenderConfig } from '../engine/sender-mapping.js'

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
  /** Android device serial that sent the message */
  device_serial: string
  /** Android user profile ID (0, 10, 11, 12) */
  profile_id: number
  /** Number of characters typed via ADB */
  char_count: number
  /** Whether a new contact was created on the Android device for this send */
  contact_registered: boolean
  /** Relative URL to the post-send screenshot (e.g. /api/v1/messages/:id/screenshot) */
  screenshot_url: string | null
  /** Number of WhatsApp dialogs dismissed before typing */
  dialogs_dismissed: number
  /** Whether the worker switched Android user before this send */
  user_switched: boolean
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
  original_message?: string
  original_session: string
  quarantined: boolean
}

export interface InterimFailureCallback {
  event: 'interim_failure'
  idempotency_key: string
  correlation_id?: string
  status: 'interim_failed'
  error: { code: string; message: string; retryable: boolean }
  failed_sender: { phone: string; session: string; pair: string } | null
  next_sender: { phone: string; session: string; pair: string; role: string } | null
  attempt: number
  context?: Record<string, unknown>
}

export interface ExpiredCallback {
  event: 'expired'
  idempotency_key: string
  correlation_id?: string
  status: 'expired'
  error: { code: 'ttl_expired'; message: string; retryable: false }
  context?: Record<string, unknown>
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

export interface NumberInvalidCallback {
  event: 'number_invalid'
  idempotency_key?: string
  correlation_id?: string
  status: 'number_invalid'
  phone_input: string
  phone_normalized: string
  variants_tried: string[]
  source: 'cache' | 'adb_probe' | 'waha' | 'send_failure'
  confidence: number | null
  check_id: string
  detected_at: string
  context?: Record<string, unknown>
}

export interface HygieneItemCallback {
  event: 'hygiene_item'
  job_id: string
  external_ref?: string
  phone_input: string
  phone_normalized: string | null
  external_id?: string
  status: 'exists' | 'not_exists' | 'error'
  check_id: string | null
  confidence: number | null
  error?: string
  processed_at: string
}

export interface HygieneCompletedCallback {
  event: 'hygiene_completed'
  job_id: string
  external_ref?: string
  summary: {
    total: number
    valid: number
    invalid: number
    error: number
    cache_hits: number
  }
  items_url: string
  audit_url: string
  completed_at: string
}

// ── Failed Callback Record (SQLite) ──

export interface FailedCallbackRecord {
  id: string
  plugin_name: string
  message_id: string
  callback_type: CallbackType
  payload: string // JSON
  webhook_url: string
  attempts: number
  last_error: string
  created_at: string
  last_attempt_at: string
  abandoned_at: string | null
  abandoned_reason: string | null
}

// ── Plugin Config (dispatch.config.json) ──

export interface DispatchPluginConfig {
  plugins: string[]
}
