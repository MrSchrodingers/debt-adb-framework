import type Database from 'better-sqlite3'
import type { DispatchEmitter } from '../events/index.js'
import type { WahaApiClient, WahaSessionInfo, WahaWebhookConfig } from './types.js'

export interface ManagedSession {
  sessionName: string
  phoneNumber: string
  status: WahaSessionInfo['status']
  deviceSerial: string
  profileId: number
}

export interface SessionManagerConfig {
  healthCheckIntervalMs?: number
  dispatchWebhookUrl?: string
  hmacSecret?: string
}

export class SessionManager {
  constructor(
    private readonly db: Database.Database,
    private readonly emitter: DispatchEmitter,
    private readonly wahaClient: WahaApiClient,
    private readonly config: SessionManagerConfig = {},
  ) {}

  initialize(): void {
    // TODO: Phase 4 implementation
  }

  async discoverManagedSessions(): Promise<ManagedSession[]> {
    // TODO: Cross-reference whatsapp_accounts with WAHA sessions
    return []
  }

  async checkHealth(): Promise<void> {
    // TODO: Check WAHA session status for managed numbers
  }

  async addWebhook(sessionName: string): Promise<void> {
    // TODO: Add Dispatch webhook to WAHA session
  }

  async restartSession(sessionName: string): Promise<void> {
    // TODO: Restart failed WAHA session
  }

  startHealthPolling(intervalMs?: number): void {
    // TODO: Start polling loop
  }

  stop(): void {
    // TODO: Stop polling
  }
}
