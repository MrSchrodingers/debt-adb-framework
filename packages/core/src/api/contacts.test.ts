import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import Database from 'better-sqlite3'
import { ContactRegistry } from '../contacts/contact-registry.js'
import { registerContactRoutes } from './contacts.js'

describe('Contacts API', () => {
  let app: FastifyInstance
  let db: Database.Database
  let registry: ContactRegistry

  beforeEach(async () => {
    db = new Database(':memory:')
    registry = new ContactRegistry(db)
    registry.initialize()
    app = Fastify()
    registerContactRoutes(app, registry)
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
  })

  it('GET /api/v1/contacts/:phone — 404 when unknown', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/contacts/+5543991938235' })
    expect(res.statusCode).toBe(404)
  })

  it('GET /api/v1/contacts/:phone — returns record when known', async () => {
    registry.record('5543991938235', {
      phone_input: '+5543991938235',
      phone_variant_tried: '5543991938235',
      source: 'adb_probe',
      result: 'exists',
      confidence: 0.95,
      evidence: null,
      device_serial: 'poco-1',
      waha_session: null,
      triggered_by: 'pre_check',
      latency_ms: 4000,
      ddd: '43',
      wa_chat_id: '5543991938235@c.us',
    })
    const res = await app.inject({ method: 'GET', url: '/api/v1/contacts/+5543991938235' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { exists_on_wa: number }
    expect(body.exists_on_wa).toBe(1)
  })

  it('POST /api/v1/contacts/:phone/recheck — 400 without reason', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/contacts/+5543991938235/recheck',
      payload: {},
    })
    expect(res.statusCode).toBe(400)
  })

  it('POST /api/v1/contacts/:phone/recheck — 404 when phone unknown (I1 guard)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/contacts/+5543991938235/recheck',
      payload: { reason: 'operator override' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('GET /api/v1/contacts/:phone/history returns timeline', async () => {
    registry.record('5543991938235', {
      phone_input: '+5543991938235',
      phone_variant_tried: '5543991938235',
      source: 'adb_probe',
      result: 'exists',
      confidence: 0.95,
      evidence: null,
      device_serial: 'poco-1',
      waha_session: null,
      triggered_by: 'pre_check',
      latency_ms: 4000,
      ddd: '43',
    })
    const res = await app.inject({ method: 'GET', url: '/api/v1/contacts/+5543991938235/history' })
    const body = res.json() as { entries: unknown[] }
    expect(body.entries).toHaveLength(1)
  })

  it('rejects non-BR numbers with 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/contacts/+19255551234' })
    expect(res.statusCode).toBe(400)
  })
})
