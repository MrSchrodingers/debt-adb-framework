import type Database from 'better-sqlite3'
import type { MessageQueue } from '../queue/message-queue.js'
import type { PluginRegistry } from './plugin-registry.js'
import type { PluginEventBus } from './plugin-event-bus.js'
import type { SenderMapping } from '../engine/sender-mapping.js'
import type { SendEngine } from '../engine/send-engine.js'
import type { IdempotencyCache } from '../queue/idempotency-cache.js'
import type {
  DispatchPlugin,
  PluginContext,
  PluginEnqueueParams,
  PluginMessage,
  QueueStats,
  HttpMethod,
  RouteHandler,
  PluginLogger,
} from './types.js'
import type { DispatchEventName } from '../events/index.js'
import { validateManifest, type ManifestValidationResult } from './manifest.js'
import { InMemoryServicesRegistry, type PluginServicesRegistry } from './services-registry.js'

const PRIORITY_MAP: Record<string, number> = {
  high: 1,
  normal: 5,
}

export interface RegisteredRoute {
  pluginName: string
  method: HttpMethod
  path: string
  handler: RouteHandler
}

export interface PluginLoggerFactory {
  child(bindings: Record<string, unknown>): PluginLogger
}

export class PluginLoader {
  private loadedPlugins = new Map<string, DispatchPlugin>()
  private registeredRoutes: RegisteredRoute[] = []
  private loggerFactory: PluginLoggerFactory
  /** Shared services registry exposed to every plugin via ctx.services. */
  private services: PluginServicesRegistry
  /** Tracks manifest validation outcome per plugin for admin introspection. */
  private manifestResults = new Map<string, ManifestValidationResult>()
  /** Last successful (apiKey, hmacSecret) used to load each plugin — needed for reload. */
  private loadCredentials = new Map<string, { apiKey: string; hmacSecret: string }>()

  constructor(
    private registry: PluginRegistry,
    private eventBus: PluginEventBus,
    private queue: MessageQueue,
    private db: Database.Database,
    logger?: PluginLoggerFactory,
    private senderMapping?: SenderMapping,
    private sendEngine?: SendEngine,
    private idempotencyCache?: IdempotencyCache,
    /**
     * Per-device lock shared with WorkerOrchestrator. When supplied,
     * plugins receive it via PluginContext.deviceMutex so their ADB
     * intents do not race the worker's typing/send sequence.
     */
    private deviceMutex?: { acquire(deviceSerial: string): Promise<() => void> },
    services?: PluginServicesRegistry,
  ) {
    this.services = services ?? new InMemoryServicesRegistry()
    this.loggerFactory = logger ?? {
      child: (bindings) => ({
        info: (msg, data) => console.log(JSON.stringify({ ...bindings, msg, ...data })),
        warn: (msg, data) => console.warn(JSON.stringify({ ...bindings, msg, ...data })),
        error: (msg, data) => console.error(JSON.stringify({ ...bindings, msg, ...data })),
        debug: (msg, data) => console.debug(JSON.stringify({ ...bindings, msg, ...data })),
      }),
    }
  }

  async loadPlugin(plugin: DispatchPlugin, apiKey: string, hmacSecret: string): Promise<void> {
    const existing = this.registry.getPlugin(plugin.name)
    if (existing && existing.enabled === 0) {
      return
    }

    // Manifest validation (NEW-5, Sprint 2 — gated by presence of plugin.manifest).
    // Plugins without a manifest still load (backwards compat) but emit a warn.
    const log = this.loggerFactory.child({ plugin: plugin.name })
    if (plugin.manifest) {
      const result = validateManifest(plugin.manifest, plugin.name)
      this.manifestResults.set(plugin.name, result)
      if (!result.ok) {
        log.error('Plugin manifest validation failed', {
          reason: result.reason,
          detail: result.detail,
        })
        if (result.reason === 'sdk_incompatible') {
          // Hard block: refuse to load a plugin built for a different SDK major.
          this.registry.setPluginStatus(plugin.name, 'error')
          throw new Error(
            `Plugin ${plugin.name} manifest sdk_incompatible: ${result.detail}`,
          )
        }
        // Schema/name issues warn but continue loading — operator should fix
        // the manifest, but legacy plugins should not be locked out.
        log.warn('Continuing without valid manifest (backwards compat)')
      } else {
        log.info('Plugin manifest validated', {
          version: result.manifest.version,
          sdkVersion: result.manifest.sdkVersion,
        })
      }
    } else {
      log.warn('Plugin has no manifest export — admin introspection limited')
    }

    this.registry.register({
      name: plugin.name,
      version: plugin.version,
      webhookUrl: plugin.webhookUrl,
      apiKey,
      hmacSecret,
      events: plugin.events as string[],
    })

    const ctx = this.createContext(plugin.name)

    // Q3: validate pluginName against registry
    const registered = this.registry.getPlugin(plugin.name)
    if (!registered) throw new Error(`Plugin ${plugin.name} not registered after upsert`)

    try {
      await plugin.init(ctx)
      this.loadedPlugins.set(plugin.name, plugin)
      this.loadCredentials.set(plugin.name, { apiKey, hmacSecret })
    } catch (err) {
      // R2: log + re-throw on init error
      this.registry.setPluginStatus(plugin.name, 'error')
      log.error('Plugin init failed', {
        err: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  }

  /**
   * Inspect-only accessors used by the admin API (B4) + reload path.
   */
  getLoadedPlugin(name: string): DispatchPlugin | undefined {
    return this.loadedPlugins.get(name)
  }

  getManifestResult(name: string): ManifestValidationResult | undefined {
    return this.manifestResults.get(name)
  }

  getServices(): PluginServicesRegistry {
    return this.services
  }

  /**
   * Re-initialize a plugin in place. Calls destroy() on the current instance
   * then init() with a fresh context. Useful in DEV to reset plugin-internal
   * state without restarting the whole core process.
   *
   * Hard-gated by `NODE_ENV !== 'production'` OR explicit
   * `DISPATCH_DEV_RELOAD=true` opt-in. Production callers receive a clear
   * rejection so the admin UI can surface why the button is disabled.
   *
   * Caveats: Node.js does NOT re-import the plugin module, so this swaps
   * runtime state, not code. Routes registered during the original init
   * remain in the Fastify router (Fastify has no public unregister API in
   * the version we use). Event handlers added by the plugin via
   * `ctx.on(...)` are also additive — listeners from prior cycles linger
   * until the process restarts. Treat reload as a state reset, not a code
   * swap.
   */
  async reloadPlugin(name: string): Promise<
    | { ok: true }
    | { ok: false; reason: 'disabled_in_production' | 'plugin_not_found' | 'missing_credentials' | 'init_failed'; detail?: string }
  > {
    const allowed =
      process.env.NODE_ENV !== 'production' ||
      process.env.DISPATCH_DEV_RELOAD === 'true'
    if (!allowed) {
      return { ok: false, reason: 'disabled_in_production' }
    }
    const plugin = this.loadedPlugins.get(name)
    if (!plugin) return { ok: false, reason: 'plugin_not_found' }
    const creds = this.loadCredentials.get(name)
    if (!creds) return { ok: false, reason: 'missing_credentials' }

    const log = this.loggerFactory.child({ plugin: name })
    try {
      await plugin.destroy()
    } catch (err) {
      log.warn('Plugin destroy failed during reload', {
        err: err instanceof Error ? err.message : String(err),
      })
    }
    this.loadedPlugins.delete(name)

    try {
      const ctx = this.createContext(name)
      await plugin.init(ctx)
      this.loadedPlugins.set(name, plugin)
      log.info('Plugin reloaded')
      return { ok: true }
    } catch (err) {
      log.error('Plugin re-init failed during reload', {
        err: err instanceof Error ? err.message : String(err),
      })
      this.registry.setPluginStatus(name, 'error')
      return {
        ok: false,
        reason: 'init_failed',
        detail: err instanceof Error ? err.message : String(err),
      }
    }
  }

  async unloadPlugin(name: string): Promise<void> {
    const plugin = this.loadedPlugins.get(name)
    if (plugin) {
      await plugin.destroy()
      this.loadedPlugins.delete(name)
    }
  }

  async destroyAll(): Promise<void> {
    for (const [name, plugin] of this.loadedPlugins) {
      try {
        await plugin.destroy()
        this.loadedPlugins.delete(name)
      } catch (err) {
        this.loggerFactory.child({ plugin: name }).warn('Plugin destroy failed', {
          err: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  getRegisteredRoutes(): RegisteredRoute[] {
    return this.registeredRoutes
  }

  private createContext(pluginName: string): PluginContext {
    const logger = this.loggerFactory.child({ plugin: pluginName })

    return {
      enqueue: (msgs: PluginEnqueueParams[]): PluginMessage[] => {
        const params = msgs.map((m) => {
          // P1/Decision #17: Merge patientId and templateId into context
          const mergedContext = {
            ...m.context,
            ...(m.patient.patientId ? { patient_id: m.patient.patientId } : {}),
            ...(m.message.templateId ? { template_id: m.message.templateId } : {}),
          }
          const hasContext = Object.keys(mergedContext).length > 0

          return {
            id: m.id,
            to: m.patient.phone,
            body: m.message.text,
            idempotencyKey: m.idempotencyKey,
            priority: PRIORITY_MAP[m.sendOptions?.priority ?? 'normal'] ?? 5,
            // P10: Only use resolvedSenderPhone — no senders[0] fallback
            senderNumber: m.resolvedSenderPhone ?? undefined,
            pluginName,
            correlationId: m.correlationId ?? undefined,
            sendersConfig: JSON.stringify(m.senders),
            context: hasContext ? JSON.stringify(mergedContext) : undefined,
            maxRetries: m.sendOptions?.maxRetries ?? 3,
            contactName: m.patient.name ?? undefined,
          }
        })

        // D5: saveContact is now inside enqueueBatch transaction via contactName param
        const { enqueued: messages } = this.queue.enqueueBatch(params)

        return messages.map((msg) => ({
          id: msg.id,
          idempotencyKey: msg.idempotencyKey,
          toNumber: msg.to,
          body: msg.body,
          senderNumber: msg.senderNumber ?? '',
          status: msg.status,
          pluginName: msg.pluginName ?? pluginName,
          createdAt: msg.createdAt,
        }))
      },

      getMessageStatus: (id: string): PluginMessage | null => {
        const msg = this.queue.getById(id)
        if (!msg) return null
        return {
          id: msg.id,
          idempotencyKey: msg.idempotencyKey,
          toNumber: msg.to,
          body: msg.body,
          senderNumber: msg.senderNumber ?? '',
          status: msg.status,
          pluginName: msg.pluginName ?? '',
          createdAt: msg.createdAt,
        }
      },

      getQueueStats: (): QueueStats => {
        return this.queue.getQueueStats(pluginName)
      },

      getSenderMapping: (phone: string) => {
        return this.senderMapping?.getByPhone(phone) ?? null
      },

      resolveSenderChain: (senders) => {
        return this.senderMapping?.resolveSenderChain(senders) ?? null
      },

      registerContact: async (senderPhone: string, patientPhone: string, patientName: string) => {
        if (!this.sendEngine || !this.senderMapping) {
          return { status: 'error' as const, error: 'SendEngine or SenderMapping not available' }
        }
        const mapping = this.senderMapping.getByPhone(senderPhone)
        if (!mapping) {
          return { status: 'error' as const, error: `No sender mapping for ${senderPhone}` }
        }
        try {
          const result = await this.sendEngine.registerContact(mapping.device_serial, patientPhone, patientName)
          return { status: result }
        } catch (err) {
          return { status: 'error' as const, error: err instanceof Error ? err.message : String(err) }
        }
      },

      on: (event: DispatchEventName, handler: (data: unknown) => Promise<void>): void => {
        this.eventBus.registerHandler(pluginName, event, handler)
      },

      registerRoute: (method: HttpMethod, path: string, handler: RouteHandler): void => {
        this.registeredRoutes.push({ pluginName, method, path, handler })
        logger.debug(`Route registered: ${method} /api/v1/plugins/${pluginName}${path}`)
      },

      logger,

      idempotencyCache: this.idempotencyCache,

      isBlacklisted: (phone: string): boolean => {
        return this.queue.isBlacklisted(phone)
      },

      deviceMutex: this.deviceMutex,

      services: this.services,
    }
  }
}
