import { readdir, unlink, stat } from 'node:fs/promises'
import { timingSafeEqual, createHmac } from 'node:crypto'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import fastifyRateLimit from '@fastify/rate-limit'
import Database from 'better-sqlite3'
import { Server as SocketIOServer } from 'socket.io'
import { MessageQueue, IdempotencyCache } from './queue/index.js'
import { AdbBridge } from './adb/index.js'
import { SendEngine, SendStrategy, SenderMapping, ReceiptTracker, AccountMutex, WahaFallback, SenderHealth, SenderScoring, WorkerOrchestrator, EventRecorder, SendWindow, SenderWarmup, DeviceCircuitBreaker, ContactCache, OptOutDetector, MediaSender } from './engine/index.js'
import { DispatchPauseState, type PauseScope } from './engine/dispatch-pause-state.js'
import { DispatchEmitter } from './events/index.js'
import { buildCorsOrigins, registerApiAuth, registerAuthLogin, registerAuthRefresh, RefreshTokenStore, registerMessageRoutes, registerDeviceRoutes, registerMonitorRoutes, registerWahaRoutes, registerSessionRoutes, registerMetricsRoutes, registerAuditRoutes, registerBulkActionRoutes, registerSenderMappingRoutes, registerPluginOralsinRoutes, registerScreenshotRoutes, registerTraceRoutes, registerSenderRoutes, registerBlacklistRoutes, registerContactRoutes, registerHygieneRoutes, registerMessageTimelineRoutes, registerAdminMessageRoutes, registerInsightsHeatmapRoutes, registerAckRateRoutes, registerFleetRoutes } from './api/index.js'
import { ChipRegistry } from './fleet/index.js'
import { HygieneLog, AutoHygiene } from './devices/index.js'
import { registerAnomalyRoutes, registerChanged24hRoutes } from './insights/index.js'
import { verifyJwt } from './api/jwt.js'
import { ContactRegistry } from './contacts/index.js'
import { HygieneJobService } from './hygiene/index.js'
import { DeviceManager, HealthCollector, WaAccountMapper, AlertSystem } from './monitor/index.js'
import { SessionManager, WebhookHandler, MessageHistory, AckHistory } from './waha/index.js'
import { createWahaHttpClient } from './waha/waha-http-client.js'
import { createChatwootHttpClient, ManagedSessions, InboxAutomation } from './chatwoot/index.js'
import { PluginRegistry, PluginEventBus, CallbackDelivery, PluginLoader } from './plugins/index.js'
import { buildLoggerConfig } from './config/logger.js'
import { GracefulShutdown } from './config/graceful-shutdown.js'
import { HotReloadCoordinator } from './config/hot-reload.js'
import { RateLimitGuard } from './config/rate-limits.js'
import { parseConfig } from './config/config-schema.js'
import { AuditLogger } from './config/audit-logger.js'
import { ScreenshotPolicy } from './config/screenshot-policy.js'
import { metricsRegistry, messagesSentTotal, messagesFailedTotal, messagesQueuedTotal, sendDurationSeconds, interMessageDelaySeconds, queueDepth, devicesOnline, senderDailyCount, quarantineEventsTotal, senderQuarantined, callbacksTotal, pluginErrorsTotal, queueDepthByPlugin, wahaAckTotal, wahaAckPersistFailedTotal } from './config/metrics.js'
import {
  sendCriticalAlert,
  alertCircuitOpened,
  alertNumberInvalid,
  alertHighFailureRate,
  alertDispatchPaused,
  alertDispatchResumed,
} from './alerts/notifier.js'
import { OralsinPlugin } from './plugins/oralsin-plugin.js'
import { AdbPrecheckPlugin } from './plugins/adb-precheck-plugin.js'
import { AdbProbeStrategy, WahaCheckStrategy, CacheOnlyStrategy } from './check-strategies/index.js'
import { ContactValidator } from './validator/contact-validator.js'
import type { DispatchEventName } from './events/index.js'
import type { DispatchPlugin, PluginRecord } from './plugins/types.js'
import { BanPredictionDaemon, type SerialResolver, type ThresholdProvider } from './research/ban-prediction-daemon.js'
import { AckRateThresholds } from './research/ack-rate-thresholds.js'
import { AckPersistFailures } from './waha/ack-persist-failures.js'

export interface DispatchCore {
  server: ReturnType<typeof Fastify>
  io: SocketIOServer
  queue: MessageQueue
  adb: AdbBridge
  engine: SendEngine
  emitter: DispatchEmitter
  shutdown: GracefulShutdown
}

export async function createServer(port = Number(process.env.PORT) || 7890): Promise<DispatchCore> {
  // Validate all env vars upfront — crash fast on misconfiguration
  const config = parseConfig(process.env as Record<string, string | undefined>)
  void config // TODO: incrementally migrate process.env reads to use config

  const loggerConfig = buildLoggerConfig(process.env.NODE_ENV, process.env.LOG_FILE)
  const server = Fastify({
    logger: loggerConfig,
    bodyLimit: 1_048_576, // S8: 1MB body limit
  })
  const corsOrigins = buildCorsOrigins(process.env.DISPATCH_ALLOWED_ORIGINS)
  await server.register(cors, { origin: corsOrigins })

  // Task 11.1: Fastify-level rate limiting (global: false — opt-in per route).
  // Tailscale Funnel masks source IPs; extract real IP from X-Forwarded-For.
  await server.register(fastifyRateLimit, {
    global: false,
    max: 60,
    timeWindow: '1 minute',
    keyGenerator: (req) => {
      const xff = (req.headers['x-forwarded-for'] as string | undefined)
        ?.split(',')[0]
        ?.trim()
      return xff ?? req.ip
    },
  })

  // Capture raw body alongside JSON parsing so plugin route HMAC verification
  // can hash the exact bytes the client signed (instead of round-tripping JSON
  // and risking key-order/whitespace divergence between client and server).
  // Behaviour-equivalent to the default JSON parser otherwise.
  server.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    ;(req as unknown as { rawBody: string }).rawBody = body as string
    if (typeof body !== 'string' || body.length === 0) {
      done(null, undefined)
      return
    }
    try {
      const json = JSON.parse(body) as unknown
      done(null, json)
    } catch (err) {
      done(err as Error, undefined)
    }
  })

  // API Auth — must be registered before routes.
  // Accepts X-API-Key (service-to-service) and/or Authorization: Bearer JWT
  // (UI login). Both gates are optional; absence of both = dev mode.
  const dispatchApiKey = process.env.DISPATCH_API_KEY
  const dispatchJwtSecret = process.env.DISPATCH_JWT_SECRET
  registerApiAuth(server, { apiKey: dispatchApiKey, jwtSecret: dispatchJwtSecret })

  const db = new Database(process.env.DB_PATH || 'dispatch.db')
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  db.pragma('wal_autocheckpoint = 400')

  // Login + refresh routes (public): only mounted when full credential triplet
  // is set. Otherwise the app boots in "open" mode for local development.
  // Task 3.4: 15min access JWT + 24h refresh token rotation. Refresh tokens
  // are opaque (random hex), stored as sha256 hashes in `refresh_tokens`.
  const authUser = process.env.DISPATCH_AUTH_USER
  const authPassword = process.env.DISPATCH_AUTH_PASSWORD
  if (authUser && authPassword && dispatchJwtSecret) {
    const refreshTokenStore = new RefreshTokenStore(db)
    // Task 11.1: 5 login attempts per IP per minute (brute-force protection).
    registerAuthLogin(server, {
      username: authUser,
      password: authPassword,
      jwtSecret: dispatchJwtSecret,
      refreshTokenStore,
      rateLimitConfig: { max: 5, timeWindow: '1 minute' },
    })
    // Task 11.1: 60 refresh attempts per IP per minute.
    registerAuthRefresh(server, {
      username: authUser,
      jwtSecret: dispatchJwtSecret,
      store: refreshTokenStore,
      rateLimitConfig: { max: 60, timeWindow: '1 minute' },
    })
  }

  const queue = new MessageQueue(db)
  queue.initialize()

  // Task 4.3: Idempotency cache — time-bounded dedupe window for plugin enqueue
  const idempotencyCache = new IdempotencyCache(db, {
    defaultTtlSec: Number(process.env.IDEMPOTENCY_CACHE_TTL_SEC) || 3600,
  })
  idempotencyCache.initialize()

  // Phase 9: Contact Registry + Hygiene
  const contactRegistry = new ContactRegistry(db)
  contactRegistry.initialize()
  const hygieneJobService = new HygieneJobService(db)
  hygieneJobService.initialize()

  // Fleet (Phase 3 of anti-ban roadmap): internal SIM-card cost tracking.
  // Schema is idempotent — safe to call on pre-existing databases.
  const chipRegistry = new ChipRegistry(db)
  chipRegistry.initialize()

  // Hygiene audit log — every hygienize run (manual + auto) writes here.
  const hygieneLog = new HygieneLog(db)
  hygieneLog.initialize()

  const auditLogger = new AuditLogger(db)

  const adb = new AdbBridge()
  const emitter = new DispatchEmitter()
  const strategy = SendStrategy.fromEnv(process.env as Record<string, string | undefined>)
  const eventRecorder = new EventRecorder(db)
  const screenshotPolicy = ScreenshotPolicy.fromEnv(process.env as Record<string, string | undefined>)
  const contactCache = new ContactCache()
  const optOutDetector = new OptOutDetector()
  const mediaSender = new MediaSender(adb)
  const engine = new SendEngine(adb, queue, emitter, strategy, eventRecorder, screenshotPolicy, contactCache, mediaSender)

  // ── Prometheus metrics collection ──
  emitter.on('message:sent', (data) => {
    messagesSentTotal.inc({
      sender: data.senderNumber ?? 'unknown',
      method: data.strategyMethod ?? 'unknown',
      app_package: data.appPackage ?? 'unknown',
    })
    sendDurationSeconds.observe(
      { method: data.strategyMethod ?? 'unknown' },
      data.durationMs / 1000,
    )
    if (data.interMessageDelayMs !== undefined && data.interMessageDelayMs > 0) {
      interMessageDelaySeconds.observe(
        { is_first_contact: data.isFirstContact ? 'true' : 'false' },
        data.interMessageDelayMs / 1000,
      )
    }
  })

  emitter.on('message:failed', (data) => {
    messagesFailedTotal.inc({
      sender: data.senderNumber ?? 'unknown',
      error_type: data.attempts !== undefined && data.attempts > 3 ? 'exhausted' : 'transient',
    })
  })

  emitter.on('message:queued', () => {
    messagesQueuedTotal.inc({ plugin: 'direct' })
  })

  emitter.on('sender:quarantined', (data) => {
    quarantineEventsTotal.inc({ sender: data.sender })
    senderQuarantined.set({ sender: data.sender }, 1)
  })

  emitter.on('sender:released', (data) => {
    senderQuarantined.set({ sender: data.sender }, 0)
  })

  // Phase 12 — ack-level Prometheus counter (ADR 0001 ack-rate calibration)
  emitter.on('waha:message_ack', (data) => {
    wahaAckTotal.inc({ ack_level_name: data.ackLevelName })
  })
  emitter.on('waha:ack_persist_failed', () => {
    wahaAckPersistFailedTotal.inc()
  })

  const senderWarmup = new SenderWarmup(db)
  const rateLimitGuard = RateLimitGuard.fromEnv(process.env as Record<string, string | undefined>)
  const senderHealth = new SenderHealth(db, {
    quarantineAfterFailures: Number(process.env.QUARANTINE_AFTER_FAILURES) || 3,
    quarantineDurationMs: Number(process.env.QUARANTINE_DURATION_MS) || 3_600_000,
  }, emitter)

  // Initialize monitor modules
  const deviceManager = new DeviceManager(db, emitter, adb)
  deviceManager.initialize()
  const healthCollector = new HealthCollector(db, adb)
  healthCollector.initialize()
  const waMapper = new WaAccountMapper(db, adb)
  waMapper.initialize()
  const alertSystem = new AlertSystem(db, emitter)
  alertSystem.initialize()

  // Auto-hygiene: run hygienizeDevice() on device:connected when due (TTL).
  // Manual REST endpoint also writes to the same log table.
  const autoHygiene = new AutoHygiene(
    { emitter, adb, hygieneLog, logger: server.log as unknown as { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void; error: (o: object, m?: string) => void } },
    {
      enabled: (process.env.DISPATCH_AUTO_HYGIENE_ENABLED ?? 'true') !== 'false',
      ttlDays: Number(process.env.DISPATCH_AUTO_HYGIENE_DAYS) || 14,
      aggressive: (process.env.DISPATCH_HYGIENE_AGGRESSIVE ?? 'false') === 'true',
    },
  )

  // Initialize WAHA modules (Phase 4)
  const messageHistory = new MessageHistory(db)
  messageHistory.initialize()

  // Phase 12 — ack-rate calibration persistence (replaces Frida path; ADR 0001)
  const ackHistory = new AckHistory(db, messageHistory)
  ackHistory.initialize()
  const ackRateThresholds = new AckRateThresholds(db)
  ackRateThresholds.initialize()
  const ackPersistFailures = new AckPersistFailures(db)
  ackPersistFailures.initialize()

  const wahaApiUrl = process.env.WAHA_API_URL
  const wahaApiKey = process.env.WAHA_API_KEY
  // WebhookHandler works without WAHA client (receives webhooks regardless)
  const webhookHandler = new WebhookHandler(emitter, messageHistory, ackHistory, {
    hmacSecret: process.env.WAHA_WEBHOOK_HMAC_SECRET,
    queue,
  })

  let sessionManager: SessionManager | null = null
  let inboxAutomation: InboxAutomation | null = null

  // Initialize managed sessions table (always available, even without WAHA/Chatwoot)
  const managedSessions = new ManagedSessions(db)
  managedSessions.initialize()

  if (wahaApiUrl && wahaApiKey) {
    const wahaClient = createWahaHttpClient(wahaApiUrl, wahaApiKey)

    sessionManager = new SessionManager(db, emitter, wahaClient, {
      dispatchWebhookUrl: process.env.DISPATCH_WEBHOOK_URL,
      hmacSecret: process.env.WAHA_WEBHOOK_HMAC_SECRET,
    })
    sessionManager.initialize()

    // Initialize Chatwoot integration (Phase 5)
    const chatwootApiUrl = process.env.CHATWOOT_API_URL
    const chatwootApiToken = process.env.CHATWOOT_API_TOKEN
    const chatwootAccountId = Number(process.env.CHATWOOT_ACCOUNT_ID) || 1

    if (chatwootApiUrl && chatwootApiToken) {
      const chatwootClient = createChatwootHttpClient({
        apiUrl: chatwootApiUrl,
        accountId: chatwootAccountId,
        apiToken: chatwootApiToken,
      })
      inboxAutomation = new InboxAutomation(chatwootClient, wahaClient, managedSessions)
    }
  }

  const serverStartTime = Date.now()

  server.get('/api/v1/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
  }))

  // ── Caddy forward_auth probe — used by /admin/jaeger ingress ──────────────
  // Returns 200 if the bearer token is valid (auth hook already ran), 401
  // otherwise. Caddy's forward_auth directive calls this URL before proxying
  // to Jaeger UI on 127.0.0.1:16686.
  server.get('/api/v1/auth/check-bearer', async (_req, reply) => {
    // If the onRequest auth hook passed control here, the bearer is valid.
    return reply.code(200).send()
  })

  // DP-6: Comprehensive health endpoint for external monitoring
  server.get('/healthz', async () => {
    const devices = deviceManager.getDevices()
    const onlineDevices = devices.filter((d) => d.status === 'online')
    const queueStats = queue.getQueueStats()
    const plugins = pluginRegistry.listPlugins()
    const pluginStatus: Record<string, string> = {}
    for (const p of plugins) {
      pluginStatus[p.name] = p.status
    }

    return {
      status: 'healthy',
      uptime_seconds: Math.floor((Date.now() - serverStartTime) / 1000),
      devices: { online: onlineDevices.length, total: devices.length },
      queue: {
        pending: queueStats.pending,
        processing: queueStats.processing,
        failed_last_hour: queueStats.failedLastHour,
      },
      plugins: pluginStatus,
      failed_callbacks: callbackDelivery.listFailedCallbacks().length,
      pid: process.pid,
    }
  })
  // Prometheus metrics endpoint (unauthenticated — standard for /metrics)
  server.get('/metrics', async (_request, reply) => {
    const metrics = await metricsRegistry.metrics()
    reply.header('content-type', metricsRegistry.contentType)
    return reply.send(metrics)
  })

  registerMessageRoutes(server, queue, emitter)
  registerDeviceRoutes(server, adb, { hygieneLog, autoHygiene })
  registerMonitorRoutes(server, { adb, engine, deviceManager, healthCollector, waMapper, alertSystem })

  // WAHA routes always registered (webhook receiver works without WAHA client)
  // sessionManager may be null if WAHA_API_URL not configured
  // WAHA routes registered after senderMapping init (see below)

  // Session management routes (Phase 5)
  registerSessionRoutes(server, { inboxAutomation, managedSessions })

  // Metrics routes (Phase 6)
  registerMetricsRoutes(server, db)
  registerAuditRoutes(server, db, auditLogger)
  registerBulkActionRoutes(server, adb)

  // Plugin monitoring routes
  registerPluginOralsinRoutes(server, db)
  registerScreenshotRoutes(server, queue)
  registerMessageTimelineRoutes(server, queue, db)
  registerAdminMessageRoutes(server, queue, auditLogger)
  registerTraceRoutes(server, eventRecorder)
  registerBlacklistRoutes(server, db)

  // Phase 9: Contact Registry + Hygiene
  registerContactRoutes(server, contactRegistry, adb, queue)
  registerHygieneRoutes(server, hygieneJobService)

  // Fleet management (chip cost tracking, Phase 3 anti-ban roadmap).
  registerFleetRoutes(server, { registry: chipRegistry })

  // Phase 9 (P9): Insights endpoints
  registerInsightsHeatmapRoutes(server, db)
  registerAnomalyRoutes(server, db)
  registerChanged24hRoutes(server, db)
  registerAckRateRoutes(server, {
    db,
    thresholds: ackRateThresholds,
    persistFailures: ackPersistFailures,
  })

  // Manual phone number mapping moved to api/devices.ts

  // Reset permanently_failed → queued (manual recovery for lost messages)
  server.post('/api/v1/messages/:id/retry', async (request, reply) => {
    const { id } = request.params as { id: string }
    const message = queue.getById(id)
    if (!message) return reply.status(404).send({ error: 'Message not found' })
    if (message.status !== 'permanently_failed' && message.status !== 'failed') {
      return reply.status(409).send({ error: `Cannot retry message in status: ${message.status}` })
    }
    const updated = queue.requeueForRetry(id)
    emitter.emit('message:queued', { id: updated.id, to: updated.to, priority: updated.priority })
    return { id: updated.id, status: updated.status, attempts: updated.attempts }
  })

  server.post('/api/v1/messages/:id/send', async (request, reply) => {
    const { id } = request.params as { id: string }
    const message = queue.getById(id)

    if (!message) {
      return reply.status(404).send({ error: 'Message not found' })
    }
    if (message.status !== 'queued' && message.status !== 'failed') {
      return reply.status(409).send({ error: `Cannot send message in status: ${message.status}` })
    }
    if (orchestrator.isRunning) {
      return reply.status(409).send({ error: 'Worker is currently sending. Try again shortly.' })
    }

    const devices = await adb.discover()
    const online = devices.find(d => d.type === 'device')
    if (!online) {
      return reply.status(503).send({ error: 'No device available' })
    }

    // Re-queue failed messages, then lock via dequeue to prevent auto-worker collision
    if (message.status === 'failed') {
      queue.updateStatus(id, 'failed', 'queued')
    }
    const locked = queue.dequeue(online.serial)
    if (!locked || locked.id !== id) {
      return reply.status(409).send({ error: 'Message was claimed by another process' })
    }

    try {
      const result = await engine.send(locked, online.serial)
      return { status: 'sent', durationMs: result.durationMs }
    } catch (err) {
      // Set failed status since there's no orchestrator WAHA fallback for manual sends
      try { queue.updateStatus(id, 'sending', 'failed') } catch { /* ignore CAS mismatch */ }
      return reply.status(500).send({
        error: 'Send failed',
        detail: err instanceof Error ? err.message : String(err),
      })
    }
  })

  // ── Receipt Tracker (DP-2) ──
  const receiptTracker = new ReceiptTracker(db, queue, emitter)
  receiptTracker.initialize()

  // ── Smart Sender Scoring (Task 5.2) ──
  const senderScoring = new SenderScoring(senderHealth, db, {
    failurePenalty: Number(process.env.DISPATCH_SCORING_FAILURE_PENALTY) || 1.0,
    idleSaturationSec: Number(process.env.DISPATCH_SCORING_IDLE_SATURATION_SEC) || 3600,
    rolePriorityWeights: {
      primary:  Number(process.env.DISPATCH_SCORING_WEIGHT_PRIMARY)  || 1.0,
      overflow: Number(process.env.DISPATCH_SCORING_WEIGHT_OVERFLOW) || 0.7,
      backup:   Number(process.env.DISPATCH_SCORING_WEIGHT_BACKUP)   || 0.5,
      reserve:  Number(process.env.DISPATCH_SCORING_WEIGHT_RESERVE)  || 0.3,
    },
  })
  senderScoring.initialize()

  // ── Sender Mapping (DP-1) ──
  const senderMapping = new SenderMapping(db, senderScoring, senderHealth)
  senderMapping.initialize()
  registerSenderMappingRoutes(server, senderMapping, auditLogger)
  registerSenderRoutes(server, { senderWarmup, senderMapping, senderHealth, queue, deviceManager })

  // WAHA routes (after senderMapping init — pair endpoint needs it)
  registerWahaRoutes(server, { webhookHandler, sessionManager, messageHistory, adb, senderMapping })

  // ── WAHA Fallback + Account Mutex (DP-3) ──
  const accountMutex = new AccountMutex()
  const wahaFallback = new WahaFallback(senderMapping, queue, fetch, process.env.WAHA_API_KEY)

  // ── Manual circuit breaker (pause state) — global/plugin/sender/device/chain/message ──
  // Hoisted before plugins so adb-precheck's hygienization mode can wire it.
  const pauseState = new DispatchPauseState(db, emitter)
  pauseState.initialize()

  // ── Plugin System (Phase 7) ──
  const pluginRegistry = new PluginRegistry(db)
  pluginRegistry.initialize()
  const pluginEventBus = new PluginEventBus(pluginRegistry, emitter)

  // A3/Decision #20: Wire onError with log + metric
  pluginEventBus.onError((pluginName, event, error) => {
    server.log.error({ plugin: pluginName, event, err: error }, 'Plugin handler error')
    pluginErrorsTotal.inc({ plugin: pluginName, event })
  })

  const callbackDelivery = new CallbackDelivery(db, pluginRegistry, fetch)
  const pinoLogger = { child: (bindings: Record<string, unknown>) => ({ info: server.log.info.bind(server.log), warn: server.log.warn.bind(server.log), error: server.log.error.bind(server.log), debug: server.log.debug.bind(server.log) }) }
  const pluginLoader = new PluginLoader(pluginRegistry, pluginEventBus, queue, db, pinoLogger, senderMapping, engine, idempotencyCache)

  // Load plugins from config
  const pluginNames = (process.env.DISPATCH_PLUGINS || '').split(',').map(s => s.trim()).filter(Boolean)
  const pluginMap: Record<string, () => DispatchPlugin> = {
    oralsin: () => new OralsinPlugin(process.env.PLUGIN_ORALSIN_WEBHOOK_URL || 'http://localhost:8000/api/webhooks/dispatch/'),
    'adb-precheck': () => {
      const pgUrl = process.env.PLUGIN_ADB_PRECHECK_PG_URL
      if (!pgUrl) {
        throw new Error('PLUGIN_ADB_PRECHECK_PG_URL is required when adb-precheck plugin is enabled')
      }
      // Optional WAHA client for L2 tiebreaker — reuse env from core WAHA config.
      const wahaApiUrl = process.env.WAHA_API_URL
      const wahaApiKey = process.env.WAHA_API_KEY
      const wahaClient = wahaApiUrl && wahaApiKey ? createWahaHttpClient(wahaApiUrl, wahaApiKey) : undefined
      // Pipedrive integration — feature-flag implicit: skipped when token absent.
      const pipedriveToken = process.env.PIPEDRIVE_API_TOKEN
      const pipedriveOpts = pipedriveToken ? {
        apiToken: pipedriveToken,
        baseUrl: process.env.PIPEDRIVE_BASE_URL,
        ratePerSec: process.env.PIPEDRIVE_RATE_PER_SEC ? Number(process.env.PIPEDRIVE_RATE_PER_SEC) : undefined,
        burst: process.env.PIPEDRIVE_BURST ? Number(process.env.PIPEDRIVE_BURST) : undefined,
        cacheTtlDays: process.env.PIPEDRIVE_CACHE_TTL_DAYS ? Number(process.env.PIPEDRIVE_CACHE_TTL_DAYS) : undefined,
        companyDomain: process.env.PIPEDRIVE_COMPANY_DOMAIN,
      } : undefined
      const inst = new AdbPrecheckPlugin(
        {
          webhookUrl: process.env.PLUGIN_ADB_PRECHECK_WEBHOOK_URL || '',
          pgConnectionString: pgUrl,
          pgMaxConnections: Number(process.env.PLUGIN_ADB_PRECHECK_PG_MAX || 4),
          defaultDeviceSerial: process.env.PLUGIN_ADB_PRECHECK_DEVICE_SERIAL,
          defaultWahaSession: process.env.PLUGIN_ADB_PRECHECK_WAHA_SESSION,
          hmacSecret: process.env.PLUGIN_ADB_PRECHECK_HMAC_SECRET,
          wahaClient,
          // Task 5.4: record precheck-invalid phones in the central blacklist
          onInvalidPhone: (phone) => queue.recordBan(phone, 'precheck_invalid'),
          pipedrive: pipedriveOpts,
          emitter,
          // Hygienization mode (Part 2): scanner pauses global sends for the
          // lifetime of the job and resumes in finally.
          pauseState,
          hygienizationOperator: 'adb-precheck:hygienization',
        },
        db,
        contactRegistry,
        adb,
      )
      return inst
    },
  }

  // Convert plugin name to env-var token: hyphens to underscores so a plugin
  // called "adb-precheck" maps to PLUGIN_ADB_PRECHECK_*. Without this,
  // hyphenated names silently miss their API_KEY/HMAC vars and the routes
  // end up unauthenticated.
  const envToken = (n: string): string => n.toUpperCase().replace(/-/g, '_')

  for (const name of pluginNames) {
    const factory = pluginMap[name]
    if (!factory) {
      server.log.warn({ plugin: name }, 'Plugin not found in registry, skipping')
      continue
    }
    const plugin = factory()
    const apiKey = process.env[`PLUGIN_${envToken(name)}_API_KEY`] || ''
    const hmacSecret = process.env[`PLUGIN_${envToken(name)}_HMAC_SECRET`] || ''
    try {
      await pluginLoader.loadPlugin(plugin, apiKey, hmacSecret)
      server.log.info({ plugin: name }, 'Plugin loaded')
    } catch (err) {
      server.log.error({ plugin: name, err }, 'Plugin failed to load, skipping')
    }
  }

  // Register plugin routes on Fastify (generic — works for any plugin)
  for (const route of pluginLoader.getRegisteredRoutes()) {
    const record = pluginRegistry.getPlugin(route.pluginName)
    if (!record || record.status !== 'active') continue
    const apiKey = process.env[`PLUGIN_${envToken(route.pluginName)}_API_KEY`] || ''
    const fullPath = `/api/v1/plugins/${route.pluginName}${route.path}`
    const method = route.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete'

    // S7: validate plugin route paths (allows Fastify `:param` syntax)
    if (!/^\/[a-zA-Z0-9/_\-:]*$/.test(route.path)) {
      server.log.error({ plugin: route.pluginName, path: route.path }, 'Invalid plugin route path, skipping')
      continue
    }

    // Per-plugin HMAC config. Opt-in via PLUGIN_<NAME>_HMAC_REQUIRED=true so
    // existing partners can keep working with X-API-Key only while the new
    // signed flow is rolled out gradually.
    const pluginHmacSecret = process.env[`PLUGIN_${envToken(route.pluginName)}_HMAC_SECRET`] || ''
    const pluginHmacRequired = process.env[`PLUGIN_${envToken(route.pluginName)}_HMAC_REQUIRED`] === 'true'

    // Fail-closed: if neither API key nor HMAC is configured for a plugin,
    // its routes would be wide open (the original code skipped the check
    // when apiKey was an empty string). That used to be silent for any
    // plugin whose name contained a hyphen. Refuse to register the route
    // unless we have at least one credential to enforce.
    if (!apiKey && !pluginHmacRequired) {
      server.log.error(
        { plugin: route.pluginName, path: fullPath },
        'Plugin route NOT registered: no PLUGIN_<NAME>_API_KEY configured and HMAC not required',
      )
      continue
    }

    // Task 11.1: per-route rate limit config.
    // /enqueue routes are keyed by API key (service-to-service, 300/min).
    // All other plugin routes fall back to the global default (60/min per IP).
    const isEnqueue = route.path === '/enqueue'
    const routeRateLimit = isEnqueue
      ? {
          max: 300,
          timeWindow: '1 minute' as const,
          keyGenerator: (req: import('fastify').FastifyRequest): string => {
            return (req.headers as Record<string, string>)['x-api-key'] ?? req.ip
          },
        }
      : { max: 60, timeWindow: '1 minute' as const }

    server.route({
      method: method.toUpperCase() as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
      url: fullPath,
      config: { rateLimit: routeRateLimit },
      handler: async (req, reply) => {
      // Auth: Bearer JWT first (logged-in UI session), then X-API-Key.
      // Without the Bearer-first ordering, a UI navigating between plugin
      // tabs would 401 whenever the build-time VITE_API_KEY drifts from
      // the rotated PLUGIN_<NAME>_API_KEY in the .env, which the global
      // window.fetch wrapper turns into an auto-logout. Bearer is the
      // canonical UI credential — we should accept it here too.
      const dispatchJwtSecret = process.env.DISPATCH_JWT_SECRET || ''
      const authHdr = (req.headers as Record<string, string>)['authorization'] ?? ''
      let bearerOk = false
      if (authHdr.startsWith('Bearer ') && dispatchJwtSecret) {
        const token = authHdr.slice(7).trim()
        const verified = verifyJwt(token, dispatchJwtSecret)
        if (!verified.ok) {
          // Bearer presented but invalid — reject explicitly so the UI
          // can auto-logout on { reason: 'expired' | 'bad_signature' | ... }
          return reply.status(401).send({ error: 'Unauthorized', reason: verified.reason })
        }
        bearerOk = true
      }

      // S1/S2: timingSafeEqual auth — only required when Bearer was NOT
      // accepted. Plugin api key remains the canonical service-to-service
      // credential (Oralsin/precheck), but a logged-in operator browsing
      // the UI should not need it.
      if (!bearerOk && apiKey) {
        const providedKey = (req.headers as Record<string, string>)['x-api-key'] ?? ''
        if (providedKey.length !== apiKey.length ||
            !timingSafeEqual(Buffer.from(providedKey), Buffer.from(apiKey))) {
          return reply.status(401).send({ error: 'Invalid API key' })
        }
      }

      // Task 11.2: HMAC verify on body-bearing methods.
      // The signature header is `X-Dispatch-Signature: sha256=<hex_hmac>` and
      // the HMAC is computed over the raw request body (same bytes the client
      // sent). Empty body produces an empty-string HMAC, mirroring how most
      // SDKs behave and avoiding edge cases on GET-style POSTs.
      //
      // PLUGIN_<NAME>_HMAC_REQUIRED=true  → missing/invalid signature → 401
      // PLUGIN_<NAME>_HMAC_REQUIRED=false → missing signature → warning logged
      //   (default false for backward compat until Oralsin client signs requests)
      //
      // To enable: set PLUGIN_ORALSIN_HMAC_REQUIRED=true in .env after the
      // Oralsin Python client has been updated to sign outbound requests.
      const reqMethod = req.method.toUpperCase()
      if (reqMethod === 'POST' || reqMethod === 'PUT' || reqMethod === 'PATCH') {
        const provided = (req.headers as Record<string, string>)['x-dispatch-signature'] ?? ''
        if (pluginHmacRequired) {
          if (!pluginHmacSecret) {
            server.log.error({ plugin: route.pluginName }, 'HMAC required but secret missing')
            return reply.status(500).send({ error: 'Server misconfiguration: HMAC secret missing' })
          }
          const rawBody = (req as unknown as { rawBody?: string }).rawBody ?? ''
          const expected = 'sha256=' + createHmac('sha256', pluginHmacSecret).update(rawBody).digest('hex')
          if (provided.length !== expected.length ||
              !timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) {
            return reply.status(401).send({ error: 'Invalid HMAC signature' })
          }
        } else if (!provided) {
          // Warn when flag is false and signature is absent: helps operators
          // know when to flip PLUGIN_<NAME>_HMAC_REQUIRED=true in production.
          server.log.warn(
            { plugin: route.pluginName, path: fullPath },
            'Request has no X-Dispatch-Signature. Set PLUGIN_<NAME>_HMAC_REQUIRED=true once client is signing.',
          )
        }
      }

      return route.handler(req, reply)
      },
    })
  }

  // ── Pipedrive operator API ─────────────────────────────────────────────
  // Pipedrive routes are registered by the adb-precheck plugin itself via
  // PluginContext.registerRoute, so they live under
  // /api/v1/plugins/adb-precheck/pipedrive/*. The plugin loader applies the
  // same X-API-Key/Bearer auth gate every other plugin route uses.

  // Plugin callback listeners — only when plugins are configured
  if (pluginNames.length > 0) {
    // Helper to extract sender session/pair from senders_config JSON
    const parseSenderInfo = (msg: { senderNumber: string | null; sendersConfig: string | null }) => {
      let senderSession = ''
      let pairUsed = ''
      if (msg.sendersConfig && msg.senderNumber) {
        try {
          const senders = JSON.parse(msg.sendersConfig) as Array<{ phone: string; session: string; pair: string }>
          const match = senders.find((s) => s.phone === msg.senderNumber)
          if (match) {
            senderSession = match.session
            pairUsed = match.pair
          }
        } catch { /* malformed JSON — ignore */ }
      }
      return { senderSession, pairUsed }
    }

    emitter.on('message:sent', (data) => {
      const msg = queue.getById(data.id)
      if (msg?.pluginName) {
        const { senderSession, pairUsed } = parseSenderInfo(msg)
        const meta = orchestrator.getSendMetadata(data.id)

        void callbackDelivery.sendResultCallback(msg.pluginName, msg.id, {
          idempotency_key: msg.idempotencyKey,
          correlation_id: msg.correlationId ?? undefined,
          status: 'sent',
          sent_at: data.sentAt,
          delivery: {
            message_id: msg.wahaMessageId,
            provider: msg.fallbackUsed ? 'waha' : 'adb',
            sender_phone: msg.senderNumber ?? '',
            sender_session: senderSession,
            pair_used: pairUsed,
            used_fallback: msg.fallbackUsed === 1,
            elapsed_ms: data.durationMs,
            device_serial: data.deviceSerial,
            profile_id: meta?.profileId ?? 0,
            char_count: msg.body.length,
            contact_registered: data.contactRegistered,
            screenshot_url: msg.screenshotPath ? `/api/v1/messages/${msg.id}/screenshot` : null,
            dialogs_dismissed: data.dialogsDismissed,
            user_switched: meta?.userSwitched ?? false,
          },
          error: null,
          fallback_reason: msg.fallbackUsed ? { original_error: 'adb_failed', original_session: senderSession, quarantined: false } : undefined,
          context: msg.context ? (() => { try { return JSON.parse(msg.context!) } catch { return undefined } })() : undefined,
        })
      }
    })

    emitter.on('message:failed', (data) => {
      orchestrator.getSendMetadata(data.id) // cleanup metadata (return value unused)
      const msg = queue.getById(data.id)
      if (msg?.pluginName) {
        void callbackDelivery.sendResultCallback(msg.pluginName, msg.id, {
          idempotency_key: msg.idempotencyKey,
          correlation_id: msg.correlationId ?? undefined,
          status: 'failed',
          sent_at: null,
          delivery: null,
          error: {
            code: 'send_failed',
            message: data.error,
            retryable: msg.attempts < msg.maxRetries,
          },
          context: msg.context ? (() => { try { return JSON.parse(msg.context!) } catch { return undefined } })() : undefined,
        })
      }
    })

    // Phase 9: number:invalid callback — L1 cache hit, send short-circuited
    emitter.on('number:invalid', (data) => {
      const msg = queue.getById(data.id)
      if (msg?.pluginName) {
        void callbackDelivery.sendNumberInvalidCallback(msg.pluginName, msg.id, {
          event: 'number_invalid',
          idempotency_key: msg.idempotencyKey,
          correlation_id: msg.correlationId ?? undefined,
          status: 'number_invalid',
          phone_input: data.phone_input,
          phone_normalized: data.phone_normalized,
          variants_tried: [data.phone_normalized],
          source: data.source,
          confidence: data.confidence,
          check_id: data.check_id,
          detected_at: data.detected_at,
          context: msg.context ? (() => { try { return JSON.parse(msg.context!) as Record<string, unknown> } catch { return undefined } })() : undefined,
        })
      }
    })

    // DP-4: ACK callbacks (delivery receipts)
    emitter.on('message:delivered', (data) => {
      const msg = queue.getById(data.id)
      if (msg?.pluginName) {
        void callbackDelivery.sendAckCallback(msg.pluginName, msg.id, {
          idempotency_key: msg.idempotencyKey,
          message_id: data.id,
          event: 'ack_update',
          ack: {
            level: 2,
            level_name: 'device',
            delivered_at: data.deliveredAt,
            read_at: null,
          },
        })
      }
    })

    emitter.on('message:read', (data) => {
      const msg = queue.getById(data.id)
      if (msg?.pluginName) {
        void callbackDelivery.sendAckCallback(msg.pluginName, msg.id, {
          idempotency_key: msg.idempotencyKey,
          message_id: data.id,
          event: 'ack_update',
          ack: {
            level: 3,
            level_name: 'read',
            delivered_at: data.readAt, // Use readAt as best available
            read_at: data.readAt,
          },
        })
      }
    })

    // DP-4: Response callback (patient reply captured by WAHA)
    emitter.on('waha:message_received', (data) => {
      // Find the most recent outgoing message to this patient
      const history = messageHistory.query({
        fromNumber: data.toNumber, // sender that sent to the patient
        toNumber: data.fromNumber, // patient's number
        direction: 'outgoing',
        limit: 1,
      })
      if (history.length === 0 || !history[0].messageId) return

      const dispatchMsgId = history[0].messageId
      const msg = queue.getById(dispatchMsgId)
      if (!msg?.pluginName) return

      const incomingHistory = messageHistory.query({
        fromNumber: data.fromNumber,
        limit: 1,
      })
      const replyText = incomingHistory.length > 0 ? (incomingHistory[0].text ?? '') : ''

      void callbackDelivery.sendResponseCallback(msg.pluginName, msg.id, {
        idempotency_key: msg.idempotencyKey,
        message_id: msg.id,
        event: 'patient_response',
        response: {
          body: replyText,
          received_at: new Date().toISOString(),
          from_number: data.fromNumber,
          has_media: false,
        },
      })
    })
  }

  // ── DP-2: Receipt Tracking — wire WAHA events to ReceiptTracker ──
  emitter.on('waha:message_sent', (data) => {
    // When webhook handler dedup-matches an outgoing message, correlate for receipts
    if (data.deduplicated && data.wahaMessageId) {
      receiptTracker.correlateOutgoing({
        wahaMessageId: data.wahaMessageId,
        toNumber: data.toNumber,
        senderNumber: data.fromNumber,
        timestamp: new Date().toISOString(),
      })
    }
  })

  emitter.on('waha:message_ack', (data) => {
    const timestamp = data.deliveredAt ?? data.readAt ?? new Date().toISOString()
    receiptTracker.handleAck(data.wahaMessageId, data.ackLevel, timestamp)
  })

  // ── Opt-out detection on WAHA incoming messages ──
  emitter.on('waha:message_received', (data) => {
    const history = messageHistory.query({ fromNumber: data.fromNumber, limit: 1 })
    if (history.length === 0) return

    const text = history[0].text
    const result = optOutDetector.detect(text)
    if (result.matched) {
      db.prepare(
        'INSERT OR IGNORE INTO blacklist (phone_number, reason, detected_message, detected_pattern, source_session) VALUES (?, ?, ?, ?, ?)',
      ).run(data.fromNumber, 'auto_detected', text, result.pattern, data.sessionName)

      emitter.emit('contact:opted_out', {
        phone: data.fromNumber,
        pattern: result.pattern,
        sourceSession: data.sessionName,
        messageText: text ?? '',
      })

      server.log.info({ phone: data.fromNumber, pattern: result.pattern }, 'Opt-out detected — phone blacklisted')
    }
  })

  // S4: Strip secrets from admin GET responses
  const sanitizePlugin = (p: PluginRecord) => {
    const { api_key: _ak, hmac_secret: _hs, ...safe } = p
    return safe
  }

  // Admin routes for plugin management
  server.get('/api/v1/admin/plugins', async (_req, reply) => {
    return reply.send(pluginRegistry.listPlugins().map(sanitizePlugin))
  })

  server.get('/api/v1/admin/plugins/:name', async (req, reply) => {
    const { name } = req.params as { name: string }
    const plugin = pluginRegistry.getPlugin(name)
    if (!plugin) return reply.status(404).send({ error: 'Plugin not found' })
    return reply.send(sanitizePlugin(plugin))
  })

  // Task 11.1: 60 mutations/min per IP on admin write routes.
  const ADMIN_WRITE_RATE_LIMIT = { max: 60, timeWindow: '1 minute' } as const

  server.route({
    method: 'PATCH',
    url: '/api/v1/admin/plugins/:name',
    config: { rateLimit: ADMIN_WRITE_RATE_LIMIT },
    handler: async (req, reply) => {
      const { name } = req.params as { name: string }
      const body = req.body as { enabled?: boolean; webhookUrl?: string; events?: string[] }
      const beforeState = pluginRegistry.getPlugin(name)
      if (body.enabled === false) pluginRegistry.disablePlugin(name)
      if (body.enabled === true) pluginRegistry.enablePlugin(name)
      if (body.webhookUrl || body.events) pluginRegistry.updatePlugin(name, body)
      const afterState = pluginRegistry.getPlugin(name)
      auditLogger.log({
        action: 'update',
        resourceType: 'plugin',
        resourceId: name,
        beforeState: beforeState ? { status: beforeState.status, webhookUrl: beforeState.webhook_url, events: beforeState.events } : null,
        afterState: afterState ? { status: afterState.status, webhookUrl: afterState.webhook_url, events: afterState.events } : null,
      })
      return reply.send(afterState)
    },
  })

  server.route({
    method: 'DELETE',
    url: '/api/v1/admin/plugins/:name',
    config: { rateLimit: ADMIN_WRITE_RATE_LIMIT },
    handler: async (req, reply) => {
      const { name } = req.params as { name: string }
      const beforeState = pluginRegistry.getPlugin(name)
      pluginRegistry.deletePlugin(name)
      auditLogger.log({
        action: 'delete',
        resourceType: 'plugin',
        resourceId: name,
        beforeState: beforeState ? { status: beforeState.status, webhookUrl: beforeState.webhook_url, events: beforeState.events } : null,
      })
      return reply.status(204).send()
    },
  })

  server.route({
    method: 'POST',
    url: '/api/v1/admin/plugins/:name/rotate-key',
    config: { rateLimit: ADMIN_WRITE_RATE_LIMIT },
    handler: async (req, reply) => {
      const { name } = req.params as { name: string }
      const newKey = pluginRegistry.rotateApiKey(name)
      auditLogger.log({
        action: 'rotate_key',
        resourceType: 'plugin',
        resourceId: name,
        // Intentionally not logging the key value for security
      })
      return reply.send({ api_key: newKey })
    },
  })

  // Admin routes for dead-letter callback management
  server.get('/api/v1/admin/callbacks/dead-letter', async (_req, reply) => {
    return reply.send(callbackDelivery.listAbandonedCallbacks())
  })

  server.route({
    method: 'POST',
    url: '/api/v1/admin/callbacks/:id/retry',
    config: { rateLimit: ADMIN_WRITE_RATE_LIMIT },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string }
      const record = callbackDelivery.getCallback(id)
      if (!record || !record.abandoned_at) return reply.status(404).send({ error: 'Dead-letter record not found' })

      const beforeState = {
        attempts: record.attempts,
        abandoned_at: record.abandoned_at,
        abandoned_reason: record.abandoned_reason,
      }

      callbackDelivery.clearAbandoned(id, 0)
      await callbackDelivery.retryFailedCallback(id)

      const afterRecord = callbackDelivery.getCallback(id)
      const afterState = afterRecord
        ? { attempts: afterRecord.attempts, abandoned_at: afterRecord.abandoned_at, abandoned_reason: afterRecord.abandoned_reason }
        : { deleted: true }
      const result = afterRecord ? 'still_failing' : 'deleted'

      auditLogger.log({
        action: 'callback_dead_letter_retry',
        resourceType: 'failed_callback',
        resourceId: id,
        beforeState,
        afterState,
      })

      return reply.send({ id, result })
    },
  })

  // ── Admin routes for manual pause (circuit breaker on dispatch chains) ──
  // GET /api/v1/admin/pause          — list active pauses
  // GET /api/v1/admin/pause/history  — last 100 pause/resume events
  // POST /api/v1/admin/pause         — pause a scope/key
  // POST /api/v1/admin/pause/resume  — resume a scope/key
  server.get('/api/v1/admin/pause', async (_req, reply) => {
    return reply.send(pauseState.listActive())
  })

  server.get('/api/v1/admin/pause/history', async (req, reply) => {
    const q = req.query as { limit?: string }
    const limit = Math.max(1, Math.min(parseInt(q.limit ?? '100', 10) || 100, 500))
    return reply.send(pauseState.listHistory(limit))
  })

  server.route({
    method: 'POST',
    url: '/api/v1/admin/pause',
    config: { rateLimit: ADMIN_WRITE_RATE_LIMIT },
    handler: async (req, reply) => {
      const body = req.body as { scope?: string; key?: string; reason?: string; by?: string }
      const scope = body.scope as PauseScope | undefined
      const validScopes: PauseScope[] = ['global', 'plugin', 'sender', 'device', 'chain', 'message']
      if (!scope || !validScopes.includes(scope)) {
        return reply.status(400).send({ error: `Invalid scope. Must be one of: ${validScopes.join(', ')}` })
      }
      const key = scope === 'global' ? '*' : (body.key ?? '')
      if (!key) return reply.status(400).send({ error: 'key is required for non-global scopes' })
      const reason = body.reason ?? 'manual pause via admin API'
      const by = body.by ?? 'admin'
      const row = pauseState.pause(scope, key, reason, by)
      auditLogger.log({
        action: 'dispatch_pause',
        resourceType: 'dispatch_pause',
        resourceId: `${scope}:${key}`,
        beforeState: null,
        afterState: row as unknown as Record<string, unknown>,
      })

      // Notify the plugin (if scope=plugin OR specific plugin can be derived from chain).
      // Best-effort callback — failures don't roll back the pause.
      if (scope === 'plugin') {
        try {
          await callbackDelivery.sendInterimFailureCallback(key, `__pause_${Date.now()}`, {
            messageId: `__pause_${Date.now()}`,
            type: 'pause' as never,
            reason: `dispatch paused by ${by}: ${reason}`,
            attempts: 0,
            maxAttempts: 0,
            nextRetryAt: null,
          } as never)
        } catch { /* best-effort */ }
      }

      return reply.status(201).send(row)
    },
  })

  server.route({
    method: 'POST',
    url: '/api/v1/admin/pause/resume',
    config: { rateLimit: ADMIN_WRITE_RATE_LIMIT },
    handler: async (req, reply) => {
      const body = req.body as { scope?: string; key?: string; by?: string }
      const scope = body.scope as PauseScope | undefined
      const validScopes: PauseScope[] = ['global', 'plugin', 'sender', 'device', 'chain', 'message']
      if (!scope || !validScopes.includes(scope)) {
        return reply.status(400).send({ error: `Invalid scope. Must be one of: ${validScopes.join(', ')}` })
      }
      const key = scope === 'global' ? '*' : (body.key ?? '')
      if (!key) return reply.status(400).send({ error: 'key is required for non-global scopes' })
      const by = body.by ?? 'admin'
      const ok = pauseState.resume(scope, key, by)
      auditLogger.log({
        action: 'dispatch_resume',
        resourceType: 'dispatch_pause',
        resourceId: `${scope}:${key}`,
        beforeState: { resumed: false },
        afterState: { resumed: ok, by },
      })
      if (!ok) return reply.status(404).send({ error: 'No active pause matched scope/key' })
      return reply.send({ resumed: true, scope, key, by })
    },
  })

  // Admin routes for banned numbers (Task 5.4 — UI surface)
  server.get('/api/v1/admin/banned-numbers', async (_req, reply) => {
    const rows = db.prepare(`
      SELECT phone_number, reason, hits, detected_message, detected_pattern,
             source_session, created_at, last_hit_at
      FROM blacklist
      ORDER BY COALESCE(last_hit_at, created_at) DESC
      LIMIT 1000
    `).all()
    return reply.send(rows)
  })

  server.route({
    method: 'DELETE',
    url: '/api/v1/admin/banned-numbers/:phone',
    config: { rateLimit: ADMIN_WRITE_RATE_LIMIT },
    handler: async (req, reply) => {
      const { phone } = req.params as { phone: string }
      const normalized = phone.replace(/\D/g, '')
      const before = db.prepare('SELECT * FROM blacklist WHERE phone_number = ?').get(normalized)
      if (!before) return reply.status(404).send({ error: 'Phone not in blacklist' })
      db.prepare('DELETE FROM blacklist WHERE phone_number = ?').run(normalized)
      auditLogger.log({
        action: 'unban_number',
        resourceType: 'blacklist',
        resourceId: normalized,
        beforeState: before as Record<string, unknown>,
        afterState: { removed: true },
      })
      return reply.status(204).send()
    },
  })

  // Auto-configure new devices on connect: disable screen lock + keep awake
  emitter.on('device:connected', (data) => {
    const { serial } = data
    server.log.info({ serial }, 'New device connected — applying keep-awake settings')
    const commands = [
      'settings put system screen_off_timeout 2147483647',
      'svc power stayon usb',
      'locksettings set-disabled true',
      'input keyevent KEYCODE_WAKEUP',
      // Disable autocorrect/autocomplete — prevents keyboard from altering message text
      'settings put secure spell_checker_enabled 0',
      'settings put system text_auto_replace 0',
      'settings put system text_auto_caps 0',
      'settings put system text_auto_punctuate 0',
    ]
    for (const cmd of commands) {
      adb.shell(serial, cmd).catch((err) => {
        server.log.warn({ serial, cmd, err: (err as Error).message }, 'Keep-awake command failed')
      })
    }

    // Disable Play Store to prevent WA auto-updates that could break automation
    adb.shell(serial, 'pm disable-user --user 0 com.android.vending').catch((err) => {
      server.log.warn({ serial, err: (err as Error).message }, 'Failed to disable Play Store')
    })

    // Warm contact cache from DB — eliminates cold-start cache misses
    const contacts = queue.getAllContactPhones()
    contactCache.warmUp(serial, contacts)
    server.log.info({ serial, contacts: contacts.length }, 'Contact cache warmed')
  })

  // Device discovery polling (5s) — managed by DeviceManager
  deviceManager.startPolling(5_000)

  // Auto-hygiene: attach listener BEFORE poll fires its first connect events
  // so devices already plugged in still trigger after their first poll cycle.
  autoHygiene.start()

  // Auto-import the chip catalogue from device-side mapping tables on boot.
  // Operator may have edited values in `chips` — INSERT OR IGNORE preserves
  // them; only NEW phones discovered on devices get a placeholder row.
  try {
    const importResult = chipRegistry.importFromDevices()
    server.log.info(
      {
        whatsapp_accounts: importResult.whatsapp_accounts,
        sender_mapping: importResult.sender_mapping,
      },
      'Boot chip auto-import completed',
    )
  } catch (err) {
    server.log.warn(
      { err: (err as Error).message },
      'Boot chip auto-import failed (non-fatal)',
    )
  }

  // In-memory health map for WorkerOrchestrator (populated by health interval)
  const latestHealthMap = new Map<string, import('./monitor/types.js').HealthSnapshot>()

  // Health collection polling (30s) — per-device error isolation
  const healthInterval = setInterval(async () => {
    for (const device of deviceManager.getDevices()) {
      if (device.status !== 'online') continue
      try {
        const snapshot = await healthCollector.collect(device.serial)
        latestHealthMap.set(device.serial, snapshot)
        alertSystem.evaluate(snapshot)
        emitter.emit('device:health', {
          serial: device.serial,
          batteryPercent: snapshot.batteryPercent,
          temperatureCelsius: snapshot.temperatureCelsius,
          ramAvailableMb: snapshot.ramAvailableMb,
          storageFreeBytes: snapshot.storageFreeBytes,
        })
      } catch (err) {
        server.log.error({ err, serial: device.serial }, 'Health collection failed for device')
      }
    }
  }, 30_000)

  // WA account mapping — run on device connect + every 5 minutes
  const mapAllAccounts = async () => {
    for (const device of deviceManager.getDevices()) {
      if (device.status !== 'online') continue
      try {
        await waMapper.mapAccounts(device.serial)
      } catch (err) {
        server.log.error({ err, serial: device.serial }, 'WA account mapping failed for device')
      }
    }
  }
  emitter.on('device:connected', () => {
    setTimeout(() => { void mapAllAccounts() }, 3000) // 3s after connect for device to stabilize
  })
  const accountInterval = setInterval(async () => {
    await mapAllAccounts()
  }, 300_000)

  // Health data cleanup (hourly, removes > 7 days)
  const healthCleanupInterval = setInterval(() => {
    healthCollector.cleanup()
    receiptTracker.cleanup() // DP-2: remove correlations older than 48h
  }, 3_600_000)

  // Screenshot retention cleanup (hourly) — deletes files older than retentionDays
  const screenshotCleanupInterval = setInterval(async () => {
    const retentionMs = screenshotPolicy.retentionDays * 24 * 60 * 60 * 1000
    const cutoff = Date.now() - retentionMs
    try {
      const files = await readdir('reports/sends')
      for (const file of files) {
        const filePath = `reports/sends/${file}`
        try {
          const fileStat = await stat(filePath)
          if (fileStat.mtimeMs < cutoff) {
            await unlink(filePath)
          }
        } catch { /* file may have been deleted between readdir and stat */ }
      }
    } catch { /* directory may not exist yet */ }
  }, 3_600_000)

  // Prometheus gauge refresh (30s) — queue depth + device count + sender daily counts
  const metricsInterval = setInterval(() => {
    const stats = queue.getQueueStats()
    queueDepth.set(stats.pending + stats.processing)
    devicesOnline.set(deviceManager.getDevices().filter(d => d.status === 'online').length)
    // Per-sender daily count gauges
    for (const mapping of senderMapping.listAll()) {
      const count = queue.getSenderDailyCount(mapping.phone_number)
      senderDailyCount.set({ sender: mapping.phone_number }, count)
    }
  }, 30_000)

  const cleanupInterval = setInterval(() => {
    const cleaned = queue.cleanStaleLocks()
    if (cleaned > 0) {
      server.log.info({ cleaned }, 'Cleaned stale locks')
    }
  }, 30_000)

  // ── Task 10.3: Critical alert forwarding ──────────────────────────────────
  // Fires to Slack/Telegram when env vars DISPATCH_ALERT_SLACK_WEBHOOK and/or
  // DISPATCH_ALERT_TELEGRAM_BOT_TOKEN + DISPATCH_ALERT_TELEGRAM_CHAT_ID are set.

  emitter.on('device:circuit:opened', (data) => {
    void sendCriticalAlert(alertCircuitOpened(
      data.serial, data.reason, data.consecutiveFailures, data.nextAttemptAt,
    ))
  })

  // Manual pause / resume — fire structured alerts
  emitter.on('dispatch:paused', (data) => {
    void sendCriticalAlert(alertDispatchPaused(data.scope, data.key, data.reason, data.by))
  })
  emitter.on('dispatch:resumed', (data) => {
    void sendCriticalAlert(alertDispatchResumed(data.scope, data.key, data.by))
  })

  // number:invalid events that originate from a ban detection surface
  emitter.on('number:invalid', (data) => {
    if (data.source === 'send_failure' || data.source === 'adb_probe') {
      void sendCriticalAlert(alertNumberInvalid(
        data.phone_normalized, data.source, data.confidence,
      ))
    }
  })

  // Phase 12 — Ack persistence failure alerts (ADR 0001).
  // Persist every event for the operator UI; throttle Telegram/Slack alerts to
  // at most one per error-message per 60s so that a webhook storm does not
  // flood the channel.
  const ackFailureLastAlertTs = new Map<string, number>()
  const ACK_FAILURE_ALERT_THROTTLE_MS = 60_000
  emitter.on('waha:ack_persist_failed', (data) => {
    try {
      ackPersistFailures.insert({
        wahaMessageId: data.wahaMessageId,
        ackLevel: data.ackLevel,
        error: data.error,
      })
    } catch (err) {
      server.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Failed to persist ack_persist_failures row',
      )
    }
    const now = Date.now()
    const last = ackFailureLastAlertTs.get(data.error) ?? 0
    if (now - last < ACK_FAILURE_ALERT_THROTTLE_MS) return
    ackFailureLastAlertTs.set(data.error, now)
    void sendCriticalAlert({
      title: 'Ack persistence failure',
      severity: 'critical',
      summary: 'WAHA webhook delivered an ack but the row could not be persisted to message_ack_history.',
      fields: {
        wahaMessageId: data.wahaMessageId,
        ackLevel: data.ackLevel,
        error: data.error,
      },
      source: 'dispatch-core / ack-history',
    })
  })

  // Pipedrive request failures — throttle alerts to one per error string per 60s.
  // Pipedrive client itself never throws; the failure event surfaces only after
  // exhausted retries, so each event represents a real loss of an Activity/Note.
  const pipedriveAlertLastTs = new Map<string, number>()
  const PIPEDRIVE_ALERT_THROTTLE_MS = 60_000
  emitter.on('pipedrive:request_failed', (data) => {
    const now = Date.now()
    const last = pipedriveAlertLastTs.get(data.error) ?? 0
    if (now - last < PIPEDRIVE_ALERT_THROTTLE_MS) return
    pipedriveAlertLastTs.set(data.error, now)
    void sendCriticalAlert({
      title: 'Pipedrive request failed',
      severity: 'warning',
      summary: `${data.kind} dispatch to ${data.endpoint} exhausted ${data.attempts} attempt(s).`,
      fields: {
        kind: data.kind,
        endpoint: data.endpoint,
        status: data.status ?? 'transport_error',
        attempts: data.attempts,
        deal_id: data.deal_id ?? 'n/a',
        error: data.error.slice(0, 200),
      },
      source: 'dispatch-core / adb-precheck / pipedrive',
    })
  })

  // Periodic failure-rate check (every 5 min). Fires when failedLastHour > threshold.
  const ALERT_FAILURE_THRESHOLD = Number(process.env.DISPATCH_ALERT_FAILURE_THRESHOLD) || 100
  const criticalAlertInterval = setInterval(() => {
    const stats = queue.getQueueStats()
    if (stats.failedLastHour > ALERT_FAILURE_THRESHOLD) {
      // Pull total processed in the last hour for the rate calculation.
      const totalLastHour = queue.getQueueStats().pending + stats.failedLastHour
      void sendCriticalAlert(alertHighFailureRate(
        stats.failedLastHour, ALERT_FAILURE_THRESHOLD, totalLastHour,
      ))
    }
  }, 5 * 60_000)

  // DP-5: Worker orchestrator — extracted from inline closures
  const sendWindow = new SendWindow({
    start: Number(process.env.SEND_WINDOW_START) || 7,
    end: Number(process.env.SEND_WINDOW_END) || 21,
    days: process.env.SEND_WINDOW_DAYS || '1,2,3,4,5',
    utcOffsetHours: Number(process.env.SEND_WINDOW_OFFSET_HOURS) || -3,
  })

  const cbThreshold = parseInt(process.env.DISPATCH_CB_FAILURE_THRESHOLD ?? '5', 10)
  const cbCooldownMs = parseInt(process.env.DISPATCH_CB_COOLDOWN_MS ?? '300000', 10)
  const circuitBreaker = new DeviceCircuitBreaker(db, emitter, {
    failureThreshold: cbThreshold,
    cooldownMs: cbCooldownMs,
  })
  circuitBreaker.initialize()

  // pauseState was hoisted earlier (right before the plugin system) so that
  // hygienization mode in adb-precheck can wire it. Nothing to do here.

  // ── Ban Prediction Daemon (Task 12.2 — experimental, default off) ──
  // Per-sender ack-rate thresholds beat the env-default when an operator has
  // applied one via the UI (ADR 0001 — env mutation is forbidden).
  const bpdSerialResolver: SerialResolver = {
    resolveSenderForSerial: (serial: string) => {
      const list = senderMapping.getByDeviceSerial(serial)
      return list.length > 0 ? list[0].phone_number : null
    },
  }
  const bpdThresholdProvider: ThresholdProvider = {
    getActiveThreshold: (senderPhone: string) => {
      const row = ackRateThresholds.getActive(senderPhone)
      return row ? { threshold: row.threshold, windowMs: row.windowMs } : null
    },
  }
  let banPredictionDaemon: BanPredictionDaemon | null = null
  if (process.env.DISPATCH_BAN_PREDICTION_ENABLED === 'true') {
    banPredictionDaemon = new BanPredictionDaemon(
      emitter,
      circuitBreaker,
      {
        port: Number(process.env.DISPATCH_BAN_PREDICTION_PORT) || 9871,
        suspectThreshold: Number(process.env.DISPATCH_BAN_PREDICTION_SUSPECT_THRESHOLD) || 3,
        windowMs: Number(process.env.DISPATCH_BAN_PREDICTION_WINDOW_MS) || 60_000,
      },
      bpdSerialResolver,
      bpdThresholdProvider,
    )
    banPredictionDaemon.start()
    server.log.info('Ban prediction daemon started (EXPERIMENTAL)')
  }

  const orchestrator = new WorkerOrchestrator({
    db, queue, engine, adb, emitter, senderMapping, senderHealth,
    rateLimitGuard, receiptTracker, accountMutex, wahaFallback,
    messageHistory, deviceManager,
    latestHealthMap,
    logger: server.log,
    sendWindow,
    senderWarmup,
    circuitBreaker,
    contactRegistry,
    pauseState,
  })
  const workerInterval = setInterval(() => orchestrator.tick(), 5_000)
  const metadataCleanupInterval = setInterval(() => orchestrator.cleanupMetadata(), 60_000)

  // ── Hot-reload coordinator (SIGHUP → re-read .env → update live components) ──
  // NOTE: rate-limit cannot be hot-reloaded because @fastify/rate-limit routes are
  // registered at boot and Fastify does not support plugin re-registration without
  // server restart. The 'rate-limit' entry is a documented no-op with a warning.
  const serverLogger = {
    info: (msg: string, data?: Record<string, unknown>) => server.log.info(data ?? {}, msg),
    warn: (msg: string, data?: Record<string, unknown>) => server.log.warn(data ?? {}, msg),
    error: (msg: string | Record<string, unknown>) => {
      if (typeof msg === 'string') {
        server.log.error(msg)
      } else {
        server.log.error(msg)
      }
    },
  }
  const hotReload = new HotReloadCoordinator(serverLogger, emitter)
  hotReload.register({
    name: 'rate-limit',
    reload: () => {
      // @fastify/rate-limit plugs in at boot — changing limits requires restart.
      server.log.warn(
        '[hot-reload] rate-limit: changes to DISPATCH_RATE_LIMIT_* require a server restart to take effect',
      )
    },
  })
  hotReload.register({
    name: 'sender-scoring',
    reload: () => senderScoring.reloadConfig({
      failurePenalty: parseFloat(process.env.DISPATCH_SCORING_FAILURE_PENALTY ?? '1.0'),
      idleSaturationSec: parseInt(process.env.DISPATCH_SCORING_IDLE_SATURATION_SEC ?? '3600', 10),
      rolePriorityWeights: {
        primary:  parseFloat(process.env.DISPATCH_SCORING_WEIGHT_PRIMARY  ?? '1.0'),
        overflow: parseFloat(process.env.DISPATCH_SCORING_WEIGHT_OVERFLOW ?? '0.7'),
        backup:   parseFloat(process.env.DISPATCH_SCORING_WEIGHT_BACKUP   ?? '0.5'),
        reserve:  parseFloat(process.env.DISPATCH_SCORING_WEIGHT_RESERVE  ?? '0.3'),
      },
    }),
  })
  hotReload.register({
    name: 'circuit-breaker',
    reload: () => circuitBreaker.reloadConfig({
      failureThreshold: parseInt(process.env.DISPATCH_CB_FAILURE_THRESHOLD ?? '5', 10),
      cooldownMs: parseInt(process.env.DISPATCH_CB_COOLDOWN_MS ?? '300000', 10),
    }),
  })
  hotReload.register({
    name: 'idempotency-cache',
    reload: () => idempotencyCache.setDefaultTtlSec(
      parseInt(process.env.IDEMPOTENCY_CACHE_TTL_SEC ?? '3600', 10),
    ),
  })
  hotReload.installSignalHandler()

  // WAHA session health polling (60s) and history cleanup (hourly)
  if (sessionManager) {
    sessionManager.startHealthPolling(60_000)
  }
  const retentionDays = Number(process.env.MESSAGE_HISTORY_RETENTION_DAYS) || 90
  const historyCleanupInterval = setInterval(() => {
    messageHistory.cleanup(retentionDays)
  }, 3_600_000)

  // Periodic callback retry worker (60s) — retries failed callbacks, max 20 per cycle
  let callbackRetryRunning = false
  const callbackRetryInterval = setInterval(async () => {
    if (callbackRetryRunning) return
    callbackRetryRunning = true
    try {
    const failed = callbackDelivery.listFailedCallbacks()
    let retried = 0
    for (const cb of failed) {
      if (retried >= 20) break // Max 20 retries per cycle to prevent storm
      try {
        await callbackDelivery.retryFailedCallback(cb.id)
        retried++
      } catch (err) {
        server.log.warn({ callbackId: cb.id, err }, 'Callback retry failed')
        retried++
      }
    }
    } finally {
      callbackRetryRunning = false
    }
  }, 60_000)

  // Task 4.3: Periodic cleanup of expired idempotency keys (hourly)
  const idempotencyCacheCleanupInterval = setInterval(() => {
    const deleted = idempotencyCache.cleanupExpired()
    if (deleted > 0) {
      server.log.info({ deleted }, 'Cleaned expired idempotency keys')
    }
  }, 60 * 60 * 1000)

  // ── Graceful Shutdown (must register hook BEFORE listen) ──
  const shutdown = new GracefulShutdown(server.log)

  server.addHook('onClose', async () => {
    await shutdown.execute()
  })

  // ── System status with circuit breaker visibility ──
  server.get('/api/v1/system/status', async () => {
    const devices = deviceManager.getDevices()
    const queueStats = queue.getQueueStats()

    return {
      server: { status: 'ok', uptime: process.uptime(), nodeEnv: process.env.NODE_ENV },
      queue: queueStats,
      devices: devices.map(d => ({
        serial: d.serial,
        status: d.status,
        circuitBreaker: circuitBreaker.getState(d.serial),
      })),
      worker: {
        tickInterval: orchestrator.getTickInterval(),
        running: orchestrator.isRunning,
      },
    }
  })

  await server.listen({ port, host: '0.0.0.0' })

  const io = new SocketIOServer(server.server, { cors: { origin: corsOrigins } })

  const events: DispatchEventName[] = [
    'message:queued', 'message:sending', 'message:sent', 'message:failed',
    'message:delivered', 'message:read',
    'device:connected', 'device:disconnected', 'device:health', 'alert:new',
    'device:circuit:opened', 'device:circuit:half_open', 'device:circuit:closed',
    'waha:message_received', 'waha:message_sent', 'waha:session_status', 'waha:message_ack',
    'contact:opted_out',
    'sender:quarantined', 'sender:released',
  ]
  for (const event of events) {
    emitter.on(event, (data) => io.emit(event, data))
  }

  // Register shutdown handlers (after listen, handlers don't use addHook)
  shutdown.addHandler('plugins', async () => {
    await pluginLoader.destroyAll()
    pluginEventBus.destroy()
  })

  shutdown.addHandler('intervals', async () => {
    deviceManager.stop()
    sessionManager?.stop()
    banPredictionDaemon?.stop()
    clearInterval(healthInterval)
    clearInterval(accountInterval)
    clearInterval(healthCleanupInterval)
    clearInterval(historyCleanupInterval)
    clearInterval(cleanupInterval)
    clearInterval(workerInterval)
    clearInterval(callbackRetryInterval)
    clearInterval(metadataCleanupInterval)
    clearInterval(metricsInterval)
    clearInterval(screenshotCleanupInterval)
    clearInterval(idempotencyCacheCleanupInterval)
    clearInterval(criticalAlertInterval)
  })

  shutdown.addHandler('stale-locks', async () => {
    const cleaned = queue.cleanStaleLocks()
    if (cleaned > 0) {
      server.log.info({ cleaned }, 'Cleaned stale locks during shutdown')
    }
  })

  shutdown.addHandler('socket.io', async () => {
    io.close()
  })

  shutdown.addHandler('database', async () => {
    db.close()
  })

  return { server, io, queue, adb, engine, emitter, shutdown }
}
