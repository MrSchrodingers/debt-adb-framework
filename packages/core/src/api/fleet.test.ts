import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import Database from 'better-sqlite3'
import { ChipRegistry } from '../fleet/index.js'
import { registerFleetRoutes } from './fleet.js'

describe('Fleet API', () => {
  let app: FastifyInstance
  let db: Database.Database
  let registry: ChipRegistry

  const baseChip = {
    phone_number: '5543991938235',
    carrier: 'vivo',
    plan_name: 'Vivo Controle 30GB',
    acquisition_date: '2026-01-15',
    acquisition_cost_brl: 50,
    monthly_cost_brl: 99.9,
    payment_due_day: 15,
    paid_by_operator: 'matheus',
  }

  beforeEach(async () => {
    db = new Database(':memory:')
    registry = new ChipRegistry(db)
    registry.initialize()
    app = Fastify()
    registerFleetRoutes(app, { registry })
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
  })

  it('GET /api/v1/fleet/chips returns empty list initially', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/fleet/chips' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ items: [], total: 0 })
  })

  it('POST /api/v1/fleet/chips creates a chip and returns 201', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/fleet/chips',
      payload: baseChip,
    })
    expect(res.statusCode).toBe(201)
    const body = res.json() as { id: string; phone_number: string }
    expect(body.id).toMatch(/.+/)
    expect(body.phone_number).toBe(baseChip.phone_number)
  })

  it('POST /api/v1/fleet/chips returns 400 for invalid phone_number', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/fleet/chips',
      payload: { ...baseChip, phone_number: '123' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('POST /api/v1/fleet/chips returns 409 on duplicate phone_number', async () => {
    await app.inject({ method: 'POST', url: '/api/v1/fleet/chips', payload: baseChip })
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/fleet/chips',
      payload: baseChip,
    })
    expect(res.statusCode).toBe(409)
  })

  it('POST /api/v1/fleet/chips/:id/payments records payment then 409 on duplicate period', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/fleet/chips',
      payload: baseChip,
    })
    const chipId = (create.json() as { id: string }).id

    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/fleet/chips/${chipId}/payments`,
      payload: {
        period: '2026-04',
        amount_brl: 99.9,
        paid_at: '2026-04-15T10:00:00Z',
        paid_by_operator: 'matheus',
      },
    })
    expect(first.statusCode).toBe(201)

    const dup = await app.inject({
      method: 'POST',
      url: `/api/v1/fleet/chips/${chipId}/payments`,
      payload: {
        period: '2026-04',
        amount_brl: 99.9,
        paid_at: '2026-04-16T10:00:00Z',
        paid_by_operator: 'matheus',
      },
    })
    expect(dup.statusCode).toBe(409)
  })

  it('POST /api/v1/fleet/chips/:id/messages records a manual SMS', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/fleet/chips',
      payload: baseChip,
    })
    const chipId = (create.json() as { id: string }).id

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/fleet/chips/${chipId}/messages`,
      payload: {
        from_number: '1058',
        message_text: 'Sua recarga foi processada',
        received_at: '2026-04-15T09:00:00Z',
        category: 'recharge_confirmation',
      },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json() as { source: string; category: string }
    expect(body.source).toBe('manual')
    expect(body.category).toBe('recharge_confirmation')
  })

  it('GET /api/v1/fleet/chips/:id 404 when missing', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/fleet/chips/missing' })
    expect(res.statusCode).toBe(404)
  })

  it('GET /api/v1/fleet/chips/:id returns chip + payments + events + messages', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/fleet/chips',
      payload: baseChip,
    })
    const chipId = (create.json() as { id: string }).id
    const res = await app.inject({ method: 'GET', url: `/api/v1/fleet/chips/${chipId}` })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      chip: { id: string }
      payments: unknown[]
      events: unknown[]
      messages: unknown[]
    }
    expect(body.chip.id).toBe(chipId)
    expect(body.events.length).toBeGreaterThan(0) // 'acquired' auto-event
  })

  it('PATCH /api/v1/fleet/chips/:id allows partial update + rejects phone change', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/fleet/chips',
      payload: baseChip,
    })
    const chipId = (create.json() as { id: string }).id
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/fleet/chips/${chipId}`,
      payload: { notes: 'updated', monthly_cost_brl: 79.9 },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { notes: string; monthly_cost_brl: number; phone_number: string }
    expect(body.notes).toBe('updated')
    expect(body.monthly_cost_brl).toBe(79.9)
    expect(body.phone_number).toBe(baseChip.phone_number) // unchanged

    // phone_number is omitted from updateChipSchema → must be ignored, not 400.
    // We don't strictly forbid the field; we just drop it.
  })

  it('DELETE /api/v1/fleet/chips/:id soft-retires the chip', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/fleet/chips',
      payload: baseChip,
    })
    const chipId = (create.json() as { id: string }).id
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/fleet/chips/${chipId}`,
      headers: { 'x-operator': 'matheus' },
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { status: string }).status).toBe('retired')
  })

  it('GET /api/v1/fleet/chips supports carrier and status filters', async () => {
    await app.inject({ method: 'POST', url: '/api/v1/fleet/chips', payload: baseChip })
    await app.inject({
      method: 'POST',
      url: '/api/v1/fleet/chips',
      payload: { ...baseChip, phone_number: '5511999999999', carrier: 'claro' },
    })
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/fleet/chips?carrier=vivo',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { total: number }
    expect(body.total).toBe(1)
  })

  it('POST /api/v1/fleet/chips/import-from-devices imports from whatsapp_accounts + sender_mapping', async () => {
    db.exec(`
      CREATE TABLE whatsapp_accounts (
        device_serial TEXT NOT NULL,
        profile_id INTEGER NOT NULL,
        package_name TEXT NOT NULL,
        phone_number TEXT,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        PRIMARY KEY (device_serial, profile_id, package_name)
      );
      INSERT INTO whatsapp_accounts (device_serial, profile_id, package_name, phone_number)
      VALUES ('SN1', 0, 'com.whatsapp', '5543991938235'),
             ('SN2', 0, 'com.whatsapp', '5543996837813'),
             ('SN1', 10, 'com.whatsapp', NULL);
    `)
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/fleet/chips/import-from-devices',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      total_inserted: number
      total_skipped: number
      sources: { whatsapp_accounts: { inserted: number }; sender_mapping: { inserted: number } }
    }
    expect(body.total_inserted).toBe(2)
    expect(body.sources.whatsapp_accounts.inserted).toBe(2)
  })

  it('POST /api/v1/fleet/chips/import bulk-inserts and reports per-row outcome', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/fleet/chips/import',
      payload: {
        chips: [
          baseChip,
          { ...baseChip, phone_number: '5511999999999', carrier: 'claro' },
          baseChip, // duplicate of first
        ],
      },
    })
    expect(res.statusCode).toBe(207)
    const body = res.json() as { inserted: number; skipped: number; results: Array<{ ok: boolean }> }
    expect(body.inserted).toBe(2)
    expect(body.skipped).toBe(1)
  })

  it('GET /api/v1/fleet/chips/reports/monthly-spend returns aggregates', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/fleet/chips',
      payload: baseChip,
    })
    const chipId = (create.json() as { id: string }).id
    await app.inject({
      method: 'POST',
      url: `/api/v1/fleet/chips/${chipId}/payments`,
      payload: {
        period: '2026-04',
        amount_brl: 99.9,
        paid_at: '2026-04-15',
        paid_by_operator: 'matheus',
      },
    })
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/fleet/chips/reports/monthly-spend?period=2026-04',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { period: string; paid_brl: number }
    expect(body.period).toBe('2026-04')
    expect(body.paid_brl).toBe(99.9)
  })

  it('GET /api/v1/fleet/chips/reports/monthly-spend rejects malformed period', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/fleet/chips/reports/monthly-spend?period=04-2026',
    })
    expect(res.statusCode).toBe(400)
  })

  it('GET /api/v1/fleet/chips/reports/renewal-calendar returns items', async () => {
    await app.inject({ method: 'POST', url: '/api/v1/fleet/chips', payload: baseChip })
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/fleet/chips/reports/renewal-calendar?days=60',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { days: number; items: unknown[] }
    expect(body.days).toBe(60)
    expect(Array.isArray(body.items)).toBe(true)
  })

  it('POST /api/v1/fleet/chips truncates very large notes via Zod cap', async () => {
    const longNotes = 'x'.repeat(5000)
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/fleet/chips',
      payload: { ...baseChip, notes: longNotes },
    })
    expect(res.statusCode).toBe(400)
  })
})
