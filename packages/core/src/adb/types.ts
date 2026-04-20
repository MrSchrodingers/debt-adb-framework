export interface DeviceInfo {
  serial: string
  type: 'device' | 'offline' | 'unauthorized' | 'emulator' | 'unknown'
  brand?: string
  model?: string
}
