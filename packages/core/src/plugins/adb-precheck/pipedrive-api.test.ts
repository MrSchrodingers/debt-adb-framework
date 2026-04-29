import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRequire } from 'node:module'
import Fastify, { type FastifyInstance } from 'fastify'
import { buildPipedriveRoutes } from './pipedrive-api.js'
import { PipedriveActivityStore } from './pipedrive-activity-store.js'
import { PipedrivePublisher } from './pipedrive-publisher.js'
import type { PipedriveClient } from './pipedrive-client.js'

const require = createRequire(import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require('better-sqlite3') as typeof import('better-sqlite3').default

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}

function fakeClient() {
  const dispatch = vi.fn(async () => ({ ok: true, status: 201, attempts: 1 }))
  const whoami = vi.fn(async () => ({
    ok: true, status: 200,
    name: 'Op One', email: 'op@debt.com.br',
    company_name: 'Debt', company_domain: 'debt-5188cf',
  }))
  return { client: { dispatch, whoami } as unknown as PipedriveClient, dispatch, whoami }
}

interface Env {
  db: import('better-sqlite3').Database
  store: PipedriveActivityStore
  publisher: PipedrivePublisher
  client: PipedriveClient
}

function buildEnv(domain = 'debt-5188cf'): Env {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  const store = new PipedriveActivityStore(db)
  store.initialize()
  const { client } = fakeClient()
  const publisher = new PipedrivePublisher(client, fakeLogger(), store, domain)
  return { db, store, publisher, client }
}

const PREFIX = '/api/v1/plugins/adb-precheck'

/**
 * Mount routes the same way the plugin loader does: prefix every relative
 * path with /api/v1/plugins/adb-precheck so the assertions below mirror
 * production URLs verbatim.
 */
function mount(server: FastifyInstance, deps: Parameters<typeof buildPipedriveRoutes>[0]): void {
  for (const [method, path, handler] of buildPipedriveRoutes(deps)) {
    server.route({
      method,
      url: `${PREFIX}${path}`,
      handler: async (req, reply) => handler(req, reply),
    })
  }
}

describe('plugin pipedrive API — health', () => {
  let server: FastifyInstance
  let env: Env

  beforeEach(async () => {
    env = buildEnv()
    server = Fastify()
    mount(server, {
      store: env.store, client: env.client, publisher: env.publisher,
      companyDomain: 'debt-5188cf',
    })
    await server.ready()
  })
  afterEach(async () => {
    await server.close()
    env.db.close()
  })

  it('GET /pipedrive/health returns tokenValid + domain when integration enabled', async () => {
    const res = await server.inject({ method: 'GET', url: `${PREFIX}/pipedrive/health` })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { tokenValid: boolean; domain: string; ownerName: string }
    expect(body.tokenValid).toBe(true)
    expect(body.domain).toBe('debt-5188cf')
    expect(body.ownerName).toBe('Op One')
  })

  it('GET /pipedrive/health returns enabled:false when client is null', async () => {
    const localServer = Fastify()
    mount(localServer, { store: null, client: null, publisher: null, companyDomain: null })
    await localServer.ready()
    const res = await localServer.inject({ method: 'GET', url: `${PREFIX}/pipedrive/health` })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { tokenValid: boolean; enabled: boolean }
    expect(body.tokenValid).toBe(false)
    expect(body.enabled).toBe(false)
    await localServer.close()
  })
})

describe('plugin pipedrive API — activities listing', () => {
  let server: FastifyInstance
  let env: Env

  beforeEach(async () => {
    env = buildEnv()
    const a = env.store.insertPending({ scenario: 'phone_fail',    deal_id: 100, pasta: 'A', phone_normalized: '5511', job_id: 'j', pipedrive_endpoint: '/activities', pipedrive_payload_json: '{"deal_id":100}' })
    env.store.insertPending({ scenario: 'deal_all_fail', deal_id: 100, pasta: 'A', phone_normalized: null, job_id: 'j', pipedrive_endpoint: '/activities', pipedrive_payload_json: '{"deal_id":100}' })
    env.store.insertPending({ scenario: 'pasta_summary', deal_id: 200, pasta: 'B', phone_normalized: null, job_id: 'j', pipedrive_endpoint: '/notes',      pipedrive_payload_json: '{"deal_id":200}' })
    env.store.updateResult(a, { status: 'success', attempts: 1, http_status: 201, pipedrive_response_id: 9999 })
    server = Fastify()
    mount(server, {
      store: env.store, client: env.client, publisher: env.publisher,
      companyDomain: 'debt-5188cf',
    })
    await server.ready()
  })
  afterEach(async () => {
    await server.close()
    env.db.close()
  })

  it('GET /pipedrive/activities returns rows with computed dealUrl', async () => {
    const res = await server.inject({ method: 'GET', url: `${PREFIX}/pipedrive/activities` })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { items: Array<{ dealUrl: string | null; activityUrl: string | null; deal_id: number }>; total: number }
    expect(body.total).toBe(3)
    expect(body.items[0].dealUrl).toMatch(/debt-5188cf\.pipedrive\.com\/deal\/\d+$/)
  })

  it('GET /pipedrive/activities filters by scenario + status', async () => {
    const res = await server.inject({ method: 'GET', url: `${PREFIX}/pipedrive/activities?scenario=phone_fail&status=success` })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { total: number }
    expect(body.total).toBe(1)
  })

  it('GET /pipedrive/activities rejects bad query', async () => {
    const res = await server.inject({ method: 'GET', url: `${PREFIX}/pipedrive/activities?limit=999999` })
    expect(res.statusCode).toBe(400)
  })

  it('GET /pipedrive/activities/:id returns single record + activityUrl when response_id present', async () => {
    const list = env.store.list({ status: 'success' })
    const id = list.items[0].id
    const res = await server.inject({ method: 'GET', url: `${PREFIX}/pipedrive/activities/${id}` })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { dealUrl: string; activityUrl: string }
    expect(body.dealUrl).toMatch(/\/deal\/100$/)
    expect(body.activityUrl).toMatch(/#activity-9999$/)
  })

  it('GET /pipedrive/activities/:id returns 404 for unknown id', async () => {
    const res = await server.inject({ method: 'GET', url: `${PREFIX}/pipedrive/activities/nope-nope` })
    expect(res.statusCode).toBe(404)
  })
})

describe('plugin pipedrive API — preview', () => {
  let server: FastifyInstance
  let env: Env

  beforeEach(async () => {
    env = buildEnv()
    server = Fastify()
    mount(server, {
      store: env.store, client: env.client, publisher: env.publisher,
      companyDomain: 'debt-5188cf',
    })
    await server.ready()
  })
  afterEach(async () => {
    await server.close()
    env.db.close()
  })

  it('POST /pipedrive/preview renders phone_fail Markdown without persisting', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${PREFIX}/pipedrive/preview`,
      payload: {
        scenario: 'phone_fail',
        deal_id: 143611, pasta: 'P', phone: '5543991938235',
        column: 'telefone_1', strategy: 'adb',
      },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { endpoint: string; markdownBody: string; dealUrl: string }
    expect(body.endpoint).toBe('/activities')
    expect(body.markdownBody).toContain('[#143611](https://debt-5188cf.pipedrive.com/deal/143611)')
    expect(body.markdownBody).toContain('5543991938235'.slice(-4))
    expect(body.dealUrl).toBe('https://debt-5188cf.pipedrive.com/deal/143611')
    expect(env.store.list({}).total).toBe(0)
  })

  it('POST /pipedrive/preview renders pasta_summary as a /notes payload', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${PREFIX}/pipedrive/preview`,
      payload: { scenario: 'pasta_summary', pasta: 'P-1', first_deal_id: 200 },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { endpoint: string }
    expect(body.endpoint).toBe('/notes')
  })

  it('POST /pipedrive/preview rejects invalid body', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${PREFIX}/pipedrive/preview`,
      payload: { scenario: 'phone_fail', deal_id: -1 },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('plugin pipedrive API — manual trigger', () => {
  let server: FastifyInstance
  let env: Env

  beforeEach(async () => {
    env = buildEnv()
    server = Fastify()
    mount(server, {
      store: env.store, client: env.client, publisher: env.publisher,
      companyDomain: 'debt-5188cf',
    })
    await server.ready()
  })
  afterEach(async () => {
    await server.close()
    env.db.close()
  })

  it('POST /pipedrive/manual-trigger persists with manual=1 and returns activityId', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${PREFIX}/pipedrive/manual-trigger`,
      payload: {
        scenario: 'phone_fail',
        deal_id: 1, pasta: 'P', phone: '5543991938235',
        column: 'telefone_1', strategy: 'adb', triggered_by: 'alice',
      },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json() as { triggered: boolean; activityId: string; triggered_by: string }
    expect(body.triggered).toBe(true)
    expect(body.triggered_by).toBe('alice')
    await env.publisher.flush()
    const row = env.store.getById(body.activityId)
    expect(row).not.toBeNull()
    expect(row!.manual).toBe(1)
    expect(row!.triggered_by).toBe('alice')
  })

  it('POST /pipedrive/manual-trigger uses X-Triggered-By header when body lacks it', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${PREFIX}/pipedrive/manual-trigger`,
      headers: { 'x-triggered-by': 'bob' },
      payload: {
        scenario: 'phone_fail',
        deal_id: 1, pasta: 'P', phone: '5543991938235',
        column: 'telefone_1', strategy: 'adb',
      },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json() as { triggered_by: string }
    expect(body.triggered_by).toBe('bob')
  })

  it('POST /pipedrive/manual-trigger returns 503 when integration disabled', async () => {
    const localServer = Fastify()
    mount(localServer, { store: null, client: null, publisher: null, companyDomain: null })
    await localServer.ready()
    const res = await localServer.inject({
      method: 'POST',
      url: `${PREFIX}/pipedrive/manual-trigger`,
      payload: {
        scenario: 'phone_fail',
        deal_id: 1, pasta: 'P', phone: '5543991938235',
        column: 'telefone_1', strategy: 'adb',
      },
    })
    expect(res.statusCode).toBe(503)
    await localServer.close()
  })

  it('POST /pipedrive/manual-trigger validates body', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${PREFIX}/pipedrive/manual-trigger`,
      payload: { scenario: 'phone_fail', deal_id: 'not-a-number' },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('plugin pipedrive API — retry', () => {
  let server: FastifyInstance
  let env: Env

  beforeEach(async () => {
    env = buildEnv()
    server = Fastify()
    mount(server, {
      store: env.store, client: env.client, publisher: env.publisher,
      companyDomain: 'debt-5188cf',
    })
    await server.ready()
  })
  afterEach(async () => {
    await server.close()
    env.db.close()
  })

  it('POST /pipedrive/activities/:id/retry creates a new manual attempt row', async () => {
    const id = env.store.insertPending({
      scenario: 'phone_fail', deal_id: 10, pasta: 'P', phone_normalized: '5511',
      job_id: 'j-1', pipedrive_endpoint: '/activities',
      pipedrive_payload_json: '{"deal_id":10,"note":""}',
    })
    env.store.updateResult(id, { status: 'failed', attempts: 3, http_status: 500, error_msg: 'x' })
    const res = await server.inject({ method: 'POST', url: `${PREFIX}/pipedrive/activities/${id}/retry` })
    expect(res.statusCode).toBe(202)
    const body = res.json() as { retried: boolean; originalId: string; newAttemptId: string }
    expect(body.retried).toBe(true)
    expect(body.originalId).toBe(id)
    expect(body.newAttemptId).toBeTruthy()
    await env.publisher.flush()
    const newRow = env.store.getById(body.newAttemptId)
    expect(newRow).not.toBeNull()
    expect(newRow!.manual).toBe(1)
  })

  it('POST /pipedrive/activities/:id/retry returns 404 for unknown id', async () => {
    const res = await server.inject({ method: 'POST', url: `${PREFIX}/pipedrive/activities/nope/retry` })
    expect(res.statusCode).toBe(404)
  })
})

describe('plugin pipedrive API — stats', () => {
  let server: FastifyInstance
  let env: Env

  beforeEach(async () => {
    env = buildEnv()
    env.store.insertPending({ scenario: 'phone_fail', deal_id: 1, pasta: 'A', phone_normalized: '5511', job_id: 'j', pipedrive_endpoint: '/activities', pipedrive_payload_json: '{}' })
    server = Fastify()
    mount(server, {
      store: env.store, client: env.client, publisher: env.publisher,
      companyDomain: 'debt-5188cf',
    })
    await server.ready()
  })
  afterEach(async () => {
    await server.close()
    env.db.close()
  })

  it('GET /pipedrive/stats returns aggregations with default period=all', async () => {
    const res = await server.inject({ method: 'GET', url: `${PREFIX}/pipedrive/stats` })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { totalActivitiesCreated: number; byScenario: { phone_fail: number } }
    expect(body.totalActivitiesCreated).toBe(1)
    expect(body.byScenario.phone_fail).toBe(1)
  })

  it('GET /pipedrive/stats accepts period filter', async () => {
    const res = await server.inject({ method: 'GET', url: `${PREFIX}/pipedrive/stats?period=7d` })
    expect(res.statusCode).toBe(200)
  })

  it('GET /pipedrive/stats rejects invalid period', async () => {
    const res = await server.inject({ method: 'GET', url: `${PREFIX}/pipedrive/stats?period=forever` })
    expect(res.statusCode).toBe(400)
  })

  it('GET /pipedrive/stats returns 503 when integration disabled', async () => {
    const localServer = Fastify()
    mount(localServer, { store: null, client: null, publisher: null, companyDomain: null })
    await localServer.ready()
    const res = await localServer.inject({ method: 'GET', url: `${PREFIX}/pipedrive/stats` })
    expect(res.statusCode).toBe(503)
    await localServer.close()
  })
})
