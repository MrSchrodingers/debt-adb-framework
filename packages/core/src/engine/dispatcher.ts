import type Database from 'better-sqlite3'
import type { SenderState } from './types.js'
import type { DeviceRecord, HealthSnapshot } from '../monitor/types.js'

export interface DispatchDecision {
  senderNumber: string
  deviceSerial: string
  profileId: number
}

/**
 * Calculate a health score for a device based on its snapshot.
 * Higher is better.
 */
export function computeHealthScore(snapshot: HealthSnapshot): number {
  const battery = snapshot.batteryPercent * 0.3
  const temp = (100 - snapshot.temperatureCelsius) * 0.3
  const ram = (snapshot.ramAvailableMb / 1000) * 0.2
  const storage = Math.min(snapshot.storageFreeBytes / 1e9, 100) * 0.2

  let score = battery + temp + ram + storage

  // Deprioritize devices with critically low battery
  if (snapshot.batteryPercent < 15) {
    score *= 0.1
  }

  return score
}

/**
 * Check if a device has an active (unresolved) ban alert.
 */
function hasBanAlert(serial: string, db: Database.Database): boolean {
  const row = db.prepare(
    "SELECT 1 FROM alerts WHERE device_serial = ? AND type = 'waha_session_banned' AND resolved = 0 LIMIT 1"
  ).get(serial)
  return row !== undefined
}

/**
 * Select the best device for sending based on health score.
 * Skips offline devices, banned devices, and devices without health data.
 * Returns null if no device is eligible.
 */
export function selectDevice(
  devices: DeviceRecord[],
  healthMap: Map<string, HealthSnapshot>,
  db: Database.Database,
): DeviceRecord | null {
  const onlineDevices = devices.filter(d => d.status === 'online')

  let bestDevice: DeviceRecord | null = null
  let bestScore = -Infinity

  for (const device of onlineDevices) {
    // Skip devices without health data
    const snapshot = healthMap.get(device.serial)
    if (!snapshot) continue

    // Skip banned devices
    if (hasBanAlert(device.serial, db)) continue

    const score = computeHealthScore(snapshot)
    if (score > bestScore) {
      bestScore = score
      bestDevice = device
    }
  }

  return bestDevice
}

export class Dispatcher {
  constructor(private now: () => number = Date.now) {}

  async selectSender(availableNumbers: SenderState[]): Promise<DispatchDecision | null> {
    const currentTime = this.now()

    const eligible = availableNumbers.filter(s => {
      if (s.banned) return false
      if (s.cooldownExpiresAt !== null && s.cooldownExpiresAt > currentTime) return false
      return true
    })

    if (eligible.length === 0) return null

    eligible.sort((a, b) => a.sendCountInWindow - b.sendCountInWindow)

    const selected = eligible[0]
    return {
      senderNumber: selected.senderNumber,
      deviceSerial: selected.deviceSerial ?? '',
      profileId: selected.profileId ?? 0,
    }
  }

  async getNextDispatchTime(availableNumbers: SenderState[]): Promise<number | null> {
    const nonBanned = availableNumbers.filter(s => !s.banned)
    if (nonBanned.length === 0) return null

    const ready = nonBanned.find(s => s.cooldownExpiresAt === null)
    if (ready) return this.now()

    let earliest = Infinity
    for (const s of nonBanned) {
      if (s.cooldownExpiresAt !== null && s.cooldownExpiresAt < earliest) {
        earliest = s.cooldownExpiresAt
      }
    }

    return earliest === Infinity ? null : earliest
  }

  isAllBanned(senderStates: SenderState[]): boolean {
    if (senderStates.length === 0) return true
    return senderStates.every(s => s.banned)
  }
}
