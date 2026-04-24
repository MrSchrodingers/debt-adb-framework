// WAHA Listener types — Phase 4
// Based on WAHA Plus GoWS 2026.3.1 API and Phase 4 grill decisions

export interface WahaSessionInfo {
  name: string
  status: 'WORKING' | 'FAILED' | 'STARTING' | 'STOPPED' | 'SCAN_QR_CODE'
  config: {
    webhooks?: WahaWebhookConfig[]
    metadata?: Record<string, unknown>
  }
  me: {
    id: string // "554396835104@c.us"
    pushName: string
  } | null
  presence: string | null
  timestamps: {
    activity?: number
  }
}

export interface WahaWebhookConfig {
  url: string
  events: string[]
  hmac?: { key: string }
  retries?: { policy: string; delaySeconds: number; attempts: number }
  customHeaders?: { name: string; value: string }[]
}

export interface WahaWebhookPayload {
  event: 'message' | 'message.any' | 'message.ack' | 'session.status'
  session: string
  me?: { id: string; pushName: string }
  payload: Record<string, unknown>
  engine?: string
  environment?: { version: string; engine: string; tier: string }
}

export interface WahaMessagePayload {
  id: string
  timestamp: number
  from: string
  to?: string
  body: string
  hasMedia: boolean
  media?: { url: string; mimetype: string; filename: string } | null
  replyTo?: string | null
}

export interface WahaSessionStatusPayload {
  status: 'WORKING' | 'FAILED' | 'STARTING' | 'STOPPED'
  statuses: { status: string; timestamp: number }[]
}

export interface WahaAckPayload {
  id: string
  ack: number // -1=error, 0=pending, 1=server, 2=device, 3=read, 4=played
}

export interface MessageHistoryRecord {
  id: string
  messageId: string | null
  direction: 'incoming' | 'outgoing'
  fromNumber: string | null
  toNumber: string | null
  text: string | null
  mediaType: string | null
  mediaPath: string | null
  deviceSerial: string | null
  profileId: number | null
  wahaMessageId: string | null
  wahaSessionName: string | null
  capturedVia: 'adb_send' | 'waha_webhook' | 'chatwoot_reply'
  createdAt: string
}

export interface WahaClientConfig {
  apiUrl: string
  apiKey: string
  webhookHmacSecret?: string
}

export interface WahaApiClient {
  listSessions(): Promise<WahaSessionInfo[]>
  getSession(name: string): Promise<WahaSessionInfo>
  updateSessionWebhooks(name: string, webhooks: WahaWebhookConfig[]): Promise<void>
  restartSession(name: string): Promise<void>
  stopSession(name: string): Promise<void>
  getServerVersion(): Promise<{ version: string; engine: string; tier: string }>
  downloadMedia(fileUrl: string): Promise<Buffer>
  getQrCode(name: string): Promise<string>
  /**
   * Check whether a phone number is registered on WhatsApp via the
   * session. Used as L2 tiebreaker by ContactValidator for ambiguous DDDs.
   */
  checkExists(session: string, phone: string): Promise<{ numberExists: boolean; chatId?: string | null }>
}

export interface StorageAdapter {
  save(sessionName: string, mediaId: string, data: Buffer, ext: string): Promise<string>
  delete(path: string): Promise<void>
  cleanup(olderThanDays: number): Promise<number>
}
