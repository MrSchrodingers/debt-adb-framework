import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AdbBridge } from '../adb/index.js'
import { IpRateLimiter } from './rate-limiter.js'
import { hygienizeDevice, type HygieneLog, type AutoHygiene } from '../devices/index.js'
import {
  extractPhonesViaRoot,
  isDeviceRooted,
  type WaAccountMapper,
} from '../monitor/index.js'
import type { ChipRegistry } from '../fleet/index.js'
import type { AuditLogger } from '../config/audit-logger.js'

const shellRateLimiter = new IpRateLimiter({ maxRequests: 10, windowMs: 60_000 })
const shellSchema = z.object({ command: z.string().min(1).max(4096) })

// ── Shared user-switch utilities (used by hygienize, switch-user, scan-number) ──

interface AdbShell {
  shell: (serial: string, cmd: string) => Promise<string>
}

/** Get current foreground Android user ID */
async function getCurrentUser(adb: AdbShell, serial: string): Promise<number> {
  const out = (await adb.shell(serial, 'am get-current-user')).trim()
  return Number(out)
}

/** Switch to target user with polling verification. Returns true if successful. */
async function switchUserVerified(adb: AdbShell, serial: string, targetUid: number, timeoutMs = 15_000): Promise<boolean> {
  const current = await getCurrentUser(adb, serial)
  if (current === targetUid) return true // already on correct user

  await adb.shell(serial, `am switch-user ${targetUid}`)

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500))
    try {
      if (await getCurrentUser(adb, serial) === targetUid) return true
    } catch { /* retry */ }
  }
  return false
}

/** Ensure device is on user 0. Call at the START and END of any multi-user operation. */
async function ensureUserZero(adb: AdbShell, serial: string): Promise<boolean> {
  return switchUserVerified(adb, serial, 0)
}

/** Check if keyguard (lock screen) is showing */
async function isScreenLocked(adb: AdbShell, serial: string): Promise<boolean> {
  try {
    const out = await adb.shell(serial, 'dumpsys window | grep isKeyguardShowing')
    return out.includes('true')
  } catch { return false }
}

/** Remove PIN + disable lock + dismiss keyguard. Works via ADB shell without UI. */
async function unlockScreen(adb: AdbShell, serial: string, pin = '12345'): Promise<boolean> {
  // Step 1: Remove PIN credential (works even when locked)
  try { await adb.shell(serial, `locksettings clear --old ${pin}`) } catch { /* no PIN set */ }
  // Step 2: Disable lock screen
  try { await adb.shell(serial, 'locksettings set-disabled true') } catch { /* ignore */ }
  // Step 3: Wake screen + dismiss keyguard
  try { await adb.shell(serial, 'input keyevent KEYCODE_POWER') } catch { /* ignore */ }
  await new Promise(r => setTimeout(r, 500))
  try { await adb.shell(serial, 'input keyevent KEYCODE_WAKEUP') } catch { /* ignore */ }
  await new Promise(r => setTimeout(r, 500))
  try { await adb.shell(serial, 'input keyevent 82') } catch { /* MENU dismisses keyguard */ }
  await new Promise(r => setTimeout(r, 1500))

  // Verify unlocked (poll for up to 5s)
  for (let i = 0; i < 10; i++) {
    if (!(await isScreenLocked(adb, serial))) return true
    await new Promise(r => setTimeout(r, 500))
  }
  return false
}

/** Switch user + unlock screen. Full verified flow. */
async function switchAndUnlock(adb: AdbShell, serial: string, targetUid: number): Promise<{ switched: boolean; unlocked: boolean }> {
  const switched = await switchUserVerified(adb, serial, targetUid)
  if (!switched) return { switched: false, unlocked: false }
  const unlocked = await unlockScreen(adb, serial)
  return { switched: true, unlocked }
}

export interface DeviceRoutesDeps {
  hygieneLog?: HygieneLog
  autoHygiene?: AutoHygiene
  waMapper?: WaAccountMapper
  /**
   * Optional. When provided the scan-number / scan-all-numbers endpoints
   * trigger an idempotent chip auto-import after persisting the phone, so
   * the Frota → Chips tab reflects new numbers without a separate click.
   */
  chipRegistry?: ChipRegistry
  /**
   * Optional. When provided the launch-wa / bypass-setup-wizard endpoints
   * record an audit_log entry per call. Profile cards in the UI rely on
   * this trail to debug "why did the operator just open WA in P10?".
   */
  auditLogger?: AuditLogger
}

/**
 * UIAutomator-driven scrape of the WhatsApp "Profile" screen for the current
 * Android user. Caller is responsible for switching/unlocking the user
 * BEFORE invoking and for returning to user 0 AFTER. Returns the registered
 * phone (digits only) or `null` when the avatar/profile screen could not be
 * reached (locked screen, first-time setup, ANR, etc).
 *
 * Extracted so `POST /:serial/profiles/:profileId/scan-number` and
 * `POST /:serial/scan-all-numbers` share one implementation. Keeping it
 * private to this module — the only callers are the two route handlers.
 */
/**
 * Helper: read foreground app from `dumpsys window`.
 * Returns the trimmed lowercase string we use both for diagnostic display
 * and for substring containment checks.
 */
async function readForegroundApp(
  adb: { shell: (serial: string, cmd: string) => Promise<string> },
  serial: string,
): Promise<string> {
  try {
    const out = await adb.shell(
      serial,
      'dumpsys window | grep -E "mCurrentFocus|mFocusedApp" | head -2',
    )
    return out.trim()
  } catch {
    return ''
  }
}

/**
 * Best-effort WA launch with `am start -n HomeActivity` then a LAUNCHER
 * intent fallback. Some never-opened profiles report `am start -n ...
 * does not exist` because PackageManager hasn't indexed the activity yet
 * — the LAUNCHER intent works in that case.
 *
 * Returns the raw `am start` output (or fallback output) for diagnostics.
 * Does NOT verify foreground — callers do that.
 */
async function amStartWaWithFallback(
  adb: { shell: (serial: string, cmd: string) => Promise<string> },
  serial: string,
  uid: number,
  pkg: 'com.whatsapp' | 'com.whatsapp.w4b',
): Promise<{ output: string; fallback: boolean }> {
  const homeActivity = `${pkg}/com.whatsapp.home.ui.HomeActivity`
  const primary = (await adb.shell(serial, `am start --user ${uid} -n ${homeActivity} 2>&1`)).trim()
  const lower = primary.toLowerCase()
  if (
    lower.includes('error') ||
    lower.includes('does not exist') ||
    lower.includes('not found')
  ) {
    const fallback = (
      await adb.shell(
        serial,
        `am start --user ${uid} -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -p ${pkg} 2>&1`,
      )
    ).trim()
    return { output: `${primary} | fallback: ${fallback}`, fallback: true }
  }
  return { output: primary || 'ok', fallback: false }
}

async function extractWaPhoneViaUiAutomator(
  adb: AdbBridge,
  serial: string,
  profileId: number,
): Promise<{ phone: string | null; foreground: string; error?: string }> {
  // Helper: dump UI, find element by pattern, return center coords.
  async function findElement(pattern: RegExp): Promise<{ x: number; y: number } | null> {
    await adb.shell(serial, 'uiautomator dump /sdcard/_scan.xml')
    const xml = await adb.shell(serial, 'cat /sdcard/_scan.xml')
    const match = xml.match(pattern)
    if (!match) return null
    const boundsMatch = match[0].match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/)
    if (!boundsMatch) return null
    return {
      x: Math.round((Number(boundsMatch[1]) + Number(boundsMatch[3])) / 2),
      y: Math.round((Number(boundsMatch[2]) + Number(boundsMatch[4])) / 2),
    }
  }

  // Open WA on the requested user (with LAUNCHER intent fallback when the
  // explicit activity is not yet known to PackageManager).
  await amStartWaWithFallback(adb, serial, profileId, 'com.whatsapp')
  await new Promise((r) => setTimeout(r, 3000))

  // Verify WA actually came to the foreground BEFORE driving UIAutomator.
  // Without this guard we end up scraping whatever Activity happens to be
  // on top (Settings, launcher, …) and matching unrelated text — which is
  // exactly Bug #1 reported in production: "Detectar abre Configurações".
  const foreground = await readForegroundApp(adb, serial)
  if (!foreground.toLowerCase().includes('com.whatsapp')) {
    return {
      phone: null,
      foreground,
      error:
        `WhatsApp não veio para o foreground em P${profileId}. Foreground atual: ` +
        `${foreground.slice(0, 200) || '(vazio)'}. Pode estar não-instalado, sem login, ou bloqueado por Setup Wizard. Use "Abrir WA" antes de "Detectar".`,
    }
  }

  // Step 1: overflow menu.
  const menuBtn = await findElement(/menuitem_overflow[^>]*bounds="[^"]*"/)
  if (menuBtn) {
    await adb.shell(serial, `input tap ${menuBtn.x} ${menuBtn.y}`)
  } else {
    await adb.shell(serial, 'input tap 680 124')
  }
  await new Promise((r) => setTimeout(r, 2000))

  // Step 2: Configurações.
  const configBtn = await findElement(/text="Configura[^"]*"[^>]*bounds="[^"]*"/)
  if (configBtn) {
    await adb.shell(serial, `input tap ${configBtn.x} ${configBtn.y}`)
  } else {
    await adb.shell(serial, 'input tap 500 916')
  }
  await new Promise((r) => setTimeout(r, 2000))

  // Step 3: tap avatar PHOTO (opens Profile screen with phone number).
  const avatarBtn = await findElement(/profile_info_photo[^>]*bounds="[^"]*"/)
  if (avatarBtn) {
    await adb.shell(serial, `input tap ${avatarBtn.x} ${avatarBtn.y}`)
  } else {
    await adb.shell(serial, 'input tap 96 276')
  }
  await new Promise((r) => setTimeout(r, 2000))

  // Step 4: extract phone from Profile screen.
  await adb.shell(serial, 'uiautomator dump /sdcard/_scan.xml')
  const profileXml = await adb.shell(serial, 'cat /sdcard/_scan.xml')
  const phoneMatch = profileXml.match(/text="\+(\d[\d \-]+)"/)
  const phone = phoneMatch ? phoneMatch[1].replace(/[\s-]/g, '') : null

  // Try to leave the WA app on home — best-effort, ignore errors.
  for (let i = 0; i < 4; i++) {
    await adb.shell(serial, 'input keyevent KEYCODE_BACK').catch(() => {})
    await new Promise((r) => setTimeout(r, 200))
  }
  await adb.shell(serial, 'input keyevent KEYCODE_HOME').catch(() => {})

  return { phone, foreground }
}

export function registerDeviceRoutes(
  server: FastifyInstance,
  adb: AdbBridge,
  deps: DeviceRoutesDeps = {},
): void {
  server.get('/api/v1/devices', async () => {
    return adb.discover()
  })

  server.get('/api/v1/devices/:serial', async (request, reply) => {
    const { serial } = request.params as { serial: string }
    const devices = await adb.discover()
    const device = devices.find(d => d.serial === serial)
    if (!device) {
      return reply.status(404).send({ error: 'Device not found' })
    }
    if (device.type === 'device') {
      const health = await adb.health(serial)
      return { ...device, health }
    }
    return device
  })

  server.post('/api/v1/devices/:serial/screenshot', async (request, reply) => {
    const { serial } = request.params as { serial: string }
    const png = await adb.screenshot(serial)
    return reply.type('image/png').send(png)
  })

  // Keep device awake — disable screen lock + timeout
  server.post('/api/v1/devices/:serial/keep-awake', async (request, reply) => {
    const { serial } = request.params as { serial: string }
    const commands = [
      { cmd: 'settings put system screen_off_timeout 2147483647', label: 'screen_timeout' },
      { cmd: 'svc power stayon usb', label: 'stay_awake_usb' },
      { cmd: 'locksettings set-disabled true', label: 'lock_disabled' },
      { cmd: 'input keyevent KEYCODE_WAKEUP', label: 'wake_screen' },
      { cmd: 'input swipe 540 1400 540 400 300', label: 'swipe_unlock' },
    ]
    const results: Record<string, string> = {}
    for (const { cmd, label } of commands) {
      try {
        results[label] = await adb.shell(serial, cmd) || 'ok'
      } catch (err) {
        results[label] = `error: ${(err as Error).message}`
      }
    }
    return reply.send({ serial, applied: results })
  })

  // Hygienize device — standardized: always starts from P0, processes all, returns to P0.
  // Delegates to the shared `hygienizeDevice()` core function (also used by
  // the auto-trigger on device:connected). Both writes to `device_hygiene_log`
  // for a single audit trail.
  server.post('/api/v1/devices/:serial/hygienize', async (request, reply) => {
    const { serial } = request.params as { serial: string }
    const operator = (request.headers['x-operator'] as string | undefined) ?? null
    const triggeredBy = operator ? 'manual:operator' : 'manual:api'

    const aggressive = (process.env.DISPATCH_HYGIENE_AGGRESSIVE ?? 'false') === 'true'
    const logId = deps.hygieneLog?.start({
      device_serial: serial,
      triggered_by: triggeredBy as 'manual:operator' | 'manual:api',
    })

    try {
      const result = await hygienizeDevice(adb, serial, { aggressive })

      if (deps.hygieneLog && logId) {
        deps.hygieneLog.finish(logId, {
          status: 'completed',
          profiles_processed: result.profilesProcessed,
          bloat_removed_count: result.bloatRemovedCount,
          per_profile_log: result.perProfileLog,
          survived_packages: result.survivedPackages,
        })
      }

      const totalSurvivors = Object.values(result.survivedPackages).reduce(
        (sum, list) => sum + list.length,
        0,
      )
      server.log.info(
        {
          serial,
          profiles: result.profilesProcessed,
          totalRemoved: result.bloatRemovedCount,
          survivors: totalSurvivors,
          triggeredBy,
        },
        'Device hygienized',
      )
      return reply.send({
        serial,
        profiles: result.profilesProcessed,
        steps: result.steps,
        survived: result.survivedPackages,
        log_id: logId ?? null,
      })
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      if (deps.hygieneLog && logId) {
        deps.hygieneLog.finish(logId, { status: 'failed', error_msg: errorMsg })
      }
      server.log.error({ serial, err: errorMsg }, 'Manual hygienize failed')
      return reply.status(500).send({ serial, error: errorMsg, log_id: logId ?? null })
    }
  })

  // List recent hygiene runs for a device (for the UI indicator).
  server.get('/api/v1/devices/:serial/hygienize/log', async (request, reply) => {
    const { serial } = request.params as { serial: string }
    if (!deps.hygieneLog) return reply.send({ serial, items: [], last: null })
    const items = deps.hygieneLog.list(serial, 20)
    const last = deps.hygieneLog.getLast(serial)
    return reply.send({ serial, items, last })
  })

  // Validate device readiness — check all profiles are ready for sending
  server.get('/api/v1/devices/:serial/validate', async (request, reply) => {
    const { serial } = request.params as { serial: string }
    const issues: string[] = []

    // Check device online
    const devices = await adb.discover()
    const device = devices.find(d => d.serial === serial)
    if (!device || device.type !== 'device') {
      return reply.send({ serial, ready: false, issues: ['Device offline ou nao encontrado'] })
    }

    // Check screen awake
    try {
      const power = await adb.shell(serial, 'dumpsys power | grep mWakefulness')
      if (!power.includes('Awake')) issues.push('Tela apagada — precisa wake')
    } catch { issues.push('Nao conseguiu verificar estado da tela') }

    // Check WiFi
    try {
      const wifi = await adb.shell(serial, 'dumpsys wifi | grep "Wi-Fi is"')
      if (!wifi.includes('enabled')) issues.push('WiFi desligado')
    } catch { issues.push('Nao conseguiu verificar WiFi') }

    // Check profiles + WA running
    let profileIds: number[] = [0]
    try {
      const usersOutput = await adb.shell(serial, 'pm list users')
      const matches = [...usersOutput.matchAll(/UserInfo\{(\d+):/g)]
      profileIds = matches.map(m => Number(m[1]))
    } catch { issues.push('Nao conseguiu listar profiles') }

    const ps = await adb.shell(serial, 'ps -A').catch(() => '')
    for (const uid of profileIds) {
      const userPrefix = uid === 0 ? 'u0_' : `u${uid}_`
      if (!ps.includes(`${userPrefix}`) || !ps.includes('com.whatsapp')) {
        // More precise check
        const hasWa = ps.split('\n').some(line =>
          line.includes(userPrefix) && line.includes('com.whatsapp')
        )
        if (!hasWa) issues.push(`Profile ${uid}: WhatsApp nao esta rodando`)
      }
    }

    // Check battery
    try {
      const battery = await adb.shell(serial, 'dumpsys battery | grep level')
      const level = Number(battery.match(/level: (\d+)/)?.[1] ?? 0)
      if (level < 15) issues.push(`Bateria critica: ${level}%`)
    } catch { /* ignore */ }

    // Check screen lock
    try {
      const lock = await adb.shell(serial, 'locksettings get-disabled')
      if (lock.includes('false')) issues.push('Lock screen ativo — precisa desabilitar')
    } catch { /* ignore */ }

    // Check for blocking WA screens (backup, update, terms, etc)
    try {
      const activities = await adb.shell(serial, 'dumpsys activity activities | grep topResumedActivity')
      const blockingActivities = [
        'GoogleDriveNewUserSetupActivity', 'BackupSettingsActivity',
        'GdprActivity', 'VerifySmsActivity', 'RegistrationActivity',
        'UpdateActivity', 'EulaActivity', 'Welcome',
      ]
      for (const blocking of blockingActivities) {
        if (activities.includes(blocking)) {
          issues.push(`Tela bloqueante: ${blocking} — precisa dismissar`)
          // Auto-fix: press BACK + HOME to dismiss
          try {
            await adb.shell(serial, 'input keyevent KEYCODE_BACK')
            await adb.shell(serial, 'input keyevent KEYCODE_BACK')
            await adb.shell(serial, 'input keyevent KEYCODE_HOME')
          } catch { /* ignore */ }
          break
        }
      }
    } catch { /* ignore */ }

    return reply.send({
      serial,
      ready: issues.length === 0,
      profiles: profileIds.length,
      issues,
    })
  })

  // Switch Android user profile (verified switch + unlock + settings)
  server.post('/api/v1/devices/:serial/switch-user/:profileId', async (request, reply) => {
    const { serial, profileId } = request.params as { serial: string; profileId: string }
    const uid = Number(profileId)

    const { switched, unlocked } = await switchAndUnlock(adb, serial, uid)
    if (!switched) {
      return reply.status(500).send({ error: `Timeout ao trocar para P${uid}` })
    }

    // Re-apply critical settings
    for (const cmd of [
      'settings put system screen_off_timeout 2147483647',
      'settings put system screen_brightness 255',
      'settings put system screen_brightness_mode 0',
      'svc power stayon usb',
    ]) {
      try { await adb.shell(serial, cmd) } catch { /* ignore */ }
    }

    const currentUser = await getCurrentUser(adb, serial)
    server.log.info({ serial, profileId: uid, currentUser, unlocked }, 'Switched user profile')
    return reply.send({ serial, profileId: uid, currentUser, verified: currentUser === uid, unlocked })
  })

  // Scan WA number — switches user, opens WA Settings > Profile, reads via UIAutomator.
  // STANDARDIZED: starts from current user, switches, scans, returns to P0.
  // When `chipRegistry` is wired we ALSO persist the phone into
  // `whatsapp_accounts` (so the Devices page reflects it) and trigger an
  // idempotent chip auto-import (so the Frota → Chips tab gets a row
  // without a second operator click).
  server.post('/api/v1/devices/:serial/profiles/:profileId/scan-number', async (request, reply) => {
    const { serial, profileId } = request.params as { serial: string; profileId: string }
    const uid = Number(profileId)
    const query = (request.query ?? {}) as { package?: string }
    const pkgRaw = (query.package ?? 'com.whatsapp').trim()
    if (pkgRaw !== 'com.whatsapp' && pkgRaw !== 'com.whatsapp.w4b') {
      return reply.status(400).send({ error: 'package must be com.whatsapp or com.whatsapp.w4b' })
    }

    try {
      // Switch to target user + unlock (UIAutomator needs screen unlocked)
      const { switched, unlocked } = await switchAndUnlock(adb, serial, uid)
      if (!switched) {
        return reply.status(500).send({ error: `Timeout ao trocar para P${uid}` })
      }
      if (!unlocked) {
        await ensureUserZero(adb, serial)
        return reply.status(500).send({ error: `Nao conseguiu destravar tela do P${uid}` })
      }

      const scan = await extractWaPhoneViaUiAutomator(adb, serial, uid)

      // Return to user 0 (standardized exit)
      await ensureUserZero(adb, serial)

      // If the WA foreground guard failed, surface a 400 with the diagnostic
      // hint instead of pretending the scan ran. This is what Bug #1 needs:
      // operator clicked "Detectar" on a profile where WA never came up,
      // UIAutomator scraped Settings, returned nothing meaningful.
      if (scan.error) {
        return reply.status(400).send({
          serial,
          profile_id: uid,
          phone: null,
          persisted: false,
          chip_created: false,
          error: scan.error,
          hint: 'Use "Abrir WA no device" primeiro para garantir que o WhatsApp esteja em primeiro plano.',
          foreground: scan.foreground,
        })
      }

      const phone = scan.phone

      // Persist + auto-create chip when phone was successfully extracted.
      let persisted = false
      let chipCreated = false
      if (phone && deps.waMapper) {
        try {
          deps.waMapper.setPhoneNumber(serial, uid, pkgRaw as 'com.whatsapp' | 'com.whatsapp.w4b', phone)
          persisted = true
        } catch (err) {
          server.log.error({ serial, profileId: uid, err }, 'setPhoneNumber failed (scan-number)')
        }
      }
      if (persisted && deps.chipRegistry) {
        try {
          const before = deps.chipRegistry.getChipByPhone(phone!)
          if (!before) {
            deps.chipRegistry.importFromDevices()
            chipCreated = Boolean(deps.chipRegistry.getChipByPhone(phone!))
          }
        } catch (err) {
          server.log.warn({ serial, profileId: uid, err }, 'chipRegistry import failed after scan')
        }
      }

      server.log.info({ serial, profileId: uid, phone, persisted, chipCreated }, 'Scanned WA number')
      return reply.send({ serial, profileId: uid, phone, persisted, chip_created: chipCreated })
    } catch (err) {
      // Always try to recover to user 0
      await ensureUserZero(adb, serial).catch(() => {})
      return reply.status(500).send({
        error: `Scan falhou: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  })

  // ── Root-based phone extraction (FAST — sub-second per profile) ───────────
  //
  // Reads `/data/user/{uid}/{pkg}/shared_prefs/{pkg}_preferences_light.xml`
  // directly via `su -c cat …` and parses `<string name="ph">…</string>`.
  // Bypasses both UIAutomator (broken on Setup-Wizard-incomplete profiles)
  // and the per-user content-provider trick (broken by isolation on
  // secondary users). See `monitor/wa-phone-extractor-root.ts` for the
  // full fallback ladder + diagnostics.
  //
  // Idempotent — already-correct phones are upserted with the same value.
  // Triggers a single `chipRegistry.importFromDevices()` sweep at the end
  // so the Frota → Chips tab reflects the new mapping in one round-trip.
  server.post('/api/v1/devices/:serial/extract-phones-root', async (request, reply) => {
    const { serial } = request.params as { serial: string }
    const startedAt = Date.now()

    const rooted = await isDeviceRooted(adb, serial)
    if (!rooted) {
      return reply.status(409).send({
        serial,
        error: 'device_not_rooted',
        detail: 'Use /scan-all-numbers (UIAutomator fallback) for non-rooted devices.',
      })
    }

    const log: typeof server.log = server.log
    const results = await extractPhonesViaRoot(adb, serial, {
      logger: { warn: (payload, msg) => log.warn(payload, msg) },
    })

    let persisted = 0
    let withPhone = 0
    let waNotInitialized = 0
    let notInstalled = 0

    for (const r of results) {
      if (r.phone) {
        withPhone++
        if (deps.waMapper) {
          try {
            deps.waMapper.setPhoneNumber(serial, r.profile_id, r.package_name, r.phone, {
              warn: (payload, msg) => log.warn(payload, msg),
            })
            persisted++
          } catch (err) {
            log.error({ serial, profile: r.profile_id, package: r.package_name, err }, 'setPhoneNumber failed (root)')
          }
        }
      } else if (r.error === 'wa_not_initialized') {
        waNotInitialized++
      } else if (r.error === 'not_installed') {
        notInstalled++
      }
    }

    let chipsCreated = 0
    if (persisted > 0 && deps.chipRegistry) {
      try {
        const before = deps.chipRegistry.listChips({}).length
        deps.chipRegistry.importFromDevices()
        const after = deps.chipRegistry.listChips({}).length
        chipsCreated = Math.max(0, after - before)
      } catch (err) {
        log.warn({ serial, err }, 'chipRegistry import failed after root extract')
      }
    }

    const elapsedMs = Date.now() - startedAt
    log.info(
      {
        serial,
        results_count: results.length,
        with_phone: withPhone,
        persisted,
        wa_not_initialized: waNotInitialized,
        not_installed: notInstalled,
        chips_created: chipsCreated,
        elapsed_ms: elapsedMs,
      },
      'Root phone extraction complete',
    )
    return reply.send({
      serial,
      method: 'root',
      results,
      counts: {
        total: results.length,
        with_phone: withPhone,
        persisted,
        wa_not_initialized: waNotInitialized,
        not_installed: notInstalled,
        chips_created: chipsCreated,
      },
      elapsed_ms: elapsedMs,
    })
  })

  // Scan ALL profiles on a device — iterates `pm list users`, for each profile
  // that doesn't yet have a phone in `whatsapp_accounts` (com.whatsapp), runs
  // the same UIAutomator scrape used by the per-profile endpoint, persists,
  // and triggers a single chip auto-import at the end.
  //
  // SLOW: ~30s per profile (switch-user + unlock + UIAutomator). 4 profiles
  // = ~2 minutes total. UI must show progress indication and use a long
  // request timeout. Always returns to user 0 in success and failure paths.
  // PREFERS ROOT: when the device is rooted we delegate to the root extractor
  // (sub-second, works on Setup-Wizard-incomplete profiles); UIAutomator is
  // only used as a fallback for non-rooted devices.
  server.post('/api/v1/devices/:serial/scan-all-numbers', async (request, reply) => {
    const { serial } = request.params as { serial: string }
    const startedAt = Date.now()

    // Fast path: when the device is rooted, delegate to the root extractor.
    // Returns the SAME response shape as the legacy UIAutomator path so the
    // UI doesn't need to branch on `method`.
    try {
      const rooted = await isDeviceRooted(adb, serial)
      if (rooted) {
        const rootResults = await extractPhonesViaRoot(adb, serial, {
          logger: { warn: (payload, msg) => server.log.warn(payload, msg) },
        })
        // Filter to com.whatsapp only to match scan-all-numbers semantics,
        // but persist results for both packages.
        const seenProfiles = new Map<number, { phone: string | null; persisted: boolean; error?: string }>()
        for (const r of rootResults) {
          if (r.phone && deps.waMapper) {
            try {
              deps.waMapper.setPhoneNumber(serial, r.profile_id, r.package_name, r.phone)
            } catch (err) {
              server.log.error({ serial, err }, 'setPhoneNumber failed (root fast-path)')
            }
          }
          if (r.package_name === 'com.whatsapp') {
            seenProfiles.set(r.profile_id, {
              phone: r.phone,
              persisted: Boolean(r.phone),
              error: r.error,
            })
          }
        }
        const results = [...seenProfiles.entries()].map(([profile_id, v]) => ({
          profile_id,
          phone: v.phone,
          persisted: v.persisted,
          ...(v.error ? { error: v.error } : {}),
        }))
        let chipsCreated = 0
        if (deps.chipRegistry) {
          try {
            const before = deps.chipRegistry.listChips({}).length
            deps.chipRegistry.importFromDevices()
            const after = deps.chipRegistry.listChips({}).length
            chipsCreated = Math.max(0, after - before)
          } catch (err) {
            server.log.warn({ serial, err }, 'chipRegistry import failed after scan-all-numbers (root)')
          }
        }
        const elapsedMs = Date.now() - startedAt
        server.log.info(
          {
            serial,
            method: 'root',
            profiles_scanned: results.length,
            phones_found: results.filter((r) => r.phone).length,
            chips_created: chipsCreated,
            elapsed_ms: elapsedMs,
          },
          'Scanned all WA numbers (root fast-path)',
        )
        return reply.send({ serial, method: 'root', results, chips_created: chipsCreated, elapsed_ms: elapsedMs })
      }
    } catch (err) {
      server.log.warn({ serial, err }, 'scan-all-numbers: root fast-path failed, falling back to UIAutomator')
    }

    // Discover profiles via `pm list users`. Fall back to [0] on parse failure.
    let profileIds: number[] = [0]
    try {
      const out = await adb.shell(serial, 'pm list users')
      const ids = [...out.matchAll(/UserInfo\{(\d+):/g)].map((m) => Number(m[1]))
      if (ids.length > 0) profileIds = ids
    } catch (err) {
      server.log.warn({ serial, err }, 'scan-all-numbers: pm list users failed, defaulting to [0]')
    }

    // Read existing phones so we can skip already-mapped (device, profile,
    // com.whatsapp) tuples — keeps the operation idempotent across retries.
    const existing = new Map<number, string>()
    if (deps.waMapper) {
      for (const acc of deps.waMapper.getAccountsByDevice(serial)) {
        if (acc.packageName === 'com.whatsapp' && acc.phoneNumber) {
          existing.set(acc.profileId, acc.phoneNumber)
        }
      }
    }

    const results: Array<{
      profile_id: number
      phone: string | null
      persisted: boolean
      skipped?: 'already_mapped'
      error?: string
    }> = []

    try {
      for (const uid of profileIds) {
        const cached = existing.get(uid)
        if (cached) {
          results.push({ profile_id: uid, phone: cached, persisted: false, skipped: 'already_mapped' })
          continue
        }

        try {
          const { switched, unlocked } = await switchAndUnlock(adb, serial, uid)
          if (!switched) {
            results.push({ profile_id: uid, phone: null, persisted: false, error: 'switch-user timeout' })
            continue
          }
          if (!unlocked) {
            results.push({ profile_id: uid, phone: null, persisted: false, error: 'tela travada' })
            continue
          }

          const scan = await extractWaPhoneViaUiAutomator(adb, serial, uid)
          if (scan.error) {
            results.push({
              profile_id: uid,
              phone: null,
              persisted: false,
              error: scan.error,
            })
            continue
          }
          const phone = scan.phone
          let persisted = false
          if (phone && deps.waMapper) {
            try {
              deps.waMapper.setPhoneNumber(serial, uid, 'com.whatsapp', phone)
              persisted = true
            } catch (err) {
              results.push({
                profile_id: uid,
                phone,
                persisted: false,
                error: `persist failed: ${err instanceof Error ? err.message : String(err)}`,
              })
              continue
            }
          }
          results.push({ profile_id: uid, phone, persisted })
        } catch (err) {
          results.push({
            profile_id: uid,
            phone: null,
            persisted: false,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
    } finally {
      // Always return to user 0 — even when a single profile blew up.
      await ensureUserZero(adb, serial).catch(() => {})
    }

    // Single chip-import sweep after the per-profile loop: idempotent and
    // captures every newly-persisted phone in one shot.
    let chipsCreated = 0
    if (deps.chipRegistry) {
      try {
        const before = deps.chipRegistry.listChips({}).length
        deps.chipRegistry.importFromDevices()
        const after = deps.chipRegistry.listChips({}).length
        chipsCreated = Math.max(0, after - before)
      } catch (err) {
        server.log.warn({ serial, err }, 'chipRegistry import failed after scan-all')
      }
    }

    const elapsedMs = Date.now() - startedAt
    server.log.info(
      {
        serial,
        profiles_scanned: results.length,
        phones_found: results.filter((r) => r.phone).length,
        chips_created: chipsCreated,
        elapsed_ms: elapsedMs,
      },
      'Scanned all WA numbers',
    )
    return reply.send({ serial, results, chips_created: chipsCreated, elapsed_ms: elapsedMs })
  })

  // Set phone number manually for a profile (com.whatsapp by default; pass
  // ?package=com.whatsapp.w4b to pin the WAB number instead). Persists into
  // `whatsapp_accounts` so the Devices UI + chip auto-import can read it.
  server.put('/api/v1/devices/:serial/profiles/:profileId/phone', async (request, reply) => {
    const { serial, profileId } = request.params as { serial: string; profileId: string }
    const body = request.body as { phone?: string; package?: string } | null
    const query = (request.query ?? {}) as { package?: string }
    const phone = typeof body?.phone === 'string' ? body.phone.trim() : ''
    const pkgRaw = (body?.package ?? query.package ?? 'com.whatsapp').trim()
    if (!phone) {
      return reply.status(400).send({ error: 'phone is required' })
    }
    if (!/^\d{10,15}$/.test(phone.replace(/\D/g, ''))) {
      return reply.status(400).send({ error: 'phone must be 10-15 digits' })
    }
    if (pkgRaw !== 'com.whatsapp' && pkgRaw !== 'com.whatsapp.w4b') {
      return reply.status(400).send({ error: 'package must be com.whatsapp or com.whatsapp.w4b' })
    }
    const pid = Number(profileId)
    if (!Number.isInteger(pid) || pid < 0) {
      return reply.status(400).send({ error: 'profileId must be a non-negative integer' })
    }
    const normalized = phone.replace(/\D/g, '')

    if (deps.waMapper) {
      try {
        deps.waMapper.setPhoneNumber(serial, pid, pkgRaw as 'com.whatsapp' | 'com.whatsapp.w4b', normalized)
      } catch (err) {
        server.log.error({ serial, profileId: pid, err }, 'setPhoneNumber failed')
        return reply.status(500).send({ error: 'failed to persist phone mapping' })
      }
    }
    server.log.info({ serial, profileId: pid, package: pkgRaw, phone: normalized }, 'Manual phone mapping set')
    return reply.send({ serial, profileId: pid, package: pkgRaw, phone: normalized })
  })

  // Live screen — screenshot as base64 for embedding
  server.get('/api/v1/devices/:serial/screen', async (request, reply) => {
    const { serial } = request.params as { serial: string }
    const png = await adb.screenshot(serial)
    return reply.send({ image: `data:image/png;base64,${png.toString('base64')}` })
  })

  // ADB Shell — execute command (rate limited + audit logged)
  server.post('/api/v1/devices/:serial/shell', async (request, reply) => {
    const { serial } = request.params as { serial: string }
    const ip = request.ip

    // Rate limiting: 10 requests per minute per IP
    if (!shellRateLimiter.isAllowed(ip)) {
      return reply.status(429).send({
        error: 'Rate limit exceeded. Max 10 shell requests per minute.',
        remaining: shellRateLimiter.remaining(ip),
        retryAfterSeconds: 60,
      })
    }

    const parsed = shellSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parsed.error.issues })
    }
    const { command } = parsed.data

    // Audit logging
    server.log.info({ event: 'shell:execute', serial, command, ip }, 'Shell command executed')

    try {
      const output = await adb.shell(serial, command)
      return reply.send({ serial, command, output })
    } catch (err) {
      return reply.status(500).send({
        error: 'Shell command failed',
        detail: err instanceof Error ? err.message : String(err),
      })
    }
  })

  // Device info — detailed system information
  server.get('/api/v1/devices/:serial/info', async (request, reply) => {
    const { serial } = request.params as { serial: string }
    const props = [
      'ro.product.brand', 'ro.product.model', 'ro.product.device',
      'ro.build.version.release', 'ro.build.version.sdk',
      'ro.build.display.id', 'ro.serialno',
      'persist.sys.timezone',
    ]
    const commands = [
      { key: 'ip', cmd: "ip route | grep 'src' | head -1 | awk '{print $NF}'" },
      { key: 'wifiSsid', cmd: "cmd wifi status 2>/dev/null | head -3 || dumpsys wifi | grep 'SSID' | head -1" },
      { key: 'screenSize', cmd: 'wm size | tail -1' },
      { key: 'screenDensity', cmd: 'wm density | tail -1' },
      { key: 'uptime', cmd: 'uptime -s 2>/dev/null || cat /proc/uptime' },
      { key: 'waVersion', cmd: 'dumpsys package com.whatsapp | grep versionName | head -1' },
      { key: 'waRunning', cmd: 'ps -A | grep -q com.whatsapp && echo running || echo stopped' },
      { key: 'wabVersion', cmd: 'dumpsys package com.whatsapp.w4b | grep versionName | head -1' },
      { key: 'wabRunning', cmd: 'ps -A | grep -q com.whatsapp.w4b && echo running || echo stopped' },
    ]

    const propResults = await Promise.all(
      props.map(async (p) => {
        try { return { key: p.split('.').pop()!, value: await adb.shell(serial, `getprop ${p}`) } }
        catch { return { key: p.split('.').pop()!, value: '' } }
      })
    )
    const cmdResults = await Promise.all(
      commands.map(async ({ key, cmd }) => {
        try { return { key, value: (await adb.shell(serial, cmd)).trim() } }
        catch { return { key, value: '' } }
      })
    )

    const info: Record<string, string> = {}
    for (const { key, value } of [...propResults, ...cmdResults]) {
      if (value) info[key] = value
    }
    return reply.send(info)
  })

  // Device profiles — list Android users with WA account status per profile
  //
  // Response shape (backward-compatible — `whatsapp` / `whatsappBusiness` /
  // `id` / `running` retained verbatim for legacy callers, plus new fields):
  //
  //   profiles: [{
  //     id, name, running,                                   // legacy
  //     profile_id, is_running,                              // new aliases
  //     whatsapp:        { installed, phone, active },       // legacy
  //     whatsappBusiness:{ installed, phone, active },       // legacy
  //     packages: [{ package_name, state, phone_number, last_extracted_at }] // new
  //   }]
  //
  // The `packages[]` array drives the new state-aware UI badges
  // ("não instalado" / "nunca aberto" / "aberto, sem login" / "logado").
  // Root-only states (installed_never_opened, opened_not_logged_in) require
  // root access to disambiguate from `unknown`; non-rooted devices report
  // `state: 'unknown'` for these intermediate cases.
  server.get('/api/v1/devices/:serial/profiles', async (request, reply) => {
    const { serial } = request.params as { serial: string }

    // Get user list
    let usersOutput: string
    try {
      usersOutput = await adb.shell(serial, 'pm list users')
    } catch {
      return reply.status(500).send({ error: 'Failed to list users' })
    }

    // Parse: UserInfo{0:Main Oralsin 2:4c13} running
    const profileRegex = /UserInfo\{(\d+):([^:]+):\w+\}\s*(running)?/g

    // Probe root once per request — used to enrich state derivation. When
    // the device is not rooted, intermediate states collapse to 'unknown'.
    const rooted = await isDeviceRooted(adb, serial)

    // Fall back to whatsapp_accounts when content provider isolation prevents
    // ADB-side extraction (per-user provider isolation on secondary profiles).
    const dbAccounts = deps.waMapper?.getAccountsByDevice(serial) ?? []
    // Pull updated_at directly from SQLite for `last_extracted_at` (the
    // mapper API doesn't surface it).
    const dbAccountsWithTs = (() => {
      try {
        // We can't directly access the db here; reuse a public helper if
        // available, otherwise return [].
        const q = (deps.waMapper as unknown as { getAccountsRawByDevice?: (s: string) => Array<{ profileId: number; packageName: string; phoneNumber: string | null; updatedAt: string }> })
          .getAccountsRawByDevice
        return typeof q === 'function' ? q(serial) : []
      } catch {
        return []
      }
    })()
    const phoneFromDb = (pid: number, pkg: 'com.whatsapp' | 'com.whatsapp.w4b'): string | null => {
      const row = dbAccounts.find(
        (a) => a.profileId === pid && a.packageName === pkg,
      )
      return row?.phoneNumber ?? null
    }
    const lastExtractedFromDb = (pid: number, pkg: 'com.whatsapp' | 'com.whatsapp.w4b'): string | null => {
      const row = dbAccountsWithTs.find(
        (a) => a.profileId === pid && a.packageName === pkg && a.phoneNumber,
      )
      return row?.updatedAt ?? null
    }

    type PackageState =
      | 'not_installed'
      | 'installed_never_opened'
      | 'opened_not_logged_in'
      | 'logged_in'
      | 'unknown'

    type EnrichedPackage = {
      package_name: 'com.whatsapp' | 'com.whatsapp.w4b'
      state: PackageState
      phone_number: string | null
      last_extracted_at: string | null
    }

    type EnrichedProfile = {
      id: number
      name: string
      running: boolean
      profile_id: number
      is_running: boolean
      whatsapp: { installed: boolean; phone: string | null; active: boolean }
      whatsappBusiness: { installed: boolean; phone: string | null; active: boolean }
      packages: EnrichedPackage[]
    }

    const profiles: EnrichedProfile[] = []

    let match: RegExpExecArray | null
    while ((match = profileRegex.exec(usersOutput)) !== null) {
      const profileId = Number(match[1])
      const name = match[2].trim()
      const running = match[3] === 'running'

      // Check WA installed + phone for this profile
      const waInfo = await getWaProfileInfo(adb, serial, profileId, 'com.whatsapp')
      const wabInfo = await getWaProfileInfo(adb, serial, profileId, 'com.whatsapp.w4b')

      const waPhone = waInfo.phone ?? phoneFromDb(profileId, 'com.whatsapp')
      const wabPhone = wabInfo.phone ?? phoneFromDb(profileId, 'com.whatsapp.w4b')

      const waState = await derivePackageState(adb, serial, profileId, 'com.whatsapp', {
        rooted,
        installed: waInfo.installed,
        phone: waPhone,
      })
      const wabState = await derivePackageState(adb, serial, profileId, 'com.whatsapp.w4b', {
        rooted,
        installed: wabInfo.installed,
        phone: wabPhone,
      })

      profiles.push({
        id: profileId,
        name,
        running,
        profile_id: profileId,
        is_running: running,
        whatsapp: { installed: waInfo.installed, phone: waPhone, active: waInfo.processRunning },
        whatsappBusiness: { installed: wabInfo.installed, phone: wabPhone, active: wabInfo.processRunning },
        packages: [
          {
            package_name: 'com.whatsapp',
            state: waState,
            phone_number: waPhone,
            last_extracted_at: lastExtractedFromDb(profileId, 'com.whatsapp'),
          },
          {
            package_name: 'com.whatsapp.w4b',
            state: wabState,
            phone_number: wabPhone,
            last_extracted_at: lastExtractedFromDb(profileId, 'com.whatsapp.w4b'),
          },
        ],
      })
    }

    return reply.send({ serial, rooted, profiles })
  })

  // ── Launch WhatsApp inside a specific Android user profile ─────────────────
  //
  // POST /api/v1/devices/:serial/profiles/:profileId/launch-wa
  // Body: { package_name?: 'com.whatsapp' | 'com.whatsapp.w4b' }
  //
  // Operator clicks "Abrir WA" on a profile that has WA installed but never
  // opened (or never logged in). We start the user (`am start-user N` if
  // root, fallback `am switch-user N`), wake/unlock the screen, then launch
  // the HomeActivity. The endpoint returns immediately — the operator
  // scans the QR code on the physical device. The next root extraction
  // run picks up the registered phone.
  server.post('/api/v1/devices/:serial/profiles/:profileId/launch-wa', async (request, reply) => {
    const { serial, profileId } = request.params as { serial: string; profileId: string }
    const uid = Number(profileId)
    if (!Number.isFinite(uid) || uid < 0) {
      return reply.status(400).send({ error: 'Invalid profile id' })
    }

    const bodySchema = z.object({
      package_name: z.enum(['com.whatsapp', 'com.whatsapp.w4b']).default('com.whatsapp'),
    }).strict()
    const parsed = bodySchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parsed.error.issues })
    }
    const pkg = parsed.data.package_name

    // 1. Validate profile exists
    let usersOutput: string
    try {
      usersOutput = await adb.shell(serial, 'pm list users')
    } catch {
      return reply.status(500).send({ error: 'Failed to list users' })
    }
    const profileMatch = new RegExp(`UserInfo\\{${uid}:`).test(usersOutput)
    if (!profileMatch) {
      return reply.status(404).send({ error: `Profile ${uid} not found on device ${serial}` })
    }

    const rooted = await isDeviceRooted(adb, serial)
    const steps: Record<string, string> = {}

    // 2. Start the profile (idempotent — `am start-user` is no-op when already running)
    try {
      if (rooted) {
        steps.start_user = (await adb.shell(serial, `su -c "am start-user ${uid}"`)).trim() || 'ok'
      } else {
        steps.start_user = (await adb.shell(serial, `am start-user ${uid}`)).trim() || 'ok'
      }
    } catch (err) {
      // Fallback: switch-user auto-starts but switches the foreground.
      try {
        steps.start_user = `start-user failed (${(err as Error).message}); fallback switch-user`
        await adb.shell(serial, `am switch-user ${uid}`)
      } catch (err2) {
        return reply.status(500).send({
          error: `Failed to start profile ${uid}: ${(err2 as Error).message}`,
          steps,
        })
      }
    }

    // 3. Wait for the profile to be ready (Android boots the user lazily)
    await new Promise(r => setTimeout(r, 3000))

    // 4. Wake + unlock the screen so the operator can scan the QR.
    //    We DO NOT switch foreground when start-user worked above — running
    //    `am start --user N` opens the activity in user N's container even
    //    when the foreground user is 0. But on locked screens nothing is
    //    visible, so still wake the device.
    //
    //    Bug #3 fix: `input keyevent 82` (MENU) does NOT dismiss the
    //    keyguard on modern Android (12+). Replace with a swipe-up gesture
    //    after WAKEUP + locksettings disable. This is what the rest of the
    //    codebase (`unlockScreen`) does for hygienize.
    try { await adb.shell(serial, 'input keyevent KEYCODE_WAKEUP') } catch { /* ignore */ }
    try { await adb.shell(serial, 'locksettings set-disabled true') } catch { /* ignore */ }
    try { await adb.shell(serial, 'input swipe 540 1500 540 500 100') } catch { /* ignore */ }
    await new Promise(r => setTimeout(r, 800))

    // 5. Launch WA HomeActivity in the target user, with LAUNCHER intent
    //    fallback when PackageManager doesn't yet know the explicit
    //    activity (common for never-opened profiles — same path used by
    //    extractWaPhoneViaUiAutomator above).
    try {
      const launch = await amStartWaWithFallback(adb, serial, uid, pkg)
      steps.am_start = launch.output
      if (launch.fallback) {
        steps.am_start_fallback_used = 'true'
      }
    } catch (err) {
      return reply.status(500).send({
        error: `Failed to launch ${pkg}: ${(err as Error).message}`,
        steps,
      })
    }

    // 6. Verify foreground. If WA didn't come up (never-opened profile,
    //    Setup Wizard intercept, app missing for that user), surface a
    //    diagnostic 500 instead of returning ok: true while the operator
    //    sees a black launcher. Bug #3: previously we always returned 200.
    await new Promise(r => setTimeout(r, 1500))
    const fg = await readForegroundApp(adb, serial)
    steps.foreground_check = fg.slice(0, 200)
    if (!fg.toLowerCase().includes(pkg)) {
      return reply.status(500).send({
        error: `${pkg} não chegou ao foreground em P${uid}. Foreground atual: ${fg.slice(0, 200) || '(vazio)'}.`,
        hint:
          'Possíveis causas: (a) app não instalado para esse user, (b) primeira execução requer interação manual no device, ' +
          '(c) Setup Wizard interceptou — tente "Bypass Setup Wizard" e reabrir.',
        serial,
        profile_id: uid,
        package_name: pkg,
        rooted,
        steps,
      })
    }

    deps.auditLogger?.log({
      action: 'launch_wa',
      resourceType: 'device_profile',
      resourceId: `${serial}:${uid}:${pkg}`,
      afterState: { serial, profile_id: uid, package_name: pkg, rooted, steps },
    })

    server.log.info({ serial, profileId: uid, pkg, rooted, steps }, 'launch-wa completed')
    return reply.send({
      ok: true,
      serial,
      profile_id: uid,
      package_name: pkg,
      rooted,
      steps,
      hint: 'Operator: scan QR on the physical device. Next root extraction will pick up the number automatically.',
    })
  })

  // ── Bypass Setup Wizard for stopped profiles (root only) ───────────────────
  //
  // POST /api/v1/devices/:serial/profiles/:profileId/bypass-setup-wizard
  // Body: { force?: boolean }
  //
  // Some MIUI profiles (10/11/12 on POCO C71) get stuck in Setup Wizard
  // and refuse to start normally. We disable the wizard packages, mark
  // setup-complete in `settings`, and re-launch the launcher in the target
  // user. RISKY: a misconfigured profile becomes painful to recover. The
  // endpoint refuses to run unless `force: true` is set.
  server.post('/api/v1/devices/:serial/profiles/:profileId/bypass-setup-wizard', async (request, reply) => {
    const { serial, profileId } = request.params as { serial: string; profileId: string }
    const uid = Number(profileId)
    if (!Number.isFinite(uid) || uid < 0) {
      return reply.status(400).send({ error: 'Invalid profile id' })
    }

    const bodySchema = z.object({
      force: z.boolean().default(false),
    }).strict()
    const parsed = bodySchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parsed.error.issues })
    }
    if (!parsed.data.force) {
      return reply.status(400).send({
        error: 'destructive_action_requires_force',
        warning:
          'This action disables Setup Wizard packages and marks setup-complete in settings. ' +
          'A misconfigured profile may be hard to recover. Re-send with `{"force":true}` to proceed.',
      })
    }

    // Root is mandatory for `pm disable --user N` and `settings put --user N`.
    const rooted = await isDeviceRooted(adb, serial)
    if (!rooted) {
      return reply.status(409).send({
        error: 'device_not_rooted',
        detail: 'Setup Wizard bypass requires root (su -c).',
      })
    }

    // Validate profile exists
    try {
      const usersOutput = await adb.shell(serial, 'pm list users')
      if (!new RegExp(`UserInfo\\{${uid}:`).test(usersOutput)) {
        return reply.status(404).send({ error: `Profile ${uid} not found on device ${serial}` })
      }
    } catch {
      return reply.status(500).send({ error: 'Failed to list users' })
    }

    const steps: Record<string, string> = {}

    // 1. Start the user (idempotent)
    try {
      steps.start_user = (await adb.shell(serial, `su -c "am start-user ${uid}"`)).trim() || 'ok'
    } catch (err) {
      steps.start_user = `error: ${(err as Error).message}`
    }

    // 2. Disable known Setup Wizard packages for this user (best-effort)
    const wizardPackages = [
      'com.google.android.setupwizard',
      'com.android.provision',
      'com.miui.cloudbackup',
    ]
    for (const wp of wizardPackages) {
      try {
        steps[`disable_${wp}`] = (
          await adb.shell(serial, `su -c "pm disable --user ${uid} ${wp}"`)
        ).trim() || 'ok'
      } catch (err) {
        steps[`disable_${wp}`] = `error: ${(err as Error).message}`
      }
    }

    // 3. Mark wizard as done in settings
    const settingsCmds: Array<{ key: string; cmd: string }> = [
      { key: 'global_setup_wizard_has_run', cmd: `su -c "settings put --user ${uid} global setup_wizard_has_run 1"` },
      { key: 'secure_user_setup_complete', cmd: `su -c "settings put --user ${uid} secure user_setup_complete 1"` },
      { key: 'secure_device_provisioned', cmd: `su -c "settings put --user ${uid} global device_provisioned 1"` },
    ]
    for (const { key, cmd } of settingsCmds) {
      try {
        steps[key] = (await adb.shell(serial, cmd)).trim() || 'ok'
      } catch (err) {
        steps[key] = `error: ${(err as Error).message}`
      }
    }

    // 4. Re-launch HOME in the target user so the launcher takes over
    try {
      steps.launch_home = (
        await adb.shell(
          serial,
          `su -c "am start --user ${uid} -a android.intent.action.MAIN -c android.intent.category.HOME"`,
        )
      ).trim() || 'ok'
    } catch (err) {
      steps.launch_home = `error: ${(err as Error).message}`
    }

    // 5. Verify profile is now running
    let nowRunning = false
    try {
      const usersOutput = await adb.shell(serial, 'pm list users')
      const re = new RegExp(`UserInfo\\{${uid}:[^}]+\\}\\s*running`)
      nowRunning = re.test(usersOutput)
    } catch { /* ignore */ }

    deps.auditLogger?.log({
      action: 'bypass_setup_wizard',
      resourceType: 'device_profile',
      resourceId: `${serial}:${uid}`,
      afterState: { serial, profile_id: uid, rooted, now_running: nowRunning, steps },
    })

    server.log.warn(
      { serial, profileId: uid, nowRunning, steps },
      'bypass-setup-wizard completed (destructive)',
    )

    return reply.send({
      ok: true,
      serial,
      profile_id: uid,
      now_running: nowRunning,
      steps,
      warning: 'Setup Wizard packages disabled and setup-complete flags set. Profile may need manual recovery if launcher fails.',
    })
  })

  // ── Search endpoint for command palette autocomplete ──────────────────────
  // GET /api/v1/devices/search?q=<substring>
  // Returns up to 20 devices whose serial contains the query string.
  // NOTE: this route MUST be registered before /:serial to avoid shadowing.
  // In practice Fastify matches static segments before parametric ones, so
  // "search" is treated as a literal segment and never matched by /:serial.
  server.get('/api/v1/devices/search', async (request) => {
    const { q } = request.query as { q?: string }
    const needle = (q ?? '').toLowerCase().trim()
    const devices = await adb.discover()
    const results = devices
      .filter((d) => !needle || d.serial.toLowerCase().includes(needle))
      .slice(0, 20)
      .map((d) => ({ serial: d.serial, status: d.type === 'device' ? 'online' : d.type }))
    return results
  })
}

/**
 * Derive a per-(profile, package) lifecycle state.
 *
 * State machine (in order of precedence):
 *   not_installed         — `pm list packages --user N` does NOT contain the pkg
 *   logged_in             — phone number is known (root or DB)
 *   installed_never_opened— [root] shared_prefs directory missing
 *   opened_not_logged_in  — [root] shared_prefs exists but no `cc`/`ph` keys
 *   unknown               — non-rooted device + intermediate state can't be probed
 *
 * Root-only states require `rooted=true`. Non-rooted devices collapse the
 * intermediate states to 'unknown' since we can't read /data/user/* without su.
 */
async function derivePackageState(
  adb: { shell: (serial: string, cmd: string) => Promise<string> },
  serial: string,
  profileId: number,
  pkg: 'com.whatsapp' | 'com.whatsapp.w4b',
  ctx: { rooted: boolean; installed: boolean; phone: string | null },
): Promise<'not_installed' | 'installed_never_opened' | 'opened_not_logged_in' | 'logged_in' | 'unknown'> {
  if (!ctx.installed) return 'not_installed'
  if (ctx.phone) return 'logged_in'

  // Without root we can't disambiguate "installed but never opened" vs
  // "opened but never logged in" — both look the same from outside.
  if (!ctx.rooted) return 'unknown'

  const sharedPrefsDir = `/data/user/${profileId}/${pkg}/shared_prefs`
  let dirExists = false
  try {
    const test = await adb.shell(serial, `su -c "test -d '${sharedPrefsDir}' && echo YES || echo NO"`)
    dirExists = test.trim().endsWith('YES')
  } catch {
    return 'unknown'
  }
  if (!dirExists) return 'installed_never_opened'

  // Directory exists — check for `cc` + `ph` keys in the prefs file. If
  // present we'd already have a phone (handled above), so the absence
  // means WA was opened but never registered.
  const lightFile = `${sharedPrefsDir}/${pkg}_preferences_light.xml`
  try {
    const xml = await adb.shell(serial, `su -c "cat '${lightFile}' 2>/dev/null"`)
    if (xml && /<string name="ph">/.test(xml) && /<string name="cc">/.test(xml)) {
      // shared_prefs has both keys but extractor returned no phone — treat
      // as logged_in (DB will catch up on next root-extract sweep).
      return 'logged_in'
    }
  } catch { /* fall through */ }

  return 'opened_not_logged_in'
}

async function getWaProfileInfo(
  adb: { shell: (serial: string, cmd: string) => Promise<string> },
  serial: string,
  profileId: number,
  packageName: string,
): Promise<{ installed: boolean; phone: string | null; processRunning: boolean }> {
  // Check if package is installed for this user
  try {
    const pkgList = await adb.shell(serial, `pm list packages --user ${profileId}`)
    if (!pkgList.includes(packageName)) {
      return { installed: false, phone: null, processRunning: false }
    }
  } catch {
    return { installed: false, phone: null, processRunning: false }
  }

  // Check if process is running for this user
  let processRunning = false
  try {
    const ps = await adb.shell(serial, 'ps -A')
    const userPrefix = profileId === 0 ? 'u0_' : `u${profileId}_`
    processRunning = ps.split('\n').some(line =>
      line.includes(userPrefix) && line.includes(packageName)
    )
  } catch { /* ignore */ }

  // Method 1: raw_contacts sync1 field (most reliable when available)
  try {
    const output = await adb.shell(
      serial,
      `content query --uri content://com.android.contacts/raw_contacts --where "account_type='${packageName}'" --projection sync1 --user ${profileId}`,
    )
    const phoneMatch = output.match(/sync1=(\d+)@s\.whatsapp\.net/)
    if (phoneMatch) {
      return { installed: true, phone: phoneMatch[1], processRunning }
    }
  } catch { /* provider not available */ }

  // Method 2: data table with WA profile mimetype
  const mimeType = packageName === 'com.whatsapp'
    ? 'vnd.android.cursor.item/vnd.com.whatsapp.profile'
    : 'vnd.android.cursor.item/vnd.com.whatsapp.w4b.profile'
  try {
    const output = await adb.shell(
      serial,
      `content query --uri content://com.android.contacts/data --where "mimetype='${mimeType}'" --projection data1 --user ${profileId}`,
    )
    const phoneMatch = output.match(/data1=(\d{10,})@/)
    if (phoneMatch) {
      return { installed: true, phone: phoneMatch[1], processRunning }
    }
  } catch { /* ignore */ }

  // Method 3: dumpsys to check account registration (confirms WA is logged in, no number)
  // Already confirmed all profiles have accounts — just can't extract number from secondary profiles
  // This is a known Android limitation: content providers are per-user isolated

  return { installed: true, phone: null, processRunning }
}
