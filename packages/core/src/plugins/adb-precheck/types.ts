/** Shape of a row from tenant_adb.prov_consultas (Pipeboard pg). */
export interface ProvConsultaRow {
  pasta: string
  deal_id: number
  contato_tipo: string
  contato_id: number
  contato_nome: string | null
  contato_relacao: string | null
  stage_nome: string | null
  pipeline_nome: string | null
  whatsapp_hot: string | null
  telefone_hot_1: string | null
  telefone_hot_2: string | null
  telefone_1: string | null
  telefone_2: string | null
  telefone_3: string | null
  telefone_4: string | null
  telefone_5: string | null
  telefone_6: string | null
  localizado: boolean | null
  telefone_localizado: string | null
}

/** Composite primary key for a prov_consultas lead. */
export interface DealKey {
  pasta: string
  deal_id: number
  contato_tipo: string
  contato_id: number
}

export function dealKeyToString(k: DealKey): string {
  return `${k.pasta}|${k.deal_id}|${k.contato_tipo}|${k.contato_id}`
}

/** Outcome of a per-phone precheck within a job. */
export type PhoneOutcome = 'valid' | 'invalid' | 'error'

/** Matches `CheckSource` from contacts/types.ts (kept as string to avoid tight coupling). */
export type PhoneCheckSource = string

export interface PhoneResult {
  column: string
  raw: string
  normalized: string
  outcome: PhoneOutcome
  source: PhoneCheckSource
  confidence: number | null
  variant_tried: string | null
  error: string | null
}

export interface DealResult {
  key: DealKey
  phones: PhoneResult[]
  valid_count: number
  invalid_count: number
  primary_valid_phone: string | null
}

/** Job lifecycle state. */
export type PrecheckJobStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface PrecheckJob {
  id: string
  status: PrecheckJobStatus
  started_at: string | null
  finished_at: string | null
  cancel_requested: number
  params_json: string
  total_deals: number | null
  scanned_deals: number
  total_phones: number
  valid_phones: number
  invalid_phones: number
  error_phones: number
  cache_hits: number
  last_error: string | null
  created_at: string
}

/** Params for a new scan run. */
export interface PrecheckScanParams {
  /** Max number of deals to scan in this run. Defaults to full pool. */
  limit?: number
  /** Only deals whose phones are older than this many days since last check. */
  recheck_after_days?: number
  /** Filter by pasta prefix. */
  pasta_prefix?: string
  /** Filter by pipeline_nome. */
  pipeline_nome?: string
  /** If true, also write invalid phones back to prov_invalidos. */
  writeback_invalid?: boolean
  /** If true, update prov_consultas.telefone_localizado / localizado. */
  writeback_localizado?: boolean
}
