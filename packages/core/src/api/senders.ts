import type { FastifyInstance } from 'fastify'
import type { SenderWarmup } from '../engine/sender-warmup.js'
import type { SenderMapping } from '../engine/sender-mapping.js'
import type { SenderHealth } from '../engine/sender-health.js'
import type { MessageQueue } from '../queue/index.js'
import type { DeviceManager } from '../monitor/index.js'

export interface SenderRouteDeps {
  senderWarmup: SenderWarmup
  senderMapping: SenderMapping
  senderHealth: SenderHealth
  queue: MessageQueue
  deviceManager?: DeviceManager
}

export function registerSenderRoutes(
  server: FastifyInstance,
  deps: SenderRouteDeps,
): void {
  const { senderWarmup, senderMapping, senderHealth, queue, deviceManager } = deps

  /**
   * Operator-facing sender views must hide synthetic placeholder
   * phones. `PUT /sessions/managed/:name/device` writes a `99999…`
   * row to sender_mapping when an operator pins a session before
   * pairing completes — that row exists purely to keep the
   * (device, profile) reservation alive in the DB. It is NOT a
   * sender that can dispatch anything (no real WhatsApp account
   * behind it), so showing it on the dashboard misled operators
   * into thinking they had more reachable numbers than they do.
   *
   * The Sessions tab still shows the pin via managed_sessions, so
   * no information is lost — only the senders dashboard is cleaned.
   */
  const isPlaceholder = (phone: string): boolean => phone.startsWith('99999')

  // ── Device-aware sender topology ──

  server.get('/api/v1/senders/topology', async () => {
    const mappings = senderMapping.listAll().filter(m => !isPlaceholder(m.phone_number))
    const onlineDevices = new Set(
      (deviceManager?.getDevices() ?? [])
        .filter(d => d.status === 'online')
        .map(d => d.serial),
    )

    const senders = mappings.map(m => {
      const health = senderHealth.getStatus(m.phone_number)
      const dailyCount = queue.getSenderDailyCount(m.phone_number)
      const deviceOnline = onlineDevices.has(m.device_serial)
      const adbReady = deviceOnline && m.active === 1 && m.paused === 0
      const wahaReady = !!m.waha_session && !!m.waha_api_url

      let availability: 'adb' | 'waha_only' | 'offline'
      if (adbReady) availability = 'adb'
      else if (wahaReady) availability = 'waha_only'
      else availability = 'offline'

      return {
        phone: m.phone_number,
        session: m.waha_session,
        device: {
          serial: m.device_serial,
          profileId: m.profile_id,
          online: deviceOnline,
        },
        status: {
          active: m.active === 1,
          paused: m.paused === 1,
          pausedReason: m.paused_reason ?? null,
          quarantined: health ? !!health.quarantinedUntil : false,
          availability,
        },
        waha: {
          session: m.waha_session,
          apiUrl: m.waha_api_url ? '(configured)' : null,
        },
        stats: {
          dailyCount,
          totalSent: health?.totalSuccesses ?? 0,
          totalFailed: health?.totalFailures ?? 0,
          consecutiveFailures: health?.consecutiveFailures ?? 0,
        },
      }
    })

    // Group by device for readability
    const byDevice = new Map<string, typeof senders>()
    for (const s of senders) {
      const key = s.device.serial
      if (!byDevice.has(key)) byDevice.set(key, [])
      byDevice.get(key)!.push(s)
    }

    const devices = [...byDevice.entries()].map(([serial, deviceSenders]) => {
      const online = deviceSenders[0]?.device.online ?? false
      return {
        serial,
        online,
        profiles: deviceSenders.length,
        senders: deviceSenders.map(s => ({
          phone: s.phone,
          session: s.session,
          profileId: s.device.profileId,
          availability: s.status.availability,
          paused: s.status.paused,
          quarantined: s.status.quarantined,
          dailyCount: s.stats.dailyCount,
        })),
      }
    })

    const summary = {
      total: senders.length,
      adb: senders.filter(s => s.status.availability === 'adb').length,
      waha_only: senders.filter(s => s.status.availability === 'waha_only').length,
      offline: senders.filter(s => s.status.availability === 'offline').length,
      paused: senders.filter(s => s.status.paused).length,
      quarantined: senders.filter(s => s.status.quarantined).length,
    }

    return { summary, devices, senders }
  })

  // ── Warmup routes (existing) ──

  server.post('/api/v1/senders/:phone/skip-warmup', async (request, reply) => {
    const { phone } = request.params as { phone: string }
    senderWarmup.skipWarmup(phone)
    const tier = senderWarmup.getTier(phone)
    return reply.send({ phone, tier: tier.tier, dailyCap: tier.dailyCap, skipped: true })
  })

  server.get('/api/v1/senders/:phone/warmup', async (request, reply) => {
    const { phone } = request.params as { phone: string }
    const tier = senderWarmup.getTier(phone)
    return reply.send({
      phone,
      tier: tier.tier,
      dailyCap: tier.dailyCap,
      delays: senderWarmup.getEffectiveDelays(phone),
    })
  })

  // ── Pause / Resume routes ──

  server.post('/api/v1/senders/:phone/pause', async (request, reply) => {
    const { phone } = request.params as { phone: string }
    const body = request.body as { reason?: string } | undefined
    const mapping = senderMapping.getByPhone(phone)
    if (!mapping) return reply.status(404).send({ error: 'Sender not found' })
    senderMapping.pauseSender(phone, body?.reason)
    return reply.send({ phone, paused: true, reason: body?.reason ?? null })
  })

  server.post('/api/v1/senders/:phone/resume', async (request, reply) => {
    const { phone } = request.params as { phone: string }
    const mapping = senderMapping.getByPhone(phone)
    if (!mapping) return reply.status(404).send({ error: 'Sender not found' })
    senderMapping.resumeSender(phone)
    return reply.send({ phone, paused: false })
  })

  // ── Comprehensive status endpoint ──

  server.get('/api/v1/senders/status', async () => {
    const mappings = senderMapping.listAll().filter(m => !isPlaceholder(m.phone_number))
    return {
      senders: mappings.map(m => {
        const health = senderHealth.getStatus(m.phone_number)
        const tier = senderWarmup.getTier(m.phone_number)
        const dailyCount = queue.getSenderDailyCount(m.phone_number)
        return {
          phone: m.phone_number,
          deviceSerial: m.device_serial,
          profileId: m.profile_id,
          appPackage: m.app_package,
          active: m.active === 1,
          paused: m.paused === 1,
          pausedReason: m.paused_reason ?? null,
          warmupTier: tier.tier,
          dailyCap: tier.dailyCap,
          dailyCount,
          quarantined: health ? !!health.quarantinedUntil : false,
          quarantinedUntil: health?.quarantinedUntil ?? null,
          consecutiveFailures: health?.consecutiveFailures ?? 0,
          totalSent: health?.totalSuccesses ?? 0,
          totalFailed: health?.totalFailures ?? 0,
        }
      }),
    }
  })
}
