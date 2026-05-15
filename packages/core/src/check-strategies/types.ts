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
  /**
   * Android user id that owns the WhatsApp account the probe should
   * run inside. Without this the `am start` intent is processed by
   * whichever user happens to be in foreground — typically profile 0
   * — and the probe answers for the wrong account.
   *
   * When provided, the strategy passes `--user N` to `am start`,
   * which Android routes to the right user's WA without needing a
   * full `am switch-user` (`adb shell` already has
   * INTERACT_ACROSS_USERS_FULL).
   */
  profileId?: number
  /**
   * Tenant id of the caller — propagated to DeviceMutex so the holder
   * state describes which tenant is currently holding the device lock.
   * Used by observability/debug paths only; never affects routing.
   */
  tenant?: string
  /**
   * Originating job id — propagated to DeviceMutex holder state for
   * the same reason as `tenant`. Used to correlate a held device lock
   * back to the scan job that took it.
   */
  jobId?: string
}
