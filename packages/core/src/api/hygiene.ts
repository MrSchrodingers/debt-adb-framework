import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { HygieneJobService } from '../hygiene/hygiene-job-service.js'
import { HygieneJobConflictError } from '../hygiene/types.js'

const lawfulBasisSchema = z.enum(['contract', 'legitimate_interest', 'legal_obligation', 'consent'])

const lgpdSchema = z.object({
  lawful_basis: lawfulBasisSchema,
  purpose: z.string().min(10).max(500),
  data_controller: z.string().min(5).max(200),
})

const itemSchema = z.object({
  phone_input: z.string().min(8).max(20),
  external_id: z.string().min(1).max(128).optional(),
})

const createJobSchema = z.object({
  plugin_name: z.string().min(1).max(64),
  external_ref: z.string().min(1).max(128).optional(),
  callback_url: z.string().url().optional(),
  priority: z.enum(['normal', 'high']).optional(),
  rate_profile: z.enum(['conservative', 'default', 'aggressive']).optional(),
  callback_granularity: z.enum(['per_item', 'aggregate', 'both']).optional(),
  requested_by: z.string().min(1).max(100).optional(),
  lgpd: lgpdSchema,
  items: z.array(itemSchema).min(1).max(10_000),
})

export function registerHygieneRoutes(
  server: FastifyInstance,
  svc: HygieneJobService,
): void {
  server.post('/api/v1/hygiene/jobs', async (req, reply) => {
    const parsed = createJobSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parsed.error.issues })
    }
    try {
      const result = svc.create(parsed.data)
      return reply.status(result.deduplicated ? 200 : 201).send(result)
    } catch (e) {
      if (e instanceof HygieneJobConflictError) {
        return reply.status(409).send({ error: e.message })
      }
      throw e
    }
  })

  server.get('/api/v1/hygiene/jobs', async (req) => {
    const q = req.query as { plugin?: string; status?: string; limit?: string }
    return svc.list({
      plugin_name: q.plugin,
      status: q.status,
      limit: q.limit ? Number(q.limit) : undefined,
    })
  })

  server.get('/api/v1/hygiene/jobs/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const job = svc.get(id)
    if (!job) return reply.status(404).send({ error: 'Job not found' })
    return job
  })

  server.get('/api/v1/hygiene/jobs/:id/items', async (req) => {
    const { id } = req.params as { id: string }
    const q = req.query as { status?: string; limit?: string; offset?: string }
    return svc.getItems(id, {
      status: q.status as never,
      limit: q.limit ? Number(q.limit) : undefined,
      offset: q.offset ? Number(q.offset) : undefined,
    })
  })

  server.post('/api/v1/hygiene/jobs/:id/cancel', async (req, reply) => {
    const { id } = req.params as { id: string }
    const ok = svc.cancel(id)
    if (!ok) return reply.status(404).send({ error: 'Job not found or already finalized' })
    return { ok: true }
  })
}
