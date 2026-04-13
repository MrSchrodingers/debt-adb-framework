import type { DispatchEmitter, DispatchEventName, DispatchEventMap } from '../events/index.js'
import type { PluginRegistry } from './plugin-registry.js'

type PluginHandler = (data: unknown) => Promise<void>
type ErrorHandler = (pluginName: string, event: string, err: Error) => void

const HANDLER_TIMEOUT_MS = 5_000

export class PluginEventBus {
  private handlers = new Map<string, Map<DispatchEventName, PluginHandler>>()
  private errorHandlers: ErrorHandler[] = []
  private listeners = new Map<DispatchEventName, (data: unknown) => void>()

  constructor(
    private registry: PluginRegistry,
    private emitter: DispatchEmitter,
  ) {}

  registerHandler(pluginName: string, event: DispatchEventName, handler: PluginHandler): void {
    if (!this.handlers.has(pluginName)) {
      this.handlers.set(pluginName, new Map())
    }
    this.handlers.get(pluginName)!.set(event, handler)

    if (!this.listeners.has(event)) {
      const listener = (data: unknown) => {
        void this.dispatchToPlugins(event, data)
      }
      this.emitter.on(event as keyof DispatchEventMap, listener as never)
      this.listeners.set(event, listener)
    }
  }

  onError(handler: ErrorHandler): void {
    this.errorHandlers.push(handler)
  }

  destroy(): void {
    for (const [event, listener] of this.listeners) {
      this.emitter.off(event as keyof DispatchEventMap, listener as never)
    }
    this.handlers.clear()
    this.errorHandlers.length = 0
    this.listeners.clear()
  }

  private async dispatchToPlugins(event: DispatchEventName, data: unknown): Promise<void> {
    const dispatches: Promise<void>[] = []

    for (const [pluginName, eventHandlers] of this.handlers) {
      const handler = eventHandlers.get(event)
      if (!handler) continue

      // R9: Use registry as source of truth instead of local pluginEnabled map
      const pluginRecord = this.registry.getPlugin(pluginName)
      if (!pluginRecord || pluginRecord.enabled !== 1) continue

      dispatches.push(this.executeWithTimeout(pluginName, event, handler, data))
    }

    await Promise.allSettled(dispatches)
  }

  private async executeWithTimeout(
    pluginName: string,
    event: DispatchEventName,
    handler: PluginHandler,
    data: unknown,
  ): Promise<void> {
    // Q1: Fix timer leak — clear timeout in finally
    let timeoutHandle: ReturnType<typeof setTimeout>
    try {
      const result = handler(data)
      const timeout = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error(`Plugin ${pluginName} handler timeout after ${HANDLER_TIMEOUT_MS}ms`)), HANDLER_TIMEOUT_MS)
      })
      await Promise.race([result, timeout])
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      for (const h of this.errorHandlers) {
        h(pluginName, event, error)
      }
    } finally {
      clearTimeout(timeoutHandle!)
    }
  }
}
