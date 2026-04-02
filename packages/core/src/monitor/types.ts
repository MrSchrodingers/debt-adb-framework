export interface HealthSnapshot {
  serial: string
  batteryPercent: number
  temperatureCelsius: number
  ramAvailableMb: number
  storageFreeBytes: number
  wifiConnected: boolean
  collectedAt: string
}

export type AlertSeverity = 'critical' | 'high' | 'medium' | 'low'

export type AlertType =
  | 'battery_low'
  | 'battery_critical'
  | 'ram_low'
  | 'temperature_high'
  | 'temperature_critical'
  | 'storage_low'
  | 'device_offline'
  | 'wa_crash'

export interface Alert {
  id: string
  deviceSerial: string
  severity: AlertSeverity
  type: AlertType
  message: string
  resolved: number
  resolvedAt: string | null
  createdAt: string
}

export interface WhatsAppAccount {
  deviceSerial: string
  profileId: number
  packageName: 'com.whatsapp' | 'com.whatsapp.w4b'
  phoneNumber: string | null
}

export interface DeviceRecord {
  serial: string
  brand: string | null
  model: string | null
  status: 'online' | 'offline' | 'unauthorized'
  lastSeenAt: string
  alertThresholds: string | null
}
