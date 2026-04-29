import type { DispatchEmitter } from '../events/index.js'
import type { HygieneLog } from './hygiene-log.js'
import { hygienizeDevice, type HygienizeAdb } from './hygienize.js'

/**
 * Auto-hygiene orchestrator — listens to `device:connected` and triggers
 * `hygienizeDevice()` when:
 *   - the device has never been hygienized OR
 *   - the last successful run is older than `ttlDays`.
 *
 * Concurrency: per-device mutex prevents two parallel runs for the same
 * serial (e.g. flap → connect twice).
 *
 * Resilience: failures don't crash the listener — they're logged and
 * recorded in `device_hygiene_log` with status='failed'.
 */

export interface AutoHygieneDeps {
  emitter: DispatchEmitter
  adb: HygienizeAdb
  hygieneLog: HygieneLog
  /** Logger compatible with pino's child-logger shape. */
  logger?: {
    info: (obj: object, msg?: string) => void
    warn: (obj: object, msg?: string) => void
    error: (obj: object, msg?: string) => void
  }
}

export interface AutoHygieneOptions {
  /** Disable the auto-trigger entirely. Default: true. */
  enabled?: boolean
  /** Re-hygienize after this many days since last successful run. Default: 14. */
  ttlDays?: number
  /** Delay before triggering after device:connected (ms). Default: 8000. */
  startupDelayMs?: number
  /** If true, removes RISKY bloat as well. Default: false. */
  aggressive?: boolean
}

const DEFAULTS = {
  enabled: true,
  ttlDays: 14,
  startupDelayMs: 8_000,
  aggressive: false,
} as const

export class AutoHygiene {
  private inflight = new Set<string>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly opts: Required<AutoHygieneOptions>

  constructor(
    private deps: AutoHygieneDeps,
    options: AutoHygieneOptions = {},
  ) {
    this.opts = {
      enabled: options.enabled ?? DEFAULTS.enabled,
      ttlDays: options.ttlDays ?? DEFAULTS.ttlDays,
      startupDelayMs: options.startupDelayMs ?? DEFAULTS.startupDelayMs,
      aggressive: options.aggressive ?? DEFAULTS.aggressive,
    }
  }

  /** Wire the listener. Idempotent — calling twice attaches twice (don't). */
  start(): void {
    if (!this.opts.enabled) {
      this.deps.logger?.info({}, 'auto-hygiene disabled via env')
      return
    }
    this.deps.emitter.on('device:connected', ({ serial }) => {
      // Defer so other on-connect handlers (keep-awake, mapAccounts) finish first
      const t = setTimeout(() => {
        this.timers.delete(serial)
        void this.maybeTrigger(serial, 'auto:device_connected')
      }, this.opts.startupDelayMs)
      this.timers.set(serial, t)
    })
    this.deps.logger?.info(
      { ttlDays: this.opts.ttlDays, aggressive: this.opts.aggressive },
      'auto-hygiene listener attached',
    )
  }

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
  }

  /**
   * Public method — also exported so tests + admin endpoint can force a run.
   * Honors the in-flight mutex but ignores TTL (caller decides).
   */
  async runNow(serial: string, source: 'manual:operator' | 'manual:api' = 'manual:api'): Promise<void> {
    await this.execute(serial, source, /* honorTtl */ false)
  }

  private async maybeTrigger(serial: string, source: 'auto:device_connected'): Promise<void> {
    if (!this.deps.hygieneLog.isDue(serial, this.opts.ttlDays)) {
      const last = this.deps.hygieneLog.getLastSuccess(serial)
      this.deps.logger?.info(
        { serial, lastRunAt: last?.finished_at },
        'auto-hygiene skipped: not due',
      )
      return
    }
    await this.execute(serial, source, /* honorTtl */ true)
  }

  private async execute(
    serial: string,
    source: 'auto:device_connected' | 'manual:operator' | 'manual:api',
    _honorTtl: boolean,
  ): Promise<void> {
    if (this.inflight.has(serial)) {
      this.deps.logger?.info({ serial, source }, 'auto-hygiene skipped: already running')
      return
    }
    this.inflight.add(serial)
    const logId = this.deps.hygieneLog.start({
      device_serial: serial,
      triggered_by: source,
    })
    const startTime = Date.now()
    try {
      this.deps.logger?.info({ serial, source, logId }, 'auto-hygiene started')
      const result = await hygienizeDevice(this.deps.adb, serial, {
        aggressive: this.opts.aggressive,
      })
      this.deps.hygieneLog.finish(logId, {
        status: 'completed',
        profiles_processed: result.profilesProcessed,
        bloat_removed_count: result.bloatRemovedCount,
        per_profile_log: result.perProfileLog,
        survived_packages: result.survivedPackages,
      })
      const totalSurvivors = Object.values(result.survivedPackages).reduce(
        (sum, list) => sum + list.length,
        0,
      )
      this.deps.logger?.info(
        {
          serial,
          source,
          logId,
          profiles: result.profilesProcessed,
          bloatRemoved: result.bloatRemovedCount,
          survivors: totalSurvivors,
          durationMs: Date.now() - startTime,
        },
        'auto-hygiene completed',
      )
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      this.deps.hygieneLog.finish(logId, {
        status: 'failed',
        error_msg: errorMsg,
      })
      this.deps.logger?.error(
        { serial, source, logId, err: errorMsg },
        'auto-hygiene failed',
      )
    } finally {
      this.inflight.delete(serial)
    }
  }
}
