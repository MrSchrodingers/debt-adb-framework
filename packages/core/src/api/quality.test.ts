import Database from 'better-sqlite3'
import Fastify from 'fastify'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { registerQualityRoutes } from './quality.js'
import { QualityHistory } from '../research/quality-history.js'
import { ChipRegistry } from '../fleet/chip-registry.js'
import { SenderWarmup } from '../engine/sender-warmup.js'
import type { QualityScoreComponents } from '../research/quality-score.js'

const FIXTURE_DDL = [
  `CREATE TABLE IF NOT EXISTS message_history (
      id TEXT PRIMARY KEY, message_id TEXT, direction TEXT NOT NULL,
      from_number TEXT, to_number TEXT, text TEXT, created_at TEXT NOT NULL,
      waha_message_id TEXT, captured_via TEXT
    )`,
  `CREATE TABLE IF NOT EXISTS message_ack_history (
      id TEXT PRIMARY KEY, waha_message_id TEXT NOT NULL, ack_level INTEGER NOT NULL,
      observed_at TEXT NOT NULL, sender_phone TEXT
    )`,
  `CREATE TABLE IF NOT EXISTS sender_warmup (
      sender_number TEXT PRIMARY KEY, activated_at TEXT NOT NULL,
      skipped INTEGER NOT NULL DEFAULT 0, skipped_at TEXT
    )`,
]

function components(t = 0.7): QualityScoreComponents {
  return { ackRate: t, banHistory: 1, age: t, warmupCompletion: 1, volumeFit: t, fingerprintFreshness: t, recipientResponse: t }
}

describe('quality API', () => {
  let db: Database.Database
  let history: QualityHistory
  let chips: ChipRegistry
  let warmup: SenderWarmup
  let server: ReturnType<typeof Fastify>

  beforeEach(async () => {
    db = new Database(':memory:')
    for (const s of FIXTURE_DDL) db.prepare(s).run()
    history = new QualityHistory(db)
    history.initialize()
    chips = new ChipRegistry(db)
    chips.initialize()
    warmup = new SenderWarmup(db)
    server = Fastify()
    registerQualityRoutes(server, {
      db, history, chips,
      composerFactory: (phone) => ({
        senderPhone: phone, db, chips, warmup, now: Date.now(),
      }),
    })
    await server.ready()
  })

  afterEach(async () => {
    await server.close()
  })

  it('GET /summary returns latest score per sender', async () => {
    history.record({ senderPhone: '551111', total: 80, components: components(0.9) })
    history.record({ senderPhone: '552222', total: 30, components: components(0.2) })
    const res = await server.inject({ method: 'GET', url: '/api/v1/quality/summary' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.total).toBe(2)
    expect(body.rows[0].senderPhone).toBe('552222') // sorted asc by score
    expect(body.rows[1].senderPhone).toBe('551111')
  })

  it('GET /trend/:phone returns time series', async () => {
    history.record({ senderPhone: '551111', total: 70, components: components(), computedAt: '2026-04-28 10:00:00' })
    history.record({ senderPhone: '551111', total: 80, components: components(), computedAt: '2026-04-29 10:00:00' })
    const res = await server.inject({ method: 'GET', url: '/api/v1/quality/trend/551111?days=30' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.senderPhone).toBe('551111')
    expect(body.samples.length).toBe(2)
    expect(body.samples[0].total).toBe(70)
  })

  it('GET /trend rejects invalid days', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/v1/quality/trend/551111?days=abc' })
    expect(res.statusCode).toBe(400)
  })

  it('GET /components/:phone returns live + persisted', async () => {
    history.record({ senderPhone: '551111', total: 60, components: components(0.5) })
    const res = await server.inject({ method: 'GET', url: '/api/v1/quality/components/551111' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.senderPhone).toBe('551111')
    expect(body.live.total).toBeGreaterThanOrEqual(0)
    expect(body.live.total).toBeLessThanOrEqual(100)
    expect(body.live.warmupTier).toBeDefined()
    expect(body.live.volumeDailyCap).toBeGreaterThan(0)
    expect(body.lastPersisted.total).toBe(60)
    expect(body.weights.ackRate).toBe(0.30)
  })

  it('GET /cohort groups by month/carrier/ddd', async () => {
    chips.createChip({
      phone_number: '5511999990001', carrier: 'tim', plan_name: 'A',
      acquisition_date: '2026-04-01', acquisition_cost_brl: 50, monthly_cost_brl: 60,
      payment_due_day: 10, paid_by_operator: 'matheus',
    })
    chips.createChip({
      phone_number: '5511999990002', carrier: 'tim', plan_name: 'A',
      acquisition_date: '2026-04-15', acquisition_cost_brl: 50, monthly_cost_brl: 60,
      payment_due_day: 10, paid_by_operator: 'matheus', status: 'banned',
    })
    chips.createChip({
      phone_number: '5543991111111', carrier: 'vivo', plan_name: 'B',
      acquisition_date: '2026-03-15', acquisition_cost_brl: 50, monthly_cost_brl: 60,
      payment_due_day: 10, paid_by_operator: 'matheus',
    })
    const res = await server.inject({ method: 'GET', url: '/api/v1/quality/cohort' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    const tim = body.rows.find((r: { ddd: string; carrier: string }) => r.ddd === '11' && r.carrier === 'tim')
    expect(tim.total).toBe(2)
    expect(tim.banned).toBe(1)
    expect(tim.banRate).toBe(0.5)
  })

  it('POST /tick returns 503 when manualTick not wired', async () => {
    const res = await server.inject({ method: 'POST', url: '/api/v1/quality/tick' })
    expect(res.statusCode).toBe(503)
  })

  it('POST /tick invokes manualTick and returns processed senders', async () => {
    let invoked = 0
    const tickServer = Fastify()
    registerQualityRoutes(tickServer, {
      db, history, chips,
      composerFactory: (phone) => ({ senderPhone: phone, db, chips, warmup, now: Date.now() }),
      manualTick: () => { invoked++; return { senders: 7 } },
    })
    await tickServer.ready()
    const res = await tickServer.inject({ method: 'POST', url: '/api/v1/quality/tick' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, senders: 7 })
    expect(invoked).toBe(1)
    await tickServer.close()
  })

  it('GET /fleet-median returns 0..1', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/v1/quality/fleet-median' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.readRatioMedianLast24h).toBeGreaterThanOrEqual(0)
    expect(body.readRatioMedianLast24h).toBeLessThanOrEqual(1)
  })
})
