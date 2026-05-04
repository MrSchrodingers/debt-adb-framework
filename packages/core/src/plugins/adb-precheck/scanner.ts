import type { ContactValidator } from '../../validator/contact-validator.js'
import type { PluginLogger } from '../types.js'
import type {
  BatchInvalidPhone,
  IPipeboardClient,
  InvalidationFonte,
} from './pipeboard-client.js'
import type { PendingWritebacks } from './pending-writebacks.js'
import type { PrecheckJobStore } from './job-store.js'
import { extractPhones } from './phone-extractor.js'
import type { PipedrivePublisher } from './pipedrive-publisher.js'
import type {
  DealKey,
  DealResult,
  PhoneResult,
  PipedrivePastaDealRow,
  PipedrivePhoneEntry,
  PrecheckScanParams,
} from './types.js'

/**
 * Subset of `DispatchPauseState` the scanner needs. Kept structural so this
 * module never imports the `engine/` tree (avoids the plugin → engine cycle).
 *
 * `set` semantics match `DispatchPauseState.pause`:
 *   - source: scope hint (we always pass 'global' for hygienization mode)
 *   - reason: human-readable label that appears in the admin UI banner
 *   - by:     audit operator name
 */
export interface ScannerPauseState {
  pause: (scope: 'global', key: string, reason: string, by: string) => void
  resume: (scope: 'global', key: string, by: string) => boolean
}

/** Hard floor for `recheck_after_days` when hygienization mode is on. */
export const HYGIENIZATION_RECHECK_FLOOR_DAYS = 30

/**
 * Reason string written into `dispatch_pause` rows when the scanner pauses
 * production for hygienization. The UI banner matches on `:hygienization`
 * substring of the source/reason — keep both stable.
 */
export const HYGIENIZATION_PAUSE_REASON =
  'auto-paused by adb-precheck:hygienization'

const INVALID_MOTIVO = 'whatsapp_nao_existe'

/**
 * Maximum number of deal keys we are willing to inline into a Postgres
 * `NOT IN ((..),(..))` tuple list before we bail out and rely on
 * scanner-side filtering instead. Empirically, parameter counts above
 * ~30k can hurt the planner; 5000 keys × 4 cols = 20k bound params, well
 * within Postgres' default `max_prepared_statements` budget but still
 * comfortably below pathological territory.
 */
const MAX_PG_EXCLUDED_KEYS = 5000

export interface ScannerDeps {
  pg: IPipeboardClient
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
  /**
   * Task 5.4: called for each phone whose outcome is 'invalid' so the
   * central blacklist is updated. Optional — omit in tests that do not
   * need ban recording.
   */
  onInvalidPhone?: (normalizedPhone: string) => void
  /**
   * Pipedrive publisher — when present, scanner fires fire-and-forget intents
   * for the three scenarios (per-phone fail, deal-all-fail, pasta summary).
   * Optional: omit (or pass undefined) when PIPEDRIVE_API_TOKEN is not set.
   */
  pipedrive?: PipedrivePublisher
  /** TTL hint for the cache footer in Pipedrive notes (days). */
  pipedriveCacheTtlDays?: number
  /**
   * When true, the scanner skips deal-level Pipedrive Activities
   * (`deal_all_fail`) because Pipeboard now generates them server-side
   * via Temporal after each `phones/invalidate` call. The end-of-scan
   * `pasta_summary` Note is still emitted from Dispatch (Pipeboard
   * does not aggregate it).
   *
   * Should be set whenever the plugin runs with `BACKEND=rest`.
   */
  skipPipedriveDealActivity?: boolean
  /**
   * Optional fail-closed buffer. When present, every batch writeback
   * goes through `pendingWritebacks.submit*` so retryable failures are
   * persisted to SQLite and drained later. When absent, calls hit
   * `pg.applyDeal*` directly and any retryable failure surfaces as a
   * scanner-level warning (current SQL backend behaviour).
   *
   * Required for production runs with BACKEND=rest.
   */
  pendingWritebacks?: PendingWritebacks
  /**
   * `fonte` value sent in batch invalidations / localizations. Defaults
   * to `dispatch_adb_precheck` (matches Pipeboard router_api_keys
   * vocabulary).
   */
  fonte?: InvalidationFonte
  /**
   * Optional pause-state proxy. When the job has `hygienization_mode = true`,
   * the scanner pauses the global circuit breaker before iterating and
   * resumes it in `finally` (regardless of cancel/error). Omitted in unit
   * tests that don't exercise the hygienization path.
   */
  pauseState?: ScannerPauseState
  /** Operator label written to the audit log when the scanner toggles pause. */
  hygienizationOperator?: string
}

interface PastaAggregate {
  pasta: string
  first_deal_id: number | null
  total_deals: number
  ok_deals: number
  archived_deals: number
  total_phones_checked: number
  ok_phones: number
  strategy_counts: { adb: number; waha: number; cache: number }
  /**
   * Per-deal phone-level breakdown carried into the `pasta_summary` Note.
   *
   * Operators wanted the timeline note to show *which* phones were checked
   * for *which* deal — not just aggregate counts. We keep one entry per
   * (deal_id) within the pasta; if the same deal appears twice in a job
   * (different `contato_id` rows), we merge their phones into the same
   * deal entry. The first time we see a deal_id, we push a new row; on
   * subsequent rows we append phones to the existing entry.
   */
  deals: Map<number, PipedrivePastaDealRow>
}

function classifyStrategy(source: string): 'adb' | 'waha' | 'cache' {
  const s = source.toLowerCase()
  if (s.includes('adb')) return 'adb'
  if (s.includes('waha')) return 'waha'
  return 'cache'
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
    const { pg, store, logger, shouldCancel, onJobFinished, pauseState } = this.deps
    // Per-job opt-out: even when the integration is wired we honour the
    // `pipedrive_enabled === false` flag and skip all 3 scenarios for this
    // job. This lets operators run a quick scan without polluting Pipedrive.
    const pipedrive = params.pipedrive_enabled === false ? undefined : this.deps.pipedrive
    let finalStatus: 'completed' | 'cancelled' | 'failed' = 'completed'
    const pastaAgg: Map<string, PastaAggregate> = new Map()
    const startedAt = new Date().toISOString()

    // ── Hygienization mode (Part 2) ─────────────────────────────────────
    //
    // When the operator opted in via `hygienization_mode=true`, we MUST
    // pause global production sends BEFORE any iteration. The pause is
    // released in the outermost `finally` regardless of cancel/error/panic.
    //
    // Safety net: if `pauseState` was not injected (legacy callers, unit
    // tests without the engine), we honour the recheck floor but log a
    // warning — operators can still detect this by inspecting the job row.
    let hygienizationActive = false
    const hygienizationOperator = this.deps.hygienizationOperator ?? 'adb-precheck:scanner'
    if (params.hygienization_mode === true) {
      // Floor `recheck_after_days` at 30 — operators chose hygiene mode to
      // avoid hammering recently-checked numbers, so we never honour smaller
      // windows in this mode (would defeat the purpose).
      const floor = HYGIENIZATION_RECHECK_FLOOR_DAYS
      const requested = params.recheck_after_days ?? 0
      if (requested < floor) {
        params = { ...params, recheck_after_days: floor }
      }
      if (pauseState) {
        try {
          pauseState.pause(
            'global',
            '*',
            HYGIENIZATION_PAUSE_REASON,
            hygienizationOperator,
          )
          hygienizationActive = true
          logger.warn('hygienization mode: global send paused', { jobId })
        } catch (e) {
          // If the pause itself fails we ABORT the job — the operator's
          // intent was "freeze prod first, then scan". Continuing without
          // the pause would violate that contract.
          logger.error('hygienization mode: failed to pause global', {
            jobId,
            error: e instanceof Error ? e.message : String(e),
          })
          store.finishJob(
            jobId,
            'failed',
            `hygienization pause failed: ${e instanceof Error ? e.message : String(e)}`,
          )
          if (onJobFinished) {
            try { await onJobFinished(jobId) } catch { /* swallow */ }
          }
          throw e
        }
      } else {
        logger.warn(
          'hygienization mode requested but pauseState not wired — proceeding without global pause',
          { jobId },
        )
      }
    }

    // ── Recheck freshness filter ────────────────────────────────────────
    //
    // When `recheck_after_days` is set, the operator wants to skip deals
    // already scanned within the freshness window — but they ALSO want
    // `params.limit` to count *processed* deals, not "first N rows from PG".
    //
    // Strategy:
    //   1. Try to fetch the recently-scanned key set from SQLite. If it
    //      fits within MAX_PG_EXCLUDED_KEYS we pass it down as an
    //      `excluded_keys` filter so PG drops them server-side (faster
    //      iteration, accurate countPool).
    //   2. If too many keys (cache larger than 5k entries) we degrade to
    //      scanner-side filtering only — the loop below still skips fresh
    //      rows, just at the cost of an extra Postgres round-trip per page.
    //
    // Either way, the inner loop ALSO checks per-row in case a new fresh
    // entry landed in the cache between countPool and iterateDeals.
    let pgParams: PrecheckScanParams = params
    let scannerSideFilter = false
    let recheckThresholdIso: string | null = null
    if (params.recheck_after_days !== undefined && params.recheck_after_days >= 0) {
      const ms = params.recheck_after_days * 24 * 60 * 60 * 1000
      recheckThresholdIso = new Date(Date.now() - ms).toISOString()
      // Probe the cache: cap at MAX_PG_EXCLUDED_KEYS+1 so we know if we
      // overflowed without pulling the whole set.
      const recentKeys = store.listRecentlyScannedKeys(
        recheckThresholdIso,
        MAX_PG_EXCLUDED_KEYS + 1,
      )
      if (recentKeys.length <= MAX_PG_EXCLUDED_KEYS && recentKeys.length > 0) {
        pgParams = { ...params, excluded_keys: recentKeys }
      } else if (recentKeys.length > MAX_PG_EXCLUDED_KEYS) {
        scannerSideFilter = true
        logger.warn(
          'recheck_after_days excluded set too large to inline — falling back to scanner-side filtering',
          { jobId, cachedKeysAboveThreshold: recentKeys.length },
        )
      }
    }

    // Scanner-side processing budget. `limit` now means "this many deals
    // ACTUALLY PROCESSED" (i.e. validator was called), not "this many rows
    // out of PG". Anything else here would re-introduce the bug where a
    // small limit (e.g. 10) gets exhausted by 10 already-fresh rows.
    const processingBudget = params.limit ?? Number.MAX_SAFE_INTEGER
    let processedCount = 0

    try {
      const total = await pg.countPool(pgParams)
      // When `limit` is set we cap the displayed total at the budget so the
      // progress bar is not misleading (a limit-10 job over a 6k pool should
      // show 10/10, not 10/6000 once finished).
      const reportedTotal = Math.min(total, processingBudget)
      store.markStarted(jobId, reportedTotal)
      logger.info('precheck scan started', {
        jobId,
        total,
        reportedTotal,
        scannerSideFilter,
        pgExcludedKeys: pgParams.excluded_keys?.length ?? 0,
        params,
      })

      outer: for await (const page of pg.iterateDeals(pgParams, 200)) {
        if (shouldCancel(jobId)) {
          store.finishJob(jobId, 'cancelled')
          logger.warn('precheck scan cancelled', { jobId })
          finalStatus = 'cancelled'
          if (onJobFinished) await onJobFinished(jobId)
          // Resume the global pause before exiting the cancel path; the early
          // `return` would otherwise skip the post-loop resume call.
          this.resumeHygienizationIfActive(hygienizationActive, hygienizationOperator, jobId)
          return
        }
        for (const row of page) {
          const key: DealKey = {
            pasta: row.pasta,
            deal_id: row.deal_id,
            contato_tipo: row.contato_tipo,
            contato_id: row.contato_id,
          }
          // Defensive freshness re-check: covers the large-set fallback path
          // AND the (rare) case where a row landed in the cache between
          // countPool and the moment we read it from PG. NEVER counts toward
          // processedCount or progress — the deal was simply not eligible.
          if (recheckThresholdIso !== null) {
            const lastScan = store.getDealLastScannedAt(key)
            if (lastScan !== null && lastScan >= recheckThresholdIso) {
              continue
            }
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
                // Task 5.4: record invalid phones in the central blacklist
                this.deps.onInvalidPhone?.(r.phone_normalized)
                // NOTE: per-phone Pipedrive Activities (`phone_fail`) were
                // removed on 2026-04-29 — too noisy on the deal timeline.
                // We now only emit one Activity per archived deal
                // (deal_all_fail) and one Note per pasta (pasta_summary).
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

          if (params.writeback_invalid) {
            // Dedupe by normalized phone — first occurrence wins for
            // column attribution (highest-priority column per
            // PHONE_COLUMNS).
            const dedupedInvalids = new Map<string, PhoneResult>()
            for (const p of phoneResults) {
              if (p.outcome === 'invalid' && !dedupedInvalids.has(p.normalized)) {
                dedupedInvalids.set(p.normalized, p)
              }
            }
            const allInvalid = validCount === 0 && phoneResults.length > 0

            if (dedupedInvalids.size > 0) {
              const phones: BatchInvalidPhone[] = [...dedupedInvalids.values()].map(
                (p) => ({
                  telefone: p.normalized,
                  colunaOrigem: p.column as BatchInvalidPhone['colunaOrigem'],
                  confidence: p.confidence,
                }),
              )
              const fonte = this.deps.fonte ?? 'dispatch_adb_precheck'
              const archiveIfEmpty = allInvalid
              try {
                const result = this.deps.pendingWritebacks
                  ? await this.deps.pendingWritebacks.submitInvalidation(key, {
                      motivo: INVALID_MOTIVO,
                      jobId,
                      fonte,
                      phones,
                      archiveIfEmpty,
                    })
                  : await pg.applyDealInvalidation(key, {
                      motivo: INVALID_MOTIVO,
                      jobId,
                      fonte,
                      phones,
                      archiveIfEmpty,
                    })
                if ('archived' in result && result.archived) {
                  logger.info('deal archived (no valid phones)', { jobId, key })
                  // Pipedrive Scenario B: only on successful archive.
                  // When BACKEND=rest, Pipeboard fires Pipedrive
                  // server-side via Temporal — gate by skip flag.
                  if (pipedrive && !this.deps.skipPipedriveDealActivity) {
                    const phoneEntries: PipedrivePhoneEntry[] = phoneResults.map(
                      (pr) => ({
                        phone: pr.normalized,
                        column: pr.column,
                        outcome: pr.outcome,
                        strategy: pr.source,
                        confidence: pr.confidence,
                      }),
                    )
                    pipedrive.enqueueDealAllFail({
                      scenario: 'deal_all_fail',
                      deal_id: row.deal_id,
                      pasta: row.pasta,
                      phones: phoneEntries,
                      motivo: 'todos_telefones_invalidos',
                      job_id: jobId,
                      occurred_at: new Date().toISOString(),
                    })
                  }
                }
                if ('enqueued' in result) {
                  logger.warn('invalidation enqueued (Pipeboard unreachable)', {
                    jobId,
                    key,
                    pendingId: result.pendingId,
                  })
                }
              } catch (e) {
                logger.warn('invalid phones writeback failed', {
                  jobId,
                  key,
                  count: dedupedInvalids.size,
                  error: e instanceof Error ? e.message : String(e),
                })
              }
            }
          }
          if (params.writeback_localizado && primaryValid) {
            const fonte = this.deps.fonte ?? 'dispatch_adb_precheck'
            try {
              if (this.deps.pendingWritebacks) {
                await this.deps.pendingWritebacks.submitLocalization(key, {
                  telefone: primaryValid,
                  source: 'adb',
                  jobId,
                  fonte,
                })
              } else {
                await pg.applyDealLocalization(key, {
                  telefone: primaryValid,
                  source: 'adb',
                  jobId,
                  fonte,
                })
              }
            } catch (e) {
              logger.warn('localization writeback failed', {
                jobId,
                key,
                phone: primaryValid,
                error: e instanceof Error ? e.message : String(e),
              })
            }
          }

          // Pasta-level aggregation for Scenario C (pasta summary Note).
          // Records first deal_id (lowest), counts, strategy distribution,
          // AND per-deal phone-level detail for the v2 layout.
          if (pipedrive) {
            let agg = pastaAgg.get(row.pasta)
            if (!agg) {
              agg = {
                pasta: row.pasta,
                first_deal_id: null,
                total_deals: 0,
                ok_deals: 0,
                archived_deals: 0,
                total_phones_checked: 0,
                ok_phones: 0,
                strategy_counts: { adb: 0, waha: 0, cache: 0 },
                deals: new Map<number, PipedrivePastaDealRow>(),
              }
              pastaAgg.set(row.pasta, agg)
            }
            if (agg.first_deal_id === null || row.deal_id < agg.first_deal_id) {
              agg.first_deal_id = row.deal_id
            }
            agg.total_deals += 1
            agg.total_phones_checked += phoneResults.length
            agg.ok_phones += validCount
            if (validCount > 0) agg.ok_deals += 1
            else if (phoneResults.length > 0) agg.archived_deals += 1
            for (const pr of phoneResults) {
              agg.strategy_counts[classifyStrategy(pr.source)] += 1
            }

            // Per-deal phone breakdown: merge by deal_id. If two rows of the
            // same deal_id (different contato_id) appear in the job, we
            // append phones into the same deal entry — operator sees one
            // 📌 sub-section per deal, with all checked phones grouped.
            let dealRow = agg.deals.get(row.deal_id)
            if (!dealRow) {
              dealRow = { deal_id: row.deal_id, phones: [] }
              agg.deals.set(row.deal_id, dealRow)
            }
            for (const pr of phoneResults) {
              dealRow.phones.push({
                column: pr.column,
                phone_normalized: pr.normalized,
                outcome: pr.outcome,
                strategy: classifyStrategy(pr.source),
              })
            }
          }

          store.bumpProgress(jobId, {
            scanned_deals: 1,
            total_phones: phoneResults.length,
            valid_phones: validCount,
            invalid_phones: invalidCount,
            error_phones: errorCount,
            cache_hits: cacheHits,
          })

          // Scanner-side limit enforcement. We count only deals that made it
          // past the freshness filter — i.e. real work was done. Once the
          // operator's budget is spent, break out of the keyset iterator
          // entirely (don't fetch additional pages we won't consume).
          processedCount += 1
          if (processedCount >= processingBudget) {
            break outer
          }
        }
      }

      store.finishJob(jobId, 'completed')
      logger.info('precheck scan completed', {
        jobId,
        processedCount,
        budget: processingBudget,
      })

      // Pipedrive Scenario C: emit one Note per pasta touched, on the lowest
      // deal_id of the pasta. Skips empty pastas (defensive — shouldn't happen
      // since we only insert into pastaAgg from inside the iteration).
      if (pipedrive) {
        const finishedAt = new Date().toISOString()
        for (const agg of pastaAgg.values()) {
          if (agg.total_deals === 0 || agg.first_deal_id === null) continue
          // Emit deals in numeric order so the Note layout is deterministic
          // and easy to scan visually (smallest deal_id first, matching the
          // `first_deal_id` referenced in the title).
          const dealsSorted = Array.from(agg.deals.values()).sort(
            (a, b) => a.deal_id - b.deal_id,
          )
          pipedrive.enqueuePastaSummary({
            scenario: 'pasta_summary',
            pasta: agg.pasta,
            first_deal_id: agg.first_deal_id,
            job_id: jobId,
            job_started: startedAt,
            job_ended: finishedAt,
            total_deals: agg.total_deals,
            ok_deals: agg.ok_deals,
            archived_deals: agg.archived_deals,
            total_phones_checked: agg.total_phones_checked,
            ok_phones: agg.ok_phones,
            strategy_counts: agg.strategy_counts,
            deals: dealsSorted,
          })
        }
      }
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
      this.resumeHygienizationIfActive(hygienizationActive, hygienizationOperator, jobId)
      throw e
    }
    if (finalStatus === 'completed' && onJobFinished) {
      try { await onJobFinished(jobId) } catch (cbErr) {
        logger.error('onJobFinished callback failed', { jobId, error: cbErr instanceof Error ? cbErr.message : String(cbErr) })
      }
    }
    // Happy path: completion went through. Resume idempotently.
    this.resumeHygienizationIfActive(hygienizationActive, hygienizationOperator, jobId)
  }

  /**
   * Idempotent helper invoked from every termination path (cancel, error,
   * success). When hygienization mode was successfully engaged at job start,
   * we MUST call resume — otherwise the global circuit breaker would stay
   * locked across a restart, blocking every plugin from sending.
   *
   * Logs loudly when resume itself fails so the operator can manually clear.
   */
  private resumeHygienizationIfActive(
    active: boolean,
    operator: string,
    jobId: string,
  ): void {
    if (!active) return
    const { pauseState, logger } = this.deps
    if (!pauseState) return
    try {
      const ok = pauseState.resume('global', '*', operator)
      logger.info('hygienization mode: global send resumed', { jobId, resumed: ok })
    } catch (resumeErr) {
      logger.error(
        'hygienization mode: failed to resume global pause — MANUAL INTERVENTION REQUIRED',
        {
          jobId,
          error: resumeErr instanceof Error ? resumeErr.message : String(resumeErr),
        },
      )
    }
  }
}
