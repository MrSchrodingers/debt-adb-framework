import type { SenderMapping } from './sender-mapping.js'
import type { MessageQueue } from '../queue/message-queue.js'
import type { Message } from '../queue/types.js'
import { normalizeBrPhoneForMatching } from './receipt-tracker.js'

type FetchFn = (url: string, init: RequestInit) => Promise<Response>

export interface WahaFallbackResult {
  success: boolean
  wahaMessageId: string | null
}

export class WahaFallback {
  constructor(
    private senderMapping: SenderMapping,
    private queue: MessageQueue,
    private fetchFn: FetchFn,
    private wahaApiKey?: string,
  ) {}

  /**
   * Send a message via WAHA API as fallback when ADB fails.
   * Uses sender_mapping to find the WAHA session and API URL.
   */
  async send(message: Message): Promise<WahaFallbackResult> {
    const senderNumber = message.senderNumber
    if (!senderNumber) {
      throw new Error('No sender number on message for WAHA fallback')
    }

    const mapping = this.senderMapping.getByPhone(senderNumber)
    if (!mapping || !mapping.waha_session || !mapping.waha_api_url) {
      throw new Error(`No WAHA session configured for sender ${senderNumber}`)
    }

    // Normalize recipient to WAHA chatId format (12-digit + @c.us)
    const chatId = normalizeBrPhoneForMatching(message.to) + '@c.us'

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.wahaApiKey) {
      headers['X-Api-Key'] = this.wahaApiKey
    }

    const response = await this.fetchFn(`${mapping.waha_api_url}/api/sendText`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        session: mapping.waha_session,
        chatId,
        text: message.body,
      }),
    })

    if (!response.ok) {
      throw new Error(`WAHA API error: ${response.status} ${response.statusText}`)
    }

    const data = await response.json() as { id?: string }
    const wahaMessageId = data.id ?? null

    // Mark message as sent via fallback
    this.queue.markFallbackUsed(message.id, 'waha')

    if (wahaMessageId) {
      this.queue.updateWahaMessageId(message.id, wahaMessageId)
    }

    return { success: true, wahaMessageId }
  }
}
