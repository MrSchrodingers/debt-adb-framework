import type { ContactValidator } from '../../validator/contact-validator.js'
import type { LockHandle, LockState, PastaLockManager } from '../../locks/pasta-lock-manager.js'
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
 * Thrown by `PrecheckScanner.run` when another scan job already holds the
 * `scan:<pasta>` lock. The plugin's HTTP handler maps this to 409 Conflict
 * with the current holder's lock state.
 */
export class ScanInProgressError extends Error {
  constructor(public readonly pasta: string, public readonly current: LockState | null) {
    super(`scan_in_progress: ${pasta}`)
    this.name = 'ScanInProgressError'
  }
}

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
  /**
   * Resolves a `(device_serial, phone_number)` pair to the Android
   * user id (`whatsapp_accounts.profile_id`) that owns that WhatsApp
   * account. Without this the L3 ADB probe runs in whichever user is
   * in foreground — usually profile 0 — even though the operator
   * picked a different sender, so the answer comes from the wrong
   * account.
   *
   * Optional: when omitted (or returning null), the probe falls back
   * to the foreground-user behaviour for backwards compat. Production
   * wiring (server.ts) always supplies this lookup.
   */
  resolveProfileForSender?: (deviceSerial: string, phoneNumber: string) => number | null
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
  /**
   * Per-pasta lock manager. When supplied, the scanner acquires
   * `scan:<pasta>` (or `scan:all` when no pasta filter is set) for the
   * lifetime of the scan + retry pass, ensuring two concurrent jobs cannot
   * race on the same pasta. Optional — when omitted (e.g. in unit tests),
   * the scanner runs without the cross-pasta safety net (legacy behaviour).
   */
  locks?: PastaLockManager
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

    // ── Per-pasta scan lock (D5) ────────────────────────────────────────
    //
    // Acquire `scan:<pasta_filter>` (or `scan:all` for jobs without a pasta
    // filter) so two concurrent jobs targeting the same pasta serialize
    // rather than race. The lock is released in the finally block below.
    //
    // When `this.deps.locks` is not injected (legacy / unit-test callers),
    // we skip the locking entirely to preserve backward compatibility.
    const lockPasta = params.pasta_filter ?? 'all'
    const lockKey = `scan:${lockPasta}`
    const scanLock: LockHandle | null = this.deps.locks
      ? this.deps.locks.acquire(lockKey, 3_600_000 /* 1h TTL */, {
          job_id: jobId,
          pasta: lockPasta,
        })
      : null

    if (this.deps.locks && !scanLock) {
      // Another job already holds the lock for this pasta — surface a typed
      // error so the HTTP handler can return 409 Conflict with the holder's
      // metadata. Mark the job failed so it does not sit in 'queued' forever.
      const current = this.deps.locks.describe(lockKey)
      logger.warn('scan_in_progress', { jobId, pasta: lockPasta, current })
      store.finishJob(jobId, 'failed', `scan_in_progress: ${lockPasta}`)
      if (onJobFinished) {
        try { await onJobFinished(jobId) } catch { /* swallow */ }
      }
      this.resumeHygienizationIfActive(hygienizationActive, hygienizationOperator, jobId)
      throw new ScanInProgressError(lockPasta, current)
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

          // Resolve once per deal — same (device, sender) for every
          // phone in the row, no need to lookup repeatedly.
          const probeDevice = params.device_serial ?? this.deps.deviceSerial
          const probeSender = params.waha_session ?? this.deps.wahaSession
          const probeProfile =
            probeDevice && probeSender && this.deps.resolveProfileForSender
              ? this.deps.resolveProfileForSender(probeDevice, probeSender) ?? undefined
              : undefined

          for (const p of phones) {
            try {
              const r = await this.deps.validator.validate(p.normalized, {
                triggered_by: 'pre_check',
                useWahaTiebreaker: true,
                device_serial: probeDevice,
                waha_session: probeSender,
                profile_id: probeProfile,
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
                  // Send the literal column digits, not the canonicalized
                  // BR E.164 form. Pipeboard's NULLIF clears columns by
                  // exact-string match against the original value, and it
                  // intentionally does not canonicalize on its side
                  // (numbers legitimately starting with `55` would be
                  // ambiguous). Sending `p.normalized` here turned 11-digit
                  // entries like `55996960878` into `5555996960878`
                  // (double-prefixed by the BR_CC rule in
                  // phone-extractor.normalizeBrPhone) — Pipeboard then
                  // failed every NULLIF on those rows and the malformed
                  // `5555…` strings landed in the blocklist instead. Using
                  // the raw column digits preserves the contract whatever
                  // shape the source ETL chose.
                  telefone: p.raw.replace(/\D/g, ''),
                  colunaOrigem: p.column as BatchInvalidPhone['colunaOrigem'],
                  confidence: p.confidence,
                }),
              )
              const fonte = this.deps.fonte ?? 'dispatch_adb_precheck'
              // Only ask Pipeboard to archive when we are certain the
              // contato will be empty after our NULLIF. extractPhones
              // already iterates every known column (whatsapp_hot,
              // telefone_hot_*, telefone_1..6) on the row Pipeboard
              // returned, so phoneResults.length is the column count
              // we observed. If any of those came back as `error`
              // (inconclusive probe), the column might still hold a
              // valid phone — sending archive_if_empty=true would be
              // wrong. Restrict the flag to the strict case where
              // every column we saw was probed and definitively
              // invalid. Pipeboard's archive logic is a no-op when
              // residuals remain (HTTP 200 + deal_archived=false), so
              // the conservative gate just avoids noisy "asked-but-
              // skipped" entries in the audit log.
              const populatedColumnsInRow = phoneResults.length
              const probeCoveredEverything = invalidCount === populatedColumnsInRow
              const archiveIfEmpty = allInvalid && probeCoveredEverything
              if (allInvalid && !probeCoveredEverything) {
                logger.warn('skipping archive_if_empty: not every column came back invalid', {
                  jobId, key,
                  populatedColumnsInRow,
                  invalidCount,
                  errorCount,
                })
              }
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
          // `writeback_localizado` was removed from Dispatch — deciding
          // which phone is "the" valid one is the provider's
          // responsibility (delivery answer), not ours (existence
          // check). The Pipeboard /deals/localize endpoint stays open
          // for the provider to call directly.

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

      // D4/D5: end-of-scan retry pass — re-validate phones that ended up 'error'.
      // Runs after finishJob so the job row is already 'completed'; mutates
      // pastaAgg in-place so the pasta_summary note reflects retried outcomes.
      // The scanLock is passed so retryErrorsPass can abort early when the
      // lock is no longer valid (fence-token guard).
      if (params.retry_errors !== false) {
        await this.retryErrorsPass(jobId, params, pastaAgg, scanLock)
      }

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
    } finally {
      // Release the per-pasta scan lock unconditionally — whether the job
      // completed, was cancelled, or threw. This is safe to call even when
      // scanLock is null (no-op).
      scanLock?.release()
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
   * Level 3 sweep entrypoint (Task E1).
   *
   * Re-validates phones with outcome='error' from PRIOR scan jobs (not the
   * in-flight one). Returns immediately with a job_id; processing is async
   * via setImmediate. Caller polls GET /scan/:id for progress.
   *
   * Optional `pasta` filter restricts scope. `since_iso` controls how far
   * back to look (default: last 7 days). `max_deals` caps the result set.
   * `dry_run=true` creates the job row for auditing but calls finishJob with
   * status='cancelled' and never touches the validator.
   */
  async runRetryErrorsJob(params: {
    pasta?: string | null
    since_iso?: string
    max_deals?: number
    dry_run?: boolean
  }): Promise<{ job_id: string; deals_planned: number; status: string }> {
    const since = params.since_iso ?? new Date(Date.now() - 7 * 24 * 3_600_000).toISOString()
    const limit = params.max_deals ?? 200

    const errorDeals = this.deps.store.listDealsWithErrorsByFilter({
      since_iso: since,
      pasta: params.pasta ?? null,
      limit,
    })

    // When all deals come from a single source job, link the sweep to it so
    // audit history is queryable. Multi-parent sweeps have no single parent.
    const distinctParents = new Set(errorDeals.map((d) => d.last_job_id))
    const parentJobId = distinctParents.size === 1 ? [...distinctParents][0] : undefined

    const sweepJobParams = {
      pasta_filter: params.pasta ?? undefined,
      retry_errors: true,
      triggered_by: 'retry-errors-sweep',
      since_iso: since,
      max_deals: limit,
    } as unknown as import('./types.js').PrecheckScanParams

    const sweepJob = this.deps.store.createJob(sweepJobParams, undefined, {
      triggeredBy: 'retry-errors-sweep',
      parentJobId,
    })
    const jobId = sweepJob.id

    if (params.dry_run) {
      this.deps.store.finishJob(jobId, 'cancelled', 'dry_run')
      return { job_id: jobId, deals_planned: errorDeals.length, status: 'dry_run' }
    }

    // Fire-and-forget — caller polls /scan/:id. processSweep handles its own
    // error logging and finishJob call.
    setImmediate(() => {
      this.processSweep(jobId, errorDeals).catch((e) => {
        this.deps.logger.error('sweep job failed', { jobId, error: String(e) })
        try { this.deps.store.finishJob(jobId, 'failed', String(e)) } catch { /* ignore */ }
      })
    })

    return { job_id: jobId, deals_planned: errorDeals.length, status: 'started' }
  }

  /**
   * Async body of `runRetryErrorsJob`. Groups error deals by pasta, acquires
   * the per-pasta scan lock for each group, re-validates only the error phones,
   * persists mutations via upsertDeal, and re-publishes pasta_summary notes for
   * every touched pasta.
   */
  private async processSweep(
    jobId: string,
    errorDeals: Array<{ key: DealKey; phones: PhoneResult[]; last_job_id: string }>,
  ): Promise<void> {
    this.deps.store.markStarted(jobId, errorDeals.length)

    // Group deals by pasta so we acquire a single lock per pasta group.
    const byPasta = new Map<string, typeof errorDeals>()
    for (const d of errorDeals) {
      const list = byPasta.get(d.key.pasta) ?? []
      list.push(d)
      byPasta.set(d.key.pasta, list)
    }

    const probeDevice = this.deps.deviceSerial
    const probeSender = this.deps.wahaSession
    const probeProfile =
      probeDevice && probeSender && this.deps.resolveProfileForSender
        ? this.deps.resolveProfileForSender(probeDevice, probeSender) ?? undefined
        : undefined

    const touchedPastas = new Set<string>()
    let totalResolved = 0

    for (const [pasta, deals] of byPasta.entries()) {
      const lockKey = `scan:${pasta}`
      const lock = this.deps.locks?.acquire(lockKey, 3_600_000 /* 1h TTL */, {
        job_id: jobId,
        pasta,
        sweep: true,
      }) ?? null

      if (this.deps.locks && !lock) {
        this.deps.logger.warn('sweep skipping pasta — scan in progress', {
          jobId,
          pasta,
          current: this.deps.locks.describe(lockKey),
        })
        // Still bump progress so total_deals stays accurate.
        for (const deal of deals) {
          this.deps.store.bumpProgress(jobId, {
            scanned_deals: 1,
            total_phones: deal.phones.length,
            valid_phones: deal.phones.filter((p) => p.outcome === 'valid').length,
            invalid_phones: deal.phones.filter((p) => p.outcome === 'invalid').length,
            error_phones: deal.phones.filter((p) => p.outcome === 'error').length,
            cache_hits: 0,
          })
        }
        continue
      }

      try {
        for (const deal of deals) {
          if (lock && !lock.isStillValid()) {
            this.deps.logger.warn('lost sweep lock, aborting pasta', { jobId, pasta })
            break
          }
          let mutated = false
          for (const ph of deal.phones) {
            if (ph.outcome !== 'error') continue
            try {
              const r = await this.deps.validator.validate(ph.normalized, {
                triggered_by: 'pre_check',
                useWahaTiebreaker: true,
                device_serial: probeDevice,
                waha_session: probeSender,
                profile_id: probeProfile,
                attempt_phase: 'sweep_retry',
              })
              if (r.exists_on_wa !== null) {
                ph.outcome = r.exists_on_wa === 1 ? 'valid' : 'invalid'
                ph.source = r.source
                ph.confidence = r.confidence
                ph.error = null
                mutated = true
                totalResolved++
              }
            } catch (e) {
              this.deps.logger.debug('sweep validate threw', {
                jobId,
                key: deal.key,
                phone: ph.normalized,
                error: e instanceof Error ? e.message : String(e),
              })
            }
          }

          if (mutated) {
            const validCount = deal.phones.filter((p) => p.outcome === 'valid').length
            const invalidCount = deal.phones.filter((p) => p.outcome === 'invalid').length
            const primaryValid = deal.phones.find((p) => p.outcome === 'valid')?.normalized ?? null
            this.deps.store.upsertDeal(jobId, {
              key: deal.key,
              phones: deal.phones,
              valid_count: validCount,
              invalid_count: invalidCount,
              primary_valid_phone: primaryValid,
            })
            touchedPastas.add(pasta)
          }

          this.deps.store.bumpProgress(jobId, {
            scanned_deals: 1,
            total_phones: deal.phones.length,
            valid_phones: deal.phones.filter((p) => p.outcome === 'valid').length,
            invalid_phones: deal.phones.filter((p) => p.outcome === 'invalid').length,
            error_phones: deal.phones.filter((p) => p.outcome === 'error').length,
            cache_hits: 0,
          })
        }
      } finally {
        lock?.release()
      }
    }

    // Re-publish updated pasta_summary notes for touched pastas. The publisher's
    // upsert path (D3) will PUT the existing note instead of creating a new one.
    if (this.deps.pipedrive && touchedPastas.size > 0) {
      const sweepJob = this.deps.store.getJob(jobId)
      for (const pasta of touchedPastas) {
        const intent = this.buildSweepPastaSummaryIntent(
          jobId,
          pasta,
          sweepJob?.started_at ?? null,
          sweepJob?.finished_at ?? new Date().toISOString(),
        )
        if (intent) {
          this.deps.pipedrive.enqueuePastaSummary(intent, {
            triggered_by: 'retry-errors-sweep',
          })
        }
      }
    }

    this.deps.logger.info('sweep complete', {
      jobId,
      total_deals: errorDeals.length,
      resolved: totalResolved,
      touched_pastas: touchedPastas.size,
    })
    this.deps.store.finishJob(jobId, 'completed')
  }

  /**
   * Re-aggregates the current state of a pasta from the DB (post-sweep) and
   * builds a `PipedrivePastaSummaryIntent`. Returns null if no deals exist for
   * the pasta (defensive — only called for pastas we actually touched).
   */
  private buildSweepPastaSummaryIntent(
    jobId: string,
    pasta: string,
    jobStarted: string | null,
    jobEnded: string | null,
  ): import('./types.js').PipedrivePastaSummaryIntent | null {
    const store = this.deps.store as import('./job-store.js').PrecheckJobStore
    const rows = store.listDealsForPasta(pasta)
    if (rows.length === 0) return null

    let firstDealId = rows[0]!.key.deal_id
    let totalDeals = 0
    let okDeals = 0
    let archivedDeals = 0
    let totalPhonesChecked = 0
    let okPhones = 0
    const strategyCounts: { adb: number; waha: number; cache: number } = { adb: 0, waha: 0, cache: 0 }
    const dealRows: import('./types.js').PipedrivePastaDealRow[] = []

    // Merge by deal_id (multiple contato_ids per deal_id merge into one entry).
    const dealMap = new Map<number, import('./types.js').PipedrivePastaDealRow>()

    for (const row of rows) {
      const { deal_id } = row.key
      if (deal_id < firstDealId) firstDealId = deal_id
      totalDeals++
      totalPhonesChecked += row.phones.length
      const validInDeal = row.phones.filter((p) => p.outcome === 'valid').length
      okPhones += validInDeal
      if (validInDeal > 0) okDeals++
      else if (row.phones.length > 0) archivedDeals++

      for (const ph of row.phones) {
        strategyCounts[classifyStrategy(ph.source)] += 1
      }

      let dealEntry = dealMap.get(deal_id)
      if (!dealEntry) {
        dealEntry = { deal_id, phones: [] }
        dealMap.set(deal_id, dealEntry)
      }
      for (const ph of row.phones) {
        dealEntry.phones.push({
          column: ph.column,
          phone_normalized: ph.normalized,
          outcome: ph.outcome,
          strategy: classifyStrategy(ph.source),
        })
      }
    }

    for (const d of dealMap.values()) {
      dealRows.push(d)
    }
    dealRows.sort((a, b) => a.deal_id - b.deal_id)

    return {
      scenario: 'pasta_summary',
      pasta,
      first_deal_id: firstDealId,
      job_id: jobId,
      job_started: jobStarted,
      job_ended: jobEnded,
      total_deals: totalDeals,
      ok_deals: okDeals,
      archived_deals: archivedDeals,
      total_phones_checked: totalPhonesChecked,
      ok_phones: okPhones,
      strategy_counts: strategyCounts,
      deals: dealRows,
    }
  }

  /**
   * End-of-scan retry pass (Level 2 / Task D4).
   *
   * After the main scan loop completes, queries the DB for deal rows whose
   * `phones_json` contains at least one `"outcome":"error"` entry and
   * re-validates each error phone via `validator.validate(…, { attempt_phase:
   * 'scan_retry' })`. When the retry returns a decisive result (valid|invalid):
   *
   *   1. The `PhoneResult` in `deal.phones` is mutated in-place (outcome,
   *      source, confidence, error cleared).
   *   2. The deal is re-persisted to SQLite via `store.upsertDeal`.
   *   3. The matching `PipedrivePastaDealRow` phone inside `pastaAgg` is
   *      updated so the subsequent pasta_summary Note reflects the retry.
   *   4. Pasta-level aggregate counts (ok_phones, ok_deals, archived_deals)
   *      are recomputed from current state.
   *
   * Phones that remain 'error' after the retry pass are left as-is; Level 3
   * (sweep) handles them in a separate job.
   */
  private async retryErrorsPass(
    jobId: string,
    params: PrecheckScanParams,
    pastaAgg: Map<string, PastaAggregate>,
    lock: LockHandle | null = null,
  ): Promise<void> {
    const errorDeals = this.deps.store.listDealsWithErrors(jobId)
    if (errorDeals.length === 0) return

    const errorPhoneCount = errorDeals.reduce(
      (n, d) => n + d.phones.filter((p) => p.outcome === 'error').length,
      0,
    )
    this.deps.logger.info('end-of-scan retry pass starting', {
      jobId, deals: errorDeals.length, error_phones: errorPhoneCount,
    })

    const probeDevice = params.device_serial ?? this.deps.deviceSerial
    const probeSender = params.waha_session ?? this.deps.wahaSession
    const probeProfile =
      probeDevice && probeSender && this.deps.resolveProfileForSender
        ? this.deps.resolveProfileForSender(probeDevice, probeSender) ?? undefined
        : undefined

    let resolvedCount = 0

    for (const deal of errorDeals) {
      // Fence-token guard: abort if the scan lock was lost mid-retry (TTL
      // expired or another worker took over). This is defensive — the 1h TTL
      // makes expiry very unlikely in practice, but we honour it faithfully.
      if (lock && !lock.isStillValid()) {
        this.deps.logger.warn('lost scan lock mid-retry, aborting retry pass', {
          jobId, fenceToken: lock.fenceToken,
        })
        return
      }
      let mutated = false
      for (const ph of deal.phones) {
        if (ph.outcome !== 'error') continue
        try {
          const r = await this.deps.validator.validate(ph.normalized, {
            triggered_by: 'pre_check',
            useWahaTiebreaker: true,
            device_serial: probeDevice,
            waha_session: probeSender,
            profile_id: probeProfile,
            attempt_phase: 'scan_retry',
          })
          if (r.exists_on_wa !== null) {
            ph.outcome = r.exists_on_wa === 1 ? 'valid' : 'invalid'
            ph.source = r.source
            ph.confidence = r.confidence
            ph.error = null
            mutated = true
            resolvedCount++
          }
        } catch (e) {
          this.deps.logger.debug('scan_retry validate threw, leaving error', {
            jobId, key: deal.key, phone: ph.normalized,
            error: e instanceof Error ? e.message : String(e),
          })
        }
      }
      if (!mutated) continue

      // Persist the mutated deal phones to the DB.
      const validCount = deal.phones.filter((p) => p.outcome === 'valid').length
      const invalidCount = deal.phones.filter((p) => p.outcome === 'invalid').length
      const primaryValid = deal.phones.find((p) => p.outcome === 'valid')?.normalized ?? null
      this.deps.store.upsertDeal(jobId, {
        key: deal.key,
        phones: deal.phones,
        valid_count: validCount,
        invalid_count: invalidCount,
        primary_valid_phone: primaryValid,
      })

      // Mirror the new outcomes into pastaAgg so the resulting pasta_summary
      // note reflects the retry pass.
      const agg = pastaAgg.get(deal.key.pasta)
      if (!agg) continue
      const aggDeal = agg.deals.get(deal.key.deal_id)
      if (!aggDeal) continue
      for (const ph of deal.phones) {
        const aggPhone = aggDeal.phones.find(
          (p) => p.column === ph.column && p.phone_normalized === ph.normalized,
        )
        if (aggPhone) {
          aggPhone.outcome = ph.outcome
          aggPhone.strategy = classifyStrategy(ph.source)
        }
      }

      // Recompute aggregate counts from current pastaAgg state — cheaper and
      // exact than tracking deltas across contato_id merges.
      let okPhones = 0
      for (const d of agg.deals.values()) {
        okPhones += d.phones.filter((p) => p.outcome === 'valid').length
      }
      agg.ok_phones = okPhones
      let okDeals = 0
      let archivedDeals = 0
      for (const d of agg.deals.values()) {
        const hasValid = d.phones.some((p) => p.outcome === 'valid')
        if (hasValid) okDeals++
        else if (d.phones.length > 0) archivedDeals++
      }
      agg.ok_deals = okDeals
      agg.archived_deals = archivedDeals
    }

    this.deps.logger.info('end-of-scan retry pass complete', {
      jobId, resolved: resolvedCount, remaining_error: errorPhoneCount - resolvedCount,
    })
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
