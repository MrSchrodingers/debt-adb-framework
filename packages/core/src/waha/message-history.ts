import type Database from 'better-sqlite3'
import type { MessageHistoryRecord } from './types.js'

export interface InsertHistoryParams {
  messageId?: string | null
  direction: 'incoming' | 'outgoing'
  fromNumber: string | null
  toNumber: string | null
  text: string | null
  mediaType?: string | null
  mediaPath?: string | null
  deviceSerial?: string | null
  profileId?: number | null
  wahaMessageId?: string | null
  wahaSessionName?: string | null
  capturedVia: 'adb_send' | 'waha_webhook' | 'chatwoot_reply'
}

export interface HistoryQuery {
  fromNumber?: string
  toNumber?: string
  direction?: 'incoming' | 'outgoing'
  wahaSessionName?: string
  limit?: number
  offset?: number
}

export class MessageHistory {
  constructor(private readonly db: Database.Database) {}

  initialize(): void {
    // TODO: Create message_history table + indexes
  }

  insert(params: InsertHistoryParams): string {
    // TODO: Insert record, return id
    return ''
  }

  findByDedup(toNumber: string, timestamp: string, windowSeconds?: number): MessageHistoryRecord | null {
    // TODO: Find record within dedup window
    return null
  }

  updateWithWahaId(id: string, wahaMessageId: string): void {
    // TODO: Update record with WAHA message ID
  }

  getById(id: string): MessageHistoryRecord | null {
    // TODO: Get record by id
    return null
  }

  query(params: HistoryQuery): MessageHistoryRecord[] {
    // TODO: Query records with filters
    return []
  }

  cleanup(retentionDays: number): number {
    // TODO: Delete records older than retention
    return 0
  }
}
