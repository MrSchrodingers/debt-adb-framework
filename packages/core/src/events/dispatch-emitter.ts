import { EventEmitter } from 'node:events'
import type { AlertSeverity, AlertType } from '../monitor/types.js'

export interface DispatchEventMap {
  'message:queued': { id: string; to: string; priority: number }
  'message:sending': { id: string; deviceSerial: string }
  'message:sent': {
    id: string; sentAt: string; durationMs: number; deviceSerial: string;
    contactRegistered: boolean; dialogsDismissed: number;
    strategyMethod?: string; appPackage?: string;
    isFirstContact?: boolean; interMessageDelayMs?: number;
    senderNumber?: string;
  }
  'message:failed': {
    id: string; error: string;
    attempts?: number; wasQuarantined?: boolean;
    lastStrategyMethod?: string; senderNumber?: string;
  }
  'device:connected': { serial: string; brand?: string; model?: string }
  'device:disconnected': { serial: string }
  'device:health': { serial: string; batteryPercent: number; temperatureCelsius: number; ramAvailableMb: number; storageFreeBytes: number }
  'alert:new': { id: string; deviceSerial: string; severity: AlertSeverity; type: AlertType; message: string }
  'waha:message_received': { sessionName: string; fromNumber: string; toNumber: string; historyId: string }
  'waha:message_sent': { sessionName: string; fromNumber: string; toNumber: string; historyId: string; deduplicated: boolean; wahaMessageId?: string }
  'waha:session_status': { sessionName: string; status: string; phoneNumber?: string }
  'waha:message_ack': { wahaMessageId: string; ackLevel: number; ackLevelName: string; deliveredAt: string | null; readAt: string | null }
  'message:delivered': { id: string; wahaMessageId: string; deliveredAt: string }
  'message:read': { id: string; wahaMessageId: string; readAt: string }
  'contact:opted_out': { phone: string; pattern: string; sourceSession: string; messageText: string }
  'sender:quarantined': { sender: string; failureCount: number; quarantinedUntil: string }
  'sender:released': { sender: string; quarantineDurationActualMs: number }
  'device:circuit:opened': {
    serial: string
    reason: string
    openedAt: string
    nextAttemptAt: string
    consecutiveFailures: number
  }
  'device:circuit:half_open': { serial: string }
  'device:circuit:closed': { serial: string }
  'number:invalid': {
    id: string
    phone_input: string
    phone_normalized: string
    source: 'cache' | 'adb_probe' | 'waha' | 'send_failure'
    confidence: number | null
    check_id: string
    detected_at: string
    correlation_id?: string
  }
  'config:reloaded': { components: number; failed: number }
  'config:reload_failed': { components: number; failed: number; errors: Array<{ name: string; error: string }> }
  'ban_prediction:triggered': { serial: string; suspectCount: number; windowMs: number }
  'dispatch:paused': { action: 'pause'; scope: string; key: string; reason: string; by: string; at: string }
  'dispatch:resumed': { action: 'resume'; scope: string; key: string; reason: string; by: string; at: string }
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
