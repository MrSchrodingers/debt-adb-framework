import Database from 'better-sqlite3'
import { describe, it, expect, beforeEach } from 'vitest'
import { composeQualityInputs, fleetMedianReadRatio } from './quality-composer.js'
import { ChipRegistry } from '../fleet/chip-registry.js'
import { SenderWarmup } from '../engine/sender-warmup.js'

interface Ctx {
  db: Database.Database
  chips: ChipRegistry
  warmup: SenderWarmup
  now: number
}

const FIXTURE_DDL = [
  `CREATE TABLE IF NOT EXISTS message_history (
      id TEXT PRIMARY KEY,
      message_id TEXT,
      direction TEXT NOT NULL,
      from_number TEXT,
      to_number TEXT,
      text TEXT,
      created_at TEXT NOT NULL,
      waha_message_id TEXT,
      captured_via TEXT
    )`,
  `CREATE TABLE IF NOT EXISTS message_ack_history (
      id TEXT PRIMARY KEY,
      waha_message_id TEXT NOT NULL,
      ack_level INTEGER NOT NULL,
      observed_at TEXT NOT NULL,
      sender_phone TEXT
    )`,
  `CREATE TABLE IF NOT EXISTS sender_warmup (
      sender_number TEXT PRIMARY KEY,
      activated_at TEXT NOT NULL,
      skipped INTEGER NOT NULL DEFAULT 0,
      skipped_at TEXT
    )`,
]

function setup(): Ctx {
  const db = new Database(':memory:')
  for (const stmt of FIXTURE_DDL) db.prepare(stmt).run()
  const chips = new ChipRegistry(db)
  chips.initialize()
  const warmup = new SenderWarmup(db)
  return { db, chips, warmup, now: new Date('2026-04-30T12:00:00Z').getTime() }
}

function insertChip(ctx: Ctx, phone: string, acquisitionDaysAgo: number): string {
  const acqDate = new Date(ctx.now - acquisitionDaysAgo * 86_400_000).toISOString().slice(0, 10)
  return ctx.chips.createChip({
    phone_number: phone,
    carrier: 'tim',
    plan_name: 'Controle 30GB',
    acquisition_date: acqDate,
    acquisition_cost_brl: 50,
    monthly_cost_brl: 60,
    payment_due_day: 10,
    paid_by_operator: 'matheus',
  }).id
}

function insertOutgoing(ctx: Ctx, sender: string, recipient: string, daysAgo: number, wahaMessageId?: string): void {
  const id = `m${Math.random().toString(36).slice(2)}`
  const ts = new Date(ctx.now - daysAgo * 86_400_000).toISOString()
  ctx.db.prepare(`INSERT INTO message_history (id, direction, from_number, to_number, text, created_at, waha_message_id, captured_via)
    VALUES (?, 'outgoing', ?, ?, ?, ?, ?, 'waha')`).run(id, sender, recipient, 'hi', ts, wahaMessageId ?? null)
}

function insertIncoming(ctx: Ctx, sender: string, recipient: string, daysAgo: number): void {
  const id = `m${Math.random().toString(36).slice(2)}`
  const ts = new Date(ctx.now - daysAgo * 86_400_000).toISOString()
  ctx.db.prepare(`INSERT INTO message_history (id, direction, from_number, to_number, text, created_at, captured_via)
    VALUES (?, 'incoming', ?, ?, ?, ?, 'waha')`).run(id, recipient, sender, 'reply', ts)
}

function insertAck(ctx: Ctx, sender: string, wahaMessageId: string, ackLevel: number, daysAgo: number): void {
  const id = `a${Math.random().toString(36).slice(2)}`
  const ts = new Date(ctx.now - daysAgo * 86_400_000).toISOString().slice(0, 19).replace('T', ' ')
  ctx.db.prepare(`INSERT INTO message_ack_history (id, waha_message_id, ack_level, observed_at, sender_phone)
    VALUES (?, ?, ?, ?, ?)`).run(id, wahaMessageId, ackLevel, ts, sender)
}

describe('composeQualityInputs', () => {
  let ctx: Ctx
  beforeEach(() => { ctx = setup() })

  it('reads accountAgeDays from chip acquisition_date', () => {
    insertChip(ctx, '5543991111111', 60)
    const r = composeQualityInputs({
      senderPhone: '5543991111111',
      db: ctx.db,
      chips: ctx.chips,
      warmup: ctx.warmup,
      now: ctx.now,
    })
    expect(r.accountAgeDays).toBeGreaterThanOrEqual(59)
    expect(r.accountAgeDays).toBeLessThanOrEqual(61)
  })

  it('reads warmup tier from SenderWarmup', () => {
    ctx.warmup.activateSender('5543991111111')
    const r = composeQualityInputs({
      senderPhone: '5543991111111',
      db: ctx.db,
      chips: ctx.chips,
      warmup: ctx.warmup,
      now: ctx.now,
    })
    expect(r.warmupTier).toBe(1)
    expect(r.warmupTierMax).toBe(4)
  })

  it('counts outbound messages in last 24h for volumeToday', () => {
    insertOutgoing(ctx, '5543991111111', '5511', 0.1)
    insertOutgoing(ctx, '5543991111111', '5511', 0.5)
    insertOutgoing(ctx, '5543991111111', '5511', 1.5)
    const r = composeQualityInputs({
      senderPhone: '5543991111111',
      db: ctx.db,
      chips: ctx.chips,
      warmup: ctx.warmup,
      now: ctx.now,
    })
    expect(r.volumeToday).toBe(2)
  })

  it('volumeDailyCap matches sender-warmup tier cap', () => {
    ctx.warmup.activateSender('5543991111111')
    const r = composeQualityInputs({
      senderPhone: '5543991111111',
      db: ctx.db,
      chips: ctx.chips,
      warmup: ctx.warmup,
      now: ctx.now,
    })
    expect(r.volumeDailyCap).toBe(20)
  })

  it('counts inbound and outbound for last 7d', () => {
    insertOutgoing(ctx, '5543991111111', '5511', 1)
    insertOutgoing(ctx, '5543991111111', '5511', 3)
    insertOutgoing(ctx, '5543991111111', '5511', 8)
    insertIncoming(ctx, '5543991111111', '5511', 2)
    insertIncoming(ctx, '5543991111111', '5511', 9)
    const r = composeQualityInputs({
      senderPhone: '5543991111111',
      db: ctx.db,
      chips: ctx.chips,
      warmup: ctx.warmup,
      now: ctx.now,
    })
    expect(r.outboundLast7d).toBe(2)
    expect(r.inboundLast7d).toBe(1)
  })

  it('reads ackReadRatio from message_ack_history', () => {
    insertOutgoing(ctx, '5543991111111', '5511', 0.5, 'waha-1')
    insertOutgoing(ctx, '5543991111111', '5511', 0.5, 'waha-2')
    insertAck(ctx, '5543991111111', 'waha-1', 3, 0.4)
    insertAck(ctx, '5543991111111', 'waha-2', 1, 0.4)
    const r = composeQualityInputs({
      senderPhone: '5543991111111',
      db: ctx.db,
      chips: ctx.chips,
      warmup: ctx.warmup,
      now: ctx.now,
    })
    expect(r.ackReadRatio).toBeCloseTo(0.5, 2)
  })

  it('daysSinceLastBan reads from chip_events', () => {
    const chipId = insertChip(ctx, '5543991111111', 60)
    const banDate = new Date(ctx.now - 5 * 86_400_000).toISOString()
    ctx.chips.recordEvent(chipId, { event_type: 'banned', occurred_at: banDate })
    const r = composeQualityInputs({
      senderPhone: '5543991111111',
      db: ctx.db,
      chips: ctx.chips,
      warmup: ctx.warmup,
      now: ctx.now,
    })
    expect(r.daysSinceLastBan).toBeGreaterThanOrEqual(4)
    expect(r.daysSinceLastBan).toBeLessThanOrEqual(6)
  })

  it('daysSinceLastBan is null when never banned', () => {
    insertChip(ctx, '5543991111111', 60)
    const r = composeQualityInputs({
      senderPhone: '5543991111111',
      db: ctx.db,
      chips: ctx.chips,
      warmup: ctx.warmup,
      now: ctx.now,
    })
    expect(r.daysSinceLastBan).toBeNull()
  })

  it('fingerprintFreshness uses chip acquisition_date as proxy until Phase 4', () => {
    insertChip(ctx, '5543991111111', 7)
    const r = composeQualityInputs({
      senderPhone: '5543991111111',
      db: ctx.db,
      chips: ctx.chips,
      warmup: ctx.warmup,
      now: ctx.now,
    })
    expect(r.daysSinceFingerprintRotation).toBeGreaterThanOrEqual(6)
    expect(r.daysSinceFingerprintRotation).toBeLessThanOrEqual(8)
    expect(r.fingerprintTtlDays).toBeGreaterThan(0)
  })
})

describe('fleetMedianReadRatio', () => {
  let ctx: Ctx
  beforeEach(() => { ctx = setup() })

  it('returns 0 when no acks', () => {
    const m = fleetMedianReadRatio(ctx.db, ctx.now, 24)
    expect(m).toBe(0)
  })

  it('computes median across senders', () => {
    insertOutgoing(ctx, '551111', '5511', 0.1, 'A')
    insertOutgoing(ctx, '551111', '5511', 0.1, 'B')
    insertAck(ctx, '551111', 'A', 3, 0.05)
    insertAck(ctx, '551111', 'B', 3, 0.05)

    insertOutgoing(ctx, '552222', '5511', 0.1, 'C')
    insertOutgoing(ctx, '552222', '5511', 0.1, 'D')
    insertAck(ctx, '552222', 'C', 1, 0.05)
    insertAck(ctx, '552222', 'D', 1, 0.05)

    insertOutgoing(ctx, '553333', '5511', 0.1, 'E')
    insertOutgoing(ctx, '553333', '5511', 0.1, 'F')
    insertAck(ctx, '553333', 'E', 3, 0.05)
    insertAck(ctx, '553333', 'F', 1, 0.05)

    const m = fleetMedianReadRatio(ctx.db, ctx.now, 24)
    expect(m).toBeCloseTo(0.5, 2)
  })
})
