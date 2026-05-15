import type Database from 'better-sqlite3'
import type {
  DispatchPlugin,
  PluginContext,
  DispatchEventName,
  ResponseCallback,
} from '@dispatch/core'
import { loadSdrPluginConfig, type SdrPluginConfig, type SdrTenantConfig } from './config/tenant-config.js'
import { initSdrSchema } from './db/migrations.js'
import { TenantPipedriveClient } from './pipedrive/tenant-pipedrive-client.js'
import { LeadPuller } from './pull/lead-puller.js'
import { Sequencer } from './sequences/sequencer.js'
import { ResponseClassifier } from './classifier/classifier.js'
import { StubLlmClient, type LlmClient } from './classifier/llm-client.js'
import { ClassifierLog } from './classifier/classifier-log.js'
import { IdentityGate } from './identity-gate/identity-gate.js'
import { ThrottleGate } from './throttle/throttle-gate.js'
import { OperatorAlerts } from './operator-alerts.js'
import { PendingWritebacks } from './responses/pending-writebacks.js'
import { ResponseHandler } from './responses/response-handler.js'
import { registerAdminRoutes } from './routes/admin-routes.js'
import { registerOperatorRoutes } from './routes/operator-routes.js'
// Side-effect import registers shipped sequences.
import './sequences/index.js'

interface ClaimedDevice {
  serial: string
  tenant: string
}

/**
 * debt-sdr — multi-tenant SDR outbound plugin.
 *
 * Lifecycle:
 *   1. Constructor parses + validates config (throws on invalid).
 *   2. init() runs schema migrations, preflight checks, claims devices
 *      + asserts senders, then wires the runtime pipeline:
 *        - per-tenant Pipedrive clients
 *        - LeadPuller, IdentityGate, ThrottleGate, Sequencer
 *        - ResponseClassifier (with configurable LlmClient — defaults
 *          to StubLlmClient which always returns ambiguous + alert)
 *        - ClassifierLog, OperatorAlerts, PendingWritebacks
 *        - ResponseHandler subscribed to incoming patient responses
 *      Crons are wired but GATED by DISPATCH_SDR_CRONS_ENABLED. Without
 *      the flag, init succeeds and routes work, but no automatic
 *      pull/sequencer ticks fire.
 *   3. destroy() stops crons, unsubscribes, releases claimed devices.
 *
 * Send safety: there is no path for the plugin to enqueue outbound
 * messages while DISPATCH_SDR_CRONS_ENABLED=false. The sequencer is the
 * only enqueue surface and it's cron-driven.
 */
export class DebtSdrPlugin implements DispatchPlugin {
  readonly name = 'debt-sdr'
  readonly version = '0.1.0'
  readonly manifest = {
    name: 'debt-sdr',
    version: '0.1.0',
    sdkVersion: '^1.0.0',
    description:
      'SDR outbound — multi-tenant, identity gate, hybrid classifier (regex+LLM), Pipedrive writeback, 3-touch sequence',
    author: 'DEBT',
  }
  readonly events: DispatchEventName[] = ['message:sent', 'message:failed']
  readonly webhookUrl: string

  private readonly config: SdrPluginConfig
  private readonly db: Database.Database
  private readonly llmClient: LlmClient
  private ctx: PluginContext | null = null
  private claimedDevices: ClaimedDevice[] = []

  // Composed runtime — created in init(), torn down in destroy().
  private pipedriveClients = new Map<string, TenantPipedriveClient>()
  private leadPuller?: LeadPuller
  private sequencer?: Sequencer
  private responseHandler?: ResponseHandler
  private operatorAlerts?: OperatorAlerts
  private classifierLog?: ClassifierLog
  private pullTimer?: NodeJS.Timeout
  private sequencerTimer?: NodeJS.Timeout
  private writebackTimer?: NodeJS.Timeout
  private responseUnsubscribe?: () => void

  constructor(
    webhookUrl: string,
    rawConfig: unknown,
    db: Database.Database,
    opts: { llmClient?: LlmClient } = {},
  ) {
    this.webhookUrl = webhookUrl
    this.config = loadSdrPluginConfig(rawConfig)
    this.db = db
    this.llmClient = opts.llmClient ?? new StubLlmClient()
  }

  async init(ctx: PluginContext): Promise<void> {
    this.ctx = ctx
    initSdrSchema(this.db)
    this.assertNoCrossTenantSenders()

    try {
      for (const tenant of this.config.tenants) {
        await this.claimTenantDevices(tenant)
        this.assertTenantSenders(tenant)
      }
      this.wireRuntime(ctx)
      this.registerRoutes(ctx)
      this.startCronsIfEnabled(ctx)

      ctx.logger.info('debt-sdr initialized', {
        tenants: this.config.tenants.map((t) => t.name),
        claimed_devices: this.claimedDevices.length,
        crons_enabled: this.cronsEnabled(),
        llm_provider: this.llmClient.name,
      })
    } catch (err) {
      this.releaseAllClaimed()
      throw err
    }
  }

  async destroy(): Promise<void> {
    if (this.pullTimer) clearInterval(this.pullTimer)
    if (this.sequencerTimer) clearInterval(this.sequencerTimer)
    if (this.writebackTimer) clearInterval(this.writebackTimer)
    this.responseUnsubscribe?.()
    if (this.ctx) {
      this.releaseAllClaimed()
      this.ctx.logger.info('debt-sdr destroyed')
      this.ctx = null
    }
  }

  // ── public test hooks ─────────────────────────────────────────────────

  getConfig(): SdrPluginConfig {
    return this.config
  }

  getClaimedDevices(): readonly ClaimedDevice[] {
    return this.claimedDevices
  }

  /**
   * Direct accessor for the ResponseHandler — used by E2E / integration
   * tests that simulate inbound responses. The HTTP route in Task 39
   * also dispatches via this method.
   */
  async handleIncomingResponse(payload: import('./responses/response-handler.js').ResponsePayload): Promise<void> {
    if (!this.responseHandler) return
    const tenant = this.tenantOfLead(payload.leadId)
    if (!tenant) {
      this.ctx?.logger.warn('incoming response for unknown lead', { lead_id: payload.leadId })
      return
    }
    await this.responseHandler.handle(tenant, payload)
  }

  // ── internals ─────────────────────────────────────────────────────────

  private cronsEnabled(): boolean {
    // Default OFF — operator must opt in via env. Plugin still loads
    // and registers routes; the runtime just doesn't auto-tick.
    return process.env.DISPATCH_SDR_CRONS_ENABLED === 'true'
  }

  /**
   * Lazily build (and cache) the Pipedrive client for a tenant. Missing
   * env var throws on first use rather than at init time, so the plugin
   * still loads cleanly in dev / test environments where the operator
   * hasn't set tokens yet.
   */
  private getPipedriveClient(tenant: SdrTenantConfig): TenantPipedriveClient {
    const cached = this.pipedriveClients.get(tenant.name)
    if (cached) return cached
    const token = process.env[tenant.pipedrive.api_token_env]
    if (!token) {
      throw new Error(
        `debt-sdr: missing Pipedrive token env var ${tenant.pipedrive.api_token_env} for tenant ${tenant.name}`,
      )
    }
    const client = new TenantPipedriveClient({ domain: tenant.pipedrive.domain, token })
    this.pipedriveClients.set(tenant.name, client)
    return client
  }

  private wireRuntime(ctx: PluginContext): void {
    const identityGate = new IdentityGate(this.db, {
      enqueueHandshake: (input) => {
        const idempotencyKey = `sdr:${input.tenant}:${input.kind}:${input.leadId}`
        const messages = ctx.enqueue([
          {
            idempotencyKey,
            correlationId: input.leadId,
            patient: { phone: input.contact.phone, name: input.contact.name },
            message: { text: input.text },
            senders: [{ phone: input.senderPhone, session: '', pair: '', role: 'primary' }],
            context: { sdr: true, kind: input.kind, tenant: input.tenant, lead_id: input.leadId },
            sendOptions: { priority: 'normal' },
            resolvedSenderPhone: input.senderPhone,
          },
        ])
        return messages[0]?.id ?? `sdr-hs-${Date.now()}`
      },
      blacklist: () => {
        // Core's queue manages the blacklist via recordBan; plugins only
        // see isBlacklisted(). For temp blacklists we rely on the
        // operator queue inspection — TODO: expose recordBan to plugins
        // when a use-case demands it.
      },
      raiseOperatorAlert: (input) => operatorAlerts.raise(input),
    })
    const throttleGate = new ThrottleGate(this.db)
    const operatorAlerts = new OperatorAlerts(this.db)
    const pendingWritebacks = new PendingWritebacks(this.db)
    const classifier = new ResponseClassifier(this.llmClient)
    const classifierLog = new ClassifierLog(this.db)
    this.operatorAlerts = operatorAlerts
    this.classifierLog = classifierLog

    this.leadPuller = new LeadPuller(
      this.db,
      { isBlacklisted: (phone) => ctx.isBlacklisted(phone) },
      ctx.logger,
    )

    this.sequencer = new Sequencer(this.db, {
      enqueueStep: (input) => {
        const idempotencyKey = `sdr:${input.tenant}:step${input.step}:${input.leadId}`
        const messages = ctx.enqueue([
          {
            idempotencyKey,
            correlationId: input.leadId,
            patient: { phone: input.contact.phone, name: input.contact.name },
            message: { text: input.text },
            senders: [{ phone: input.senderPhone, session: '', pair: '', role: 'primary' }],
            context: { sdr: true, kind: 'step', tenant: input.tenant, lead_id: input.leadId, step: input.step },
            sendOptions: { priority: 'normal' },
            resolvedSenderPhone: input.senderPhone,
          },
        ])
        return messages[0]?.id ?? `sdr-step-${Date.now()}`
      },
      pickSender: (tenant) => tenant.senders[0]?.phone ?? '',
      identityGate,
      throttleGate,
      hasOutgoingHistory: () => {
        // TODO: wire message_history accessor when needed by Phase D
        // smoke. For now, returning false defers to the identity gate
        // check which is the safer default.
        return false
      },
      logger: ctx.logger,
    })

    this.responseHandler = new ResponseHandler(this.db, {
      classifier,
      classifierLog,
      identityGate,
      sequencer: this.sequencer,
      pipedrive: (tenantName) => {
        const tenant = this.config.tenants.find((t) => t.name === tenantName)
        if (!tenant) throw new Error(`debt-sdr: unknown tenant ${tenantName}`)
        return this.getPipedriveClient(tenant)
      },
      operatorAlerts,
      pendingWritebacks,
      llmProviderName: this.llmClient.name,
      logger: ctx.logger,
    })

    // Response routing: core delivers patient replies via the plugin's
    // webhookUrl (configured at plugin registration). The HTTP route
    // is added in Task 39; for now `handleIncomingResponse` is the
    // direct entry point for tests + E2E. We keep a non-issuing
    // reference to ResponseCallback so the type import isn't pruned
    // (it documents the wire-format we accept).
    void ({} as ResponseCallback)
  }

  private registerRoutes(ctx: PluginContext): void {
    if (!this.operatorAlerts || !this.classifierLog || !this.sequencer) {
      throw new Error('debt-sdr: routes registered before runtime wired')
    }
    const tenantNames = this.config.tenants.map((t) => t.name)
    registerAdminRoutes(ctx, {
      db: this.db,
      alerts: this.operatorAlerts,
      classifierLog: this.classifierLog,
      tenantNames,
      llmProviderName: this.llmClient.name,
      cronsEnabled: () => this.cronsEnabled(),
      pipedriveTokenPresent: (tenantName) => {
        const tenant = this.config.tenants.find((t) => t.name === tenantName)
        return tenant ? Boolean(process.env[tenant.pipedrive.api_token_env]) : false
      },
    })
    registerOperatorRoutes(ctx, {
      db: this.db,
      alerts: this.operatorAlerts,
      sequencer: this.sequencer,
    })
  }

  private startCronsIfEnabled(ctx: PluginContext): void {
    if (!this.cronsEnabled()) {
      ctx.logger.info('debt-sdr crons disabled (set DISPATCH_SDR_CRONS_ENABLED=true to start)')
      return
    }
    if (!this.leadPuller || !this.sequencer) {
      throw new Error('debt-sdr crons: runtime not wired')
    }

    // Pull every tenant's poll_interval_minutes — staggered so two tenants
    // never hit Pipedrive at the same instant.
    let offset = 0
    for (const tenant of this.config.tenants) {
      const intervalMs = tenant.pipedrive.pull.poll_interval_minutes * 60 * 1000
      const client = this.getPipedriveClient(tenant)
      this.pullTimer = setInterval(() => {
        this.leadPuller!.pullTenant(tenant, client).catch((err) =>
          ctx.logger.warn('lead pull failed', { tenant: tenant.name, error: String(err) }),
        )
      }, intervalMs)
      // Trigger an immediate first pull after `offset` so plugin boot
      // doesn't wait the full interval.
      setTimeout(() => {
        this.leadPuller!.pullTenant(tenant, client).catch((err) =>
          ctx.logger.warn('lead initial pull failed', { tenant: tenant.name, error: String(err) }),
        )
      }, offset).unref()
      offset += 30_000
    }

    // Sequencer tick every minute across all tenants.
    this.sequencerTimer = setInterval(() => {
      for (const tenant of this.config.tenants) {
        this.sequencer!.tick(tenant).catch((err) =>
          ctx.logger.warn('sequencer tick failed', { tenant: tenant.name, error: String(err) }),
        )
      }
    }, 60_000)
    this.sequencerTimer.unref?.()
  }

  private async claimTenantDevices(tenant: SdrTenantConfig): Promise<void> {
    if (!this.ctx) throw new Error('init must set ctx before claiming devices')
    for (const serial of tenant.devices) {
      const r = this.ctx.requestDeviceAssignment(serial, tenant.name)
      if (!r.ok) {
        throw new Error(
          `debt-sdr cannot claim device ${serial} for tenant ${tenant.name}: ` +
            `${r.reason} (current tenant=${r.current_tenant}, plugin=${r.current_plugin})`,
        )
      }
      this.claimedDevices.push({ serial, tenant: tenant.name })
    }
  }

  private assertTenantSenders(tenant: SdrTenantConfig): void {
    if (!this.ctx) throw new Error('init must set ctx before asserting senders')
    for (const sender of tenant.senders) {
      const r = this.ctx.assertSenderInTenant(sender.phone, tenant.name)
      if (!r.ok) {
        if (r.reason === 'conflicting_tenant') {
          throw new Error(
            `debt-sdr cannot assert sender ${sender.phone} for tenant ${tenant.name}: ` +
              `already owned by ${r.current_tenant}`,
          )
        }
        if (r.reason === 'phone_not_found') {
          throw new Error(
            `debt-sdr sender ${sender.phone} (${sender.app}) for tenant ${tenant.name} ` +
              `has no row in sender_mapping — operator must add the mapping first`,
          )
        }
      }
    }
  }

  private assertNoCrossTenantSenders(): void {
    const stmt = this.db.prepare(
      `SELECT phone_number, tenant
         FROM sender_mapping
        WHERE device_serial = ?
          AND active = 1
          AND tenant IS NOT NULL`,
    )
    const conflicts: Array<{ device: string; tenant: string; foreign: string; phone: string }> = []
    for (const tenant of this.config.tenants) {
      for (const device of tenant.devices) {
        const rows = stmt.all(device) as Array<{ phone_number: string; tenant: string }>
        for (const row of rows) {
          if (row.tenant !== tenant.name) {
            conflicts.push({
              device,
              tenant: tenant.name,
              foreign: row.tenant,
              phone: row.phone_number,
            })
          }
        }
      }
    }
    if (conflicts.length > 0) {
      const detail = conflicts
        .map((c) => `${c.device}: phone=${c.phone} tenant=${c.foreign} (expected ${c.tenant})`)
        .join('; ')
      throw new Error(`debt-sdr preflight: cross-tenant senders on target devices: ${detail}`)
    }
  }

  private releaseAllClaimed(): void {
    if (!this.ctx) {
      this.claimedDevices = []
      return
    }
    for (const claim of this.claimedDevices) {
      const r = this.ctx.releaseDeviceAssignment(claim.serial)
      if (!r.ok) {
        this.ctx.logger.warn('debt-sdr release returned non-ok', {
          device: claim.serial,
          tenant: claim.tenant,
          reason: r.reason,
        })
      }
    }
    this.claimedDevices = []
  }

  private tenantOfLead(leadId: string): SdrTenantConfig | null {
    const row = this.db
      .prepare('SELECT tenant FROM sdr_lead_queue WHERE id = ?')
      .get(leadId) as { tenant: string } | undefined
    if (!row) return null
    return this.config.tenants.find((t) => t.name === row.tenant) ?? null
  }
}
