export interface EnqueueParams {
  to: string
  body: string
  idempotencyKey: string
  priority?: number
  senderNumber?: string
  pluginName?: string
  correlationId?: string
  sendersConfig?: string
  context?: string
  maxRetries?: number
}

export interface Message {
  id: string
  to: string
  body: string
  idempotencyKey: string
  priority: number
  senderNumber: string | null
  status: MessageStatus
  attempts: number
  lockedBy: string | null
  lockedAt: string | null
  createdAt: string
  updatedAt: string
  pluginName: string | null
  correlationId: string | null
  sendersConfig: string | null
  context: string | null
  wahaMessageId: string | null
  maxRetries: number
}

export type MessageStatus =
  | 'queued'
  | 'locked'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'permanently_failed'
  | 'waiting_device'
