import type Database from 'better-sqlite3'
import { createHmac } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import type { ContactRegistry } from '../contacts/contact-registry.js'
import type { AdbShellAdapter } from '../monitor/types.js'
import { checkDeviceReady } from '../adb/device-health.js'
import type { WahaApiClient } from '../waha/types.js'
import type { DispatchPauseState } from '../engine/dispatch-pause-state.js'
import { ContactValidator } from '../validator/contact-validator.js'
import {
  AdbProbeStrategy,
  CacheOnlyStrategy,
  WahaCheckStrategy,
} from '../check-strategies/index.js'
import type { DispatchPlugin, PluginContext } from './types.js'
import type { GeoViewDefinition } from '../geo/types.js'
import { PastaLockManager } from '../locks/index.js'
import { ProbeSnapshotWriter } from '../snapshots/probe-snapshot-writer.js'
import { listSnapshotFiles } from '../snapshots/list.js'
import type { DispatchEventName } from '../events/index.js'
import type { DispatchEmitter } from '../events/dispatch-emitter.js'
import {
  PipeboardPg,
  PipeboardRest,
  PipeboardRawRest,
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
import { TenantRegistry, type TenantId } from './adb-precheck/tenant-registry.js'

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
    /**
     * Selects which tenant's Pipeboard client + scanner pair to use.
     * Defaults to 'adb' (back-compat). Validated against the configured
     * tenant registry — unknown tenants get a 400 from the handler.
     */
    tenant: z.enum(['adb', 'sicoob', 'oralsin']).optional(),
    /**
     * Override the Pipeboard pipeline scoped for this scan only. When
     * supplied, an ad-hoc PipeboardRawRest + PrecheckScanner is built
     * for the lifetime of this job so the cached maps are not polluted.
     * Only meaningful for raw-mode tenants (sicoob / oralsin) — the adb
     * tenant does not filter by pipeline_id. Must be a positive integer.
     */
    pipeline_id: z.number().int().positive().optional(),
    /**
     * Override the Pipeboard stage scoped for this scan only. Pairs
     * with `pipeline_id`. Ignored for prov-mode tenants.
     */
    stage_id: z.number().int().positive().optional(),
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
  manifest: import('./manifest.js').PluginManifest = {
    name: 'adb-precheck',
    version: '0.1.0',
    sdkVersion: '^1.0.0',
    description: 'WhatsApp number validation via ADB probe + Pipeboard reconciliation for hygienization workflows',
    author: 'DEBT',
  }
  events: DispatchEventName[] = []
  webhookUrl: string

  private ctx: PluginContext | null = null
  // T22: per-tenant client + scanner. Built in init() from TenantRegistry.
  // The 'adb' entry preserves the legacy single-tenant behaviour byte-for-
  // byte; raw tenants (sicoob/oralsin) get a PipeboardRawRest client.
  private pgByTenant = new Map<TenantId, IPipeboardClient>()
  private scannerByTenant = new Map<TenantId, PrecheckScanner>()
  private pipeboardBackend: PipeboardBackend = 'sql'
  private pendingWritebacks: PendingWritebacks | null = null
  private store: PrecheckJobStore
  private validator: ContactValidator
  // Strategy refs kept so init() can rebuild the validator with a
  // mutex-aware AdbProbeStrategy without rewiring everything else.
  private cacheStrategy!: CacheOnlyStrategy
  private wahaStrategy!: WahaCheckStrategy
  private defaultDeviceSerial: string | undefined
  private defaultWahaSession: string | undefined
  private hmacSecret: string | undefined
  private readonly onInvalidPhoneCb: ((phone: string) => void) | undefined

  private pipedriveClient: PipedriveClient | null = null
  private pipedrivePublisher: PipedrivePublisher | null = null
  private pipedriveActivityStore: PipedriveActivityStore | null = null
  /**
   * T23: per-tenant PipedrivePublisher map. Built in init() once we have the
   * pastaLocks + activity store + tenant registry wired. The legacy
   * `pipedrivePublisher` field is preserved and now points at the 'adb'
   * tenant's publisher so the read-only plugin routes
   * (`/plugins/adb-precheck/pipedrive/*`) keep working without refactor.
   */
  private pipedriveByTenant = new Map<TenantId, PipedrivePublisher>()
  private readonly pipedriveCacheTtlDays: number | undefined
  private readonly pipedriveCompanyDomain: string | null
  private readonly pauseState: DispatchPauseState | undefined
  private readonly hygienizationOperator: string
  private pastaLocks: PastaLockManager | null = null
  private pastaLockReapTimer: NodeJS.Timeout | null = null
  private snapshotWriter: ProbeSnapshotWriter
  private tenantRegistry: TenantRegistry | undefined
  // Stashed for late-bound client construction in init(). The adb tenant
  // still honours the legacy unsuffixed env vars via these fields; raw
  // tenants pull their own credentials from TenantRegistry.
  private readonly adbBackend: PipeboardBackend
  private readonly adbRestTimeoutMs: number | undefined
  private readonly adbPgConnectionString: string | undefined
  private readonly adbPgMaxConnections: number
  // T23: stashed for per-tenant PipedriveClient construction in init(). The
  // tenant registry carries each tenant's apiToken + companyDomain, and the
  // rate/burst/emitter knobs are shared across tenants (same Pipedrive
  // workspace contention regardless of which tenant initiated the publish).
  private readonly pipedriveRatePerSec: number | undefined
  private readonly pipedriveBurst: number | undefined
  private readonly pipedriveBaseUrl: string | undefined
  private readonly emitter: DispatchEmitter | undefined

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
      /**
       * Pre-built TenantRegistry to serve from GET /tenants. When omitted,
       * the handler falls back to TenantRegistry.fromEnv() at request time.
       * Injected in server.ts (T9); tests and legacy instantiations can omit.
       */
      tenantRegistry?: TenantRegistry
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
    // Validate adb-tenant credentials up-front (back-compat: existing
    // deployments throw at boot exactly when they did before T22). The
    // raw-tenant credentials are validated by TenantRegistry.fromEnv()
    // when init() builds them.
    if (backend === 'rest') {
      if (!opts.restBaseUrl || !opts.restApiKey) {
        throw new Error(
          'adb-precheck: backend=rest requires restBaseUrl and restApiKey',
        )
      }
    }
    this.adbBackend = backend
    this.adbRestTimeoutMs = opts.restTimeoutMs
    this.adbPgConnectionString = opts.pgConnectionString
    this.adbPgMaxConnections = opts.pgMaxConnections ?? 4
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
    this.tenantRegistry = opts.tenantRegistry
    // T23: stash for per-tenant PipedriveClient construction in init().
    this.pipedriveRatePerSec = opts.pipedrive?.ratePerSec
    this.pipedriveBurst = opts.pipedrive?.burst
    this.pipedriveBaseUrl = opts.pipedrive?.baseUrl
    this.emitter = opts.emitter

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
    // T23: activity store is shared across tenants — every (tenant, dedup_key)
    // pair lives in the same table. Initialised before the per-tenant publisher
    // loop below so each tenant's PipedrivePublisher can wire it up directly.
    // Stays null when no tenant has Pipedrive configured (scanner is a no-op
    // for Pipedrive intents in that case).
    if (this.pipedriveClient) {
      this.pipedriveActivityStore = new PipedriveActivityStore(this.db)
      this.pipedriveActivityStore.initialize()
      ctx.logger.info('Pipedrive integration enabled', {
        companyDomain: this.pipedriveCompanyDomain ?? '(unset — links disabled)',
      })
    }
    // T22: build one IPipeboardClient + one PrecheckScanner per configured
    // tenant. The legacy 'adb' path still routes through PipeboardRest /
    // PipeboardPg using the unsuffixed env vars (TenantRegistry.fromEnv()
    // already reads them); raw tenants get PipeboardRawRest. The shared
    // pendingWritebacks / pipedrivePublisher are wired to every scanner —
    // raw scanners ignore the writeback path (T21) so a single buffer
    // pointed at the adb client is sufficient for the production scope.
    const tenantRegistry = this.tenantRegistry ?? TenantRegistry.fromEnv()
    for (const tc of tenantRegistry.list()) {
      let client: IPipeboardClient
      if (tc.mode === 'prov') {
        // adb tenant — legacy backend selection preserved byte-for-byte.
        if (this.adbBackend === 'rest') {
          client = new PipeboardRest({
            baseUrl: tc.restBaseUrl,
            apiKey: tc.restApiKey,
            timeoutMs: tc.restTimeoutMs ?? this.adbRestTimeoutMs,
          })
        } else {
          // Postgres backend is supported only for the legacy adb tenant.
          if (tc.id !== 'adb') {
            throw new Error(
              `tenant ${tc.id}: postgres backend not supported for non-adb tenants — set BACKEND=rest`,
            )
          }
          if (!this.adbPgConnectionString) {
            throw new Error(
              'adb-precheck: BACKEND=sql requires pgConnectionString for the adb tenant',
            )
          }
          client = new PipeboardPg(this.adbPgConnectionString, this.adbPgMaxConnections)
        }
      } else {
        // Raw mode (sicoob / oralsin) — Pipeboard exposes /precheck-raw.
        if (!tc.defaultPipelineId) {
          throw new Error(`tenant ${tc.id}: missing PIPELINE_ID for raw mode`)
        }
        client = new PipeboardRawRest({
          baseUrl: tc.restBaseUrl,
          apiKey: tc.restApiKey,
          pipelineId: tc.defaultPipelineId,
          stageId: tc.defaultStageId,
          timeoutMs: tc.restTimeoutMs,
        })
      }
      this.pgByTenant.set(tc.id, client)
    }

    // Fail-closed buffer for retryable Pipeboard failures. Always
    // wired — the SQL backend rarely fails in a retryable way, but
    // when it does (network blip on the SSH tunnel, transient PG)
    // queueing locally is the safe choice. For BACKEND=rest this is
    // the *only* safe path: a SQL fallback would be silently zeroed
    // by Pipeboard's blocklist trigger.
    //
    // T22 transitional: pointed at the adb client. Raw-mode scanners
    // short-circuit before touching this buffer (scanner.ts checks
    // tenantMode === 'raw'), so a single instance suffices.
    const adbClient = this.pgByTenant.get('adb')
    if (!adbClient) {
      throw new Error('adb-precheck: tenant registry must include adb')
    }
    this.pendingWritebacks = new PendingWritebacks(this.db, {
      client: adbClient,
      logger: ctx.logger,
    })
    this.pendingWritebacks.initialize()
    this.pendingWritebacks.startDrain()

    // T23: build one PipedrivePublisher per tenant. Each tenant carries its
    // own Pipedrive workspace token + company domain via TenantConfig, so
    // every publisher gets its own PipedriveClient instance. The shared
    // activity store + pasta locks live across tenants because dedup +
    // pasta concurrency are global concerns regardless of who initiated
    // the publish.
    //
    // Tenants without `pipedrive.apiToken` configured don't get a publisher —
    // their scanner runs without Pipedrive (intents are simply not emitted).
    // The legacy `this.pipedrivePublisher` field is kept in sync with the
    // 'adb' publisher so the read-only Pipedrive plugin routes
    // (`/plugins/adb-precheck/pipedrive/*`) keep working without refactor.
    if (this.pipedriveActivityStore) {
      for (const tc of tenantRegistry.list()) {
        if (!tc.pipedrive?.apiToken) continue
        // adb tenant reuses the constructor-built client (preserves
        // single-tenant rate-bucket behaviour byte-for-byte); other tenants
        // get a fresh client built from their TenantConfig credentials.
        const client =
          tc.id === 'adb' && this.pipedriveClient
            ? this.pipedriveClient
            : new PipedriveClient({
                apiToken: tc.pipedrive.apiToken,
                baseUrl: this.pipedriveBaseUrl,
                ratePerSec: this.pipedriveRatePerSec,
                burst: this.pipedriveBurst,
                emitter: this.emitter,
              })
        const publisher = new PipedrivePublisher(
          client,
          ctx.logger,
          this.pipedriveActivityStore,
          tc.pipedrive.companyDomain ?? null,
          undefined, // idempotencyWindowMs uses default
          this.pastaLocks ?? undefined,
          tc.id,
          tc.label,
        )
        this.pipedriveByTenant.set(tc.id, publisher)
      }
      // Back-compat: legacy field points at the adb tenant's publisher.
      // The read-only plugin routes (`/plugins/adb-precheck/pipedrive/*`)
      // only surface adb-tenant data so this is safe.
      this.pipedrivePublisher = this.pipedriveByTenant.get('adb') ?? null
    }

    for (const tc of tenantRegistry.list()) {
      const client = this.pgByTenant.get(tc.id)!
      const scanner = new PrecheckScanner({
        pg: client,
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
        // T23: each scanner gets its tenant's PipedrivePublisher. Tenants
        // without an apiToken configured pass undefined and the scanner
        // skips Pipedrive intents entirely. The publishers are independent
        // instances so the in-memory `seenDedupKeys` Set is naturally
        // tenant-scoped, and each persists rows with its own `tenant`
        // value so the partial UNIQUE INDEX on (tenant, dedup_key)
        // enforces cross-restart idempotency without cross-tenant
        // collisions.
        pipedrive: this.pipedriveByTenant.get(tc.id) ?? undefined,
        pipedriveCacheTtlDays: this.pipedriveCacheTtlDays,
        // Pipeboard generates deal-level Pipedrive activities server-side
        // when running on the REST backend, so skip the Dispatch-side
        // `deal_all_fail` to avoid duplicates. `pasta_summary` is still
        // emitted from Dispatch — Pipeboard does not aggregate it.
        skipPipedriveDealActivity: this.pipeboardBackend === 'rest',
        pendingWritebacks: this.pendingWritebacks,
        // Hygienization mode pauses global ADB sends. Only meaningful
        // for the adb tenant — raw tenants don't share a device with
        // production sends, so we leave pauseState undefined for them
        // to avoid unrelated tenants flipping the global breaker.
        pauseState: tc.mode === 'prov' ? this.pauseState : undefined,
        hygienizationOperator: this.hygienizationOperator,
        locks: this.pastaLocks ?? undefined,
        // Reactive device-failure recovery: scanner runs `checkDeviceReady`
        // after 3 consecutive probe throws and waits up to 30min (exp
        // backoff capped at 2min) for the device to come back. The shell
        // adapter is the same one the L3 probe uses so the check shares
        // its timeout and connection behaviour.
        adbShell: this.adb,
        appPackage: 'com.whatsapp',
        tenant: tc.id,
        tenantMode: tc.mode,
      })
      this.scannerByTenant.set(tc.id, scanner)
    }

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
    ctx.registerRoute('POST', '/retry-errors', this.handleRetryErrors.bind(this))
    ctx.registerRoute('GET',  '/notes/:pasta/history', this.handleNoteHistory.bind(this))
    ctx.registerRoute('GET',  '/admin/locks',           this.handleListLocks.bind(this))
    ctx.registerRoute('GET',  '/admin/probe-snapshots', this.handleListSnapshots.bind(this))
    ctx.registerRoute('GET',  '/tenants',               this.handleListTenants.bind(this))
    ctx.registerRoute('GET',  '/devices/availability',  this.handleDeviceAvailability.bind(this))

    // Geo views — heatmap by DDD. Plugin contributes 3 cohort views:
    //  - no-match: WA checks that returned 'not_exists' (distinct phones)
    //  - valid:    WA checks that confirmed existence (distinct phones)
    //  - pipedrive-mapped: every phone in the Pipeboard pool (upstream)
    // T22: geo views are still scoped to the adb tenant. Per-tenant geo
    // (sicoob / oralsin) is out of scope here and lives in a later task.
    // adbClient was already validated above, but the type-narrowed local
    // is asserted again for the geo-view closure.
    const adbPgForGeo = adbClient
    for (const view of buildAdbPrecheckGeoViews(this.db, adbPgForGeo)) {
      ctx.registerGeoView(view)
    }
    // Pre-warm the Pipeboard DDD aggregation cache so the first geo-tab
    // load doesn't block waiting for the full pool to iterate. Fire-and-
    // forget — failures degrade gracefully (view falls back to local).
    if (typeof adbPgForGeo.aggregatePhoneDddDistribution === 'function') {
      void adbPgForGeo.aggregatePhoneDddDistribution().catch((err) => {
        ctx.logger.warn('Geo: Pipeboard DDD prewarm failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }

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
    // T23: flush every per-tenant publisher. Sequential rather than parallel
    // so a slow tenant doesn't starve a fast one — drain order does not
    // matter because publishers are independent.
    for (const [tenantId, publisher] of this.pipedriveByTenant.entries()) {
      try { await publisher.flush() }
      catch (e) {
        this.ctx?.logger.warn('Pipedrive publisher flush failed during destroy', {
          tenant: tenantId,
          error: e instanceof Error ? e.message : String(e),
        })
      }
    }
    this.pipedriveByTenant.clear()
    this.pendingWritebacks?.stopDrain()
    for (const [tenantId, pg] of this.pgByTenant.entries()) {
      try {
        await pg.close()
      } catch (e) {
        this.ctx?.logger.warn('pg close failed', {
          tenant: tenantId,
          error: e instanceof Error ? e.message : String(e),
        })
      }
    }
    this.pgByTenant.clear()
    this.scannerByTenant.clear()
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
    const tenant = job.tenant ?? 'adb'
    const body = {
      event: 'precheck_completed' as const,
      plugin: this.name,
      plugin_version: this.version,
      job_id: job.id,
      external_ref: (this.store as unknown as { db: { prepare: (s: string) => { get: (...a: unknown[]) => { external_ref: string | null } | undefined } } })
        .db.prepare('SELECT external_ref FROM adb_precheck_jobs WHERE id = ?').get(jobId)?.external_ref ?? null,
      status: job.status,
      tenant,
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
    headers['X-Dispatch-Tenant'] = tenant
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

  private async handleHealth(req: unknown, reply: unknown): Promise<unknown> {
    const pg = this.resolvePgFromQuery(req)
    const r = await pg.healthcheck()
    return (reply as { send: (x: unknown) => unknown }).send(r)
  }

  /**
   * T22: per-tenant resolver helper used by read-only route handlers. Reads
   * `?tenant=` from the query, falls back to 'adb' so unsuffixed callers
   * preserve the legacy single-tenant behaviour byte-for-byte.
   */
  private resolvePgFromQuery(req: unknown): IPipeboardClient {
    const q = (req as { query?: { tenant?: string } } | undefined)?.query
    const raw = q?.tenant?.toLowerCase()
    const id: TenantId = raw === 'sicoob' || raw === 'oralsin' ? raw : 'adb'
    return this.pgByTenant.get(id) ?? this.pgByTenant.get('adb')!
  }

  private async handleListTenants(_req: unknown, reply: unknown): Promise<unknown> {
    const r = reply as { send: (x: unknown) => unknown }
    const list = (this.tenantRegistry ?? TenantRegistry.fromEnv()).list().map((t) => ({
      id: t.id,
      label: t.label,
      mode: t.mode,
      defaultPipelineId: t.defaultPipelineId,
      defaultStageId: t.defaultStageId,
      writeback: t.writeback,
      pipedriveEnabled: Boolean(t.pipedrive?.apiToken),
    }))
    return r.send({ tenants: list })
  }

  /**
   * T7: surface device availability for the multi-tenant precheck UI.
   * Returns one row per connected device with current holder context when
   * the DeviceMutex is busy. Degrades gracefully when DeviceManager isn't
   * wired (unit-test fixtures) — empty list.
   */
  private async handleDeviceAvailability(_req: unknown, reply: unknown): Promise<unknown> {
    const r = reply as { send: (x: unknown) => unknown }
    const list = this.ctx?.listConnectedDevices ? await this.ctx.listConnectedDevices() : []
    const mutex = this.ctx?.deviceMutex
    const devices = list.map((d) => {
      const holder = mutex?.describeHolder ? mutex.describeHolder(d.serial) : null
      if (holder) {
        return { serial: d.serial, available: false, tenant: holder.tenant, job_id: holder.jobId, since: holder.since }
      }
      return { serial: d.serial, available: true }
    })
    return r.send({ devices })
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

    const pg = this.resolvePgFromQuery(req)
    let poolTotal: number | null
    let poolError: string | null = null
    let poolUnsupported = false
    try {
      const v = await pg.countPool({})
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
    const dealAgg = this.store.aggregateStats()
    // Bucket math with tombstoned excluded from live coverage:
    //   scannedTotal = fresh (live + window) + stale (live + outside window) + tombstoned
    //   poolTotal already excludes tombstoned (they're gone from prov_consultas)
    //   liveScanned = fresh + stale  → what we still cover today
    //   pending = poolTotal − liveScanned
    const tombstoned = dealAgg.deals_tombstoned
    const stale = Math.max(0, scannedTotal - fresh - tombstoned)
    const liveScanned = fresh + stale
    const dealsPending = poolTotal !== null ? Math.max(0, poolTotal - liveScanned) : null
    const dealsCoveragePct =
      poolTotal !== null && poolTotal > 0 ? (liveScanned / poolTotal) * 100 : null
    // Truth-set: derived from adb_precheck_deals.phones_json (current state),
    // NOT from SUM(adb_precheck_jobs.*) which inflates with retry passes.
    const phoneAgg = this.store.aggregatePhoneStatsTruth()

    // wa_contact_checks lives in the shared registry; query directly
    // since the plugin already owns this DB. Count DISTINCT phones —
    // the cache stores one row per (phone, attempt_phase) and ratios
    // of ~2 rows/phone are normal once retries run, so a raw COUNT(*)
    // would also overstate cache coverage.
    let cacheFresh = 0
    let cacheTotal = 0
    try {
      const cacheRow = (this.db
        .prepare(
          `SELECT COUNT(DISTINCT phone_normalized) AS total,
                  COUNT(DISTINCT CASE WHEN checked_at >= ? THEN phone_normalized END) AS fresh
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
        tombstoned: dealAgg.deals_tombstoned,
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

    const pg = this.resolvePgFromQuery(req)
    let poolTotal: number | null
    let poolError: string | null = null
    let poolUnsupported = false
    try {
      const v = await pg.countPool({})
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
    // Pre-flight device readiness — fail fast (503) when the device that
    // would receive the L3 probe is offline / booting / WA not running.
    // Without this the scanner still creates the job, burns its first 3
    // phones marking each `error`, then enters the recovery loop and
    // typically fails ~30min later. A 503 here lets the operator fix the
    // device (replug, unlock, restart WA) and retry immediately.
    //
    // Skipped when no device is wired (legacy callers / unit tests).
    const effectiveSerial = rawParams.device_serial ?? this.defaultDeviceSerial
    if (effectiveSerial && this.ctx?.deviceMutex?.isHeld(effectiveSerial)) {
      const h = this.ctx.deviceMutex.describeHolder(effectiveSerial)
      return r.status(409).send(
        h
          ? { error: 'device_busy', serial: effectiveSerial, tenant: h.tenant, job_id: h.jobId, since: h.since }
          : { error: 'device_busy', serial: effectiveSerial },
      )
    }
    if (effectiveSerial) {
      const ready = await checkDeviceReady(this.adb, effectiveSerial, { appPackage: 'com.whatsapp' })
      if (!ready.ok) {
        this.ctx?.logger.warn('scan rejected: device not ready', {
          serial: effectiveSerial, reason: ready.reason, detail: ready.detail,
        })
        return r.status(503).send({
          error: 'device_not_ready',
          reason: ready.reason,
          detail: ready.detail,
          serial: effectiveSerial,
        })
      }
    }

    // T22: resolve the per-tenant scanner. Default to 'adb' for back-compat;
    // unknown tenants short-circuit with a 400 so misconfigured clients get
    // an actionable error instead of running against the wrong Pipeboard
    // schema.
    const tenantId: TenantId = (rawParams.tenant ?? 'adb') as TenantId
    if (!this.scannerByTenant.has(tenantId)) {
      return r.status(400).send({ error: 'tenant_not_configured', tenant: tenantId })
    }

    // T25: resolve pipeline_id / stage_id overrides. For raw-mode tenants the
    // caller may pass these to target a different pipeline or stage than the
    // env-configured defaults. When they differ from the cached config we build
    // an ad-hoc PipeboardRawRest + PrecheckScanner for THIS scan only so the
    // shared maps are never mutated mid-flight.
    const tc = (this.tenantRegistry ?? TenantRegistry.fromEnv()).get(tenantId)
    const pipelineId = rawParams.pipeline_id ?? tc.defaultPipelineId
    const stageId = rawParams.stage_id ?? tc.defaultStageId

    if (tc.mode === 'raw' && !pipelineId) {
      return r.status(400).send({
        error: 'pipeline_id_required_for_raw_tenant',
        tenant: tc.id,
        hint: `Set PLUGIN_ADB_PRECHECK_PIPELINE_ID_${tc.id.toUpperCase()} env var or pass pipeline_id in the scan body.`,
      })
    }

    let scanScanner: PrecheckScanner = this.scannerByTenant.get(tenantId)!

    if (
      tc.mode === 'raw' &&
      (pipelineId !== tc.defaultPipelineId || stageId !== tc.defaultStageId)
    ) {
      // Ad-hoc client + scanner: scoped to this request only. All deps
      // are re-used from the plugin instance so no init overhead is paid.
      const scanClient = new PipeboardRawRest({
        baseUrl: tc.restBaseUrl,
        apiKey: tc.restApiKey,
        pipelineId: pipelineId!,
        stageId,
        timeoutMs: tc.restTimeoutMs,
      })
      const logger = this.ctx!.logger
      scanScanner = new PrecheckScanner({
        pg: scanClient,
        store: this.store,
        validator: this.validator,
        logger,
        shouldCancel: (jobId) => this.store.isCancelRequested(jobId),
        deviceSerial: this.defaultDeviceSerial,
        wahaSession: this.defaultWahaSession,
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
        pipedrive: this.pipedriveByTenant.get(tc.id) ?? undefined,
        pipedriveCacheTtlDays: this.pipedriveCacheTtlDays,
        skipPipedriveDealActivity: this.pipeboardBackend === 'rest',
        pendingWritebacks: this.pendingWritebacks ?? undefined,
        pauseState: undefined, // raw tenants don't own the global pause breaker
        hygienizationOperator: this.hygienizationOperator,
        locks: this.pastaLocks ?? undefined,
        adbShell: this.adb,
        appPackage: 'com.whatsapp',
        tenant: tc.id,
        tenantMode: tc.mode,
      })
    }

    const job = this.store.createJob(params, external_ref, {
      pipedriveEnabled,
      hygienizationMode,
      tenant: tenantId,
    })
    if (job.status === 'queued') {
      // Fire-and-forget; progress visible via GET /scan/:id
      void scanScanner.runJob(job.id, params).catch(() => {
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

    // Augment the response with retry stats, UI state distribution, and snapshot
    // counts. These are computed on demand from the audit tables — no caching.
    const retry_stats = this.store.getRetryStats(id)
    const ui_state_distribution = this.store.getUiStateDistribution(id)
    const snapshots_captured = this.store.getSnapshotsCaptured(id)

    return (reply as { send: (x: unknown) => unknown }).send({
      ...job,
      retry_stats,
      ui_state_distribution,
      snapshots_captured,
    })
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
    // Pagination over cached per-deal results.
    //
    // Filter semantics (aligned with aggregateStats):
    //   all          no filter — includes tombstoned (audit view)
    //   valid        LIVE (deleted_at IS NULL) AND valid_count > 0
    //   invalid      LIVE AND valid_count = 0 AND invalid_count > 0
    //                — zero-phone deals are NOT included; they sit outside
    //                  the "all invalid" semantic ("nenhum telefone
    //                  WhatsApp" means tried-and-failed, not never-tried).
    //   tombstoned   deleted_at IS NOT NULL — rows Pipeboard's ETL removed
    //                upstream after we scanned them.
    const q = (req as { query: Record<string, string | undefined> }).query ?? {}
    const limit = Math.min(Math.max(Number(q.limit ?? 50), 1), 500)
    const offset = Math.max(Number(q.offset ?? 0), 0)
    let where: string
    switch (q.filter) {
      case 'valid':
        where = 'deleted_at IS NULL AND valid_count > 0'
        break
      case 'invalid':
        where = 'deleted_at IS NULL AND valid_count = 0 AND invalid_count > 0'
        break
      case 'tombstoned':
        where = 'deleted_at IS NOT NULL'
        break
      default:
        where = '1=1' // all
        break
    }
    const stmt = this.db.prepare(
      `SELECT pasta, deal_id, contato_tipo, contato_id,
              valid_count, invalid_count, primary_valid_phone,
              scanned_at, last_job_id, deleted_at
       FROM adb_precheck_deals
       WHERE ${where}
       ORDER BY COALESCE(deleted_at, scanned_at) DESC
       LIMIT ? OFFSET ?`,
    )
    const rows = stmt.all(limit, offset)
    const totalRow = this.db
      .prepare(`SELECT COUNT(*) AS n FROM adb_precheck_deals WHERE ${where}`)
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

  /**
   * POST /retry-errors
   *
   * Manual sweep entrypoint (Level 3 / Task E1). Re-validates phones with
   * outcome='error' from prior scan jobs. Returns 202 immediately with
   * { job_id, deals_planned, status }; caller polls GET /scan/:id for progress.
   * Optional body: { pasta, since_iso, max_deals, dry_run }.
   */
  private async handleRetryErrors(req: unknown, reply: unknown): Promise<unknown> {
    const r = reply as { code: (n: number) => { send: (x: unknown) => unknown } }
    const body = ((req as { body?: unknown }).body ?? {}) as {
      pasta?: string
      since_iso?: string
      max_deals?: number
      dry_run?: boolean
      tenant?: string
    }
    // T22: tenant resolution mirrors handleStartScan — default 'adb',
    // 400 on unknown.
    const rawTenant = body.tenant?.toLowerCase()
    const tenantId: TenantId =
      rawTenant === 'sicoob' || rawTenant === 'oralsin' || rawTenant === 'adb'
        ? (rawTenant as TenantId)
        : 'adb'
    if (body.tenant !== undefined && !this.scannerByTenant.has(tenantId)) {
      return r.code(400).send({ error: 'tenant_not_configured', tenant: body.tenant })
    }
    const scanner = this.scannerByTenant.get(tenantId)
    if (!scanner) {
      return r.code(503).send({ error: 'scanner_not_ready' })
    }
    try {
      const result = await scanner.runRetryErrorsJob({
        pasta: body.pasta ?? null,
        since_iso: body.since_iso,
        max_deals: body.max_deals,
        dry_run: body.dry_run,
      })
      return r.code(202).send(result)
    } catch (e: unknown) {
      if (e !== null && typeof e === 'object' && 'constructor' in e && (e as { constructor?: { name?: string } }).constructor?.name === 'ScanInProgressError') {
        const err = e as { pasta?: string; current?: unknown }
        return r.code(409).send({
          error: 'scan_in_progress',
          pasta: err.pasta,
          current: err.current,
        })
      }
      throw e
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

  /**
   * GET /notes/:pasta/history
   *
   * Returns the full chronological revision chain of pasta_summary notes for
   * a given pasta, joined with the originating job's triggered_by so the
   * caller can attribute each revision (manual scan, retry-errors-sweep, etc.).
   *
   * Returns 503 when the Pipedrive integration is not configured
   * (PIPEDRIVE_API_TOKEN unset — activity store was never wired).
   */
  private async handleNoteHistory(req: unknown, reply: unknown): Promise<unknown> {
    const { pasta } = (req as { params: { pasta: string } }).params
    const r = reply as {
      status: (c: number) => { send: (x: unknown) => unknown }
      send: (x: unknown) => unknown
    }
    if (!this.pipedriveActivityStore) {
      return r.status(503).send({ error: 'pipedrive_disabled' })
    }
    const revisions = this.pipedriveActivityStore.listPastaNoteRevisions(pasta)
    const current = this.pipedriveActivityStore.findCurrentPastaNote(pasta)
    return r.send({
      pasta,
      current_pipedrive_id: current?.pipedrive_response_id ?? null,
      revisions,
    })
  }

  private async handleListLocks(_req: unknown, reply: unknown): Promise<unknown> {
    const r = reply as { send: (x: unknown) => unknown }
    return r.send({ locks: this.pastaLocks?.listAll() ?? [] })
  }

  private async handleListSnapshots(req: unknown, reply: unknown): Promise<unknown> {
    const q = ((req as { query?: Record<string, string | undefined> }).query ?? {})
    const since = q.since
    const state = q.state
    const baseDir = join(process.env.DATA_DIR ?? 'data', 'probe-snapshots')
    const snapshots = listSnapshotFiles(baseDir, { since, state })
    return (reply as { send: (x: unknown) => unknown }).send({ snapshots })
  }
}

// ── Geo Views (Geolocalização tab) ──

/**
 * Build the adb-precheck geographic views. Three cohort heatmaps by DDD:
 *  1. no-match — hygiene_job_items status='invalid' (number found absent on WhatsApp)
 *  2. valid    — wa_contact_checks result='exists' (number confirmed present)
 *  3. pipedrive-mapped — live deals reconciled with Pipedrive (deleted_at IS NULL)
 *
 * Views 1-2 use phone_normalized (12 digits, with 55) so DDD = chars 3-4.
 * View 3 uses primary_valid_phone (11 digits, no 55) so DDD = chars 1-2.
 */
export function buildAdbPrecheckGeoViews(
  db: Database.Database,
  pipeboardClient?: { aggregatePhoneDddDistribution?(): Promise<Record<string, number>> },
): GeoViewDefinition[] {
  const windowFilter = {
    type: 'window' as const,
    id: 'window',
    defaultValue: '7d' as const,
    options: ['24h', '7d', '30d', 'all'] as const,
  }

  // Helper: build a wa_contact_checks-based cohort view. `result` is the
  // outcome value to filter by. Counts are DISTINCT phone_normalized so
  // re-checks of the same number don't inflate the heatmap.
  const cohortView = (
    id: string,
    label: string,
    description: string,
    resultValue: 'exists' | 'not_exists',
    dateLabel: string,
  ): GeoViewDefinition => ({
    id, label, description,
    group: 'adb-precheck',
    palette: 'sequential',
    filters: [{ ...windowFilter, options: [...windowFilter.options] }],
    aggregate: async (params) => {
      const since = windowToIso(params.window)
      const rows = db.prepare(`
        SELECT substr(phone_normalized, 3, 2) AS ddd,
               COUNT(DISTINCT phone_normalized) AS count
        FROM wa_contact_checks
        WHERE result = ? AND checked_at >= ?
        GROUP BY ddd
      `).all(resultValue, since) as Array<{ ddd: string; count: number }>
      const buckets: Record<string, number> = {}
      for (const r of rows) if (r.ddd) buckets[r.ddd] = r.count
      return { buckets, total: rows.reduce((s, r) => s + r.count, 0), generatedAt: new Date().toISOString() }
    },
    drill: async (ddd, params) => {
      const since = windowToIso(params.window)
      const pageSize = params.pageSize ?? 50
      const offset = ((params.page ?? 1) - 1) * pageSize
      // DISTINCT phone with latest check timestamp — so a phone re-checked
      // 5 times appears once with the most recent date.
      const rows = db.prepare(`
        SELECT phone_normalized AS phone, MAX(checked_at) AS last_check
        FROM wa_contact_checks
        WHERE result = ? AND checked_at >= ?
          AND substr(phone_normalized, 3, 2) = ?
        GROUP BY phone_normalized
        ORDER BY last_check DESC
        LIMIT ? OFFSET ?
      `).all(resultValue, since, ddd, pageSize, offset)
      const total = (db.prepare(`
        SELECT COUNT(DISTINCT phone_normalized) AS c FROM wa_contact_checks
        WHERE result = ? AND checked_at >= ?
          AND substr(phone_normalized, 3, 2) = ?
      `).get(resultValue, since, ddd) as { c: number }).c
      return {
        columns: [
          { key: 'phone', label: 'Telefone', type: 'phone' },
          { key: 'last_check', label: dateLabel, type: 'date' },
        ],
        rows: rows as Array<Record<string, unknown>>,
        total, page: params.page ?? 1, pageSize,
      }
    },
  })

  const noMatch = cohortView(
    'adb-precheck.no-match',
    'Não existentes',
    'DDDs com mais números que NÃO existem no WhatsApp (telefones únicos, última checagem)',
    'not_exists',
    'Verificado em',
  )

  const validView = cohortView(
    'adb-precheck.valid',
    'Validados',
    'DDDs com mais números validados como existentes no WhatsApp (telefones únicos)',
    'exists',
    'Validado em',
  )

  // SQL fragment that extracts DDD from a JSON phone object. The phone is
  // stored as 12-13 digits with leading 55. Strip the 55 prefix when present.
  const dddFromJsonPhone = `
    substr(
      CASE
        WHEN length(json_extract(p.value, '$.normalized')) >= 12
             AND substr(json_extract(p.value, '$.normalized'), 1, 2) = '55'
        THEN substr(json_extract(p.value, '$.normalized'), 3)
        ELSE json_extract(p.value, '$.normalized')
      END,
      1, 2)
  `

  const pipedriveMappedView: GeoViewDefinition = {
    id: 'adb-precheck.pipedrive-mapped',
    label: 'Mapeados no Pipedrive',
    description: 'Todos os telefones do pool Pipeboard upstream (5.689 deals × ~4.6 phones cada) — estado global',
    group: 'adb-precheck',
    palette: 'sequential',
    filters: [],
    aggregate: async () => {
      // Preferred: query Pipeboard upstream directly so the heatmap
      // reflects the ENTIRE pool, including pending deals not yet
      // scanned by Dispatch.
      if (pipeboardClient?.aggregatePhoneDddDistribution) {
        try {
          const buckets = await pipeboardClient.aggregatePhoneDddDistribution()
          const total = Object.values(buckets).reduce((s, v) => s + v, 0)
          return { buckets, total, generatedAt: new Date().toISOString() }
        } catch (err) {
          // Fall through to local fallback rather than failing the view.
          // eslint-disable-next-line no-console
          console.warn('[geo] Pipeboard pool aggregate failed, falling back to local:', err)
        }
      }
      // Fallback: phones inside locally-scanned deals only. Best-effort
      // when Pipeboard upstream is unreachable or the backend doesn't
      // support the aggregation primitive (REST).
      const rows = db.prepare(`
        SELECT ${dddFromJsonPhone} AS ddd, COUNT(*) AS count
        FROM adb_precheck_deals d, json_each(d.phones_json) p
        WHERE d.deleted_at IS NULL
          AND json_extract(p.value, '$.normalized') IS NOT NULL
        GROUP BY ddd
      `).all() as Array<{ ddd: string; count: number }>
      const buckets: Record<string, number> = {}
      for (const r of rows) if (r.ddd) buckets[r.ddd] = r.count
      return { buckets, total: rows.reduce((s, r) => s + r.count, 0), generatedAt: new Date().toISOString() }
    },
    drill: async (ddd, params) => {
      const pageSize = params.pageSize ?? 50
      const offset = ((params.page ?? 1) - 1) * pageSize
      const rows = db.prepare(`
        SELECT d.pasta, d.deal_id, d.contato_tipo, d.contato_id,
               json_extract(p.value, '$.normalized') AS phone,
               json_extract(p.value, '$.column')     AS phone_column,
               json_extract(p.value, '$.outcome')    AS outcome,
               d.scanned_at
        FROM adb_precheck_deals d, json_each(d.phones_json) p
        WHERE d.deleted_at IS NULL
          AND json_extract(p.value, '$.normalized') IS NOT NULL
          AND ${dddFromJsonPhone} = ?
        ORDER BY d.scanned_at DESC
        LIMIT ? OFFSET ?
      `).all(ddd, pageSize, offset)
      const total = (db.prepare(`
        SELECT COUNT(*) AS c
        FROM adb_precheck_deals d, json_each(d.phones_json) p
        WHERE d.deleted_at IS NULL
          AND json_extract(p.value, '$.normalized') IS NOT NULL
          AND ${dddFromJsonPhone} = ?
      `).get(ddd) as { c: number }).c
      return {
        columns: [
          { key: 'deal_id', label: 'Deal ID', type: 'number' },
          { key: 'pasta', label: 'Pasta', type: 'string' },
          { key: 'phone_column', label: 'Coluna', type: 'string' },
          { key: 'phone', label: 'Telefone', type: 'phone' },
          { key: 'outcome', label: 'Outcome', type: 'string' },
          { key: 'scanned_at', label: 'Scaneado em', type: 'date' },
        ],
        rows: rows as Array<Record<string, unknown>>,
        total, page: params.page ?? 1, pageSize,
      }
    },
  }

  return [noMatch, validView, pipedriveMappedView]
}

function windowToIso(window: '24h' | '7d' | '30d' | 'all'): string {
  if (window === 'all') return '1970-01-01T00:00:00.000Z'
  const ms = window === '24h' ? 24 * 60 * 60 * 1000
           : window === '7d'  ? 7  * 24 * 60 * 60 * 1000
           :                    30 * 24 * 60 * 60 * 1000
  return new Date(Date.now() - ms).toISOString()
}
