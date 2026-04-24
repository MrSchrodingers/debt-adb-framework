import type { ContactValidator } from '../../validator/contact-validator.js'
import type { PluginLogger } from '../types.js'
import type { PipeboardPg } from './postgres-client.js'
import type { PrecheckJobStore } from './job-store.js'
import { extractPhones } from './phone-extractor.js'
import type { DealResult, PhoneResult, PrecheckScanParams } from './types.js'

const INVALID_MOTIVO = 'whatsapp_nao_existe'

export interface ScannerDeps {
  pg: PipeboardPg
  store: PrecheckJobStore
  validator: ContactValidator
  logger: PluginLogger
  /** Abort signal — if true, scanner drains current page then stops. */
  shouldCancel: (jobId: string) => boolean
  /** Routes ADB probes to this device. Required for L3 strategy. */
  deviceSerial?: string
  /** Routes WAHA tiebreaker probes to this session. Required for L2. */
  wahaSession?: string
  /** Called after each finished job (completed/cancelled/failed). */
  onJobFinished?: (jobId: string) => Promise<void>
}

/**
 * Orchestrates a pre-check scan run:
 *   1. count the pool for job.total_deals
 *   2. iterate prov_consultas in keyset pages
 *   3. for each deal, extract & normalize phones, then validate via
 *      ContactValidator (shared L1 cache → L3 ADB → L2 WAHA tiebreaker)
 *   4. cache the per-deal result in SQLite
 *   5. optionally write invalid phones back to tenant_adb.prov_invalidos
 *   6. optionally write first valid phone to prov_consultas.telefone_localizado
 *
 * Every write is idempotent. Re-running the same job id is a no-op until
 * `finishJob` clears the row; re-running a DIFFERENT job over the same deal
 * overwrites the cache (the `scanned_at` timestamp is the audit trail).
 */
export class PrecheckScanner {
  constructor(private deps: ScannerDeps) {}

  async runJob(jobId: string, params: PrecheckScanParams): Promise<void> {
    const { pg, store, logger, shouldCancel, onJobFinished } = this.deps
    let finalStatus: 'completed' | 'cancelled' | 'failed' = 'completed'
    try {
      const total = await pg.countPool(params)
      store.markStarted(jobId, total)
      logger.info('precheck scan started', { jobId, total, params })

      for await (const page of pg.iterateDeals(params, 200)) {
        if (shouldCancel(jobId)) {
          store.finishJob(jobId, 'cancelled')
          logger.warn('precheck scan cancelled', { jobId })
          finalStatus = 'cancelled'
          if (onJobFinished) await onJobFinished(jobId)
          return
        }
        for (const row of page) {
          const key = {
            pasta: row.pasta,
            deal_id: row.deal_id,
            contato_tipo: row.contato_tipo,
            contato_id: row.contato_id,
          }
          const phones = extractPhones(row)
          const phoneResults: PhoneResult[] = []
          let validCount = 0
          let invalidCount = 0
          let errorCount = 0
          let cacheHits = 0
          let primaryValid: string | null = null

          for (const p of phones) {
            try {
              const r = await this.deps.validator.validate(p.normalized, {
                triggered_by: 'pre_check',
                useWahaTiebreaker: true,
                device_serial: this.deps.deviceSerial,
                waha_session: this.deps.wahaSession,
              })
              if (r.from_cache) cacheHits++
              const outcome = r.exists_on_wa === 1 ? 'valid' : r.exists_on_wa === 0 ? 'invalid' : 'error'
              if (outcome === 'valid') {
                validCount++
                if (!primaryValid) primaryValid = r.phone_normalized
              } else if (outcome === 'invalid') {
                invalidCount++
              } else {
                errorCount++
              }
              phoneResults.push({
                column: p.column,
                raw: p.raw,
                normalized: r.phone_normalized,
                outcome,
                source: r.source,
                confidence: r.confidence,
                variant_tried: r.attempts[r.attempts.length - 1]?.variant_tried ?? null,
                error: null,
              })
            } catch (e) {
              errorCount++
              phoneResults.push({
                column: p.column,
                raw: p.raw,
                normalized: p.normalized,
                outcome: 'error',
                source: 'cache',
                confidence: null,
                variant_tried: null,
                error: e instanceof Error ? e.message : String(e),
              })
            }
          }

          const result: DealResult = {
            key,
            phones: phoneResults,
            valid_count: validCount,
            invalid_count: invalidCount,
            primary_valid_phone: primaryValid,
          }
          store.upsertDeal(jobId, result)

          if (params.writeback_invalid && validCount === 0 && phoneResults.length > 0) {
            await pg.writeInvalid(key, INVALID_MOTIVO)
          }
          if (params.writeback_localizado && primaryValid) {
            await pg.writeLocalizado(key, primaryValid, 'dispatch_adb_precheck')
          }

          store.bumpProgress(jobId, {
            scanned_deals: 1,
            total_phones: phoneResults.length,
            valid_phones: validCount,
            invalid_phones: invalidCount,
            error_phones: errorCount,
            cache_hits: cacheHits,
          })
        }
      }

      store.finishJob(jobId, 'completed')
      logger.info('precheck scan completed', { jobId })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      store.finishJob(jobId, 'failed', msg)
      logger.error('precheck scan failed', { jobId, error: msg })
      finalStatus = 'failed'
      if (onJobFinished) {
        try { await onJobFinished(jobId) } catch (cbErr) {
          logger.error('onJobFinished callback failed', { jobId, error: cbErr instanceof Error ? cbErr.message : String(cbErr) })
        }
      }
      throw e
    }
    if (finalStatus === 'completed' && onJobFinished) {
      try { await onJobFinished(jobId) } catch (cbErr) {
        logger.error('onJobFinished callback failed', { jobId, error: cbErr instanceof Error ? cbErr.message : String(cbErr) })
      }
    }
  }
}
