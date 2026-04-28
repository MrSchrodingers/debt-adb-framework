import { config as loadEnv } from 'dotenv'
import type { DispatchEmitter } from '../events/dispatch-emitter.js'

interface HotReloadLogger {
  info(msg: string, data?: Record<string, unknown>): void
  warn(msg: string, data?: Record<string, unknown>): void
  error(msg: string | Record<string, unknown>, ...args: unknown[]): void
}

export interface HotReloadable {
  /** Human-readable name for logs/events. */
  name: string
  /** Re-apply env-driven config to the live component. Throws to abort the reload. */
  reload(): void | Promise<void>
}

/**
 * SIGHUP-driven config hot reloader.
 *
 * What hot-reloads (env vars only — components implement Reloadable):
 *  - Rate limit thresholds (per-route)
 *  - Sender scoring weights / penalties
 *  - Idempotency cache TTL
 *  - Ban threshold
 *  - Circuit breaker thresholds (re-applied to existing breaker instance)
 *  - Plugin webhook URLs (via PluginRegistry)
 *
 * What does NOT hot-reload (requires restart):
 *  - DB path, server port, plugin set (DISPATCH_PLUGINS)
 *  - DISPATCH_API_KEY (cached at boot in api-auth middleware)
 *  - Telemetry SDK (auto-instrumentation patches at startup)
 *
 * Emits `config:reloaded` on success and `config:reload_failed` on partial failure
 * via DispatchEmitter, so UI can flash a notification.
 */
export class HotReloadCoordinator {
  private reloadables: HotReloadable[] = []
  private installed = false

  constructor(
    private logger: HotReloadLogger,
    private emitter: DispatchEmitter,
    private envPath: string = '.env',
  ) {}

  /**
   * Register a component that wants to be re-applied on SIGHUP.
   * Order of registration is order of execution.
   */
  register(reloadable: HotReloadable): void {
    this.reloadables.push(reloadable)
  }

  /**
   * Re-read .env (with override=true) and run every reloadable's reload().
   * Failures are logged per-reloadable but do not abort the rest.
   * Returns counts for tests / observability.
   */
  async reload(): Promise<{ ok: number; failed: Array<{ name: string; error: string }> }> {
    this.logger.info('Hot reload triggered — re-reading env')
    loadEnv({ path: this.envPath, override: true })

    let ok = 0
    const failed: Array<{ name: string; error: string }> = []

    for (const r of this.reloadables) {
      try {
        await r.reload()
        ok++
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        this.logger.error({ err, reloadable: r.name }, `Reload of "${r.name}" failed`)
        failed.push({ name: r.name, error: msg })
      }
    }

    if (failed.length === 0) {
      this.logger.info(`Hot reload complete — ${ok} component(s) reloaded`)
      this.emitter.emit('config:reloaded', { components: ok, failed: 0 })
    } else {
      this.logger.warn(`Hot reload partial — ${ok} ok, ${failed.length} failed`)
      this.emitter.emit('config:reload_failed', { components: ok, failed: failed.length, errors: failed })
    }

    return { ok, failed }
  }

  /** Install SIGHUP handler. Idempotent — second call is no-op. */
  installSignalHandler(): void {
    if (this.installed) return
    this.installed = true
    process.on('SIGHUP', () => {
      void this.reload()
    })
    this.logger.info('SIGHUP hot-reload handler installed')
  }
}
