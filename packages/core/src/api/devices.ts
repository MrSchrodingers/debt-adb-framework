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

  // Hygienize device — keep-awake + disable bloatware
  server.post('/api/v1/devices/:serial/hygienize', async (request, reply) => {
    const { serial } = request.params as { serial: string }
    const results: Record<string, string> = {}

    // Step 1: Keep awake
    const awakeCommands = [
      { cmd: 'settings put system screen_off_timeout 2147483647', label: 'screen_timeout' },
      { cmd: 'svc power stayon usb', label: 'stay_awake_usb' },
      { cmd: 'locksettings set-disabled true', label: 'lock_disabled' },
      { cmd: 'input keyevent KEYCODE_WAKEUP', label: 'wake_screen' },
    ]
    for (const { cmd, label } of awakeCommands) {
      try {
        results[label] = await adb.shell(serial, cmd) || 'ok'
      } catch (err) {
        results[label] = `error: ${(err as Error).message}`
      }
    }

    // Step 2: Disable bloatware
    const bloatPackages = [
      'com.facebook.appmanager', 'com.facebook.services', 'com.facebook.system',
      'com.amazon.appmanager',
      'com.google.android.apps.youtube.music', 'com.google.android.apps.maps',
      'com.google.android.apps.photosgo', 'com.google.android.apps.walletnfcrel',
      'com.miui.android.fashiongallery', 'com.miui.gameCenter.overlay',
      'com.miui.calculator.go', 'com.android.calendar.go',
    ]
    const disabled: string[] = []
    const skipped: string[] = []
    for (const pkg of bloatPackages) {
      try {
        const out = await adb.shell(serial, `pm disable-user --user 0 ${pkg}`)
        if (out.includes('disabled')) {
          disabled.push(pkg)
        } else {
          skipped.push(pkg)
        }
      } catch {
        skipped.push(pkg)
      }
    }

    results.bloat_disabled = `${disabled.length} packages`
    results.bloat_skipped = `${skipped.length} packages`

    server.log.info({ serial, disabled: disabled.length, skipped: skipped.length }, 'Device hygienized')

    return reply.send({
      serial,
      applied: results,
      bloat: { disabled, skipped },
    })
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
      { key: 'waRunning', cmd: 'pidof com.whatsapp > /dev/null && echo running || echo stopped' },
      { key: 'wabVersion', cmd: 'dumpsys package com.whatsapp.w4b | grep versionName | head -1' },
      { key: 'wabRunning', cmd: 'pidof com.whatsapp.w4b > /dev/null && echo running || echo stopped' },
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
}
