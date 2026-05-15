import { describe, it, expect, vi } from 'vitest'
import { TenantPipedriveClient, PipedriveError } from './tenant-pipedrive-client.js'

function makeResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

function makeClient(fetchImpl: typeof fetch, opts: Partial<ConstructorParameters<typeof TenantPipedriveClient>[0]> = {}) {
  return new TenantPipedriveClient({
    domain: 'oralsin-xyz',
    token: 'tok-1234',
    fetchImpl,
    // High rate-limit + fast wait for tests.
    ratePerSec: 1000,
    burst: 1000,
    wait: () => Promise.resolve(),
    now: () => Date.now(),
    maxRetries: 2,
    ...opts,
  })
}

describe('TenantPipedriveClient — constructor', () => {
  it('throws when domain is missing', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => new TenantPipedriveClient({ domain: '', token: 't', fetchImpl: vi.fn() } as any)).toThrow(/domain and token/)
  })

  it('throws when token is missing', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => new TenantPipedriveClient({ domain: 'd', token: '', fetchImpl: vi.fn() } as any)).toThrow(/domain and token/)
  })
})

describe('TenantPipedriveClient — getDealsByStage', () => {
  it('issues GET /deals with stage_id and api_token', async () => {
    const fetchMock = vi.fn(async () => makeResponse({ data: [{ id: 100, title: 'X', stage_id: 5 }] }))
    const client = makeClient(fetchMock as unknown as typeof fetch)
    const deals = await client.getDealsByStage(5)
    expect(deals).toHaveLength(1)
    expect(deals[0].id).toBe(100)
    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toContain('stage_id=5')
    expect(url).toContain('api_token=tok-1234')
  })

  it('returns [] when Pipedrive returns null data', async () => {
    const fetchMock = vi.fn(async () => makeResponse({ data: null }))
    const client = makeClient(fetchMock as unknown as typeof fetch)
    expect(await client.getDealsByStage(5)).toEqual([])
  })
})

describe('TenantPipedriveClient — updateDealStage', () => {
  it('sends PUT with stage_id body', async () => {
    const fetchMock = vi.fn(async () => makeResponse({ data: { id: 100 } }))
    const client = makeClient(fetchMock as unknown as typeof fetch)
    await client.updateDealStage(100, 6)
    const [, init] = fetchMock.mock.calls[0]
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body as string)).toEqual({ stage_id: 6 })
  })
})

describe('TenantPipedriveClient — createActivity / addNote', () => {
  it('createActivity posts with deal_id + subject + default type', async () => {
    const fetchMock = vi.fn(async () => makeResponse({ data: { id: 999 } }))
    const client = makeClient(fetchMock as unknown as typeof fetch)
    const r = await client.createActivity({ dealId: 100, subject: 'SDR: qualified' })
    expect(r.id).toBe(999)
    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse(init.body as string)
    expect(body.deal_id).toBe(100)
    expect(body.subject).toBe('SDR: qualified')
    expect(body.type).toBe('task')
  })

  it('addNote posts with deal_id + content', async () => {
    const fetchMock = vi.fn(async () => makeResponse({ data: { id: 888 } }))
    const client = makeClient(fetchMock as unknown as typeof fetch)
    const r = await client.addNote(100, 'aut audit body')
    expect(r.id).toBe(888)
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body.content).toBe('aut audit body')
  })
})

describe('TenantPipedriveClient — retry / rate limit handling', () => {
  it('retries on 503 up to maxRetries then surfaces PipedriveError', async () => {
    const fetchMock = vi.fn(async () => new Response('boom', { status: 503 }))
    const client = makeClient(fetchMock as unknown as typeof fetch, { maxRetries: 2 })
    await expect(client.getDealsByStage(5)).rejects.toBeInstanceOf(PipedriveError)
    // 1 initial + 2 retries = 3 attempts
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('honors Retry-After on 429 then succeeds', async () => {
    let count = 0
    const fetchMock = vi.fn(async () => {
      count++
      if (count === 1) return new Response('rate', { status: 429, headers: { 'retry-after': '0' } })
      return makeResponse({ data: [] })
    })
    const client = makeClient(fetchMock as unknown as typeof fetch)
    const r = await client.getDealsByStage(5)
    expect(r).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('surfaces PipedriveError on 4xx non-429 immediately', async () => {
    const fetchMock = vi.fn(async () => new Response('forbidden', { status: 403 }))
    const client = makeClient(fetchMock as unknown as typeof fetch)
    await expect(client.updateDealStage(100, 6)).rejects.toBeInstanceOf(PipedriveError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('PipedriveError carries status + body', async () => {
    const fetchMock = vi.fn(async () => new Response('detail-body', { status: 401 }))
    const client = makeClient(fetchMock as unknown as typeof fetch)
    try {
      await client.getDealsByStage(5)
      expect.fail('should have thrown')
    } catch (e) {
      const err = e as PipedriveError
      expect(err.status).toBe(401)
      expect(err.body).toContain('detail-body')
    }
  })
})

describe('TenantPipedriveClient — base URL', () => {
  it('constructs the correct base URL from domain', async () => {
    const fetchMock = vi.fn(async () => makeResponse({ data: [] }))
    const client = makeClient(fetchMock as unknown as typeof fetch, { domain: 'sicoob-xyz' })
    await client.getDealsByStage(5)
    const url = fetchMock.mock.calls[0][0] as string
    expect(url.startsWith('https://sicoob-xyz.pipedrive.com/api/v1/')).toBe(true)
  })
})
