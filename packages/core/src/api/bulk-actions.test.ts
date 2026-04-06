import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import Database from 'better-sqlite3'
import { DeviceManager } from '../monitor/device-manager.js'
import { HealthCollector } from '../monitor/health-collector.js'
import { DispatchEmitter } from '../events/index.js'
import { registerBulkActionRoutes } from './bulk-actions.js'

// Minimal mock ADB adapter
function createMockAdb(
  onlineSerials: Set<string>,
  shellResults: Map<string, string> = new Map(),
  screenshotResults: Map<string, Buffer> = new Map(),
) {
  const shellCalls: Array<{ serial: string; command: string }> = []

  return {
    shellCalls,
    discover: async () =>
      [...onlineSerials].map(s => ({ serial: s, type: 'device' as const })),
    shell: async (serial: string, command: string) => {
      shellCalls.push({ serial, command })
      if (!onlineSerials.has(serial)) {
        throw new Error('Device offline')
      }
      return shellResults.get(`${serial}:${command}`) ?? ''
    },
    screenshot: async (serial: string) => {
      if (!onlineSerials.has(serial)) {
        throw new Error('Device offline')
      }
      return screenshotResults.get(serial) ?? Buffer.from('fake-png')
    },
  }
}

describe('POST /api/v1/devices/bulk-action', () => {
  let server: FastifyInstance
  let db: Database.Database
  let emitter: DispatchEmitter
  let deviceManager: DeviceManager
  let mockAdb: ReturnType<typeof createMockAdb>

  beforeEach(async () => {
    db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    emitter = new DispatchEmitter()
    mockAdb = createMockAdb(new Set(['serial-1', 'serial-2']))
    deviceManager = new DeviceManager(db, emitter, mockAdb)
    deviceManager.initialize()
    // Populate devices table
    await deviceManager.poll()

    server = Fastify()
    registerBulkActionRoutes(server, { adb: mockAdb, deviceManager })
    await server.ready()
  })

  afterEach(async () => {
    await server.close()
    db.close()
  })

  it('applies keep-awake to all devices', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/devices/bulk-action',
      payload: {
        serials: ['serial-1', 'serial-2'],
        action: 'keep-awake',
      },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.results).toHaveLength(2)
    expect(body.results[0]).toEqual({ serial: 'serial-1', success: true })
    expect(body.results[1]).toEqual({ serial: 'serial-2', success: true })

    // Verify shell commands were issued
    const keepAwakeCmds = mockAdb.shellCalls.filter(c =>
      c.command.includes('svc power stayon')
    )
    expect(keepAwakeCmds).toHaveLength(2)
  })

  it('failed device does not stop others', async () => {
    // Remove serial-1 from online set to simulate offline device
    const offlineAdb = createMockAdb(new Set(['serial-2']))
    const offlineDeviceManager = new DeviceManager(db, emitter, offlineAdb)
    // Don't re-init (we want existing device rows)

    const offlineServer = Fastify()
    registerBulkActionRoutes(offlineServer, { adb: offlineAdb, deviceManager: offlineDeviceManager })
    await offlineServer.ready()

    // But the device is still in the devices table from initial poll
    // Simulate: serial-1 shell calls will throw
    const res = await offlineServer.inject({
      method: 'POST',
      url: '/api/v1/devices/bulk-action',
      payload: {
        serials: ['serial-1', 'serial-2'],
        action: 'screenshot',
      },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.results).toHaveLength(2)

    // serial-1 should fail (offline), serial-2 should succeed
    const result1 = body.results.find((r: { serial: string }) => r.serial === 'serial-1')
    const result2 = body.results.find((r: { serial: string }) => r.serial === 'serial-2')

    expect(result1.success).toBe(false)
    expect(result1.error).toBeDefined()
    expect(result2.success).toBe(true)

    await offlineServer.close()
  })

  it('returns 400 for invalid action', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/devices/bulk-action',
      payload: {
        serials: ['serial-1'],
        action: 'format-device',
      },
    })

    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body.error).toBeDefined()
  })

  it('returns 400 for empty serials', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/devices/bulk-action',
      payload: {
        serials: [],
        action: 'keep-awake',
      },
    })

    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body.error).toBeDefined()
  })

  it('reboot action issues reboot command', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/devices/bulk-action',
      payload: {
        serials: ['serial-1'],
        action: 'reboot',
      },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.results[0]).toEqual({ serial: 'serial-1', success: true })

    const rebootCmds = mockAdb.shellCalls.filter(c => c.command === 'reboot')
    expect(rebootCmds).toHaveLength(1)
    expect(rebootCmds[0].serial).toBe('serial-1')
  })

  it('screenshot action returns success without binary data', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/devices/bulk-action',
      payload: {
        serials: ['serial-1'],
        action: 'screenshot',
      },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.results[0]).toEqual({ serial: 'serial-1', success: true })
  })
})
