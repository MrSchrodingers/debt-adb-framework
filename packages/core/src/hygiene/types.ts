export type HygieneJobStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'failed'

export type HygieneItemStatus =
  | 'pending'
  | 'processing'
  | 'exists'
  | 'not_exists'
  | 'error'

export type LawfulBasis =
  | 'contract'
  | 'legitimate_interest'
  | 'legal_obligation'
  | 'consent'

export type RateProfile = 'conservative' | 'default' | 'aggressive'
export type CallbackGranularity = 'per_item' | 'aggregate' | 'both'

export interface HygieneJobLgpd {
  lawful_basis: LawfulBasis
  purpose: string
  data_controller: string
}

export interface HygieneJobRecord {
  id: string
  plugin_name: string
  external_ref: string | null
  status: HygieneJobStatus
  total_items: number
  completed_items: number
  valid_items: number
  invalid_items: number
  error_items: number
  cache_hits: number
  priority: 'normal' | 'high'
  rate_profile: RateProfile
  callback_granularity: CallbackGranularity
  callback_url: string | null
  lawful_basis: LawfulBasis
  purpose: string
  data_controller: string
  created_at: string
  started_at: string | null
  completed_at: string | null
  requested_by: string | null
}

export interface HygieneJobItemRecord {
  id: string
  job_id: string
  phone_input: string
  phone_normalized: string | null
  external_id: string | null
  status: HygieneItemStatus
  check_id: string | null
  callback_sent: number
  callback_sent_at: string | null
  error: string | null
  created_at: string
  updated_at: string
}

export interface CreateJobInput {
  plugin_name: string
  external_ref?: string
  callback_url?: string
  priority?: 'normal' | 'high'
  rate_profile?: RateProfile
  callback_granularity?: CallbackGranularity
  requested_by?: string
  lgpd: HygieneJobLgpd
  items: { phone_input: string; external_id?: string }[]
}

export interface CreateJobResult {
  job_id: string
  deduplicated: boolean
  total_items: number
  status: HygieneJobStatus
}

export class HygieneJobConflictError extends Error {
  constructor(external_ref: string) {
    super(`hygiene_job with external_ref="${external_ref}" exists with different items`)
    this.name = 'HygieneJobConflictError'
  }
}
