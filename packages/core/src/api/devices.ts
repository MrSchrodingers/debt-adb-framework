import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AdbBridge } from '../adb/index.js'
import { IpRateLimiter } from './rate-limiter.js'
import { hygienizeDevice, type HygieneLog, type AutoHygiene } from '../devices/index.js'
import type { WaAccountMapper } from '../monitor/index.js'
import type { ChipRegistry } from '../fleet/index.js'

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
async function extractWaPhoneViaUiAutomator(
  adb: AdbBridge,
  serial: string,
  profileId: number,
): Promise<string | null> {
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

  // Open WA on the requested user.
  await adb.shell(serial, `am start --user ${profileId} -n com.whatsapp/com.whatsapp.home.ui.HomeActivity`)
  await new Promise((r) => setTimeout(r, 3000))

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

  return phone
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

      const phone = await extractWaPhoneViaUiAutomator(adb, serial, uid)

      // Return to user 0 (standardized exit)
      await ensureUserZero(adb, serial)

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

  // Scan ALL profiles on a device — iterates `pm list users`, for each profile
  // that doesn't yet have a phone in `whatsapp_accounts` (com.whatsapp), runs
  // the same UIAutomator scrape used by the per-profile endpoint, persists,
  // and triggers a single chip auto-import at the end.
  //
  // SLOW: ~30s per profile (switch-user + unlock + UIAutomator). 4 profiles
  // = ~2 minutes total. UI must show progress indication and use a long
  // request timeout. Always returns to user 0 in success and failure paths.
  server.post('/api/v1/devices/:serial/scan-all-numbers', async (request, reply) => {
    const { serial } = request.params as { serial: string }
    const startedAt = Date.now()

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

          const phone = await extractWaPhoneViaUiAutomator(adb, serial, uid)
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
    const profiles: Array<{
      id: number
      name: string
      running: boolean
      whatsapp: { installed: boolean; phone: string | null; active: boolean }
      whatsappBusiness: { installed: boolean; phone: string | null; active: boolean }
    }> = []

    // Fall back to whatsapp_accounts when content provider isolation prevents
    // ADB-side extraction (per-user provider isolation on secondary profiles).
    const dbAccounts = deps.waMapper?.getAccountsByDevice(serial) ?? []
    const phoneFromDb = (pid: number, pkg: 'com.whatsapp' | 'com.whatsapp.w4b'): string | null => {
      const row = dbAccounts.find(
        (a) => a.profileId === pid && a.packageName === pkg,
      )
      return row?.phoneNumber ?? null
    }

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

      profiles.push({
        id: profileId,
        name,
        running,
        whatsapp: { installed: waInfo.installed, phone: waPhone, active: waInfo.processRunning },
        whatsappBusiness: { installed: wabInfo.installed, phone: wabPhone, active: wabInfo.processRunning },
      })
    }

    return reply.send({ serial, profiles })
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
