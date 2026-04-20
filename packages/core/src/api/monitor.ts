import type { FastifyInstance } from 'fastify'
import type { AdbBridge } from '../adb/index.js'
import type { SendEngine } from '../engine/index.js'
import type { DeviceManager, HealthCollector, WaAccountMapper, AlertSystem } from '../monitor/index.js'

interface MonitorDeps {
  adb: AdbBridge
  engine: SendEngine
  deviceManager: DeviceManager
  healthCollector: HealthCollector
  waMapper: WaAccountMapper
  alertSystem: AlertSystem
}

const ALLOWED_WA_PACKAGES = new Set(['com.whatsapp', 'com.whatsapp.w4b'])

export function registerMonitorRoutes(server: FastifyInstance, deps: MonitorDeps): void {
  const { adb, engine, deviceManager, healthCollector, waMapper, alertSystem } = deps

  // Enhanced device list — returns devices with status from DeviceManager
  server.get('/api/v1/monitor/devices', async () => {
    return deviceManager.getDevices()
  })

  // Device detail with health + accounts
  server.get('/api/v1/monitor/devices/:serial', async (request, reply) => {
    const { serial } = request.params as { serial: string }
    const device = deviceManager.getDevice(serial)
    if (!device) return reply.status(404).send({ error: 'Device not found' })

    const accounts = waMapper.getAccountsByDevice(serial)
    const health = healthCollector.getHistory(serial, 24)
    const alerts = alertSystem.getActive(serial)

    return { ...device, accounts, health, alerts }
  })

  // Health history
  server.get('/api/v1/monitor/devices/:serial/health', async (request, reply) => {
    const { serial } = request.params as { serial: string }
    const { hours } = request.query as { hours?: string }
    const h = hours ? parseInt(hours, 10) : 24
    return healthCollector.getHistory(serial, h)
  })

  // WA accounts for device
  server.get('/api/v1/monitor/devices/:serial/accounts', async (request) => {
    const { serial } = request.params as { serial: string }
    return waMapper.getAccountsByDevice(serial)
  })

  // Reboot device — with serial validation + send-lock guard
  server.post('/api/v1/monitor/devices/:serial/reboot', async (request, reply) => {
    const { serial } = request.params as { serial: string }
    if (!deviceManager.getDevice(serial)) {
      return reply.status(404).send({ error: 'Device not found' })
    }
    if (engine.isProcessing) {
      return reply.status(409).send({ error: 'Device is sending a message. Try again in a few seconds.' })
    }
    await adb.shell(serial, 'reboot')
    return { status: 'rebooting', serial }
  })

  // Restart WhatsApp — with serial validation + package allowlist + send-lock guard
  server.post('/api/v1/monitor/devices/:serial/restart-whatsapp', async (request, reply) => {
    const { serial } = request.params as { serial: string }
    const { packageName } = request.query as { packageName?: string }
    const pkg = packageName || 'com.whatsapp'

    if (!ALLOWED_WA_PACKAGES.has(pkg)) {
      return reply.status(400).send({ error: `Invalid package. Allowed: ${[...ALLOWED_WA_PACKAGES].join(', ')}` })
    }
    if (!deviceManager.getDevice(serial)) {
      return reply.status(404).send({ error: 'Device not found' })
    }
    if (engine.isProcessing) {
      return reply.status(409).send({ error: 'Device is sending a message. Try again in a few seconds.' })
    }

    await adb.shell(serial, `am force-stop ${pkg}`)
    await adb.shell(serial, `am start -n ${pkg}/com.whatsapp.Main`)
    return { status: 'restarted', serial, packageName: pkg }
  })

  // All alerts (with optional device filter)
  server.get('/api/v1/monitor/alerts', async (request) => {
    const { serial, active } = request.query as { serial?: string; active?: string }
    if (serial) {
      return active === 'true' ? alertSystem.getActive(serial) : alertSystem.getAll(serial)
    }
    return alertSystem.getAllActive()
  })
}
