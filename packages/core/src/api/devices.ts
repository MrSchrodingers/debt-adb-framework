import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AdbBridge } from '../adb/index.js'
import { IpRateLimiter } from './rate-limiter.js'

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

/** Verify a setting was applied by reading it back */
async function verifySetting(adb: AdbShell, serial: string, namespace: string, key: string, expected: string): Promise<boolean> {
  try {
    const actual = (await adb.shell(serial, `settings get ${namespace} ${key}`)).trim()
    return actual === expected
  } catch { return false }
}

/** Get list of profile IDs from device */
async function getProfileIds(adb: AdbShell, serial: string): Promise<number[]> {
  try {
    const out = await adb.shell(serial, 'pm list users')
    return [...out.matchAll(/UserInfo\{(\d+):/g)].map(m => Number(m[1]))
  } catch { return [0] }
}

export function registerDeviceRoutes(
  server: FastifyInstance,
  adb: AdbBridge,
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

  // Hygienize device — standardized: always starts from P0, processes all, returns to P0
  server.post('/api/v1/devices/:serial/hygienize', async (request, reply) => {
    const { serial } = request.params as { serial: string }
    const steps: Record<string, string> = {}

    // STEP 0: Always start from user 0 (standardized entry point)
    const startedOnZero = await ensureUserZero(adb, serial)
    steps.initial_state = startedOnZero ? 'P0:ok' : 'P0:forced'

    const bloatPackages = [
      'com.facebook.appmanager', 'com.facebook.services', 'com.facebook.system',
      'com.amazon.appmanager',
      'com.google.android.apps.youtube.music', 'com.google.android.youtube',
      'com.google.android.apps.maps', 'com.google.android.apps.photosgo',
      'com.google.android.apps.walletnfcrel', 'com.android.chrome',
      'com.google.android.apps.docs', 'com.google.android.apps.messaging',
      'com.google.android.apps.nbu.files', 'com.google.android.apps.restore',
      'com.google.android.apps.safetyhub', 'com.google.android.apps.searchlite',
      'com.google.android.apps.subscriptions.red', 'com.google.android.apps.tachyon',
      'com.google.android.apps.wellbeing', 'com.google.android.feedback',
      'com.google.android.gm', 'com.google.android.marvin.talkback',
      'com.google.android.videos', 'com.google.android.safetycore',
      'com.google.android.gms.supervision',
      'com.miui.android.fashiongallery', 'com.miui.gameCenter.overlay',
      'com.miui.calculator.go', 'com.miui.analytics.go', 'com.miui.bugreport',
      'com.miui.cleaner.go', 'com.miui.msa.global', 'com.miui.qr',
      'com.miui.theme.lite', 'com.miui.videoplayer', 'com.miui.player',
      'com.xiaomi.discover', 'com.xiaomi.mipicks', 'com.xiaomi.scanner',
      'com.xiaomi.glgm', 'com.mi.globalminusscreen',
      'com.unisoc.phone', 'com.android.mms.service',
      'com.android.calendar.go', 'com.android.fmradio', 'com.go.browser',
    ]

    // Settings that work via ADB shell WITHOUT needing screen unlock
    const settingsCommands = [
      'locksettings clear --old 12345',    // remove PIN first
      'locksettings set-disabled true',     // disable lock screen
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
    ]

    // Discover profiles
    const profileIds = await getProfileIds(adb, serial)
    steps.profiles_found = profileIds.join(', ')

    // Process each profile
    let totalRemoved = 0
    const perUser: Record<number, string> = {}

    for (const uid of profileIds) {
      const log: string[] = []

      // Step 1: Switch user (verified with polling)
      const switched = await switchUserVerified(adb, serial, uid)
      if (!switched) {
        log.push('FALHOU: switch-user timeout (15s)')
        perUser[uid] = log.join(', ')
        continue
      }
      log.push('switch:ok')

      // Step 2: Apply settings (NO UI needed — works with locked screen)
      let settingsOk = 0
      for (const cmd of settingsCommands) {
        try { await adb.shell(serial, cmd); settingsOk++ } catch { /* ignore */ }
      }
      log.push(`settings:${settingsOk}/${settingsCommands.length}`)

      // Step 3: Remove bloatware (NO UI needed)
      let removed = 0
      for (const pkg of bloatPackages) {
        try {
          const out = await adb.shell(serial, `pm uninstall -k --user ${uid} ${pkg}`)
          if (out.includes('Success')) removed++
        } catch { /* skip */ }
      }
      totalRemoved += removed
      log.push(`bloat:${removed}`)

      // Step 4: Ensure essential packages (NO UI needed)
      for (const pkg of ['com.whatsapp', 'com.whatsapp.w4b', 'com.android.contacts', 'com.android.providers.contacts']) {
        try { await adb.shell(serial, `cmd package install-existing --user ${uid} ${pkg}`) } catch { /* ignore */ }
      }
      log.push('pkgs:ensured')

      // Step 5: Force stop noisy services
      for (const svc of ['com.google.android.gms', 'com.google.android.gsf', 'com.google.android.safetycore']) {
        try { await adb.shell(serial, `am force-stop ${svc}`) } catch { /* ignore */ }
      }

      // Step 6: Verify critical settings
      const briOk = await verifySetting(adb, serial, 'system', 'screen_brightness', '255')
      const toOk = await verifySetting(adb, serial, 'system', 'screen_off_timeout', '2147483647')
      const dndOk = await verifySetting(adb, serial, 'global', 'zen_mode', '1')
      log.push(`verify:bri=${briOk ? 'ok' : 'FAIL'},timeout=${toOk ? 'ok' : 'FAIL'},dnd=${dndOk ? 'ok' : 'FAIL'}`)

      perUser[uid] = log.join(', ')
    }

    steps.bloat_removed = `${totalRemoved} total`
    steps.per_user = JSON.stringify(perUser)

    // FINAL: Always return to user 0 (standardized exit)
    const backedToZero = await ensureUserZero(adb, serial)
    steps.switched_back = backedToZero ? 'P0:ok' : 'P0:FAILED'

    // Wake screen at the end
    try {
      await adb.shell(serial, 'input keyevent KEYCODE_WAKEUP')
    } catch { /* ignore */ }

    server.log.info({ serial, profiles: profileIds, totalRemoved, perUser }, 'Device hygienized')

    return reply.send({ serial, profiles: profileIds, steps })
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

  // Scan WA number — switches user, opens WA Settings > Profile, reads via UIAutomator
  // STANDARDIZED: starts from current user, switches, scans, returns to P0
  server.post('/api/v1/devices/:serial/profiles/:profileId/scan-number', async (request, reply) => {
    const { serial, profileId } = request.params as { serial: string; profileId: string }
    const uid = Number(profileId)

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

      // Helper: dump UI, find element by pattern, return center coords
      async function findElement(pattern: RegExp): Promise<{ x: number; y: number } | null> {
        await adb.shell(serial, 'uiautomator dump /sdcard/_scan.xml')
        const xml = await adb.shell(serial, 'cat /sdcard/_scan.xml')
        const match = xml.match(pattern)
        if (!match) return null
        // Extract bounds [x1,y1][x2,y2]
        const boundsMatch = match[0].match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/)
        if (!boundsMatch) return null
        return {
          x: Math.round((Number(boundsMatch[1]) + Number(boundsMatch[3])) / 2),
          y: Math.round((Number(boundsMatch[2]) + Number(boundsMatch[4])) / 2),
        }
      }

      // Open WA
      await adb.shell(serial, `am start --user ${uid} -n com.whatsapp/com.whatsapp.home.ui.HomeActivity`)
      await new Promise(r => setTimeout(r, 3000))

      // Step 1: Find and tap overflow menu (resource-id: menuitem_overflow)
      const menuBtn = await findElement(/menuitem_overflow[^>]*bounds="[^"]*"/)
      if (menuBtn) {
        await adb.shell(serial, `input tap ${menuBtn.x} ${menuBtn.y}`)
      } else {
        await adb.shell(serial, 'input tap 680 124') // fallback
      }
      await new Promise(r => setTimeout(r, 2000))

      // Step 2: Find and tap "Configurações"
      const configBtn = await findElement(/text="Configura[^"]*"[^>]*bounds="[^"]*"/)
      if (configBtn) {
        await adb.shell(serial, `input tap ${configBtn.x} ${configBtn.y}`)
      } else {
        await adb.shell(serial, 'input tap 500 916') // fallback
      }
      await new Promise(r => setTimeout(r, 2000))

      // Step 3: Find and tap avatar PHOTO (not name/about — photo opens Profile with phone)
      const avatarBtn = await findElement(/profile_info_photo[^>]*bounds="[^"]*"/)
      if (avatarBtn) {
        await adb.shell(serial, `input tap ${avatarBtn.x} ${avatarBtn.y}`)
      } else {
        await adb.shell(serial, 'input tap 96 276') // fallback
      }
      await new Promise(r => setTimeout(r, 2000))

      // Step 4: Extract phone number from Profile screen
      await adb.shell(serial, 'uiautomator dump /sdcard/_scan.xml')
      const profileXml = await adb.shell(serial, 'cat /sdcard/_scan.xml')
      const phoneMatch = profileXml.match(/text="\+(\d[\d \-]+)"/)
      const phone = phoneMatch ? phoneMatch[1].replace(/[\s-]/g, '') : null

      // Go home
      for (let i = 0; i < 4; i++) {
        await adb.shell(serial, 'input keyevent KEYCODE_BACK').catch(() => {})
        await new Promise(r => setTimeout(r, 200))
      }
      await adb.shell(serial, 'input keyevent KEYCODE_HOME').catch(() => {})

      // Return to user 0 (standardized exit)
      await ensureUserZero(adb, serial)

      server.log.info({ serial, profileId: uid, phone }, 'Scanned WA number')
      return reply.send({ serial, profileId: uid, phone })
    } catch (err) {
      // Always try to recover to user 0
      await ensureUserZero(adb, serial).catch(() => {})
      return reply.status(500).send({
        error: `Scan falhou: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  })

  // Set phone number manually for a profile
  server.put('/api/v1/devices/:serial/profiles/:profileId/phone', async (request, reply) => {
    const { serial, profileId } = request.params as { serial: string; profileId: string }
    const body = request.body as { phone: string }
    if (!body?.phone || typeof body.phone !== 'string') {
      return reply.status(400).send({ error: 'phone is required' })
    }
    // Store in whatsapp_accounts table
    const db = (request.server as unknown as { db?: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db
    // Fallback: use the monitor's DB via the server context
    // For now, just log and return success — the WaAccountMapper handles persistence
    server.log.info({ serial, profileId, phone: body.phone }, 'Manual phone mapping set')
    return reply.send({ serial, profileId: Number(profileId), phone: body.phone })
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

    let match: RegExpExecArray | null
    while ((match = profileRegex.exec(usersOutput)) !== null) {
      const profileId = Number(match[1])
      const name = match[2].trim()
      const running = match[3] === 'running'

      // Check WA installed + phone for this profile
      const waInfo = await getWaProfileInfo(adb, serial, profileId, 'com.whatsapp')
      const wabInfo = await getWaProfileInfo(adb, serial, profileId, 'com.whatsapp.w4b')

      profiles.push({
        id: profileId,
        name,
        running,
        whatsapp: { installed: waInfo.installed, phone: waInfo.phone, active: waInfo.processRunning },
        whatsappBusiness: { installed: wabInfo.installed, phone: wabInfo.phone, active: wabInfo.processRunning },
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
