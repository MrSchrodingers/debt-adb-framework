/**
 * Minimal cross-plugin services registry.
 *
 * Plugins that own a shared capability (e.g. a Pipedrive HTTP client with
 * auth + rate limiting) register an instance under a well-known name during
 * their `init()`. Consumer plugins retrieve the instance via
 * `ctx.services.get<T>(name)` and skip re-implementing the integration.
 *
 * Stub-shaped in NEW-5 (this sprint): plumbing is in place, but no built-in
 * services are registered yet. Promoting Pipedrive from
 * `plugins/adb-precheck/` lands in a follow-up sprint when a second CRM
 * consumer materializes (B2 revisado in the v2 roadmap).
 */

export interface PluginServicesRegistry {
  /** Register a service by name. Throws on duplicate to surface collisions early. */
  register<T>(name: string, instance: T): void
  /** Retrieve a service. Returns undefined when nothing is registered under `name`. */
  get<T>(name: string): T | undefined
  /** Check whether a service is registered. */
  has(name: string): boolean
  /** All registered service names — for admin introspection. */
  list(): string[]
}

export class InMemoryServicesRegistry implements PluginServicesRegistry {
  private services = new Map<string, unknown>()

  register<T>(name: string, instance: T): void {
    if (!name || typeof name !== 'string') {
      throw new Error('service name must be a non-empty string')
    }
    if (this.services.has(name)) {
      throw new Error(`service "${name}" already registered`)
    }
    this.services.set(name, instance)
  }

  get<T>(name: string): T | undefined {
    return this.services.get(name) as T | undefined
  }

  has(name: string): boolean {
    return this.services.has(name)
  }

  list(): string[] {
    return Array.from(this.services.keys()).sort()
  }
}
