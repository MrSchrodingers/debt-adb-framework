import type { FastifyInstance } from 'fastify'
import type { SenderWarmup } from '../engine/sender-warmup.js'
import type { SenderMapping } from '../engine/sender-mapping.js'
import type { SenderHealth } from '../engine/sender-health.js'
import type { MessageQueue } from '../queue/index.js'

export interface SenderRouteDeps {
  senderWarmup: SenderWarmup
  senderMapping: SenderMapping
  senderHealth: SenderHealth
  queue: MessageQueue
}

export function registerSenderRoutes(
  server: FastifyInstance,
  deps: SenderRouteDeps,
): void {
  const { senderWarmup, senderMapping, senderHealth, queue } = deps

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
    const mappings = senderMapping.listAll()
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
