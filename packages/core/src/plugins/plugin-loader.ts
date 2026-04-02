import type Database from 'better-sqlite3'
import type { MessageQueue } from '../queue/message-queue.js'
import type { PluginRegistry } from './plugin-registry.js'
import type { PluginEventBus } from './plugin-event-bus.js'
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

export class PluginLoader {
  private loadedPlugins = new Map<string, DispatchPlugin>()

  constructor(
    private registry: PluginRegistry,
    private eventBus: PluginEventBus,
    private queue: MessageQueue,
    private db: Database.Database,
  ) {}

  async loadPlugin(plugin: DispatchPlugin, apiKey: string, hmacSecret: string): Promise<void> {
    // Check if already registered and disabled
    const existing = this.registry.getPlugin(plugin.name)
    if (existing && existing.enabled === 0) {
      return // Skip disabled plugins
    }

    // Register/upsert in registry
    this.registry.register({
      name: plugin.name,
      version: plugin.version,
      webhookUrl: plugin.webhookUrl,
      apiKey,
      hmacSecret,
      events: plugin.events as string[],
    })

    // Create restricted PluginContext
    const ctx = this.createContext(plugin.name)

    try {
      await plugin.init(ctx)
      this.loadedPlugins.set(plugin.name, plugin)
    } catch {
      this.registry.setPluginStatus(plugin.name, 'error')
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
    for (const [name] of this.loadedPlugins) {
      await this.unloadPlugin(name)
    }
  }

  private createContext(pluginName: string): PluginContext {
    const logger = this.createLogger(pluginName)

    return {
      enqueue: (msgs: PluginEnqueueParams[]): PluginMessage[] => {
        const params = msgs.map((m) => ({
          to: m.patient.phone,
          body: m.message.text,
          idempotencyKey: m.idempotencyKey,
          priority: PRIORITY_MAP[m.sendOptions?.priority ?? 'normal'] ?? 5,
          senderNumber: m.senders[0]?.phone ?? null,
          pluginName,
          correlationId: m.correlationId ?? null,
          sendersConfig: JSON.stringify(m.senders),
          context: m.context ? JSON.stringify(m.context) : null,
          maxRetries: m.sendOptions?.maxRetries ?? 3,
        }))

        const messages = this.queue.enqueueBatch(params)

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

      on: (event: DispatchEventName, handler: (data: unknown) => Promise<void>): void => {
        this.eventBus.registerHandler(pluginName, event, handler)
      },

      registerRoute: (_method: HttpMethod, _path: string, _handler: RouteHandler): void => {
        // Route registration is handled by the server integration layer
        // Stored for later binding when Fastify is available
        logger.debug(`Route registered: ${_method} /api/v1/plugins/${pluginName}${_path}`)
      },

      logger,
    }
  }

  private createLogger(pluginName: string): PluginLogger {
    return {
      info: (msg: string, data?: Record<string, unknown>) => {
        console.log(JSON.stringify({ level: 'info', plugin: pluginName, msg, ...data }))
      },
      warn: (msg: string, data?: Record<string, unknown>) => {
        console.warn(JSON.stringify({ level: 'warn', plugin: pluginName, msg, ...data }))
      },
      error: (msg: string, data?: Record<string, unknown>) => {
        console.error(JSON.stringify({ level: 'error', plugin: pluginName, msg, ...data }))
      },
      debug: (msg: string, data?: Record<string, unknown>) => {
        console.debug(JSON.stringify({ level: 'debug', plugin: pluginName, msg, ...data }))
      },
    }
  }
}
