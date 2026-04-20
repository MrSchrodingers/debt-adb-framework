export type CheckSource =
  | 'adb_probe'
  | 'waha'
  | 'send_success'
  | 'send_failure'
  | 'send_success_backfill'
  | 'manual_recheck'
  | 'cache'

export type CheckResult = 'exists' | 'not_exists' | 'error' | 'inconclusive'

export type TriggeredBy =
  | 'pre_check'
  | 'send_pipeline'
  | 'manual'
  | `hygiene_job:${string}`

export interface WaContactRecord {
  phone_normalized: string
  phone_input_last: string
  wa_chat_id: string | null
  exists_on_wa: 0 | 1 | null
  last_check_source: CheckSource | null
  last_check_confidence: number | null
  last_check_id: string | null
  last_checked_at: string | null
  recheck_due_at: string | null
  check_count: number
  send_attempts: number
  send_successes: number
  first_seen_at: string
  updated_at: string
  ddd: string | null
  country_code: string
  metadata: string | null
  /** Patient/contact display name — joined from legacy `contacts` table at query time */
  name: string | null
}

export interface WaContactCheck {
  id: string
  phone_normalized: string
  phone_variant_tried: string
  source: CheckSource
  result: CheckResult
  confidence: number | null
  evidence: string | null
  device_serial: string | null
  waha_session: string | null
  triggered_by: TriggeredBy
  latency_ms: number | null
  checked_at: string
}
