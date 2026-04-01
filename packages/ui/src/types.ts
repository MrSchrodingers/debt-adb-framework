export interface DeviceInfo {
  serial: string
  type: 'device' | 'offline' | 'unauthorized' | 'emulator' | 'unknown'
  brand?: string
  model?: string
}

export interface Message {
  id: string
  to: string
  body: string
  idempotencyKey: string
  priority: number
  senderNumber: string | null
  status: 'queued' | 'locked' | 'sending' | 'sent' | 'failed'
  lockedBy: string | null
  lockedAt: string | null
  createdAt: string
  updatedAt: string
}
