import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  ChipNotFoundError,
  DuplicateChipError,
  DuplicatePaymentError,
  type ChipRegistry,
  type ListChipsFilter,
  type ChipStatus,
} from '../fleet/index.js'

/**
 * REST API for the internal SIM-card fleet (Phase 3 of the anti-ban roadmap).
 *
 * Routes mount under `/api/v1/fleet/*`. They are gated by the existing
 * X-API-Key auth middleware (registered in server.ts BEFORE this function).
 *
 * SECURITY:
 *   - All free-form strings (notes, plan names, payment_method, sms text) are
 *     length-capped at the Zod layer to prevent storage bloat.
 *   - Phone numbers are validated as 10..15 digits — same rule used in the
 *     contacts API for consistency.
 *   - Outputs are JSON; React on the consumer side auto-escapes when
 *     rendering as text. We do NOT interpolate strings into HTML server-side
 *     anywhere, so the "escape on render" contract holds via React.
 */
const phoneRegex = /^\+?\d{10,15}$/

const planTypeSchema = z.enum(['postpago', 'prepago', 'controle'])
const chipStatusSchema = z.enum(['active', 'inactive', 'banned', 'retired'])
const messageCategorySchema = z.enum([
  'recharge_confirmation',
  'expiry_warning',
  'balance',
  'promo',
  'fraud_alert',
  'other',
])

const createChipSchema = z.object({
  phone_number: z.string().regex(phoneRegex, 'phone_number must be 10..15 digits'),
  carrier: z.string().min(1).max(40),
  plan_name: z.string().min(1).max(120),
  plan_type: planTypeSchema.optional(),
  acquisition_date: z.string().min(8).max(40),
  acquisition_cost_brl: z.number().min(0).max(100_000),
  monthly_cost_brl: z.number().min(0).max(100_000),
  payment_due_day: z.number().int().min(1).max(31),
  payment_method: z.string().max(120).nullish(),
  paid_by_operator: z.string().min(1).max(80),
  invoice_ref: z.string().max(120).nullish(),
  invoice_path: z.string().max(500).nullish(),
  device_serial: z.string().max(80).nullish(),
  status: chipStatusSchema.optional(),
  acquired_for_purpose: z.string().max(200).nullish(),
  notes: z.string().max(2000).nullish(),
})

const updateChipSchema = createChipSchema.partial().omit({
  phone_number: true, // immutable
  acquisition_date: true,
  acquisition_cost_brl: true,
})

const recordPaymentSchema = z.object({
  period: z.string().regex(/^\d{4}-\d{2}$/, 'period must be YYYY-MM'),
  amount_brl: z.number().min(0).max(100_000),
  paid_at: z.string().min(8).max(40),
  paid_by_operator: z.string().min(1).max(80),
  payment_method: z.string().max(120).nullish(),
  receipt_path: z.string().max(500).nullish(),
  notes: z.string().max(2000).nullish(),
})

const recordEventSchema = z.object({
  event_type: z.string().min(1).max(60),
  occurred_at: z.string().min(8).max(40),
  operator: z.string().max(80).nullish(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
  notes: z.string().max(2000).nullish(),
})

const recordMessageSchema = z.object({
  from_number: z.string().min(1).max(40),
  message_text: z.string().min(1).max(4000),
  received_at: z.string().min(8).max(40),
  category: messageCategorySchema.nullish(),
  source: z.enum(['manual', 'adb_sms_dump']).optional(),
  raw: z.record(z.string(), z.unknown()).nullish(),
})

const importBatchSchema = z.object({
  chips: z.array(createChipSchema).min(1).max(500),
})

export interface FleetRoutesDeps {
  registry: ChipRegistry
}

export function registerFleetRoutes(server: FastifyInstance, deps: FleetRoutesDeps): void {
  const { registry } = deps

  // ── Chips list / create ───────────────────────────────────────────────
  server.get('/api/v1/fleet/chips', async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>
    const filter: ListChipsFilter = {}
    if (q.carrier) filter.carrier = q.carrier
    if (q.status) filter.status = q.status as ChipStatus
    if (q.paid_by_operator) filter.paid_by_operator = q.paid_by_operator
    if (q.device_serial) filter.device_serial = q.device_serial
    const items = registry.listChips(filter)
    return reply.send({ items, total: items.length })
  })

  server.post('/api/v1/fleet/chips', async (req, reply) => {
    const parsed = createChipSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid params', issues: parsed.error.issues })
    }
    try {
      const chip = registry.createChip(parsed.data)
      return reply.status(201).send(chip)
    } catch (e) {
      if (e instanceof DuplicateChipError) {
        return reply.status(409).send({ error: 'duplicate_phone_number', phone_number: e.phone_number })
      }
      throw e
    }
  })

  // ── Bulk import (CSV-like batch) ──────────────────────────────────────
  // Used by the UI bulk-import wizard. Best-effort: returns per-row outcome
  // so the operator can see which rows duplicated. Each row is independent —
  // a duplicate doesn't abort the batch.
  server.post('/api/v1/fleet/chips/import', async (req, reply) => {
    const parsed = importBatchSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid params', issues: parsed.error.issues })
    }
    const results: Array<{
      phone_number: string
      ok: boolean
      id?: string
      error?: string
    }> = []
    let inserted = 0
    let skipped = 0
    for (const row of parsed.data.chips) {
      try {
        const c = registry.createChip(row)
        results.push({ phone_number: row.phone_number, ok: true, id: c.id })
        inserted += 1
      } catch (e) {
        skipped += 1
        results.push({
          phone_number: row.phone_number,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        })
      }
    }
    return reply.status(207).send({ inserted, skipped, results })
  })

  // ── Chip detail / patch / retire ──────────────────────────────────────
  server.get('/api/v1/fleet/chips/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const chip = registry.getChip(id)
    if (!chip) return reply.status(404).send({ error: 'chip_not_found' })
    const payments = registry.listPayments(id)
    const events = registry.listEvents(id)
    const messages = registry.listMessages(id)
    return reply.send({ chip, payments, events, messages })
  })

  server.patch('/api/v1/fleet/chips/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const parsed = updateChipSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid params', issues: parsed.error.issues })
    }
    try {
      const chip = registry.updateChip(id, parsed.data)
      return reply.send(chip)
    } catch (e) {
      if (e instanceof ChipNotFoundError) return reply.status(404).send({ error: 'chip_not_found' })
      throw e
    }
  })

  server.delete('/api/v1/fleet/chips/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const operator =
      ((req.headers['x-operator'] as string | undefined) ?? '').trim() || 'unknown'
    try {
      const chip = registry.retireChip(id, operator)
      return reply.send(chip)
    } catch (e) {
      if (e instanceof ChipNotFoundError) return reply.status(404).send({ error: 'chip_not_found' })
      throw e
    }
  })

  // ── Payments ──────────────────────────────────────────────────────────
  server.get('/api/v1/fleet/chips/:id/payments', async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!registry.getChip(id)) return reply.status(404).send({ error: 'chip_not_found' })
    return reply.send({ items: registry.listPayments(id) })
  })

  server.post('/api/v1/fleet/chips/:id/payments', async (req, reply) => {
    const { id } = req.params as { id: string }
    const parsed = recordPaymentSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid params', issues: parsed.error.issues })
    }
    try {
      const p = registry.recordPayment(id, parsed.data)
      return reply.status(201).send(p)
    } catch (e) {
      if (e instanceof ChipNotFoundError) return reply.status(404).send({ error: 'chip_not_found' })
      if (e instanceof DuplicatePaymentError) {
        return reply.status(409).send({
          error: 'duplicate_payment',
          chip_id: e.chip_id,
          period: e.period,
        })
      }
      throw e
    }
  })

  // ── Events ────────────────────────────────────────────────────────────
  server.get('/api/v1/fleet/chips/:id/events', async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!registry.getChip(id)) return reply.status(404).send({ error: 'chip_not_found' })
    return reply.send({ items: registry.listEvents(id) })
  })

  server.post('/api/v1/fleet/chips/:id/events', async (req, reply) => {
    const { id } = req.params as { id: string }
    const parsed = recordEventSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid params', issues: parsed.error.issues })
    }
    try {
      const e = registry.recordEvent(id, parsed.data)
      return reply.status(201).send(e)
    } catch (e) {
      if (e instanceof ChipNotFoundError) return reply.status(404).send({ error: 'chip_not_found' })
      throw e
    }
  })

  // ── Messages ──────────────────────────────────────────────────────────
  // v1 is manual entry only.  TODO: ADB SMS auto-dump — see chip-registry.ts
  // module docblock.
  server.get('/api/v1/fleet/chips/:id/messages', async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!registry.getChip(id)) return reply.status(404).send({ error: 'chip_not_found' })
    return reply.send({ items: registry.listMessages(id) })
  })

  server.post('/api/v1/fleet/chips/:id/messages', async (req, reply) => {
    const { id } = req.params as { id: string }
    const parsed = recordMessageSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid params', issues: parsed.error.issues })
    }
    try {
      const m = registry.recordMessage(id, parsed.data)
      return reply.status(201).send(m)
    } catch (e) {
      if (e instanceof ChipNotFoundError) return reply.status(404).send({ error: 'chip_not_found' })
      throw e
    }
  })

  // ── Reports ───────────────────────────────────────────────────────────
  server.get('/api/v1/fleet/chips/reports/monthly-spend', async (req, reply) => {
    const q = (req.query ?? {}) as { period?: string }
    const period = q.period ?? new Date().toISOString().slice(0, 7)
    if (!/^\d{4}-\d{2}$/.test(period)) {
      return reply.status(400).send({ error: 'period must be YYYY-MM' })
    }
    return reply.send(registry.monthlySpend(period))
  })

  server.get('/api/v1/fleet/chips/reports/renewal-calendar', async (req, reply) => {
    const q = (req.query ?? {}) as { days?: string }
    const days = Math.min(Math.max(Number(q.days) || 30, 1), 400)
    return reply.send({ days, items: registry.renewalCalendar(days) })
  })

  server.get('/api/v1/fleet/chips/reports/overdue', async (_req, reply) => {
    return reply.send({ items: registry.overdue() })
  })
}
