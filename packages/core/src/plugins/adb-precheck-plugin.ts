import type Database from 'better-sqlite3'
import { createHmac } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import type { ContactRegistry } from '../contacts/contact-registry.js'
import type { AdbShellAdapter } from '../monitor/types.js'
import type { WahaApiClient } from '../waha/types.js'
import type { DispatchPauseState } from '../engine/dispatch-pause-state.js'
import { ContactValidator } from '../validator/contact-validator.js'
import {
  AdbProbeStrategy,
  CacheOnlyStrategy,
  WahaCheckStrategy,
} from '../check-strategies/index.js'
import type { DispatchPlugin, PluginContext } from './types.js'
import { PastaLockManager } from '../locks/index.js'
import { ProbeSnapshotWriter } from '../snapshots/probe-snapshot-writer.js'
import type { DispatchEventName } from '../events/index.js'
import type { DispatchEmitter } from '../events/dispatch-emitter.js'
import {
  PipeboardPg,
  PipeboardRest,
  PendingWritebacks,
  PrecheckJobStore,
  PrecheckScanner,
  PipedriveClient,
  PipedriveActivityStore,
  PipedrivePublisher,
  registerPipedrivePluginRoutes,
  resolvePipeboardBackend,
  type IPipeboardClient,
  type PipeboardBackend,
} from './adb-precheck/index.js'

const scanParamsSchema = z
  .object({
    limit: z.number().int().min(1).max(100_000).optional(),
    recheck_after_days: z.number().int().min(0).max(3650).optional(),
    pasta_prefix: z.string().min(1).max(255).optional(),
    pipeline_nome: z.string().min(1).max(255).optional(),
    writeback_invalid: z.boolean().default(false),
    external_ref: z.string().min(1).max(128).optional(),
    /**
     * Per-job Pipedrive opt-in. Undefined → default to `true` if integration
     * is wired (token + client present), else `false`. Operator can force
     * `false` to skip even when wired (e.g. dry-run scans).
     */
    pipedrive_enabled: z.boolean().optional(),
    /**
     * Hygienization mode (Part 2): pauses global production sends for the
     * lifetime of the job and floors `recheck_after_days` at 30. Default
     * false. The actual pause/resume happens server-side in the scanner
     * (so the lifecycle is honoured even if the UI is closed mid-scan).
     */
    hygienization_mode: z.boolean().optional(),
    /**
     * Override which connected device performs the L3 ADB probe for this
     * job. When omitted, falls back to PLUGIN_ADB_PRECHECK_DEVICE_SERIAL.
     * Must match an `adb devices` serial currently online — otherwise the
     * probe step throws and the scanner records `error` outcomes.
     */
    device_serial: z.string().min(1).max(64).optional(),
    /**
     * Override which WAHA session performs the L2 tiebreaker. When
     * omitted, falls back to PLUGIN_ADB_PRECHECK_WAHA_SESSION. Pair
     * naturally with `device_serial` when the operator wants both legs
     * of the validation routed through the same WhatsApp account.
     */
    waha_session: z.string().min(1).max(64).optional(),
  })
  .strict()

/**
 * ADB Pre-check Plugin — Pipeboard integration.
 *
 * Business purpose: given the pool of leads in `tenant_adb.prov_consultas`
 * (6k+ rows, ~19k distinct phones), validate which phones exist on WhatsApp
 * using the shared ContactRegistry cache + ADB probe + WAHA tiebreaker, and
 * optionally push findings back to Pipeboard (mark invalid leads, mark the
 * first valid phone as `telefone_localizado`).
 *
 * Isolation from Oralsin:
 *   - Separate Postgres pool (pipeboard schema, not Oralsin's)
 *   - Separate SQLite tables prefixed `adb_precheck_*`
 *   - Routes under `/api/v1/plugins/adb-precheck/*`
 *   - Env prefix `PLUGIN_ADB_PRECHECK_*`
 *   - Subscribes to zero core events (pull-model: scan on demand)
 *
 * Shared with Oralsin (by design, not by accident):
 *   - `wa_contacts` / `wa_contact_checks` registry tables — any validation
 *     performed here primes the cache for everyone else, and vice-versa.
 *     This is the whole point of having a central registry.
 */
export class AdbPrecheckPlugin implements DispatchPlugin {
  name = 'adb-precheck' as const
  version = '0.1.0'
  events: DispatchEventName[] = []
  webhookUrl: string

  private ctx: PluginContext | null = null
  private pg: IPipeboardClient
  private pipeboardBackend: PipeboardBackend = 'sql'
  private pendingWritebacks: PendingWritebacks | null = null
  private store: PrecheckJobStore
  private validator: ContactValidator
  // Strategy refs kept so init() can rebuild the validator with a
  // mutex-aware AdbProbeStrategy without rewiring everything else.
  private cacheStrategy!: CacheOnlyStrategy
  private wahaStrategy!: WahaCheckStrategy
  private scanner: PrecheckScanner | null = null
  private defaultDeviceSerial: string | undefined
  private defaultWahaSession: string | undefined
  private hmacSecret: string | undefined
  private readonly onInvalidPhoneCb: ((phone: string) => void) | undefined

  private pipedriveClient: PipedriveClient | null = null
  private pipedrivePublisher: PipedrivePublisher | null = null
  private pipedriveActivityStore: PipedriveActivityStore | null = null
  private readonly pipedriveCacheTtlDays: number | undefined
  private readonly pipedriveCompanyDomain: string | null
  private readonly pauseState: DispatchPauseState | undefined
  private readonly hygienizationOperator: string
  private pastaLocks: PastaLockManager | null = null
  private pastaLockReapTimer: NodeJS.Timeout | null = null
  private snapshotWriter: ProbeSnapshotWriter

  constructor(
    opts: {
      webhookUrl: string
      pgConnectionString: string
      pgMaxConnections?: number
      /**
       * Selects the Pipeboard backend. `sql` uses the legacy SSH-tunnelled
       * `pg.Pool`; `rest` calls the Pipeboard router endpoints. The two
       * are mutually exclusive — Pipeboard's blocklist trigger silently
       * NULLifies any SQL UPDATE that would reintroduce a blocked phone,
       * so a SQL fallback during rest mode would corrupt mutations.
       *
       * Defaults to `sql` until the cutover gate. Set to `rest` only after
       * `restApiKey` and `restBaseUrl` are configured.
       */
      backend?: PipeboardBackend
      /** Base URL of the Pipeboard router including tenant segment, e.g. http://pipeboard-router:18080/api/v1/adb */
      restBaseUrl?: string
      /** API key (X-API-Key header) for Pipeboard. Required when backend=rest. */
      restApiKey?: string
      /** Per-request timeout in ms (default 15s). */
      restTimeoutMs?: number
      /** Default device serial to route ADB probes through. */
      defaultDeviceSerial?: string
      /** Default WAHA session for L2 tiebreaker. */
      defaultWahaSession?: string
      /** HMAC secret for outgoing callback signatures. */
      hmacSecret?: string
      /** WAHA API client (optional — disables L2 tiebreaker when absent). */
      wahaClient?: WahaApiClient
      /**
       * Task 5.4: callback to record a phone in the central blacklist when
       * precheck confirms outcome=invalid.  Optional — omit to disable ban
       * recording (useful in isolated test environments).
       */
      onInvalidPhone?: (phone: string) => void
      /**
       * Pipedrive integration — when set, scanner emits per-phone fail,
       * deal-archive, and pasta-summary intents to Pipedrive (Activities +
       * Notes). Feature-flag implicit: omit to disable.
       */
      pipedrive?: {
        apiToken: string
        baseUrl?: string
        ratePerSec?: number
        burst?: number
        cacheTtlDays?: number
        /**
         * Pipedrive company subdomain (just the prefix — e.g. `debt-5188cf`).
         * Used to build clickable deal links in Markdown notes/activities.
         */
        companyDomain?: string
      }
      /** Dispatch emitter — required for Pipedrive failure event surfacing. */
      emitter?: DispatchEmitter
      /**
       * Optional pause-state proxy used by hygienization mode. When omitted,
       * hygienization-mode jobs run with the recheck floor enforced but
       * WITHOUT pausing global sends — a warning is logged. In production
       * (server.ts) we always pass it; tests can omit it.
       */
      pauseState?: DispatchPauseState
      /** Operator label written to the audit log when scanner toggles pause. */
      hygienizationOperator?: string
    },
    private db: Database.Database,
    private registry: ContactRegistry,
    private adb: AdbShellAdapter,
  ) {
    this.webhookUrl = opts.webhookUrl
    this.defaultDeviceSerial = opts.defaultDeviceSerial
    this.defaultWahaSession = opts.defaultWahaSession
    this.hmacSecret = opts.hmacSecret
    this.onInvalidPhoneCb = opts.onInvalidPhone
    const backend: PipeboardBackend = opts.backend ?? 'sql'
    if (backend === 'rest') {
      if (!opts.restBaseUrl || !opts.restApiKey) {
        throw new Error(
          'adb-precheck: backend=rest requires restBaseUrl and restApiKey',
        )
      }
      this.pg = new PipeboardRest({
        baseUrl: opts.restBaseUrl,
        apiKey: opts.restApiKey,
        timeoutMs: opts.restTimeoutMs,
      })
    } else {
      this.pg = new PipeboardPg(opts.pgConnectionString, opts.pgMaxConnections ?? 4)
    }
    this.pipeboardBackend = backend
    this.store = new PrecheckJobStore(db)
    const snapshotBaseDir = join(process.env.DATA_DIR ?? 'data', 'probe-snapshots')
    this.snapshotWriter = new ProbeSnapshotWriter({
      baseDir: snapshotBaseDir,
      dailyQuota: 500,
      perMinuteCap: 10,
    })
    this.pipedriveCacheTtlDays = opts.pipedrive?.cacheTtlDays
    this.pipedriveCompanyDomain = opts.pipedrive?.companyDomain ?? null
    this.pauseState = opts.pauseState
    this.hygienizationOperator = opts.hygienizationOperator ?? 'adb-precheck:hygienization'

    // Pipedrive client + publisher are wired only when a token is provided.
    // Stays null when the env var is missing — scanner becomes a no-op for
    // Pipedrive calls (intents are simply not produced).
    if (opts.pipedrive?.apiToken) {
      this.pipedriveClient = new PipedriveClient({
        apiToken: opts.pipedrive.apiToken,
        baseUrl: opts.pipedrive.baseUrl,
        ratePerSec: opts.pipedrive.ratePerSec,
        burst: opts.pipedrive.burst,
        emitter: opts.emitter,
      })
    }

    // Strategies are owned by the plugin, independent from the worker's
    // pre-check path. Probes go through the same ContactRegistry so findings
    // accrue to the shared WhatsApp validity cache (benefits Oralsin too).
    //
    // The AdbProbeStrategy is rebuilt in init() once we have ctx.deviceMutex,
    // so probe runs serialise against worker sends. Until init we use a
    // mutex-less strategy so unit-test instantiations of the plugin keep
    // working without needing a fake context.
    const cacheStrategy = new CacheOnlyStrategy(this.registry)
    const adbStrategy = new AdbProbeStrategy(this.adb, undefined, undefined, this.snapshotWriter)
    // L2 tiebreaker is active only when a WAHA client + session are provided.
    const wahaClient = opts.wahaClient
    const wahaStrategy = new WahaCheckStrategy(
      {
        checkExists: async (session, phone) => {
          if (!wahaClient) return { numberExists: false, chatId: null }
          return wahaClient.checkExists(session, phone)
        },
      },
      () => Boolean(wahaClient && this.defaultWahaSession),
    )
    this.cacheStrategy = cacheStrategy
    this.wahaStrategy = wahaStrategy
    this.validator = new ContactValidator(this.registry, adbStrategy, wahaStrategy, cacheStrategy)
  }

  async init(ctx: PluginContext): Promise<void> {
    this.ctx = ctx
    // Rebuild the L3 ADB probe strategy with the shared device mutex
    // so probes serialise with worker sends. Without this, an active
    // scan races the SendEngine on the same physical screen and any
    // half-typed Oralsin message becomes a draft.
    if (ctx.deviceMutex) {
      const adbStrategy = new AdbProbeStrategy(this.adb, undefined, ctx.deviceMutex, this.snapshotWriter)
      this.validator = new ContactValidator(
        this.registry,
        adbStrategy,
        this.wahaStrategy,
        this.cacheStrategy,
      )
    }
    this.store.initialize()
    // A8: pasta locks shared across scan + note-publish paths.
    // SQLite-backed manager survives restart via the `pasta_locks` table.
    this.pastaLocks = new PastaLockManager(this.db)
    this.pastaLocks.initialize()
    const reapedLocks = this.pastaLocks.releaseExpired()
    if (reapedLocks > 0) {
      ctx.logger.warn('reaped expired pasta locks on boot', { count: reapedLocks })
    }
    this.pastaLockReapTimer = setInterval(() => {
      try {
        this.pastaLocks?.releaseExpired()
      } catch (e) {
        ctx.logger.warn('pasta lock reap failed', { error: e instanceof Error ? e.message : String(e) })
      }
    }, 5 * 60_000)
    this.pastaLockReapTimer.unref()
    // Boot-time watchdog: anything still flagged `running` in the job
    // table belongs to a previous process that died without finishing.
    // Mark them as failed so the UI / metrics don't carry phantom
    // "in flight" jobs forever (this was how the 4-day-old 42/50 job
    // got stuck before).
    const reaped = this.store.reapOrphanedRunningJobs()
    if (reaped > 0) {
      ctx.logger.warn('reaped orphaned precheck jobs from prior run', { count: reaped })
    }
    if (this.pipedriveClient) {
      this.pipedriveActivityStore = new PipedriveActivityStore(this.db)
      this.pipedriveActivityStore.initialize()
      this.pipedrivePublisher = new PipedrivePublisher(
        this.pipedriveClient,
        ctx.logger,
        this.pipedriveActivityStore,
        this.pipedriveCompanyDomain,
      )
      ctx.logger.info('Pipedrive integration enabled', {
        companyDomain: this.pipedriveCompanyDomain ?? '(unset — links disabled)',
      })
    }
    // Fail-closed buffer for retryable Pipeboard failures. Always
    // wired — the SQL backend rarely fails in a retryable way, but
    // when it does (network blip on the SSH tunnel, transient PG)
    // queueing locally is the safe choice. For BACKEND=rest this is
    // the *only* safe path: a SQL fallback would be silently zeroed
    // by Pipeboard's blocklist trigger.
    this.pendingWritebacks = new PendingWritebacks(this.db, {
      client: this.pg,
      logger: ctx.logger,
    })
    this.pendingWritebacks.initialize()
    this.pendingWritebacks.startDrain()

    this.scanner = new PrecheckScanner({
      pg: this.pg,
      store: this.store,
      validator: this.validator,
      logger: ctx.logger,
      shouldCancel: (jobId) => this.store.isCancelRequested(jobId),
      deviceSerial: this.defaultDeviceSerial,
      wahaSession: this.defaultWahaSession,
      // Resolve which Android user owns the chosen sender on the
      // chosen device, so the L3 ADB probe targets the right WA.
      // Falls back to whatsapp_accounts (truth from the device) and
      // tolerates the BR 9-prefix gap by digit-suffix matching.
      resolveProfileForSender: (device, phone) => {
        const digits = phone.replace(/\D/g, '')
        if (!digits) return null
        const row = this.db
          .prepare(
            `SELECT profile_id FROM whatsapp_accounts
              WHERE device_serial = ?
                AND package_name = 'com.whatsapp'
                AND phone_number IS NOT NULL
                AND (phone_number = ? OR phone_number LIKE ? OR ? LIKE '%' || phone_number)
              ORDER BY profile_id ASC LIMIT 1`,
          )
          .get(device, digits, `%${digits}`, digits) as { profile_id: number } | undefined
        return row?.profile_id ?? null
      },
      onJobFinished: (jobId) => this.deliverJobCompletedCallback(jobId),
      onInvalidPhone: this.onInvalidPhoneCb,
      pipedrive: this.pipedrivePublisher ?? undefined,
      pipedriveCacheTtlDays: this.pipedriveCacheTtlDays,
      // Pipeboard generates deal-level Pipedrive activities server-side
      // when running on the REST backend, so skip the Dispatch-side
      // `deal_all_fail` to avoid duplicates. `pasta_summary` is still
      // emitted from Dispatch — Pipeboard does not aggregate it.
      skipPipedriveDealActivity: this.pipeboardBackend === 'rest',
      pendingWritebacks: this.pendingWritebacks,
      // Hygienization mode wiring — DispatchPauseState satisfies ScannerPauseState
      // structurally so we can pass it directly. When omitted, the scanner
      // logs a warning and runs without pausing global sends.
      pauseState: this.pauseState,
      hygienizationOperator: this.hygienizationOperator,
    })

    ctx.registerRoute('GET',  '/health',     this.handleHealth.bind(this))
    ctx.registerRoute('GET',  '/stats',         this.handleStats.bind(this))
    ctx.registerRoute('GET',  '/stats/pool',    this.handleStatsPool.bind(this))
    ctx.registerRoute('GET',  '/stats/global',  this.handleStatsGlobal.bind(this))
    ctx.registerRoute('POST', '/scan',       this.handleStartScan.bind(this))
    ctx.registerRoute('GET',  '/scan/:id',   this.handleGetJob.bind(this))
    ctx.registerRoute('POST', '/scan/:id/cancel', this.handleCancelJob.bind(this))
    ctx.registerRoute('GET',  '/jobs',       this.handleListJobs.bind(this))
    ctx.registerRoute('GET',  '/deals',      this.handleListDeals.bind(this))
    ctx.registerRoute('GET',  '/deals/:pasta/:deal_id/:contato_tipo/:contato_id', this.handleGetDeal.bind(this))
    ctx.registerRoute('POST', '/probe',      this.handleProbePhone.bind(this))

    // Plugin-scoped Pipedrive operator API. Routes mount under
    // /api/v1/plugins/adb-precheck/pipedrive/* (the loader prefixes the
    // plugin namespace automatically). Health endpoint always works so the
    // UI can render a "disabled" empty state when the token is absent.
    registerPipedrivePluginRoutes(ctx, {
      store: this.pipedriveActivityStore,
      client: this.pipedriveClient,
      publisher: this.pipedrivePublisher,
      companyDomain: this.pipedriveCompanyDomain,
      cacheTtlDays: this.pipedriveCacheTtlDays,
      baseUrl: process.env.PIPEDRIVE_BASE_URL,
    })

    ctx.logger.info('ADB pre-check plugin initialized')
  }

  async destroy(): Promise<void> {
    if (this.pastaLockReapTimer) {
      clearInterval(this.pastaLockReapTimer)
      this.pastaLockReapTimer = null
    }
    if (this.pipedrivePublisher) {
      try { await this.pipedrivePublisher.flush() }
      catch (e) {
        this.ctx?.logger.warn('Pipedrive publisher flush failed during destroy', {
          error: e instanceof Error ? e.message : String(e),
        })
      }
    }
    this.pendingWritebacks?.stopDrain()
    await this.pg.close()
    this.ctx?.logger.info('ADB pre-check plugin destroyed')
    this.ctx = null
  }

  /**
   * Fire-and-forget `precheck_completed` callback to the plugin's webhook URL.
   * HMAC-signed (same scheme as Oralsin callbacks). Best-effort: a failure
   * only logs, it does not fail the scan job. Re-delivery on failure is not
   * implemented yet (scope for v0.2 — would reuse `failed_callbacks` table).
   */
  private async deliverJobCompletedCallback(jobId: string): Promise<void> {
    if (!this.webhookUrl) return
    const job = this.store.getJob(jobId)
    if (!job) return
    const body = {
      event: 'precheck_completed' as const,
      plugin: this.name,
      plugin_version: this.version,
      job_id: job.id,
      external_ref: (this.store as unknown as { db: { prepare: (s: string) => { get: (...a: unknown[]) => { external_ref: string | null } | undefined } } })
        .db.prepare('SELECT external_ref FROM adb_precheck_jobs WHERE id = ?').get(jobId)?.external_ref ?? null,
      status: job.status,
      summary: {
        total_deals: job.total_deals,
        scanned_deals: job.scanned_deals,
        total_phones: job.total_phones,
        valid_phones: job.valid_phones,
        invalid_phones: job.invalid_phones,
        error_phones: job.error_phones,
        cache_hits: job.cache_hits,
      },
      started_at: job.started_at,
      finished_at: job.finished_at,
      deals_url: `/api/v1/plugins/${this.name}/deals?limit=500`,
      last_error: job.last_error,
    }
    const payload = JSON.stringify(body)
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.hmacSecret) {
      const sig = createHmac('sha256', this.hmacSecret).update(payload).digest('hex')
      headers['X-Dispatch-Signature'] = `sha256=${sig}`
      headers['X-Dispatch-Plugin'] = this.name
      headers['X-Dispatch-Event'] = 'precheck_completed'
    }
    try {
      const res = await fetch(this.webhookUrl, { method: 'POST', headers, body: payload })
      if (!res.ok) {
        this.ctx?.logger.warn('precheck_completed callback non-2xx', { jobId, status: res.status })
      } else {
        this.ctx?.logger.info('precheck_completed callback delivered', { jobId })
      }
    } catch (e) {
      this.ctx?.logger.warn('precheck_completed callback failed', { jobId, error: e instanceof Error ? e.message : String(e) })
    }
  }

  // ── Route Handlers (typed loosely; Fastify injects the real shape) ──

  private async handleHealth(_req: unknown, reply: unknown): Promise<unknown> {
    const r = await this.pg.healthcheck()
    return (reply as { send: (x: unknown) => unknown }).send(r)
  }

  private async handleStats(_req: unknown, reply: unknown): Promise<unknown> {
    return (reply as { send: (x: unknown) => unknown }).send(this.store.aggregateStats())
  }

  /**
   * Combined coverage view ("Visão Geral global"). One round-trip for
   * the UI to render the top-of-page panel: how big is the pool, how
   * many deals/phones have we covered, how many are still pending,
   * how big is the cache, and a rough phones-per-deal multiplier so
   * the operator can size the next batch ("limit=100 → ≈480 phones →
   * ≈32 min at observed rate").
   *
   * Pool size comes from Pipeboard (`countPool`); when the REST
   * backend reports `-1` (intentional — Pipeboard's ADR 0002 omits
   * COUNT for performance) we surface `pool_total: null` so the UI
   * shows the deal/phone totals without faking a denominator.
   */
  private async handleStatsGlobal(req: unknown, reply: unknown): Promise<unknown> {
    const r = reply as {
      status: (c: number) => { send: (x: unknown) => unknown }
      send: (x: unknown) => unknown
    }
    const query = (req as { query?: { recheck_after_days?: string | number } }).query ?? {}
    const defaultRecheckDays = Number(process.env.PLUGIN_ADB_PRECHECK_DEFAULT_RECHECK_AFTER_DAYS ?? 30)
    const recheckAfterDays = query.recheck_after_days !== undefined
      ? Number(query.recheck_after_days)
      : defaultRecheckDays
    if (!Number.isFinite(recheckAfterDays) || recheckAfterDays < 0) {
      return r.status(400).send({ error: 'invalid_recheck_after_days' })
    }

    let poolTotal: number | null
    let poolError: string | null = null
    let poolUnsupported = false
    try {
      const v = await this.pg.countPool({})
      if (v < 0) {
        poolTotal = null
        poolUnsupported = true
      } else {
        poolTotal = v
      }
    } catch (e) {
      poolTotal = null
      poolError = e instanceof Error ? e.message : String(e)
    }

    const thresholdIso = new Date(Date.now() - recheckAfterDays * 86_400_000).toISOString()
    const { fresh, total: scannedTotal } = this.store.countScannedSince(thresholdIso)
    const stale = Math.max(0, scannedTotal - fresh)
    const dealsPending = poolTotal !== null ? Math.max(0, poolTotal - fresh) : null
    const dealsCoveragePct =
      poolTotal !== null && poolTotal > 0 ? (scannedTotal / poolTotal) * 100 : null

    const dealAgg = this.store.aggregateStats()
    const phoneAgg = this.store.aggregatePhoneStats()

    // wa_contact_checks lives in the shared registry; query directly
    // since the plugin already owns this DB.
    let cacheFresh = 0
    let cacheTotal = 0
    try {
      const cacheRow = (this.db
        .prepare(
          `SELECT COUNT(*) AS total,
                  COALESCE(SUM(CASE WHEN checked_at >= ? THEN 1 ELSE 0 END),0) AS fresh
             FROM wa_contact_checks`,
        )
        .get(thresholdIso) as { total: number; fresh: number } | undefined) ?? { total: 0, fresh: 0 }
      cacheTotal = cacheRow.total
      cacheFresh = cacheRow.fresh
    } catch {
      // wa_contact_checks may not exist in legacy DBs — leave zero.
    }

    // Phones-per-deal observed across the lifetime of completed scans.
    // Used by the UI to extrapolate `phones_estimated_in_pool` so the
    // operator can plan batches without manual math. Marked
    // `_estimated` because the source is sampling, not authoritative.
    const phonesPerDealAvg =
      dealAgg.deals_scanned > 0
        ? phoneAgg.phones_checked / dealAgg.deals_scanned
        : null
    const phonesEstimatedInPool =
      poolTotal !== null && phonesPerDealAvg !== null
        ? Math.round(poolTotal * phonesPerDealAvg)
        : null
    const phonesEstimatedRemaining =
      dealsPending !== null && phonesPerDealAvg !== null
        ? Math.round(dealsPending * phonesPerDealAvg)
        : null

    return r.status(200).send({
      recheck_after_days: recheckAfterDays,
      threshold_iso: thresholdIso,

      pool: {
        deals_total: poolTotal,
        unsupported: poolUnsupported,
        error: poolError,
      },
      deals: {
        scanned: scannedTotal,
        fresh,
        stale,
        pending: dealsPending,
        coverage_percent:
          dealsCoveragePct !== null ? Number(dealsCoveragePct.toFixed(2)) : null,
        with_valid: dealAgg.deals_with_valid,
        all_invalid: dealAgg.deals_all_invalid,
      },
      phones: {
        checked: phoneAgg.phones_checked,
        valid: phoneAgg.phones_valid,
        invalid: phoneAgg.phones_invalid,
        error: phoneAgg.phones_error,
        per_deal_avg:
          phonesPerDealAvg !== null ? Number(phonesPerDealAvg.toFixed(2)) : null,
        estimated_in_pool: phonesEstimatedInPool,
        estimated_remaining: phonesEstimatedRemaining,
      },
      cache: {
        fresh: cacheFresh,
        total: cacheTotal,
        stale: Math.max(0, cacheTotal - cacheFresh),
      },
      last_scan_at: dealAgg.last_scan_at,
    })
  }

  /**
   * Operator-facing pool inventory: how many deals are in the upstream pool
   * (Pipeboard PG), how many we've already covered, how many are still fresh
   * within the recheck window, and how many are due for re-scan. Helps answer
   * "is the scanner stuck or just waiting on input?" without trawling logs.
   */
  private async handleStatsPool(req: unknown, reply: unknown): Promise<unknown> {
    const r = reply as { status: (c: number) => { send: (x: unknown) => unknown }; send: (x: unknown) => unknown }
    const query = (req as { query?: { recheck_after_days?: string | number } }).query ?? {}
    const defaultRecheckDays = Number(process.env.PLUGIN_ADB_PRECHECK_DEFAULT_RECHECK_AFTER_DAYS ?? 30)
    const recheckAfterDays = query.recheck_after_days !== undefined
      ? Number(query.recheck_after_days)
      : defaultRecheckDays
    if (!Number.isFinite(recheckAfterDays) || recheckAfterDays < 0) {
      return r.status(400).send({ error: 'invalid_recheck_after_days' })
    }

    let poolTotal: number | null
    let poolError: string | null = null
    let poolUnsupported = false
    try {
      const v = await this.pg.countPool({})
      // PipeboardRest returns -1 when COUNT is not exposed by the
      // backend (the REST contract intentionally omits it for
      // performance — see ADR 0002). Treat that as "unknown" exactly
      // like a thrown error, so derived metrics (pending, coverage)
      // collapse to null instead of producing negative values.
      if (v < 0) {
        poolTotal = null
        poolUnsupported = true
      } else {
        poolTotal = v
      }
    } catch (e) {
      poolTotal = null
      poolError = e instanceof Error ? e.message : String(e)
    }

    const thresholdIso = new Date(Date.now() - recheckAfterDays * 86_400_000).toISOString()
    const { fresh, total: scannedTotal } = this.store.countScannedSince(thresholdIso)
    const stale = Math.max(0, scannedTotal - fresh)
    const pending = poolTotal !== null ? Math.max(0, poolTotal - fresh) : null
    const coveragePercent =
      poolTotal !== null && poolTotal > 0 ? (scannedTotal / poolTotal) * 100 : null

    return r.status(200).send({
      recheck_after_days: recheckAfterDays,
      threshold_iso: thresholdIso,
      pool_total: poolTotal,
      pool_error: poolError,
      pool_unsupported: poolUnsupported,
      scanned_total: scannedTotal,
      fresh_count: fresh,
      stale_count: stale,
      pending_count: pending,
      coverage_percent: coveragePercent !== null ? Number(coveragePercent.toFixed(2)) : null,
    })
  }

  private async handleStartScan(req: unknown, reply: unknown): Promise<unknown> {
    const r = reply as { status: (c: number) => { send: (x: unknown) => unknown } }
    const parsed = scanParamsSchema.safeParse((req as { body: unknown }).body ?? {})
    if (!parsed.success) {
      return r.status(400).send({ error: 'Invalid params', issues: parsed.error.issues })
    }
    const { external_ref, ...rawParams } = parsed.data

    // Resolve the per-job Pipedrive flag.
    //   - Default (undefined): enabled iff PIPEDRIVE_API_TOKEN was configured.
    //   - Explicit true: honoured if integration is wired; otherwise we log
    //     a warning and silently downgrade to false (matches the documented
    //     "warn + skip" contract).
    //   - Explicit false: always honoured.
    const integrationWired = this.pipedriveClient !== null
    let pipedriveEnabled: boolean
    if (rawParams.pipedrive_enabled === undefined) {
      pipedriveEnabled = integrationWired
    } else if (rawParams.pipedrive_enabled === true && !integrationWired) {
      this.ctx?.logger.warn(
        'Scan requested with pipedrive_enabled=true but PIPEDRIVE_API_TOKEN is not configured — Pipedrive intents will be skipped',
        { external_ref },
      )
      pipedriveEnabled = false
    } else {
      pipedriveEnabled = rawParams.pipedrive_enabled
    }

    // Materialise the resolved flag back onto params so it lands in
    // params_json (operators can audit exactly what was decided).
    const hygienizationMode = rawParams.hygienization_mode === true

    // Default freshness window: when the caller omits `recheck_after_days`,
    // treat scans as incremental (skip deals scanned in the last N days). The
    // env knob lets operators override globally; pass an explicit value (incl.
    // 0 for force-rescan-all) to bypass. Without this default, the scanner
    // re-iterates the same first-page deals every run — every cache hit
    // counts toward `limit`, so a 10-deal budget is exhausted by the same
    // 10 already-validated deals forever.
    const defaultRecheckDays = Number(process.env.PLUGIN_ADB_PRECHECK_DEFAULT_RECHECK_AFTER_DAYS ?? 30)
    const recheckAfterDays = rawParams.recheck_after_days ?? defaultRecheckDays
    const params = {
      ...rawParams,
      recheck_after_days: recheckAfterDays,
      pipedrive_enabled: pipedriveEnabled,
      hygienization_mode: hygienizationMode,
    }
    const job = this.store.createJob(params, external_ref, { pipedriveEnabled, hygienizationMode })
    if (job.status === 'queued') {
      // Fire-and-forget; progress visible via GET /scan/:id
      void this.scanner!.runJob(job.id, params).catch(() => {
        // scanner already logged + marked failed
      })
    }
    return r.status(job.status === 'queued' ? 201 : 200).send(job)
  }

  private async handleGetJob(req: unknown, reply: unknown): Promise<unknown> {
    const { id } = (req as { params: { id: string } }).params
    const job = this.store.getJob(id)
    const r = reply as { status: (c: number) => { send: (x: unknown) => unknown } }
    if (!job) return r.status(404).send({ error: 'Job not found' })
    return (reply as { send: (x: unknown) => unknown }).send(job)
  }

  private async handleCancelJob(req: unknown, reply: unknown): Promise<unknown> {
    const { id } = (req as { params: { id: string } }).params
    this.store.requestCancel(id)
    return (reply as { send: (x: unknown) => unknown }).send({ ok: true })
  }

  private async handleListJobs(req: unknown, reply: unknown): Promise<unknown> {
    const limit = Number((req as { query: { limit?: string } }).query?.limit ?? 20)
    return (reply as { send: (x: unknown) => unknown }).send(this.store.listJobs(limit))
  }

  private async handleListDeals(req: unknown, reply: unknown): Promise<unknown> {
    // Pagination over cached per-deal results. Filter on valid/invalid/all.
    const q = (req as { query: Record<string, string | undefined> }).query ?? {}
    const limit = Math.min(Math.max(Number(q.limit ?? 50), 1), 500)
    const offset = Math.max(Number(q.offset ?? 0), 0)
    const filter = q.filter === 'valid' ? 'valid_count > 0'
      : q.filter === 'invalid' ? 'valid_count = 0'
      : '1=1'
    const stmt = this.db.prepare(
      `SELECT pasta, deal_id, contato_tipo, contato_id,
              valid_count, invalid_count, primary_valid_phone,
              scanned_at, last_job_id
       FROM adb_precheck_deals
       WHERE ${filter}
       ORDER BY scanned_at DESC
       LIMIT ? OFFSET ?`,
    )
    const rows = stmt.all(limit, offset)
    const totalRow = this.db
      .prepare(`SELECT COUNT(*) AS n FROM adb_precheck_deals WHERE ${filter}`)
      .get() as { n: number }
    return (reply as { send: (x: unknown) => unknown }).send({
      data: rows,
      total: totalRow.n,
    })
  }

  /**
   * Diagnostic: validate a single phone through the same L1→L3→L2 pipeline the
   * scanner uses, without touching Pipeboard or the job store. Shared cache
   * (wa_contacts/wa_contact_checks) IS written, by design — this is how the
   * registry gets primed incrementally.
   */
  private async handleProbePhone(req: unknown, reply: unknown): Promise<unknown> {
    const r = reply as { status: (c: number) => { send: (x: unknown) => unknown } }
    const body = (req as { body: unknown }).body as { phone?: unknown } | null
    const phone = typeof body?.phone === 'string' ? body.phone : null
    if (!phone || !/^\+?\d{8,20}$/.test(phone)) {
      return r.status(400).send({ error: 'phone (8-20 digits, optional +) required' })
    }
    const started = Date.now()
    try {
      const result = await this.validator.validate(phone, {
        triggered_by: 'manual',
        useWahaTiebreaker: true,
        device_serial: this.defaultDeviceSerial,
        waha_session: this.defaultWahaSession,
      })
      return (reply as { send: (x: unknown) => unknown }).send({
        phone_input: phone,
        phone_normalized: result.phone_normalized,
        exists_on_wa: result.exists_on_wa,
        source: result.source,
        confidence: result.confidence,
        from_cache: result.from_cache,
        wa_chat_id: result.wa_chat_id,
        attempts: result.attempts,
        total_latency_ms: Date.now() - started,
      })
    } catch (e) {
      return r.status(400).send({
        error: e instanceof Error ? e.message : String(e),
        phone_input: phone,
      })
    }
  }

  private async handleGetDeal(req: unknown, reply: unknown): Promise<unknown> {
    const p = (req as { params: { pasta: string; deal_id: string; contato_tipo: string; contato_id: string } }).params
    const row = this.db
      .prepare(
        `SELECT * FROM adb_precheck_deals
         WHERE pasta = ? AND deal_id = ? AND contato_tipo = ? AND contato_id = ?`,
      )
      .get(p.pasta, Number(p.deal_id), p.contato_tipo, Number(p.contato_id))
    const r = reply as { status: (c: number) => { send: (x: unknown) => unknown } }
    if (!row) return r.status(404).send({ error: 'Deal not scanned yet' })
    return (reply as { send: (x: unknown) => unknown }).send(row)
  }
}
