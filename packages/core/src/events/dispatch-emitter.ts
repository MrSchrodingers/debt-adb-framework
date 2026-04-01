import { EventEmitter } from 'node:events'

export interface DispatchEventMap {
  'message:queued': { id: string; to: string; priority: number }
  'message:sending': { id: string; deviceSerial: string }
  'message:sent': { id: string; sentAt: string; durationMs: number }
  'message:failed': { id: string; error: string }
  'device:connected': { serial: string; brand?: string; model?: string }
  'device:disconnected': { serial: string }
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
