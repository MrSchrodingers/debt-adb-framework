import { describe, it, expect, vi } from 'vitest'
import { PipedriveClient, TokenBucket } from './pipedrive-client.js'
import type { PipedriveOutgoingIntent } from './types.js'

function okResponse(body: unknown = { success: true, data: { id: 1 } }): Response {
  return new Response(JSON.stringify(body), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  })
}

function errorResponse(status: number, body = ''): Response {
  return new Response(body, { status })
}

function fakeEmitter() {
  const calls: Array<[string, unknown]> = []
  return {
    calls,
    emit: vi.fn((evt: string, data: unknown) => {
      calls.push([evt, data])
      return true
    }),
  }
}

const sampleActivity: PipedriveOutgoingIntent = {
  kind: 'activity',
  dedup_key: 'phone_fail|1|2|j',
  payload: { subject: 's', type: 'call', done: 1, deal_id: 12345, note: 'note' },
}

describe('TokenBucket', () => {
  it('starts full and consumes one token per take', async () => {
    const sleeps: number[] = []
    let now = 1_000
    const bucket = new TokenBucket({
      ratePerSec: 10,
      burst: 3,
      now: () => now,
      sleep: async (ms) => { sleeps.push(ms); now += ms },
    })
    await bucket.take()
    await bucket.take()
    await bucket.take()
    expect(sleeps.length).toBe(0) // all from the burst budget
  })

  it('throttles when bucket empty, refilling proportionally', async () => {
    const sleeps: number[] = []
    let now = 1_000
    const bucket = new TokenBucket({
      ratePerSec: 10, // ~100ms per token
      burst: 1,
      now: () => now,
      sleep: async (ms) => { sleeps.push(ms); now += ms },
    })
    await bucket.take() // consumes the burst
    await bucket.take() // must wait
    expect(sleeps.length).toBeGreaterThanOrEqual(1)
    // 1 / 10 req/s = 100ms expected
    const totalSlept = sleeps.reduce((a, b) => a + b, 0)
    expect(totalSlept).toBeGreaterThanOrEqual(100)
  })
})

describe('PipedriveClient — happy path', () => {
  it('POSTs to /v1/activities for activity intents', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(okResponse())
    const client = new PipedriveClient({
      apiToken: 'tok',
      fetchImpl: fetchSpy as unknown as typeof fetch,
      sleep: async () => {},
    })
    const r = await client.dispatch(sampleActivity)
    expect(r.ok).toBe(true)
    expect(r.attempts).toBe(1)
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/v1/activities')
    expect(url).toContain('api_token=tok')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toMatchObject({ deal_id: 12345 })
  })

  it('POSTs to /v1/notes for note intents', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(okResponse())
    const client = new PipedriveClient({
      apiToken: 'tok',
      fetchImpl: fetchSpy as unknown as typeof fetch,
      sleep: async () => {},
    })
    await client.dispatch({
      kind: 'note',
      dedup_key: 'k',
      payload: { deal_id: 9, content: 'hi' },
    })
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/v1/notes')
  })

  it('treats success:false JSON as a non-retryable failure', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: false, error: 'bad deal' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }),
    )
    const emitter = fakeEmitter()
    const client = new PipedriveClient({
      apiToken: 'tok',
      fetchImpl: fetchSpy as unknown as typeof fetch,
      sleep: async () => {},
      emitter,
    })
    const r = await client.dispatch(sampleActivity)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('bad deal')
    // success:false is NOT retried
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(emitter.calls[0][0]).toBe('pipedrive:request_failed')
  })
})

describe('PipedriveClient — retry/backoff', () => {
  it('retries on 429 then succeeds', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(errorResponse(429, 'rate limit'))
      .mockResolvedValueOnce(okResponse())
    const sleeps: number[] = []
    const client = new PipedriveClient({
      apiToken: 'tok',
      fetchImpl: fetchSpy as unknown as typeof fetch,
      maxRetries: 3,
      retryBaseMs: 10,
      sleep: async (ms) => { sleeps.push(ms) },
    })
    const r = await client.dispatch(sampleActivity)
    expect(r.ok).toBe(true)
    expect(r.attempts).toBe(2)
    expect(sleeps.length).toBeGreaterThanOrEqual(1)
  })

  it('honors Retry-After header on 429', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '2' } }))
      .mockResolvedValueOnce(okResponse())
    const sleeps: number[] = []
    const client = new PipedriveClient({
      apiToken: 'tok',
      fetchImpl: fetchSpy as unknown as typeof fetch,
      maxRetries: 3,
      retryBaseMs: 10,
      sleep: async (ms) => { sleeps.push(ms) },
    })
    await client.dispatch(sampleActivity)
    expect(sleeps[0]).toBe(2000)
  })

  it('retries on 500/502/503/504', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValueOnce(okResponse())
    const client = new PipedriveClient({
      apiToken: 'tok',
      fetchImpl: fetchSpy as unknown as typeof fetch,
      retryBaseMs: 5,
      sleep: async () => {},
    })
    const r = await client.dispatch(sampleActivity)
    expect(r.ok).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('does NOT retry on 4xx other than 408/429', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(errorResponse(400, 'bad request'))
    const client = new PipedriveClient({
      apiToken: 'tok',
      fetchImpl: fetchSpy as unknown as typeof fetch,
      retryBaseMs: 5,
      sleep: async () => {},
    })
    const r = await client.dispatch(sampleActivity)
    expect(r.ok).toBe(false)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('emits pipedrive:request_failed after retries exhausted', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(errorResponse(503))
    const emitter = fakeEmitter()
    const client = new PipedriveClient({
      apiToken: 'tok',
      fetchImpl: fetchSpy as unknown as typeof fetch,
      maxRetries: 2,
      retryBaseMs: 5,
      sleep: async () => {},
      emitter,
    })
    const r = await client.dispatch(sampleActivity)
    expect(r.ok).toBe(false)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(emitter.calls).toHaveLength(1)
    const [evt, data] = emitter.calls[0] as [string, { status: number | null; deal_id: number | null }]
    expect(evt).toBe('pipedrive:request_failed')
    expect(data.status).toBe(503)
    expect(data.deal_id).toBe(12345)
  })

  it('NEVER throws on transport error — returns ok:false', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('ECONNRESET'))
    const emitter = fakeEmitter()
    const client = new PipedriveClient({
      apiToken: 'tok',
      fetchImpl: fetchSpy as unknown as typeof fetch,
      maxRetries: 2,
      retryBaseMs: 5,
      sleep: async () => {},
      emitter,
    })
    const r = await client.dispatch(sampleActivity)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('ECONNRESET')
    expect(emitter.calls[0][0]).toBe('pipedrive:request_failed')
  })
})

describe('PipedriveClient — config', () => {
  it('throws on missing apiToken', () => {
    expect(() => new PipedriveClient({ apiToken: '' })).toThrow(/apiToken/)
  })
})
