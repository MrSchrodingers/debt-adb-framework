export interface EnqueueParams {
  to: string
  body: string
  idempotencyKey: string
  priority?: number
  senderNumber?: string
}

export interface Message {
  id: string
  to: string
  body: string
  idempotencyKey: string
  priority: number
  senderNumber: string | null
  status: MessageStatus
  lockedBy: string | null
  lockedAt: string | null
  createdAt: string
  updatedAt: string
}

export type MessageStatus = 'queued' | 'locked' | 'sending' | 'sent' | 'failed'
