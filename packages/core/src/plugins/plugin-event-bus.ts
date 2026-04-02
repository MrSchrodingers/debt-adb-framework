import type { DispatchEmitter, DispatchEventName, DispatchEventMap } from '../events/index.js'
import type { PluginRegistry } from './plugin-registry.js'

type PluginHandler = (data: unknown) => Promise<void>
type ErrorHandler = (err: Error) => void

const HANDLER_TIMEOUT_MS = 5_000

export class PluginEventBus {
  private handlers = new Map<string, Map<DispatchEventName, PluginHandler>>()
  private errorHandlers: ErrorHandler[] = []
  private listeners = new Map<DispatchEventName, (data: unknown) => void>()
  private pluginEnabled = new Map<string, boolean>()

  constructor(
    private registry: PluginRegistry,
    private emitter: DispatchEmitter,
  ) {}

  registerHandler(pluginName: string, event: DispatchEventName, handler: PluginHandler): void {
    if (!this.handlers.has(pluginName)) {
      this.handlers.set(pluginName, new Map())
    }
    this.handlers.get(pluginName)!.set(event, handler)
    this.pluginEnabled.set(pluginName, true)

    if (!this.listeners.has(event)) {
      const listener = (data: unknown) => {
        void this.dispatchToPlugins(event, data)
      }
      this.emitter.on(event as keyof DispatchEventMap, listener as never)
      this.listeners.set(event, listener)
    }
  }

  setPluginEnabled(pluginName: string, enabled: boolean): void {
    this.pluginEnabled.set(pluginName, enabled)
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
    this.pluginEnabled.clear()
  }

  private async dispatchToPlugins(event: DispatchEventName, data: unknown): Promise<void> {
    const dispatches: Promise<void>[] = []

    for (const [pluginName, eventHandlers] of this.handlers) {
      const handler = eventHandlers.get(event)
      if (!handler) continue

      if (!this.pluginEnabled.get(pluginName)) continue

      dispatches.push(this.executeWithTimeout(pluginName, handler, data))
    }

    await Promise.allSettled(dispatches)
  }

  private async executeWithTimeout(
    pluginName: string,
    handler: PluginHandler,
    data: unknown,
  ): Promise<void> {
    try {
      const result = handler(data)
      const timeout = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Plugin ${pluginName} handler timeout after ${HANDLER_TIMEOUT_MS}ms`)), HANDLER_TIMEOUT_MS)
      })
      await Promise.race([result, timeout])
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      for (const h of this.errorHandlers) {
        h(error)
      }
    }
  }
}
