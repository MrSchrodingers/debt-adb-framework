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

  constructor(
    private registry: PluginRegistry,
    private eventBus: PluginEventBus,
    private queue: MessageQueue,
    private db: Database.Database,
    logger?: PluginLoggerFactory,
    private senderMapping?: SenderMapping,
    private sendEngine?: SendEngine,
    private idempotencyCache?: IdempotencyCache,
  ) {
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
    } catch (err) {
      // R2: log + re-throw on init error
      this.registry.setPluginStatus(plugin.name, 'error')
      this.loggerFactory.child({ plugin: plugin.name }).error('Plugin init failed', {
        err: err instanceof Error ? err.message : String(err),
      })
      throw err
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
    }
  }
}
