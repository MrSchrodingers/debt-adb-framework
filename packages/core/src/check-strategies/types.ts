import type { CheckResult, CheckSource } from '../contacts/types.js'

export interface StrategyResult {
  source: CheckSource
  result: CheckResult
  confidence: number | null
  wa_chat_id?: string | null
  evidence: Record<string, unknown> | null
  latency_ms: number
  variant_tried: string
  device_serial?: string | null
  waha_session?: string | null
}

export interface CheckStrategy {
  readonly source: CheckSource
  probe(variant: string, context?: CheckContext): Promise<StrategyResult>
  available(): boolean
}

export interface CheckContext {
  deviceSerial?: string
  wahaSession?: string
  timeoutMs?: number
}
