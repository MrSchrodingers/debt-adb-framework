import { createHmac, timingSafeEqual } from 'node:crypto'
import type { DispatchEmitter } from '../events/index.js'
import type { MessageHistory } from './message-history.js'
import type { AckHistory } from './ack-history.js'
import type { MessageQueue } from '../queue/message-queue.js'
import type { WahaWebhookPayload, WahaMessagePayload } from './types.js'

export interface WebhookHandlerConfig {
  hmacSecret?: string
  queue?: MessageQueue
}

export interface WebhookResult {
  processed: boolean
  historyId?: string
  event: string
  deduplicated?: boolean
}

export class WebhookHandler {
  constructor(
    private readonly emitter: DispatchEmitter,
    private readonly history: MessageHistory,
    private readonly ackHistory: AckHistory,
    private readonly config: WebhookHandlerConfig = {},
  ) {}

  isHmacConfigured(): boolean {
    return !!this.config.hmacSecret
  }

  validateHmac(body: string, signature: string): boolean {
    if (!this.config.hmacSecret) return false
    const expected = createHmac('sha512', this.config.hmacSecret)
      .update(body)
      .digest('hex')

    // Use timing-safe comparison to prevent timing attacks
    try {
      const sigBuf = Buffer.from(signature, 'hex')
      const expBuf = Buffer.from(expected, 'hex')
      if (sigBuf.length !== expBuf.length) return false
      return timingSafeEqual(sigBuf, expBuf)
    } catch {
      return false
    }
  }

  async processWebhook(payload: WahaWebhookPayload): Promise<WebhookResult> {
    switch (payload.event) {
      case 'message':
      case 'message.any':
        return this.handleMessage(payload)
      case 'session.status':
        return this.handleSessionStatus(payload)
      case 'message.ack':
        return this.handleAck(payload)
      default:
        return { processed: false, event: payload.event }
    }
  }

  private handleMessage(payload: WahaWebhookPayload): WebhookResult {
    const msg = payload.payload as unknown as WahaMessagePayload
    const sessionMe = payload.me?.id.replace('@c.us', '') ?? ''

    // Determine direction: if from == session owner, it's outgoing
    const fromNumber = msg.from?.replace('@c.us', '') ?? ''
    const toNumber = msg.to?.replace('@c.us', '') ?? fromNumber
    const isOutgoing = fromNumber === sessionMe

    // For outgoing messages: check dedup against ADB sends
    if (isOutgoing) {
      const wahaTimestamp = new Date(msg.timestamp * 1000).toISOString()
      const existing = this.history.findByDedup(toNumber, wahaTimestamp, 30)

      if (existing) {
        // Update existing ADB record with WAHA message ID
        this.history.updateWithWahaId(existing.id, msg.id)
        // Correlation fix: copy waha_message_id to messages table
        if (this.config.queue && existing.messageId) {
          this.config.queue.updateWahaMessageId(existing.messageId, msg.id)
        }
        this.emitter.emit('waha:message_sent', {
          sessionName: payload.session,
          fromNumber,
          toNumber,
          historyId: existing.id,
          deduplicated: true,
          wahaMessageId: msg.id,
        })
        return { processed: true, historyId: existing.id, event: payload.event, deduplicated: true }
      }
    }

    // Insert new record (incoming, or outgoing not from Dispatch)
    const historyId = this.history.insert({
      direction: isOutgoing ? 'outgoing' : 'incoming',
      fromNumber,
      toNumber: isOutgoing ? toNumber : sessionMe,
      text: msg.body || null,
      mediaType: msg.media?.mimetype ?? null,
      wahaMessageId: msg.id,
      wahaSessionName: payload.session,
      capturedVia: 'waha_webhook',
    })

    const eventName = isOutgoing ? 'waha:message_sent' : 'waha:message_received'
    this.emitter.emit(eventName, {
      sessionName: payload.session,
      fromNumber,
      toNumber: isOutgoing ? toNumber : sessionMe,
      historyId,
      ...(isOutgoing ? { deduplicated: false } : {}),
    })

    return { processed: true, historyId, event: payload.event, deduplicated: false }
  }

  private handleSessionStatus(payload: WahaWebhookPayload): WebhookResult {
    const status = (payload.payload as { status?: string }).status ?? 'unknown'
    const phoneNumber = payload.me?.id.replace('@c.us', '')

    this.emitter.emit('waha:session_status', {
      sessionName: payload.session,
      status,
      phoneNumber,
    })

    return { processed: true, event: payload.event }
  }

  private handleAck(payload: WahaWebhookPayload): WebhookResult {
    const ack = payload.payload as unknown as {
      id?: string
      ack?: number
      ackName?: string
      timestamp?: number
    }

    if (ack.id) {
      const ackLevel = ack.ack ?? 0
      const ackNames: Record<number, string> = {
        [-1]: 'error',
        0: 'pending',
        1: 'server',
        2: 'device',
        3: 'read',
        4: 'played',
      }
      const ackLevelName = ackNames[ackLevel] ?? 'unknown'
      const ackTimestamp = new Date((ack.timestamp ?? 0) * 1000).toISOString()
      const deliveredAt = ackLevel >= 2 ? ackTimestamp : null
      const readAt = ackLevel >= 3 ? ackTimestamp : null

      // Persist ack for the calibrator (research/ack-rate-calibrator.ts).
      // INSERT OR IGNORE makes this idempotent across webhook replays.
      // Persistence failure must NOT 500 the webhook — that triggers WAHA
      // retry storms. Log and continue; the emitter event still fires below.
      try {
        this.ackHistory.insert({
          wahaMessageId: ack.id,
          ackLevel,
          ackLevelName,
          deliveredAt,
          readAt,
        })
      } catch (err) {
        this.emitter.emit('waha:ack_persist_failed', {
          wahaMessageId: ack.id,
          ackLevel,
          error: err instanceof Error ? err.message : String(err),
        })
      }

      this.emitter.emit('waha:message_ack', {
        wahaMessageId: ack.id,
        ackLevel,
        ackLevelName,
        deliveredAt,
        readAt,
      })
    }

    return { processed: true, event: payload.event }
  }
}
