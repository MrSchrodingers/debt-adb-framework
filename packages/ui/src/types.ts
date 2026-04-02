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

export interface DeviceRecord {
  serial: string
  brand: string | null
  model: string | null
  status: 'online' | 'offline' | 'unauthorized'
  lastSeenAt: string
  alertThresholds: string | null
}

export interface HealthSnapshot {
  serial: string
  batteryPercent: number
  temperatureCelsius: number
  ramAvailableMb: number
  storageFreeBytes: number
  wifiConnected: boolean
  collectedAt: string
}

export interface Alert {
  id: string
  deviceSerial: string
  severity: 'critical' | 'high' | 'medium' | 'low'
  type: string
  message: string
  resolved: number
  resolvedAt: string | null
  createdAt: string
}

export interface WhatsAppAccount {
  deviceSerial: string
  profileId: number
  packageName: string
  phoneNumber: string | null
}
