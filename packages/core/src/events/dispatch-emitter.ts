import { EventEmitter } from 'node:events'
import type { AlertSeverity, AlertType } from '../monitor/types.js'

export interface DispatchEventMap {
  'message:queued': { id: string; to: string; priority: number }
  'message:sending': { id: string; deviceSerial: string }
  'message:sent': { id: string; sentAt: string; durationMs: number }
  'message:failed': { id: string; error: string }
  'device:connected': { serial: string; brand?: string; model?: string }
  'device:disconnected': { serial: string }
  'device:health': { serial: string; batteryPercent: number; temperatureCelsius: number; ramAvailableMb: number; storageFreeBytes: number }
  'alert:new': { id: string; deviceSerial: string; severity: AlertSeverity; type: AlertType; message: string }
  'waha:message_received': { sessionName: string; fromNumber: string; toNumber: string; historyId: string }
  'waha:message_sent': { sessionName: string; fromNumber: string; toNumber: string; historyId: string; deduplicated: boolean }
  'waha:session_status': { sessionName: string; status: string; phoneNumber?: string }
  'waha:message_ack': { wahaMessageId: string; ackLevel: number; ackLevelName: string; deliveredAt: string | null; readAt: string | null }
}

export type DispatchEventName = keyof DispatchEventMap

export class DispatchEmitter extends EventEmitter {
  override emit<K extends DispatchEventName>(event: K, data: DispatchEventMap[K]): boolean {
    return super.emit(event, data)
  }

  override on<K extends DispatchEventName>(
    event: K,
    listener: (data: DispatchEventMap[K]) => void,
  ): this {
    return super.on(event, listener)
  }
}
