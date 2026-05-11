import type { AdbShellAdapter } from '../monitor/types.js'

/**
 * Why a device is not ready. The classification is what callers branch on —
 * `device_offline` and `adb_shell_failed` warrant a wait-and-retry; the
 * other two usually indicate the operator needs to intervene (e.g. unlock
 * screen, re-open WhatsApp), but we still retry briefly in case the state
 * was transient.
 */
export type DeviceUnreadyReason =
  | 'device_offline'
  | 'boot_not_completed'
  | 'app_not_running'
  | 'adb_shell_failed'

export interface DeviceReadiness {
  ok: boolean
  reason?: DeviceUnreadyReason
  /** Raw error message or output, capped for log-friendliness. */
  detail?: string
}

/**
 * Heuristic patterns we treat as "device is gone, not just the shell call
 * failing on a specific command". Matches adbkit's typical wording when
 * the device is unplugged, offline, or the server can't reach it.
 */
const OFFLINE_PATTERNS = [
  /device.*not\s+found/i,
  /device.*offline/i,
  /no\s+devices?\/emulators?\s+found/i,
  /connection\s+refused/i,
  /unauthorized/i,
  /not\s+connected/i,
]

function classifyShellError(message: string): DeviceUnreadyReason {
  return OFFLINE_PATTERNS.some((p) => p.test(message)) ? 'device_offline' : 'adb_shell_failed'
}

/**
 * Returns whether the device is currently in a state where the L3 ADB
 * probe pipeline can succeed. Three checks, in order of how cheaply they
 * signal a known failure mode:
 *
 *   1. `getprop sys.boot_completed` — must read `"1"`. Catches devices
 *      that just rebooted (e.g. after `reboot` in a stuck-WA recovery)
 *      and aren't fully up yet, and devices that are entirely
 *      disconnected (shell throws).
 *   2. `pidof <appPackage>` — must return at least one PID. Catches
 *      WhatsApp force-closed by Android (low-memory killer, manual
 *      stop, OS update post-reboot, etc.). Only run when `appPackage`
 *      is supplied.
 *
 * Test boundary: takes an `AdbShellAdapter` (interface), not a concrete
 * `AdbBridge`. Production wiring passes the same adapter the
 * `AdbProbeStrategy` is built with — so this function shares connection
 * and timeout behaviour with the real probe.
 */
export async function checkDeviceReady(
  adb: AdbShellAdapter,
  serial: string,
  opts: { appPackage?: string } = {},
): Promise<DeviceReadiness> {
  let boot: string
  try {
    boot = await adb.shell(serial, 'getprop sys.boot_completed')
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    return { ok: false, reason: classifyShellError(detail), detail: detail.slice(0, 200) }
  }
  if (boot.trim() !== '1') {
    return { ok: false, reason: 'boot_not_completed', detail: boot.trim().slice(0, 80) }
  }
  if (opts.appPackage) {
    let pid: string
    try {
      pid = await adb.shell(serial, `pidof ${opts.appPackage}`)
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e)
      return { ok: false, reason: classifyShellError(detail), detail: detail.slice(0, 200) }
    }
    if (!pid.trim()) {
      return { ok: false, reason: 'app_not_running', detail: `pidof ${opts.appPackage} returned empty` }
    }
  }
  return { ok: true }
}
