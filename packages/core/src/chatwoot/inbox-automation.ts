import type { ChatwootApiClient, InboxAutomationResult } from './types.js'
import type { WahaApiClient, WahaSessionInfo } from '../waha/types.js'
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

function extractPhone(session: WahaSessionInfo): string | null {
  if (!session.me) return null
  return session.me.id.replace(/@c\.us$/, '')
}

export class InboxAutomation {
  private chatwootClient: ChatwootApiClient
  private wahaClient: WahaApiClient
  private managedSessions: ManagedSessions
  private wahaApiUrl: string
  private wahaApiKey: string

  constructor(
    chatwootClient: ChatwootApiClient,
    wahaClient: WahaApiClient,
    managedSessions: ManagedSessions,
    config?: { wahaApiUrl?: string; wahaApiKey?: string },
  ) {
    this.chatwootClient = chatwootClient
    this.wahaClient = wahaClient
    this.managedSessions = managedSessions
    this.wahaApiUrl = config?.wahaApiUrl ?? ''
    this.wahaApiKey = config?.wahaApiKey ?? ''
  }

  async createInboxForSession(
    sessionName: string,
    options?: { inboxName?: string },
  ): Promise<InboxAutomationResult> {
    try {
      const session = await this.wahaClient.getSession(sessionName)
      const phone = extractPhone(session)

      const inboxName = options?.inboxName ?? `Dispatch — ${phone ?? sessionName}`
      const inbox = await this.chatwootClient.createInbox(inboxName)

      // Persist or update managed session
      const existing = this.managedSessions.get(sessionName)
      if (existing) {
        this.managedSessions.updateChatwootInboxId(sessionName, inbox.id)
      } else {
        this.managedSessions.add({
          sessionName,
          phoneNumber: phone ?? '',
          deviceSerial: null,
          profileId: null,
          chatwootInboxId: inbox.id,
        })
      }

      return {
        sessionName,
        chatwootInboxId: inbox.id,
        chatwootInboxName: inboxName,
        success: true,
      }
    } catch (error) {
      return {
        sessionName,
        chatwootInboxId: 0,
        chatwootInboxName: '',
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async listSessionsWithStatus(): Promise<SessionWithStatus[]> {
    const wahaSessions = await this.wahaClient.listSessions()

    return wahaSessions.map((ws) => {
      const managed = this.managedSessions.get(ws.name)
      return {
        sessionName: ws.name,
        wahaStatus: ws.status,
        phoneNumber: extractPhone(ws),
        managed: managed?.managed ?? false,
        chatwootInboxId: managed?.chatwootInboxId ?? null,
      }
    })
  }

  async bulkSetManaged(sessionNames: string[]): Promise<BulkManagedResult[]> {
    if (sessionNames.length === 0) return []

    const results: BulkManagedResult[] = []
    const wahaSessions = await this.wahaClient.listSessions()

    for (const name of sessionNames) {
      const existing = this.managedSessions.get(name)
      if (existing && existing.managed) {
        results.push({ sessionName: name, alreadyManaged: true })
        continue
      }

      // Find session in WAHA list or fetch individually
      let session = wahaSessions.find((s) => s.name === name)
      if (!session) {
        try {
          session = await this.wahaClient.getSession(name)
        } catch {
          continue
        }
      }

      const phone = extractPhone(session)
      if (existing) {
        this.managedSessions.setManaged(name, true)
      } else {
        this.managedSessions.add({
          sessionName: name,
          phoneNumber: phone ?? '',
          deviceSerial: null,
          profileId: null,
          chatwootInboxId: null,
        })
      }
      results.push({ sessionName: name, alreadyManaged: false })
    }

    return results
  }

  async getQrCode(sessionName: string): Promise<string> {
    const session = await this.wahaClient.getSession(sessionName)
    if (session.status !== 'SCAN_QR_CODE') {
      throw new Error(`Session ${sessionName} is not in SCAN_QR_CODE status (current: ${session.status})`)
    }

    const url = `${this.wahaApiUrl}/api/sessions/${encodeURIComponent(sessionName)}/qr`
    const headers: Record<string, string> = {}
    if (this.wahaApiKey) {
      headers['X-Api-Key'] = this.wahaApiKey
    }

    const res = await fetch(url, { headers })
    const data = (await res.json()) as { qr: string }
    return data.qr
  }
}
