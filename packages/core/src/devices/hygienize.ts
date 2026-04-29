import { getBloatPackages, BLOAT_GREP_PATTERNS } from './bloat-list.js'

/**
 * Per-device hygiene routine — extracted from `api/devices.ts` so it can be
 * called from BOTH the manual REST endpoint and the auto-trigger that fires
 * on `device:connected`.
 *
 * Standardized flow:
 *   1. Switch to user 0 (entry point).
 *   2. Discover profiles.
 *   3. For each profile: switch → settings → uninstall bloat → ensure
 *      essentials → force-stop noisy services → verify settings.
 *   4. Run a verification pass (`pm list packages --user N`) to detect
 *      packages that survived the uninstall (system-signed, etc).
 *   5. Switch back to user 0.
 *   6. Wake screen.
 *
 * SECURITY: `serial` is operator-supplied via the route param. We never
 * interpolate it into a shell string with quoted user input — `adb.shell`
 * runs a fixed command list. Package names come from a constant whitelist
 * (`bloat-list.ts`).
 */

export interface HygienizeAdb {
  shell: (serial: string, cmd: string) => Promise<string>
}

export interface HygienizeOptions {
  aggressive?: boolean
  /** If true, skip the post-pass verification (faster, less observable). */
  skipVerification?: boolean
}

export interface HygienizeResult {
  serial: string
  profilesProcessed: number[]
  bloatRemovedCount: number
  perProfileLog: Record<number, string>
  /** Map of profile_id → packages still present that match a bloat grep pattern. */
  survivedPackages: Record<number, string[]>
  steps: Record<string, string>
}

const SETTINGS_COMMANDS = [
  'locksettings clear --old 12345',
  'locksettings set-disabled true',
  'settings put system screen_off_timeout 2147483647',
  'settings put system screen_brightness 255',
  'settings put system screen_brightness_mode 0',
  'svc power stayon usb',
  'cmd notification set_dnd priority',
  'settings put secure notification_badging 0',
  'settings put system ringtone_volume 0',
  'settings put system notification_sound_volume 0',
  'settings put system alarm_volume 0',
  'settings put system vibrate_when_ringing 0',
  'settings put system haptic_feedback_enabled 0',
] as const

const ESSENTIAL_PACKAGES = [
  'com.whatsapp',
  'com.whatsapp.w4b',
  'com.android.contacts',
  'com.android.providers.contacts',
] as const

const NOISY_SERVICES = [
  'com.google.android.gms',
  'com.google.android.gsf',
  'com.google.android.safetycore',
] as const

async function getCurrentUser(adb: HygienizeAdb, serial: string): Promise<number> {
  const out = (await adb.shell(serial, 'am get-current-user')).trim()
  return Number(out)
}

async function switchUserVerified(
  adb: HygienizeAdb,
  serial: string,
  targetUid: number,
  timeoutMs = 15_000,
): Promise<boolean> {
  const current = await getCurrentUser(adb, serial)
  if (current === targetUid) return true
  await adb.shell(serial, `am switch-user ${targetUid}`)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500))
    try {
      if ((await getCurrentUser(adb, serial)) === targetUid) return true
    } catch {
      /* retry */
    }
  }
  return false
}

async function ensureUserZero(adb: HygienizeAdb, serial: string): Promise<boolean> {
  return switchUserVerified(adb, serial, 0)
}

async function getProfileIds(adb: HygienizeAdb, serial: string): Promise<number[]> {
  try {
    const out = await adb.shell(serial, 'pm list users')
    return [...out.matchAll(/UserInfo\{(\d+):/g)].map((m) => Number(m[1]))
  } catch {
    return [0]
  }
}

async function verifySetting(
  adb: HygienizeAdb,
  serial: string,
  namespace: string,
  key: string,
  expected: string,
): Promise<boolean> {
  try {
    const actual = (await adb.shell(serial, `settings get ${namespace} ${key}`)).trim()
    return actual === expected
  } catch {
    return false
  }
}

/**
 * Detect bloat that survived `pm uninstall` (typically: system-signed apps).
 * Returns the list of installed package names matching any
 * BLOAT_GREP_PATTERNS entry. Empty list means clean.
 */
async function detectSurvivors(
  adb: HygienizeAdb,
  serial: string,
  uid: number,
): Promise<string[]> {
  try {
    const out = await adb.shell(serial, `pm list packages --user ${uid}`)
    const installed = out
      .split('\n')
      .map((line) => line.replace('package:', '').trim())
      .filter(Boolean)
    const survivors = installed.filter((pkg) =>
      BLOAT_GREP_PATTERNS.some((pat) => pkg.toLowerCase().includes(pat)),
    )
    return survivors
  } catch {
    return []
  }
}

export async function hygienizeDevice(
  adb: HygienizeAdb,
  serial: string,
  opts: HygienizeOptions = {},
): Promise<HygienizeResult> {
  const steps: Record<string, string> = {}
  const bloatPackages = getBloatPackages({ aggressive: opts.aggressive ?? false })

  const startedOnZero = await ensureUserZero(adb, serial)
  steps.initial_state = startedOnZero ? 'P0:ok' : 'P0:forced'

  const profileIds = await getProfileIds(adb, serial)
  steps.profiles_found = profileIds.join(', ')

  let totalRemoved = 0
  const perProfileLog: Record<number, string> = {}
  const survivedPackages: Record<number, string[]> = {}

  for (const uid of profileIds) {
    const log: string[] = []

    const switched = await switchUserVerified(adb, serial, uid)
    if (!switched) {
      log.push('FALHOU: switch-user timeout (15s)')
      perProfileLog[uid] = log.join(', ')
      continue
    }
    log.push('switch:ok')

    let settingsOk = 0
    for (const cmd of SETTINGS_COMMANDS) {
      try {
        await adb.shell(serial, cmd)
        settingsOk++
      } catch {
        /* ignore */
      }
    }
    log.push(`settings:${settingsOk}/${SETTINGS_COMMANDS.length}`)

    let removed = 0
    for (const pkg of bloatPackages) {
      try {
        // Two-phase removal: first try -k (keep data) then full uninstall.
        // `pm uninstall --user N <pkg>` is more aggressive than `-k`.
        // We accept either as success.
        const out1 = await adb.shell(serial, `pm uninstall -k --user ${uid} ${pkg}`)
        if (out1.includes('Success')) {
          removed++
          continue
        }
        // Fall back to non-keep variant for stubborn packages
        const out2 = await adb.shell(serial, `pm uninstall --user ${uid} ${pkg}`)
        if (out2.includes('Success')) removed++
      } catch {
        /* skip */
      }
    }
    totalRemoved += removed
    log.push(`bloat:${removed}`)

    for (const pkg of ESSENTIAL_PACKAGES) {
      try {
        await adb.shell(serial, `cmd package install-existing --user ${uid} ${pkg}`)
      } catch {
        /* ignore */
      }
    }
    log.push('pkgs:ensured')

    for (const svc of NOISY_SERVICES) {
      try {
        await adb.shell(serial, `am force-stop ${svc}`)
      } catch {
        /* ignore */
      }
    }

    const briOk = await verifySetting(adb, serial, 'system', 'screen_brightness', '255')
    const toOk = await verifySetting(adb, serial, 'system', 'screen_off_timeout', '2147483647')
    const dndOk = await verifySetting(adb, serial, 'global', 'zen_mode', '1')
    log.push(
      `verify:bri=${briOk ? 'ok' : 'FAIL'},timeout=${toOk ? 'ok' : 'FAIL'},dnd=${dndOk ? 'ok' : 'FAIL'}`,
    )

    if (!opts.skipVerification) {
      const survivors = await detectSurvivors(adb, serial, uid)
      survivedPackages[uid] = survivors
      log.push(`survivors:${survivors.length}`)
    }

    perProfileLog[uid] = log.join(', ')
  }

  steps.bloat_removed = `${totalRemoved} total`
  steps.per_user = JSON.stringify(perProfileLog)
  if (!opts.skipVerification) {
    steps.survived = JSON.stringify(survivedPackages)
  }

  const backedToZero = await ensureUserZero(adb, serial)
  steps.switched_back = backedToZero ? 'P0:ok' : 'P0:FAILED'

  try {
    await adb.shell(serial, 'input keyevent KEYCODE_WAKEUP')
  } catch {
    /* ignore */
  }

  return {
    serial,
    profilesProcessed: profileIds,
    bloatRemovedCount: totalRemoved,
    perProfileLog,
    survivedPackages,
    steps,
  }
}
