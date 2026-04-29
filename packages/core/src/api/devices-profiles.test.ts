/**
 * Tests for the per-profile lifecycle endpoints added on top of
 * `registerDeviceRoutes`:
 *
 *   GET  /api/v1/devices/:serial/profiles                                — enriched payload (packages[])
 *   POST /api/v1/devices/:serial/profiles/:profileId/launch-wa           — operator-driven WA launch
 *   POST /api/v1/devices/:serial/profiles/:profileId/bypass-setup-wizard — destructive root-only
 *
 * The tests stub `adb.shell` to fake the responses we'd see live on a POCO
 * C71. Since `derivePackageState` and the launch / bypass flow only ever
 * call `adb.shell`, the mock is sufficient — no real device required.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerDeviceRoutes } from './devices.js'
import type { AdbBridge } from '../adb/index.js'

// ── Helpers ──────────────────────────────────────────────────────────────

interface ShellMock {
  /** Match by exact substring (first match wins). */
  match: string
  /** What the fake `adb.shell` returns. */
  response: string
}

function buildAdb(mocks: ShellMock[]): AdbBridge {
  const shell = vi.fn(async (_serial: string, cmd: string) => {
    for (const m of mocks) {
      if (cmd.includes(m.match)) return m.response
    }
    return ''
  })
  return {
    shell,
    discover: vi.fn().mockResolvedValue([]),
    health: vi.fn(),
    screenshot: vi.fn(),
  } as unknown as AdbBridge
}

async function buildServer(adb: AdbBridge): Promise<FastifyInstance> {
  const server = Fastify({ logger: false })
  registerDeviceRoutes(server, adb)
  await server.ready()
  return server
}

// `pm list users` output mimicking POCO #1 (P0 + P10 + P25)
const POCO1_PM_LIST_USERS = `Users:
\tUserInfo{0:Main Oralsin 2:4c13} running
\tUserInfo{10:Oralsin 2 1:0}
\tUserInfo{25:Clone0:1010} running
`

// ── GET /profiles enrichment ─────────────────────────────────────────────

describe('GET /api/v1/devices/:serial/profiles — enriched payload', () => {
  it('returns rooted=true and packages[] with state derivation when device is rooted', async () => {
    const adb = buildAdb([
      { match: 'pm list users', response: POCO1_PM_LIST_USERS },
      // Root probe — rooted device
      { match: 'su -c id', response: 'uid=0(root) gid=0(root)' },
      // P0 has WA installed + opened (logged in shared_prefs)
      { match: 'pm list packages --user 0', response: 'package:com.whatsapp\npackage:com.whatsapp.w4b' },
      // shared_prefs dir exists for P0/com.whatsapp
      { match: `test -d '/data/user/0/com.whatsapp/shared_prefs'`, response: 'YES' },
      { match: `test -d '/data/user/0/com.whatsapp.w4b/shared_prefs'`, response: 'NO' },
      // ph + cc keys present in WA prefs (logged_in)
      {
        match: '/data/user/0/com.whatsapp/shared_prefs/com.whatsapp_preferences_light.xml',
        response: '<map><string name="cc">55</string><string name="ph">43996835100</string></map>',
      },
      // P10 has WA installed but never opened (no shared_prefs dir)
      { match: 'pm list packages --user 10', response: 'package:com.whatsapp' },
      { match: `test -d '/data/user/10/com.whatsapp/shared_prefs'`, response: 'NO' },
      // P25 has WAB installed, opened but not logged in (shared_prefs without ph/cc)
      { match: 'pm list packages --user 25', response: 'package:com.whatsapp.w4b' },
      { match: `test -d '/data/user/25/com.whatsapp.w4b/shared_prefs'`, response: 'YES' },
      {
        match: '/data/user/25/com.whatsapp.w4b/shared_prefs/com.whatsapp.w4b_preferences_light.xml',
        response: '<map><string name="other">x</string></map>',
      },
      // contacts content provider lookups (return nothing — fall back to unknown phone)
      { match: 'content query --uri content://com.android.contacts', response: '' },
      { match: 'ps -A', response: '' },
    ])
    const server = await buildServer(adb)
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/devices/POCO1/profiles',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      serial: string
      rooted: boolean
      profiles: Array<{
        profile_id: number
        is_running: boolean
        packages: Array<{
          package_name: string
          state: string
          phone_number: string | null
          last_extracted_at: string | null
        }>
      }>
    }
    expect(body.rooted).toBe(true)
    expect(body.profiles).toHaveLength(3)

    const p0 = body.profiles.find((p) => p.profile_id === 0)!
    expect(p0.is_running).toBe(true)
    const p0wa = p0.packages.find((p) => p.package_name === 'com.whatsapp')!
    expect(p0wa.state).toBe('logged_in')

    const p10 = body.profiles.find((p) => p.profile_id === 10)!
    const p10wa = p10.packages.find((p) => p.package_name === 'com.whatsapp')!
    expect(p10wa.state).toBe('installed_never_opened')
    const p10wab = p10.packages.find((p) => p.package_name === 'com.whatsapp.w4b')!
    expect(p10wab.state).toBe('not_installed')

    const p25 = body.profiles.find((p) => p.profile_id === 25)!
    const p25wab = p25.packages.find((p) => p.package_name === 'com.whatsapp.w4b')!
    expect(p25wab.state).toBe('opened_not_logged_in')
  })

  it('collapses intermediate states to "unknown" on non-rooted devices', async () => {
    const adb = buildAdb([
      { match: 'pm list users', response: 'Users:\n\tUserInfo{0:Main:1} running\n\tUserInfo{10:Sec:1} ' },
      // Root probe — NOT rooted (doesn't return uid=0)
      { match: 'su -c id', response: '/system/bin/sh: su: not found' },
      // P0 has WA installed + somehow we have a phone in some other channel — phone null
      { match: 'pm list packages --user 0', response: 'package:com.whatsapp' },
      { match: 'pm list packages --user 10', response: 'package:com.whatsapp' },
      { match: 'content query --uri content://com.android.contacts', response: '' },
      { match: 'ps -A', response: '' },
    ])
    const server = await buildServer(adb)
    const res = await server.inject({ method: 'GET', url: '/api/v1/devices/X/profiles' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      rooted: boolean
      profiles: Array<{ profile_id: number; packages: Array<{ state: string; package_name: string }> }>
    }
    expect(body.rooted).toBe(false)
    const p0wa = body.profiles[0].packages.find((p) => p.package_name === 'com.whatsapp')!
    expect(p0wa.state).toBe('unknown')
    const p10wa = body.profiles[1].packages.find((p) => p.package_name === 'com.whatsapp')!
    expect(p10wa.state).toBe('unknown')
  })
})

// ── POST /launch-wa ──────────────────────────────────────────────────────

describe('POST /api/v1/devices/:serial/profiles/:id/launch-wa', () => {
  let server: FastifyInstance
  let shell: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    const adb = buildAdb([
      { match: 'pm list users', response: POCO1_PM_LIST_USERS },
      { match: 'su -c id', response: 'uid=0(root) gid=0(root)' },
      { match: 'am start-user', response: 'Success' },
      { match: 'am start --user', response: 'Starting: Intent { act=android.intent.action.MAIN }' },
    ])
    shell = adb.shell as unknown as ReturnType<typeof vi.fn>
    server = await buildServer(adb)
  })

  it('returns 404 when profile does not exist on the device', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/devices/POCO1/profiles/99/launch-wa',
      payload: {},
    })
    expect(res.statusCode).toBe(404)
  })

  it('starts the user and launches HomeActivity for the requested package', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/devices/POCO1/profiles/10/launch-wa',
      payload: { package_name: 'com.whatsapp' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { ok: boolean; package_name: string; rooted: boolean; steps: Record<string, string> }
    expect(body.ok).toBe(true)
    expect(body.package_name).toBe('com.whatsapp')
    expect(body.rooted).toBe(true)
    // Should have shelled out to am start-user 10 and am start --user 10 -n com.whatsapp/...
    const cmds: string[] = (shell.mock.calls as Array<[string, string]>).map((c) => c[1])
    expect(cmds.some((c) => c.includes('am start-user 10'))).toBe(true)
    expect(cmds.some((c) => c.includes('am start --user 10') && c.includes('com.whatsapp/'))).toBe(true)
  })

  it('rejects invalid package_name via Zod', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/devices/POCO1/profiles/10/launch-wa',
      payload: { package_name: 'com.evil.pkg' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('defaults package_name to com.whatsapp when body is empty', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/devices/POCO1/profiles/10/launch-wa',
      payload: {},
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { package_name: string }
    expect(body.package_name).toBe('com.whatsapp')
  })
})

// ── POST /bypass-setup-wizard ────────────────────────────────────────────

describe('POST /api/v1/devices/:serial/profiles/:id/bypass-setup-wizard', () => {
  it('refuses without {force:true}', async () => {
    const adb = buildAdb([
      { match: 'pm list users', response: POCO1_PM_LIST_USERS },
      { match: 'su -c id', response: 'uid=0(root) gid=0(root)' },
    ])
    const server = await buildServer(adb)
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/devices/POCO1/profiles/10/bypass-setup-wizard',
      payload: {},
    })
    expect(res.statusCode).toBe(400)
    const body = res.json() as { error: string; warning: string }
    expect(body.error).toBe('destructive_action_requires_force')
    expect(body.warning).toContain('force')
  })

  it('refuses on non-rooted devices', async () => {
    const adb = buildAdb([
      { match: 'pm list users', response: POCO1_PM_LIST_USERS },
      { match: 'su -c id', response: '/system/bin/sh: su: not found' },
    ])
    const server = await buildServer(adb)
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/devices/POCO1/profiles/10/bypass-setup-wizard',
      payload: { force: true },
    })
    expect(res.statusCode).toBe(409)
    const body = res.json() as { error: string }
    expect(body.error).toBe('device_not_rooted')
  })

  it('runs the full sequence on rooted devices with force=true and reports running status', async () => {
    const adb = buildAdb([
      // First call returns "10 NOT running"; final verification call returns "10 running"
      { match: 'pm list users', response: POCO1_PM_LIST_USERS },
      { match: 'su -c id', response: 'uid=0(root) gid=0(root)' },
      { match: 'am start-user', response: 'Success' },
      { match: 'pm disable', response: 'Package disabled' },
      { match: 'settings put', response: '' },
      { match: 'am start --user', response: 'Starting: Intent' },
    ])
    const server = await buildServer(adb)
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/devices/POCO1/profiles/10/bypass-setup-wizard',
      payload: { force: true },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      ok: boolean
      profile_id: number
      now_running: boolean
      steps: Record<string, string>
    }
    expect(body.ok).toBe(true)
    expect(body.profile_id).toBe(10)
    // P10 in our mock is NOT running, so now_running should be false
    expect(body.now_running).toBe(false)
    expect(body.steps).toHaveProperty('start_user')
    expect(body.steps).toHaveProperty('disable_com.android.provision')
    expect(body.steps).toHaveProperty('global_setup_wizard_has_run')
    expect(body.steps).toHaveProperty('launch_home')
  })

  it('returns 404 when profile does not exist', async () => {
    const adb = buildAdb([
      { match: 'pm list users', response: POCO1_PM_LIST_USERS },
      { match: 'su -c id', response: 'uid=0(root) gid=0(root)' },
    ])
    const server = await buildServer(adb)
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/devices/POCO1/profiles/99/bypass-setup-wizard',
      payload: { force: true },
    })
    expect(res.statusCode).toBe(404)
  })
})
