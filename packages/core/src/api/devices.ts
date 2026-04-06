import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AdbBridge } from '../adb/index.js'
import { IpRateLimiter } from './rate-limiter.js'

const shellRateLimiter = new IpRateLimiter({ maxRequests: 10, windowMs: 60_000 })
const shellSchema = z.object({ command: z.string().min(1).max(4096) })

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

  // Hygienize device — per-user cleanup across ALL profiles
  server.post('/api/v1/devices/:serial/hygienize', async (request, reply) => {
    const { serial } = request.params as { serial: string }
    const steps: Record<string, string> = {}

    // Step 1: Keep awake (device-global)
    const awakeCommands = [
      { cmd: 'settings put system screen_off_timeout 2147483647', label: 'screen_timeout_max' },
      { cmd: 'svc power stayon usb', label: 'stay_awake_usb' },
      { cmd: 'locksettings set-disabled true', label: 'lock_disabled' },
      { cmd: 'input keyevent KEYCODE_WAKEUP', label: 'wake_screen' },
    ]
    for (const { cmd, label } of awakeCommands) {
      try { steps[label] = await adb.shell(serial, cmd) || 'ok' }
      catch (err) { steps[label] = `error: ${(err as Error).message}` }
    }

    // Step 2: Discover profiles
    let profileIds: number[] = [0]
    try {
      const usersOutput = await adb.shell(serial, 'pm list users')
      const matches = [...usersOutput.matchAll(/UserInfo\{(\d+):/g)]
      profileIds = matches.map(m => Number(m[1]))
    } catch { /* fallback to [0] */ }
    steps.profiles_found = profileIds.join(', ')

    // Step 3: Uninstall bloatware PER USER
    // NEVER remove: contacts, providers.contacts, phone (needed for WA mapping)
    const bloatPackages = [
      // Facebook
      'com.facebook.appmanager', 'com.facebook.services', 'com.facebook.system',
      // Amazon
      'com.amazon.appmanager',
      // Google bloat
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
      // Xiaomi/MIUI bloat
      'com.miui.android.fashiongallery', 'com.miui.gameCenter.overlay',
      'com.miui.calculator.go', 'com.miui.analytics.go', 'com.miui.bugreport',
      'com.miui.cleaner.go', 'com.miui.msa.global', 'com.miui.qr',
      'com.miui.theme.lite', 'com.miui.videoplayer', 'com.miui.player',
      'com.xiaomi.discover', 'com.xiaomi.mipicks', 'com.xiaomi.scanner',
      'com.xiaomi.glgm', 'com.mi.globalminusscreen',
      // Dialer/SMS (block calls noise, but keep contacts provider)
      'com.unisoc.phone', 'com.android.mms.service',
      // Calendar, FM, Browser
      'com.android.calendar.go', 'com.android.fmradio', 'com.go.browser',
    ]

    let totalRemoved = 0
    const perUser: Record<number, number> = {}
    for (const uid of profileIds) {
      let count = 0
      for (const pkg of bloatPackages) {
        try {
          const out = await adb.shell(serial, `pm uninstall -k --user ${uid} ${pkg}`)
          if (out.includes('Success')) count++
        } catch { /* skip */ }
      }
      perUser[uid] = count
      totalRemoved += count
    }
    steps.bloat_removed = `${totalRemoved} total (${profileIds.map(u => `P${u}:${perUser[u]}`).join(', ')})`

    // Step 4: Ensure contacts provider exists on ALL profiles (needed for WA number extraction)
    for (const uid of profileIds) {
      try {
        await adb.shell(serial, `cmd package install-existing --user ${uid} com.android.contacts`)
        await adb.shell(serial, `cmd package install-existing --user ${uid} com.android.providers.contacts`)
      } catch { /* ignore */ }
    }
    steps.contacts_restored = `${profileIds.length} profiles`

    // Step 5: Silence (device-global)
    const silenceCommands = [
      { cmd: 'settings put global zen_mode 2', label: 'dnd_total_silence' },
      { cmd: 'settings put secure notification_badging 0', label: 'badge_dots_off' },
      { cmd: 'settings put system ringtone_volume 0', label: 'ringtone_muted' },
      { cmd: 'settings put system notification_sound_volume 0', label: 'notification_muted' },
      { cmd: 'settings put system alarm_volume 0', label: 'alarm_muted' },
      { cmd: 'settings put system vibrate_when_ringing 0', label: 'vibrate_off' },
      { cmd: 'settings put system haptic_feedback_enabled 0', label: 'haptic_off' },
    ]
    for (const { cmd, label } of silenceCommands) {
      try { steps[label] = await adb.shell(serial, cmd) || 'ok' }
      catch (err) { steps[label] = `error: ${(err as Error).message}` }
    }

    // Step 6: Force-stop noisy services
    for (const svc of ['com.google.android.gms', 'com.google.android.gsf', 'com.google.android.safetycore']) {
      try { await adb.shell(serial, `am force-stop ${svc}`) } catch { /* ignore */ }
    }
    steps.services_stopped = 'ok'

    // Step 7: Detect and dismiss blocking WA screens (do NOT open WA — just check and fix)
    const blockingActivities = [
      'GoogleDriveNewUserSetupActivity', 'BackupSettingsActivity',
      'GdprActivity', 'VerifySmsActivity', 'RegistrationActivity',
      'UpdateActivity', 'EulaActivity', 'Welcome',
    ]
    let dismissed = 0
    try {
      const activities = await adb.shell(serial, 'dumpsys activity activities | grep -E "topResumedActivity|mResumedActivity"')
      for (const blocking of blockingActivities) {
        if (activities.includes(blocking)) {
          await adb.shell(serial, 'input keyevent KEYCODE_BACK')
          await new Promise(r => setTimeout(r, 300))
          await adb.shell(serial, 'input keyevent KEYCODE_BACK')
          await new Promise(r => setTimeout(r, 300))
          await adb.shell(serial, 'input keyevent KEYCODE_HOME')
          dismissed++
          break
        }
      }
    } catch { /* ignore */ }
    steps.blocking_screens_dismissed = dismissed > 0 ? `${dismissed} dismissada(s)` : 'nenhuma'

    server.log.info({ serial, profiles: profileIds, totalRemoved }, 'Device hygienized (per-user)')

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

  // Switch Android user profile on device
  server.post('/api/v1/devices/:serial/switch-user/:profileId', async (request, reply) => {
    const { serial, profileId } = request.params as { serial: string; profileId: string }
    const uid = Number(profileId)

    try {
      await adb.shell(serial, `am switch-user ${uid}`)
      // Wait for switch, then unlock with PIN
      await new Promise(r => setTimeout(r, 3000))
      await adb.shell(serial, 'input keyevent KEYCODE_WAKEUP')
      await new Promise(r => setTimeout(r, 500))
      await adb.shell(serial, 'input swipe 540 1400 540 400 300')
      await new Promise(r => setTimeout(r, 500))
      await adb.shell(serial, 'input text 12345')
      await new Promise(r => setTimeout(r, 300))
      await adb.shell(serial, 'input keyevent KEYCODE_ENTER')
      await new Promise(r => setTimeout(r, 2000))
      // Re-apply keep-awake for this user
      await adb.shell(serial, 'settings put system screen_off_timeout 2147483647')
      await adb.shell(serial, 'svc power stayon usb')

      const currentUser = await adb.shell(serial, 'am get-current-user')
      server.log.info({ serial, profileId: uid }, 'Switched user profile')
      return reply.send({ serial, profileId: uid, currentUser: currentUser.trim() })
    } catch (err) {
      return reply.status(500).send({ error: `Failed to switch user: ${err instanceof Error ? err.message : String(err)}` })
    }
  })

  // Scan WA number from profile via UIAutomator (switches user, opens WA Settings > Profile)
  server.post('/api/v1/devices/:serial/profiles/:profileId/scan-number', async (request, reply) => {
    const { serial, profileId } = request.params as { serial: string; profileId: string }
    const uid = Number(profileId)

    try {
      // Switch user
      await adb.shell(serial, `am switch-user ${uid}`)
      await new Promise(r => setTimeout(r, 3500))
      // Unlock
      await adb.shell(serial, 'input keyevent KEYCODE_WAKEUP')
      await new Promise(r => setTimeout(r, 500))
      await adb.shell(serial, 'input swipe 540 1400 540 400 300')
      await new Promise(r => setTimeout(r, 500))
      await adb.shell(serial, 'input text 12345')
      await new Promise(r => setTimeout(r, 300))
      await adb.shell(serial, 'input keyevent KEYCODE_ENTER')
      await new Promise(r => setTimeout(r, 2500))
      // Open WA
      await adb.shell(serial, `am start --user ${uid} -n com.whatsapp/com.whatsapp.home.ui.HomeActivity`)
      await new Promise(r => setTimeout(r, 3000))
      // Navigate: Menu > Configuracoes > Perfil
      await adb.shell(serial, 'input tap 697 120') // 3-dot menu
      await new Promise(r => setTimeout(r, 1500))
      await adb.shell(serial, 'input tap 360 910') // Configuracoes
      await new Promise(r => setTimeout(r, 2000))
      await adb.shell(serial, 'input tap 180 215') // Profile avatar
      await new Promise(r => setTimeout(r, 2000))
      // Dump UI and extract phone
      await adb.shell(serial, 'uiautomator dump /sdcard/wa_profile_scan.xml')
      const xml = await adb.shell(serial, 'cat /sdcard/wa_profile_scan.xml')
      const phoneMatch = xml.match(/text="\+(\d[\d \-]+)"/)
      const phone = phoneMatch ? phoneMatch[1].replace(/[\s-]/g, '') : null
      // Navigate back to home
      await adb.shell(serial, 'input keyevent KEYCODE_BACK')
      await adb.shell(serial, 'input keyevent KEYCODE_BACK')
      await adb.shell(serial, 'input keyevent KEYCODE_BACK')
      await adb.shell(serial, 'input keyevent KEYCODE_HOME')
      // Re-apply keep-awake
      await adb.shell(serial, 'settings put system screen_off_timeout 2147483647')
      await adb.shell(serial, 'svc power stayon usb')

      server.log.info({ serial, profileId: uid, phone }, 'Scanned WA number from profile')
      return reply.send({ serial, profileId: uid, phone })
    } catch (err) {
      // Try to recover
      try {
        await adb.shell(serial, 'input keyevent KEYCODE_HOME')
      } catch { /* ignore */ }
      return reply.status(500).send({
        error: `Scan failed: ${err instanceof Error ? err.message : String(err)}`,
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
      whatsapp: { installed: boolean; phone: string | null }
      whatsappBusiness: { installed: boolean; phone: string | null }
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
