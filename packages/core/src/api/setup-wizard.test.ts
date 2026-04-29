/**
 * Tests for the per-device Setup Wizard endpoints (`registerSetupWizardRoutes`).
 *
 * These tests cover:
 *   - GET /setup/state            (defaults when no row, persisted state otherwise)
 *   - POST /setup/root-check      (rooted vs non-rooted, manual ack)
 *   - POST /setup/create-users    (validation, root requirement, output parsing)
 *   - POST /setup/install-wa-per-user (validation + idempotent loop)
 *   - POST /setup/mark-registered (HITL ack)
 *   - POST /setup/finalize        (root requirement)
 *
 * `adb.shell` is fully stubbed — no real device is required. The wizard
 * state lives in an in-memory SQLite database created per test.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import Database from 'better-sqlite3'
import { registerSetupWizardRoutes } from './setup-wizard.js'
import { SetupWizardStore } from '../devices/setup-wizard-state.js'
import type { AdbBridge } from '../adb/index.js'

interface ShellMock {
  match: string
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

function build(adb: AdbBridge): { server: FastifyInstance; store: SetupWizardStore } {
  const db = new Database(':memory:')
  const store = new SetupWizardStore(db)
  store.initialize()
  const server = Fastify({ logger: false })
  registerSetupWizardRoutes(server, adb, { store })
  return { server, store }
}

// ── GET /setup/state ─────────────────────────────────────────────────────

describe('GET /api/v1/devices/:serial/setup/state', () => {
  it('returns defaults with exists=false when no row persisted', async () => {
    const adb = buildAdb([])
    const { server } = build(adb)
    await server.ready()
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/devices/POCO2/setup/state',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { exists: boolean; root_done: boolean }
    expect(body.exists).toBe(false)
    expect(body.root_done).toBe(false)
  })

  it('returns persisted state after wizard advances', async () => {
    const adb = buildAdb([])
    const { server, store } = build(adb)
    store.upsert('POCO2', { root_done: true, current_step: 'root_done' })
    await server.ready()
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/devices/POCO2/setup/state',
    })
    const body = res.json() as { exists: boolean; root_done: boolean; current_step: string }
    expect(body.exists).toBe(true)
    expect(body.root_done).toBe(true)
    expect(body.current_step).toBe('root_done')
  })
})

// ── POST /setup/root-check ───────────────────────────────────────────────

describe('POST /api/v1/devices/:serial/setup/root-check', () => {
  it('persists root_done=true when device is rooted', async () => {
    const adb = buildAdb([
      { match: 'su -c id', response: 'uid=0(root) gid=0(root)' },
    ])
    const { server, store } = build(adb)
    await server.ready()
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/devices/POCO1/setup/root-check',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { ok: boolean; rooted: boolean }
    expect(body.rooted).toBe(true)
    expect(body.ok).toBe(true)
    expect(store.get('POCO1')?.root_done).toBe(true)
  })

  it('returns 409 with hint when device is not rooted', async () => {
    const adb = buildAdb([
      { match: 'su -c id', response: '/system/bin/sh: su: inaccessible' },
    ])
    const { server } = build(adb)
    await server.ready()
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/devices/POCO2/setup/root-check',
    })
    expect(res.statusCode).toBe(409)
    const body = res.json() as { ok: boolean; rooted: boolean; hint: string }
    expect(body.rooted).toBe(false)
    expect(body.hint).toMatch(/poco-c71-root-procedure/)
  })

  it('manual-root-ack sets root_done=true without re-probing', async () => {
    const adb = buildAdb([])
    const { server, store } = build(adb)
    await server.ready()
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/devices/POCO2/setup/manual-root-ack',
    })
    expect(res.statusCode).toBe(200)
    expect(store.get('POCO2')?.root_done).toBe(true)
  })
})

// ── POST /setup/create-users ─────────────────────────────────────────────

describe('POST /api/v1/devices/:serial/setup/create-users', () => {
  it('parses created uid from `cmd user create-user` output', async () => {
    const adb = buildAdb([
      { match: 'su -c id', response: 'uid=0(root)' },
      { match: 'pm list users', response: 'Users:\n\tUserInfo{0:Main:1} running' },
      {
        match: 'cmd user create-user --user-type android.os.usertype.full.SECONDARY',
        response: 'Success: created user id 11',
      },
    ])
    const { server, store } = build(adb)
    await server.ready()
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/devices/POCO2/setup/create-users',
      payload: { users: [{ name: 'Oralsin 1 1' }] },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      ok: boolean
      results: Array<{ uid?: number; created: boolean }>
    }
    expect(body.results[0].created).toBe(true)
    expect(body.results[0].uid).toBe(11)
    const state = store.get('POCO2')!
    expect(state.users_created['11']).toBe('Oralsin 1 1')
  })

  it('returns 409 when device is not rooted', async () => {
    const adb = buildAdb([
      { match: 'su -c id', response: '/system/bin/sh: su: not found' },
    ])
    const { server } = build(adb)
    await server.ready()
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/devices/POCO2/setup/create-users',
      payload: { users: [{ name: 'X' }] },
    })
    expect(res.statusCode).toBe(409)
    const body = res.json() as { error: string }
    expect(body.error).toBe('device_not_rooted')
  })

  it('rejects names with shell-injection metachars', async () => {
    const adb = buildAdb([])
    const { server } = build(adb)
    await server.ready()
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/devices/POCO2/setup/create-users',
      payload: { users: [{ name: '"; rm -rf /' }] },
    })
    expect(res.statusCode).toBe(400)
  })
})

// ── POST /setup/install-wa-per-user ──────────────────────────────────────

describe('POST /api/v1/devices/:serial/setup/install-wa-per-user', () => {
  it('iterates `pm install-existing` per (user, package) and persists installed map', async () => {
    const adb = buildAdb([
      {
        match: 'pm list users',
        response:
          'Users:\n\tUserInfo{0:Main:1} running\n\tUserInfo{10:Sec:1}\n\tUserInfo{11:Sec2:1}',
      },
      {
        match: 'cmd package install-existing --user 10 com.whatsapp',
        response: 'Package com.whatsapp installed for user: 10',
      },
      {
        match: 'cmd package install-existing --user 10 com.whatsapp.w4b',
        response: 'Package com.whatsapp.w4b installed for user: 10',
      },
      {
        match: 'cmd package install-existing --user 11',
        response: 'Package installed for user: 11',
      },
    ])
    const { server, store } = build(adb)
    await server.ready()
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/devices/POCO2/setup/install-wa-per-user',
      payload: {},
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { ok: boolean; results: Array<{ ok: boolean }> }
    expect(body.results.length).toBeGreaterThan(0)
    expect(body.results.every((r) => r.ok)).toBe(true)
    const state = store.get('POCO2')!
    expect(state.wa_installed_profiles['10']).toContain('com.whatsapp')
  })

  it('returns 400 when no secondary users exist', async () => {
    const adb = buildAdb([
      { match: 'pm list users', response: 'Users:\n\tUserInfo{0:Main:1} running' },
    ])
    const { server } = build(adb)
    await server.ready()
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/devices/POCO2/setup/install-wa-per-user',
      payload: {},
    })
    expect(res.statusCode).toBe(400)
    const body = res.json() as { error: string }
    expect(body.error).toBe('no_target_users')
  })
})

// ── POST /setup/mark-registered ──────────────────────────────────────────

describe('POST /api/v1/devices/:serial/setup/mark-registered', () => {
  it('records phone number for a profile', async () => {
    const adb = buildAdb([])
    const { server, store } = build(adb)
    await server.ready()
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/devices/POCO2/setup/mark-registered',
      payload: { uid: 10, phone_number: '+5543991938235' },
    })
    expect(res.statusCode).toBe(200)
    const state = store.get('POCO2')!
    expect(state.wa_registered_profiles['10']).toBe('+5543991938235')
    expect(state.current_step).toBe('wa_registered')
  })

  it('rejects payload missing uid', async () => {
    const adb = buildAdb([])
    const { server } = build(adb)
    await server.ready()
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/devices/POCO2/setup/mark-registered',
      payload: { phone_number: '5511' },
    })
    expect(res.statusCode).toBe(400)
  })
})

// ── POST /setup/finalize ─────────────────────────────────────────────────

describe('POST /api/v1/devices/:serial/setup/finalize', () => {
  it('returns 409 when device is not rooted', async () => {
    const adb = buildAdb([
      { match: 'su -c id', response: '/system/bin/sh: su: not found' },
    ])
    const { server } = build(adb)
    await server.ready()
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/devices/POCO2/setup/finalize',
    })
    expect(res.statusCode).toBe(409)
  })
})

// ── Idempotency / re-entrancy ────────────────────────────────────────────

describe('SetupWizardStore re-entrancy', () => {
  it('merges per-profile maps across upsert calls (does not overwrite siblings)', () => {
    const db = new Database(':memory:')
    const store = new SetupWizardStore(db)
    store.initialize()
    store.upsert('A', { wa_registered_profiles: { '10': '+5511' } })
    store.upsert('A', { wa_registered_profiles: { '11': '+5512' } })
    const s = store.get('A')!
    expect(s.wa_registered_profiles).toEqual({ '10': '+5511', '11': '+5512' })
  })

  it('reset wipes the row', () => {
    const db = new Database(':memory:')
    const store = new SetupWizardStore(db)
    store.initialize()
    store.upsert('A', { root_done: true })
    expect(store.get('A')).toBeTruthy()
    store.reset('A')
    expect(store.get('A')).toBeNull()
  })
})
