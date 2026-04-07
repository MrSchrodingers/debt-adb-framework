import type Database from 'better-sqlite3'
import type { MessageQueue } from '../queue/message-queue.js'
import type { DispatchEmitter } from '../events/index.js'

/**
 * Normalize Brazilian phone number to 12-digit WAHA format for matching.
 * ADB uses 13-digit (5543991938235), WAHA uses 12-digit (554391938235@c.us).
 * If 13 digits, starts with 55, and 5th digit is 9: remove the 5th digit.
 */
export function normalizeBrPhoneForMatching(phone: string): string {
  const digits = phone.replace(/\D/g, '')
  if (digits.length === 13 && digits.startsWith('55') && digits[4] === '9') {
    return digits.slice(0, 4) + digits.slice(5)
  }
  return digits
}

export interface RegisterSentParams {
  messageId: string
  toNumber: string
  senderNumber: string
  sentAt: string
}

export interface CorrelateOutgoingParams {
  wahaMessageId: string
  toNumber: string
  senderNumber: string
  timestamp: string
}

export interface CorrelationResult {
  messageId: string
  wahaMessageId: string
}

/** TTL for pending correlations: 48 hours */
const CORRELATION_TTL_HOURS = 48

/** Time window for matching ADB send with WAHA outgoing: 60 seconds */
const CORRELATION_WINDOW_SECONDS = 60

export class ReceiptTracker {
  constructor(
    private db: Database.Database,
    private queue: MessageQueue,
    private emitter: DispatchEmitter,
  ) {}

  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pending_correlations (
        message_id TEXT PRIMARY KEY,
        to_number_normalized TEXT NOT NULL,
        sender_number_normalized TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        waha_message_id TEXT,
        delivered_emitted INTEGER NOT NULL DEFAULT 0,
        read_emitted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_pending_corr_lookup
        ON pending_correlations(to_number_normalized, sender_number_normalized, sent_at);
      CREATE INDEX IF NOT EXISTS idx_pending_corr_waha
        ON pending_correlations(waha_message_id);
    `)
  }

  /**
   * Register that an ADB send completed. Stores a pending correlation
   * entry so we can match it with the WAHA outgoing webhook later.
   */
  registerSent(params: RegisterSentParams): void {
    const toNorm = normalizeBrPhoneForMatching(params.toNumber)
    const senderNorm = normalizeBrPhoneForMatching(params.senderNumber)

    this.db.prepare(`
      INSERT OR IGNORE INTO pending_correlations
        (message_id, to_number_normalized, sender_number_normalized, sent_at)
      VALUES (?, ?, ?, ?)
    `).run(params.messageId, toNorm, senderNorm, params.sentAt)
  }

  /**
   * When WAHA fires message.any for an outgoing (fromMe) message,
   * try to match it with a pending ADB send within the time window.
   */
  correlateOutgoing(params: CorrelateOutgoingParams): CorrelationResult | null {
    const toNorm = normalizeBrPhoneForMatching(params.toNumber)
    const senderNorm = normalizeBrPhoneForMatching(params.senderNumber)

    // Check if this waha message was already correlated
    const existing = this.db.prepare(
      'SELECT 1 FROM pending_correlations WHERE waha_message_id = ?',
    ).get(params.wahaMessageId)
    if (existing) return null

    // Find pending correlation within time window
    const windowSec = CORRELATION_WINDOW_SECONDS
    const row = this.db.prepare(`
      SELECT message_id FROM pending_correlations
      WHERE to_number_normalized = ?
        AND sender_number_normalized = ?
        AND waha_message_id IS NULL
        AND datetime(sent_at) >= datetime(?, '-' || ? || ' seconds')
        AND datetime(sent_at) <= datetime(?, '+' || ? || ' seconds')
      ORDER BY sent_at DESC
      LIMIT 1
    `).get(toNorm, senderNorm, params.timestamp, windowSec, params.timestamp, windowSec) as { message_id: string } | undefined

    if (!row) return null

    // Update correlation with WAHA message ID
    this.db.prepare(
      'UPDATE pending_correlations SET waha_message_id = ? WHERE message_id = ?',
    ).run(params.wahaMessageId, row.message_id)

    // Also store in messages table for future ACK lookups
    this.queue.updateWahaMessageId(row.message_id, params.wahaMessageId)

    return {
      messageId: row.message_id,
      wahaMessageId: params.wahaMessageId,
    }
  }

  /**
   * Handle WAHA ACK event. Looks up correlation and emits
   * message:delivered (ACK >= 2) and message:read (ACK >= 3).
   */
  handleAck(wahaMessageId: string, ackLevel: number, timestamp: string): void {
    const row = this.db.prepare(
      'SELECT message_id, delivered_emitted, read_emitted FROM pending_correlations WHERE waha_message_id = ?',
    ).get(wahaMessageId) as { message_id: string; delivered_emitted: number; read_emitted: number } | undefined

    if (!row) return

    // ACK level 2 = device delivered
    if (ackLevel >= 2 && row.delivered_emitted === 0) {
      this.db.prepare(
        'UPDATE pending_correlations SET delivered_emitted = 1 WHERE message_id = ?',
      ).run(row.message_id)

      this.emitter.emit('message:delivered', {
        id: row.message_id,
        wahaMessageId,
        deliveredAt: timestamp,
      })
    }

    // ACK level 3 = read
    if (ackLevel >= 3 && row.read_emitted === 0) {
      this.db.prepare(
        'UPDATE pending_correlations SET read_emitted = 1 WHERE message_id = ?',
      ).run(row.message_id)

      this.emitter.emit('message:read', {
        id: row.message_id,
        wahaMessageId,
        readAt: timestamp,
      })
    }
  }

  /**
   * Remove expired correlations older than TTL (48 hours).
   */
  cleanup(): number {
    const ttlHours = CORRELATION_TTL_HOURS
    const result = this.db.prepare(
      "DELETE FROM pending_correlations WHERE created_at < datetime('now', '-' || ? || ' hours')",
    ).run(ttlHours)
    return result.changes
  }
}
