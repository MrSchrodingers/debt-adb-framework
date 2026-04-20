// Chatwoot Integration types — Phase 5
// Based on Chatwoot API v4.11.0 and Phase 5 grill decisions

export interface ChatwootConfig {
  apiUrl: string // https://chat.debt.com.br
  accountId: number // 1
  apiToken: string // agent/admin access token
}

export interface ChatwootInbox {
  id: number
  name: string
  channel_type: string
  website_token?: string
  inbox_identifier?: string
}

export interface ChatwootApiClient {
  listInboxes(): Promise<ChatwootInbox[]>
  createInbox(name: string): Promise<ChatwootInbox>
  getInbox(id: number): Promise<ChatwootInbox>
}

export interface ManagedSessionRecord {
  sessionName: string
  phoneNumber: string
  deviceSerial: string | null
  profileId: number | null
  chatwootInboxId: number | null
  managed: boolean
  createdAt: string
}

export interface InboxAutomationResult {
  sessionName: string
  chatwootInboxId: number
  chatwootInboxName: string
  success: boolean
  error?: string
}
