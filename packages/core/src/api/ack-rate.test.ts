import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import Fastify, { type FastifyInstance } from 'fastify'
import { AckHistory } from '../waha/ack-history.js'
import { MessageHistory } from '../waha/message-history.js'
import { AckRateThresholds } from '../research/ack-rate-thresholds.js'
import { AckPersistFailures } from '../waha/ack-persist-failures.js'
import {
  buildSummary,
  buildSparkline,
  registerAckRateRoutes,
} from './ack-rate.js'

const require = createRequire(import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require('better-sqlite3') as typeof import('better-sqlite3').default

interface SeededAck {
  wahaMessageId: string
  ackLevel: number
  observedAtMs: number
  senderPhone: string
}

function setup(): {
  db: import('better-sqlite3').Database
  history: MessageHistory
  ackHistory: AckHistory
  thresholds: AckRateThresholds
  persistFailures: AckPersistFailures
} {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  const history = new MessageHistory(db)
  history.initialize()
  const ackHistory = new AckHistory(db, history)
  ackHistory.initialize()
  const thresholds = new AckRateThresholds(db)
  thresholds.initialize()
  const persistFailures = new AckPersistFailures(db)
  persistFailures.initialize()
  return { db, history, ackHistory, thresholds, persistFailures }
}

function seedAcks(
  db: import('better-sqlite3').Database,
  history: MessageHistory,
  ackHistory: AckHistory,
  acks: SeededAck[],
): void {
  // Insert outbound message_history rows for each unique waha_message_id
  // so AckHistory.insert resolves sender_phone via JOIN.
  const seen = new Set<string>()
  for (const a of acks) {
    if (seen.has(a.wahaMessageId)) continue
    seen.add(a.wahaMessageId)
    history.insert({
      direction: 'outgoing',
      fromNumber: a.senderPhone,
      toNumber: '5543991938235',
      text: 'hi',
      capturedVia: 'adb_send',
      wahaMessageId: a.wahaMessageId,
    })
  }
  for (const a of acks) {
    ackHistory.insert({
      wahaMessageId: a.wahaMessageId,
      ackLevel: a.ackLevel,
      ackLevelName: a.ackLevel === 1 ? 'sent' : a.ackLevel === 2 ? 'delivered' : 'read',
      deliveredAt: a.ackLevel >= 2 ? new Date(a.observedAtMs).toISOString() : null,
      readAt: a.ackLevel >= 3 ? new Date(a.observedAtMs).toISOString() : null,
    })
    // Override observed_at to the seeded time so range queries are deterministic
    db.prepare(
      `UPDATE message_ack_history
       SET observed_at = ?
       WHERE waha_message_id = ? AND ack_level = ?`,
    ).run(msToSqliteDatetime(a.observedAtMs), a.wahaMessageId, a.ackLevel)
  }
}

function msToSqliteDatetime(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
}

describe('ack-rate API — buildSummary', () => {
  it('returns INSUFFICIENT when no acks exist', () => {
    const { db, thresholds } = setup()
    const result = buildSummary(db, thresholds, {
      windowMs: 3_600_000, hours: 24, percentile: 0.05, minWindows: 24,
    })
    expect(result.dataSufficiency).toBe('INSUFFICIENT')
    expect(result.perSender).toHaveLength(0)
  })

  it('returns SPARSE when senders have some windows but below minWindows', () => {
    const { db, history, ackHistory, thresholds } = setup()
    const now = Date.now()
    const acks: SeededAck[] = []
    // 5 messages in 5 distinct hourly buckets — sampleWindows will be 5.
    // With minWindows=8, halfThreshold=4 and 5 >= 4 so verdict is SPARSE.
    for (let i = 0; i < 5; i++) {
      const id = `wa-${i}`
      acks.push({ wahaMessageId: id, ackLevel: 1, observedAtMs: now - i * 3_600_000, senderPhone: '5511999' })
      acks.push({ wahaMessageId: id, ackLevel: 3, observedAtMs: now - i * 3_600_000, senderPhone: '5511999' })
    }
    seedAcks(db, history, ackHistory, acks)
    const result = buildSummary(db, thresholds, {
      windowMs: 3_600_000, hours: 24, percentile: 0.05, minWindows: 8,
    })
    expect(result.dataSufficiency).toBe('SPARSE')
    expect(result.perSender).toHaveLength(1)
    expect(result.perSender[0].senderPhone).toBe('5511999')
    expect(result.perSender[0].totalSent).toBe(5)
    expect(result.perSender[0].totalRead).toBe(5)
  })

  it('returns SUFFICIENT when at least one sender meets minWindows', () => {
    const { db, history, ackHistory, thresholds } = setup()
    const now = Date.now()
    const acks: SeededAck[] = []
    for (let i = 0; i < 30; i++) {
      const id = `wa-${i}`
      acks.push({ wahaMessageId: id, ackLevel: 1, observedAtMs: now - i * 3_600_000, senderPhone: '5511999' })
      acks.push({ wahaMessageId: id, ackLevel: 3, observedAtMs: now - i * 3_600_000, senderPhone: '5511999' })
    }
    seedAcks(db, history, ackHistory, acks)
    const result = buildSummary(db, thresholds, {
      windowMs: 3_600_000, hours: 30 + 1, percentile: 0.05, minWindows: 10,
    })
    expect(result.dataSufficiency).toBe('SUFFICIENT')
  })

  it('joins NULL sender_phone via message_history backfill', () => {
    const { db, history, thresholds } = setup()
    // Create a row in message_history first
    history.insert({
      direction: 'outgoing',
      fromNumber: '5511999',
      toNumber: '5543991938235',
      text: 'hi',
      capturedVia: 'adb_send',
      wahaMessageId: 'wa-orphan',
    })
    // Insert ack manually with sender_phone = NULL to simulate the race
    db.prepare(
      `INSERT INTO message_ack_history
         (id, waha_message_id, ack_level, ack_level_name, observed_at, sender_phone)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('id-1', 'wa-orphan', 1, 'sent', msToSqliteDatetime(Date.now()), null)
    db.prepare(
      `INSERT INTO message_ack_history
         (id, waha_message_id, ack_level, ack_level_name, observed_at, sender_phone)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('id-2', 'wa-orphan', 3, 'read', msToSqliteDatetime(Date.now()), null)

    const result = buildSummary(db, thresholds, {
      windowMs: 3_600_000, hours: 24, percentile: 0.05, minWindows: 1,
    })
    expect(result.perSender).toHaveLength(1)
    expect(result.perSender[0].senderPhone).toBe('5511999')
  })

  it('attaches applied threshold info when one exists for the sender', () => {
    const { db, history, ackHistory, thresholds } = setup()
    const now = Date.now()
    seedAcks(db, history, ackHistory, [
      { wahaMessageId: 'wa-1', ackLevel: 1, observedAtMs: now, senderPhone: '5511999' },
      { wahaMessageId: 'wa-1', ackLevel: 3, observedAtMs: now, senderPhone: '5511999' },
    ])
    thresholds.apply({ senderPhone: '5511999', threshold: 0.42, windowMs: 7_200_000, appliedBy: 'alice' })
    const result = buildSummary(db, thresholds, {
      windowMs: 3_600_000, hours: 24, percentile: 0.05, minWindows: 1,
    })
    expect(result.perSender[0].appliedThreshold).toBe(0.42)
    expect(result.perSender[0].appliedBy).toBe('alice')
  })
})

describe('ack-rate API — buildSparkline', () => {
  it('returns empty data for unknown sender', () => {
    const { db } = setup()
    const result = buildSparkline(db, '5511999', 7)
    expect(result.data).toEqual([])
  })

  it('produces per-hour buckets with delivery and read ratios', () => {
    const { db, history, ackHistory } = setup()
    const now = Date.now()
    seedAcks(db, history, ackHistory, [
      { wahaMessageId: 'wa-1', ackLevel: 1, observedAtMs: now, senderPhone: '5511999' },
      { wahaMessageId: 'wa-1', ackLevel: 3, observedAtMs: now, senderPhone: '5511999' },
      { wahaMessageId: 'wa-2', ackLevel: 1, observedAtMs: now - 3_600_000, senderPhone: '5511999' },
    ])
    const result = buildSparkline(db, '5511999', 1, now + 60_000)
    expect(result.data.length).toBeGreaterThanOrEqual(2)
    const last = result.data[result.data.length - 1]
    expect(last.sentTotal).toBe(1)
    expect(last.readRatio).toBe(1)
  })
})

describe('ack-rate API — routes', () => {
  let server: FastifyInstance
  let env: ReturnType<typeof setup>

  beforeEach(async () => {
    env = setup()
    server = Fastify()
    registerAckRateRoutes(server, {
      db: env.db,
      thresholds: env.thresholds,
      persistFailures: env.persistFailures,
    })
    await server.ready()
  })

  afterEach(async () => {
    await server.close()
    env.db.close()
  })

  it('GET /summary returns INSUFFICIENT for empty DB', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/v1/ack-rate/summary?hours=24' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { dataSufficiency: string; perSender: unknown[] }
    expect(body.dataSufficiency).toBe('INSUFFICIENT')
    expect(body.perSender).toEqual([])
  })

  it('GET /summary rejects invalid query params', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/v1/ack-rate/summary?hours=-3' })
    expect(res.statusCode).toBe(400)
  })

  it('GET /sparkline returns hourly data shape', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/ack-rate/sparkline/5511999?days=7',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { data: unknown[] }
    expect(Array.isArray(body.data)).toBe(true)
  })

  it('GET /persist-failures returns count and recent', async () => {
    env.persistFailures.insert({ wahaMessageId: 'wa-1', ackLevel: 3, error: 'boom' })
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/ack-rate/persist-failures?hours=24',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { count: number; recent: unknown[] }
    expect(body.count).toBe(1)
    expect(body.recent).toHaveLength(1)
  })

  it('POST /apply persists a per-sender threshold and supersedes the previous one', async () => {
    const first = await server.inject({
      method: 'POST',
      url: '/api/v1/ack-rate/apply',
      payload: { senderPhone: '5511999', threshold: 0.4, windowMs: 3_600_000 },
    })
    expect(first.statusCode).toBe(201)
    const firstBody = first.json() as { id: string; active: { id: string; threshold: number } }
    expect(firstBody.id).toBeTruthy()

    const second = await server.inject({
      method: 'POST',
      url: '/api/v1/ack-rate/apply',
      payload: { senderPhone: '5511999', threshold: 0.6, windowMs: 7_200_000, appliedBy: 'alice' },
    })
    expect(second.statusCode).toBe(201)
    const secondBody = second.json() as { id: string; active: { threshold: number; appliedBy: string } }
    expect(secondBody.active.threshold).toBe(0.6)
    expect(secondBody.active.appliedBy).toBe('alice')

    const list = env.thresholds.history('5511999')
    expect(list).toHaveLength(2)
    const old = list.find((r) => r.id === firstBody.id)
    expect(old?.supersededBy).toBe(secondBody.id)
  })

  it('POST /apply rejects threshold outside [0, 1]', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/ack-rate/apply',
      payload: { senderPhone: '5511999', threshold: 1.5, windowMs: 3_600_000 },
    })
    expect(res.statusCode).toBe(400)
  })

  it('POST /apply rejects non-positive windowMs', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/ack-rate/apply',
      payload: { senderPhone: '5511999', threshold: 0.4, windowMs: 0 },
    })
    expect(res.statusCode).toBe(400)
  })

  it('GET /applied lists active thresholds', async () => {
    env.thresholds.apply({ senderPhone: '5511999', threshold: 0.4, windowMs: 3_600_000 })
    const res = await server.inject({ method: 'GET', url: '/api/v1/ack-rate/applied' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { rows: Array<{ senderPhone: string; threshold: number }> }
    expect(body.rows).toHaveLength(1)
    expect(body.rows[0].senderPhone).toBe('5511999')
  })
})
