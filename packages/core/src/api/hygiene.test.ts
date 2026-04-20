import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import Database from 'better-sqlite3'
import { HygieneJobService } from '../hygiene/hygiene-job-service.js'
import { registerHygieneRoutes } from './hygiene.js'

const validLgpd = {
  lawful_basis: 'legitimate_interest',
  purpose: 'debt-recovery hygiene for Oralsin accounts',
  data_controller: 'Debt Oralsin CNPJ 00.000.000/0001-00',
}

describe('Hygiene API', () => {
  let app: FastifyInstance
  let db: Database.Database
  let svc: HygieneJobService

  beforeEach(async () => {
    db = new Database(':memory:')
    svc = new HygieneJobService(db)
    svc.initialize()
    app = Fastify()
    registerHygieneRoutes(app, svc)
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
  })

  it('POST /hygiene/jobs creates a new job with 201', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/hygiene/jobs',
      payload: {
        plugin_name: 'adb-debt',
        lgpd: validLgpd,
        items: [{ phone_input: '+5543991938235', external_id: 'deal-1' }],
      },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json() as { deduplicated: boolean }
    expect(body.deduplicated).toBe(false)
  })

  it('POST /hygiene/jobs rejects missing lawful_basis — D7 LGPD', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/hygiene/jobs',
      payload: {
        plugin_name: 'adb-debt',
        items: [{ phone_input: '+5543991938235' }],
      },
    })
    expect(res.statusCode).toBe(400)
  })

  it('POST /hygiene/jobs is idempotent on external_ref — D9', async () => {
    const payload = {
      plugin_name: 'adb-debt',
      external_ref: 'batch-001',
      lgpd: validLgpd,
      items: [{ phone_input: '+5543991938235' }],
    }
    const first = await app.inject({ method: 'POST', url: '/api/v1/hygiene/jobs', payload })
    expect(first.statusCode).toBe(201)
    const second = await app.inject({ method: 'POST', url: '/api/v1/hygiene/jobs', payload })
    expect(second.statusCode).toBe(200)
    expect((second.json() as { deduplicated: boolean }).deduplicated).toBe(true)
  })

  it('POST /hygiene/jobs returns 409 on ref collision with different items — D9', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v1/hygiene/jobs',
      payload: {
        plugin_name: 'adb-debt',
        external_ref: 'batch-002',
        lgpd: validLgpd,
        items: [{ phone_input: '+5543991938235' }],
      },
    })
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/hygiene/jobs',
      payload: {
        plugin_name: 'adb-debt',
        external_ref: 'batch-002',
        lgpd: validLgpd,
        items: [{ phone_input: '+5543991938235' }, { phone_input: '+5511987654321' }],
      },
    })
    expect(res.statusCode).toBe(409)
  })

  it('GET /hygiene/jobs/:id returns job details', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/hygiene/jobs',
      payload: {
        plugin_name: 'adb-debt',
        lgpd: validLgpd,
        items: [{ phone_input: '+5543991938235' }],
      },
    })
    const { job_id } = create.json() as { job_id: string }
    const res = await app.inject({ method: 'GET', url: `/api/v1/hygiene/jobs/${job_id}` })
    expect(res.statusCode).toBe(200)
  })

  it('POST /hygiene/jobs/:id/cancel flips status', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/hygiene/jobs',
      payload: {
        plugin_name: 'adb-debt',
        lgpd: validLgpd,
        items: [{ phone_input: '+5543991938235' }],
      },
    })
    const { job_id } = create.json() as { job_id: string }
    const cancel = await app.inject({ method: 'POST', url: `/api/v1/hygiene/jobs/${job_id}/cancel` })
    expect(cancel.statusCode).toBe(200)
  })
})
