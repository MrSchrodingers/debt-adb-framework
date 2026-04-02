import type { ChatwootApiClient, InboxAutomationResult } from './types.js'
import type { WahaApiClient } from '../waha/types.js'
import type { ManagedSessions } from './managed-sessions.js'

export interface SessionWithStatus {
  sessionName: string
  wahaStatus: string
  phoneNumber: string | null
  managed: boolean
  chatwootInboxId: number | null
}

export interface BulkManagedResult {
  sessionName: string
  alreadyManaged: boolean
}

export class InboxAutomation {
  constructor(
    _chatwootClient: ChatwootApiClient,
    _wahaClient: WahaApiClient,
    _managedSessions: ManagedSessions,
  ) {
    throw new Error('Not implemented — TDD Red')
  }

  async createInboxForSession(
    _sessionName: string,
    _options?: { inboxName?: string },
  ): Promise<InboxAutomationResult> {
    throw new Error('Not implemented — TDD Red')
  }

  async listSessionsWithStatus(): Promise<SessionWithStatus[]> {
    throw new Error('Not implemented — TDD Red')
  }

  async bulkSetManaged(_sessionNames: string[]): Promise<BulkManagedResult[]> {
    throw new Error('Not implemented — TDD Red')
  }

  async getQrCode(_sessionName: string): Promise<string> {
    throw new Error('Not implemented — TDD Red')
  }
}
