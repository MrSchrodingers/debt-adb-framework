import type Database from 'better-sqlite3'
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
 * Get all device serials with active (unresolved) ban alerts in a single query.
 */
function getBannedSerials(db: Database.Database): Set<string> {
  const rows = db.prepare(
    "SELECT DISTINCT device_serial FROM alerts WHERE type = 'waha_session_banned' AND resolved = 0"
  ).all() as Array<{ device_serial: string }>
  return new Set(rows.map(r => r.device_serial))
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
  const bannedSerials = getBannedSerials(db)

  let bestDevice: DeviceRecord | null = null
  let bestScore = -Infinity

  for (const device of onlineDevices) {
    const snapshot = healthMap.get(device.serial)
    if (!snapshot) continue

    if (bannedSerials.has(device.serial)) continue

    const score = computeHealthScore(snapshot)
    if (score > bestScore) {
      bestScore = score
      bestDevice = device
    }
  }

  return bestDevice
}

