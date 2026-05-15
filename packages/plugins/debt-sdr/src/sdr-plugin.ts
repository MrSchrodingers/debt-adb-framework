import type {
  DispatchPlugin,
  PluginContext,
  DispatchEventName,
} from '@dispatch/core'
import type { SdrPluginConfig } from './config/tenant-config.js'

/**
 * debt-sdr — multi-tenant SDR outbound plugin.
 *
 * Tenants partition by sender phone, device serial, and message
 * tenant_hint. Each tenant has its own Pipedrive instance (token via
 * env), sender pool, throttle, and 3-touch sequence (day 0/2/5). The
 * plugin claims devices exclusively at init time and fails loud on
 * conflict — no split-tenant mode.
 *
 * Phase B scaffold: init/destroy are wired in subsequent tasks. The
 * scaffold gates the config + types so downstream development can
 * build against a stable surface.
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

  private config: SdrPluginConfig
  /** Devices claimed during init — released on destroy (defense-in-depth; loader auto-releases too). */
  private claimedDevices: string[] = []
  /** Plugin context captured during init for use by routes / crons. */
  private ctx: PluginContext | null = null

  constructor(config: SdrPluginConfig, webhookUrl: string) {
    this.config = config
    this.webhookUrl = webhookUrl
  }

  async init(ctx: PluginContext): Promise<void> {
    this.ctx = ctx
    // Filled in Task 14 (migrations, device claim, sender assertion).
  }

  async destroy(): Promise<void> {
    // Filled in Task 15 (cron stop + explicit device release).
    this.ctx = null
  }

  getConfig(): SdrPluginConfig {
    return this.config
  }

  /** Test hook — returns the device serials this instance has claimed. */
  getClaimedDevices(): readonly string[] {
    return this.claimedDevices
  }
}
