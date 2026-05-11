import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PipeboardRest,
  PipeboardRestError,
} from './pipeboard-rest.js'
import { metricsRegistry } from '../../config/metrics.js'
import type { DealKey } from './types.js'

const KEY: DealKey = {
  pasta: 'AB-2024/12',
  deal_id: 12345,
  contato_tipo: 'person',
  contato_id: 67890,
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function textResponse(status: number, body: string): Response {
  return new Response(body, { status })
}

function makeClient(fetchImpl: ReturnType<typeof vi.fn>): PipeboardRest {
  return new PipeboardRest({
    baseUrl: 'http://test/api/v1/adb',
    apiKey: 'pbk_test',
    fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
  })
}

describe('PipeboardRest.applyDealInvalidation', () => {
  beforeEach(() => metricsRegistry.resetMetrics())
  afterEach(() => vi.restoreAllMocks())

  it('200 → returns applied[] and emits metric with status=200', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        request_id: 'req-1',
        idempotent: false,
        applied: [
          { telefone: '5543991938235', status: 'applied', cleared_from: ['telefone_1'] },
        ],
        deal_archived: false,
      }),
    )
    const c = makeClient(fetchImpl)
    const res = await c.applyDealInvalidation(KEY, {
      motivo: 'phone_not_on_whatsapp',
      jobId: 'job-1',
      fonte: 'dispatch_adb_precheck',
      phones: [{ telefone: '5543991938235', colunaOrigem: 'telefone_1', confidence: 0.9 }],
      archiveIfEmpty: false,
    })
    expect(res.requestId).toBe('req-1')
    expect(res.applied).toEqual([
      { telefone: '5543991938235', status: 'applied', clearedFrom: ['telefone_1'] },
    ])
    expect(res.clearedColumns).toEqual(['telefone_1'])
    const metricLines = await metricsRegistry.metrics()
    expect(metricLines).toContain('op="invalidate"')
    expect(metricLines).toContain('status="200"')
  })

  it('passes deterministic Idempotency-Key based on jobId+key+body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        request_id: 'req-1',
        idempotent: false,
        applied: [],
      }),
    )
    const c = makeClient(fetchImpl)
    await c.applyDealInvalidation(KEY, {
      motivo: 'm',
      jobId: 'job-X',
      fonte: 'dispatch_adb_precheck',
      phones: [{ telefone: '5543991938235', colunaOrigem: null, confidence: null }],
      archiveIfEmpty: false,
    })
    const headers = (fetchImpl.mock.calls[0]![1] as RequestInit).headers as Record<string, string>
    expect(headers['Idempotency-Key']).toMatch(/^[a-f0-9]{64}$/)
    expect(headers['X-API-Key']).toBe('pbk_test')

    // Replay should produce the SAME key.
    fetchImpl.mockClear().mockResolvedValue(
      jsonResponse(200, { request_id: 'req-1', idempotent: true, applied: [] }),
    )
    await c.applyDealInvalidation(KEY, {
      motivo: 'm',
      jobId: 'job-X',
      fonte: 'dispatch_adb_precheck',
      phones: [{ telefone: '5543991938235', colunaOrigem: null, confidence: null }],
      archiveIfEmpty: false,
    })
    const headers2 = (fetchImpl.mock.calls[0]![1] as RequestInit).headers as Record<string, string>
    expect(headers2['Idempotency-Key']).toBe(headers['Idempotency-Key'])
  })

  it('200 idempotent replay → idempotent=true', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        request_id: 'req-1',
        idempotent: true,
        applied: [{ telefone: '5543991938235', status: 'duplicate_already_moved' }],
      }),
    )
    const c = makeClient(fetchImpl)
    const res = await c.applyDealInvalidation(KEY, {
      motivo: 'm',
      jobId: 'j',
      fonte: 'dispatch_adb_precheck',
      phones: [{ telefone: '5543991938235', colunaOrigem: null, confidence: null }],
      archiveIfEmpty: false,
    })
    expect(res.idempotent).toBe(true)
    expect(res.applied[0]!.status).toBe('duplicate_already_moved')
  })

  it('409 collision → throws PipeboardRestError with conflictKind=collision', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      textResponse(409, '{"error":{"code":"collision","message":"Idempotency-Key collision"}}'),
    )
    const c = makeClient(fetchImpl)
    await expect(
      c.applyDealInvalidation(KEY, {
        motivo: 'm',
        jobId: 'j',
        fonte: 'dispatch_adb_precheck',
        phones: [{ telefone: '5543991938235', colunaOrigem: null, confidence: null }],
        archiveIfEmpty: false,
      }),
    ).rejects.toMatchObject({
      name: 'PipeboardRestError',
      status: 409,
      conflictKind: 'collision',
      isPermanent: true,
      isRetryable: false,
    })
  })

  it('401 unauthorized → permanent, not retryable', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse(401, 'invalid api key'))
    const c = makeClient(fetchImpl)
    try {
      await c.applyDealInvalidation(KEY, {
        motivo: 'm',
        jobId: 'j',
        fonte: 'dispatch_adb_precheck',
        phones: [{ telefone: '5543991938235', colunaOrigem: null, confidence: null }],
        archiveIfEmpty: false,
      })
      expect.fail('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(PipeboardRestError)
      expect((e as PipeboardRestError).status).toBe(401)
      expect((e as PipeboardRestError).isPermanent).toBe(true)
      expect((e as PipeboardRestError).isRetryable).toBe(false)
    }
  })

  it('429 rate-limited → retryable', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse(429, 'slow down'))
    const c = makeClient(fetchImpl)
    try {
      await c.applyDealInvalidation(KEY, {
        motivo: 'm',
        jobId: 'j',
        fonte: 'dispatch_adb_precheck',
        phones: [{ telefone: '5543991938235', colunaOrigem: null, confidence: null }],
        archiveIfEmpty: false,
      })
      expect.fail('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(PipeboardRestError)
      expect((e as PipeboardRestError).status).toBe(429)
      expect((e as PipeboardRestError).isRetryable).toBe(true)
    }
  })

  it('parses rejected_no_match + rejected_invalid_input statuses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        request_id: 'req-x',
        idempotent: false,
        applied: [
          { telefone: '5500000000001', status: 'rejected_no_match' },
          { telefone: 'bogus', status: 'rejected_invalid_input' },
        ],
        deal_archived: false,
      }),
    )
    const c = makeClient(fetchImpl)
    const res = await c.applyDealInvalidation(KEY, {
      motivo: 'm',
      jobId: 'j',
      fonte: 'dispatch_adb_precheck',
      phones: [
        { telefone: '5500000000001', colunaOrigem: null, confidence: null },
        { telefone: 'bogus', colunaOrigem: null, confidence: null },
      ],
      archiveIfEmpty: false,
    })
    expect(res.applied.map((p) => p.status)).toEqual([
      'rejected_no_match',
      'rejected_invalid_input',
    ])
    expect(res.clearedColumns).toEqual([])
  })

  it('503 server error → retryable', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse(503, 'down'))
    const c = makeClient(fetchImpl)
    try {
      await c.applyDealInvalidation(KEY, {
        motivo: 'm',
        jobId: 'j',
        fonte: 'dispatch_adb_precheck',
        phones: [{ telefone: '5543991938235', colunaOrigem: null, confidence: null }],
        archiveIfEmpty: false,
      })
      expect.fail('should have thrown')
    } catch (e) {
      expect((e as PipeboardRestError).isRetryable).toBe(true)
    }
  })
})

describe('PipeboardRest.applyDealLocalization', () => {
  it('discriminates 409 by error.message → guardrail_blocked', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      textResponse(
        409,
        '{"error":{"code":"guardrail","message":"telefone is in prov_telefones_invalidos and cannot be localized"}}',
      ),
    )
    const c = makeClient(fetchImpl)
    try {
      await c.applyDealLocalization(KEY, {
        telefone: '5543991938235',
        source: 'adb',
        jobId: 'j',
        fonte: 'dispatch_adb_precheck',
      })
      expect.fail('should have thrown')
    } catch (e) {
      expect((e as PipeboardRestError).status).toBe(409)
      expect((e as PipeboardRestError).conflictKind).toBe('guardrail_blocked')
    }
  })

  it('200 noop_already_localized → applied=false but no throw', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        request_id: 'req-x',
        idempotent: false,
        status: 'noop_already_localized',
      }),
    )
    const c = makeClient(fetchImpl)
    const res = await c.applyDealLocalization(KEY, {
      telefone: '5543991938235',
      source: 'cache',
      jobId: 'j',
      fonte: 'dispatch_adb_precheck',
    })
    expect(res.applied).toBe(false)
    expect(res.requestId).toBe('req-x')
  })
})

describe('PipeboardRest.iterateDeals', () => {
  it('paginates via opaque cursor and stops on next_cursor=null', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          items: [makeDeal(1), makeDeal(2)],
          next_cursor: 'opaque-cursor-page-2',
          has_more: true,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          items: [makeDeal(3)],
          next_cursor: null,
          has_more: false,
        }),
      )
    const c = makeClient(fetchImpl)
    const collected: number[] = []
    for await (const page of c.iterateDeals({}, 200)) {
      collected.push(...page.map((r) => r.deal_id))
    }
    expect(collected).toEqual([1, 2, 3])
    // Second request must include cursor= verbatim.
    const url2 = fetchImpl.mock.calls[1]![0] as string
    expect(url2).toContain('cursor=opaque-cursor-page-2')
  })

  it('passes recheck_after_days as exclude_after ISO timestamp', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(200, { items: [], next_cursor: null, has_more: false }),
      )
    const c = makeClient(fetchImpl)
    for await (const _ of c.iterateDeals({ recheck_after_days: 30 }, 200)) {
      void _
    }
    const url = fetchImpl.mock.calls[0]![0] as string
    expect(url).toMatch(/exclude_after=\d{4}-\d{2}-\d{2}T/)
  })
})

describe('PipeboardRest.healthcheck', () => {
  it('no auth header on /healthz', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, { status: 'ok', db_latency_ms: 3, version: '0.1' }),
    )
    const c = makeClient(fetchImpl)
    const r = await c.healthcheck()
    expect(r.ok).toBe(true)
    const headers = (fetchImpl.mock.calls[0]![1] as RequestInit).headers as Record<string, string>
    expect(headers['X-API-Key']).toBeUndefined()
  })
})

function makeDeal(id: number) {
  return {
    pasta: 'AB',
    deal_id: id,
    contato_tipo: 'person',
    contato_id: id * 10,
    contato_nome: null,
    contato_relacao: null,
    stage_nome: null,
    pipeline_nome: null,
    whatsapp_hot: null,
    telefone_hot_1: null,
    telefone_hot_2: null,
    telefone_1: '5543991938235',
    telefone_2: null,
    telefone_3: null,
    telefone_4: null,
    telefone_5: null,
    telefone_6: null,
    localizado: null,
    telefone_localizado: null,
  }
}

describe('PipeboardRest.lookupDeals', () => {
  beforeEach(() => metricsRegistry.resetMetrics())
  afterEach(() => vi.restoreAllMocks())

  function activeResult(deal_id: number, last_modified_at = '2026-05-09T14:22:01Z') {
    return {
      key: { pasta: '16071653-A', deal_id, contato_tipo: 'person', contato_id: 360411 },
      status: 'active',
      last_modified_at,
      active_phones: {
        telefone_1: '5551935646163',
        telefone_2: null,
        telefone_3: null,
      },
      invalidated_phones: [
        { telefone: '5562982410247', coluna_origem: 'telefone_4', motivo: 'whatsapp_nao_existe',
          fonte: 'dispatch_adb_precheck', invalidado_em: '2026-05-07T19:08:36Z' },
      ],
    }
  }

  function deletedResult(deal_id: number, deleted_at = '2026-04-26T08:14:32Z') {
    return {
      key: { pasta: '13735652-A', deal_id, contato_tipo: 'organization', contato_id: 15476 },
      status: 'deleted',
      last_modified_at: deleted_at,
      deleted_at,
      active_phones: null,
      invalidated_phones: [],
    }
  }

  function notFoundResult(deal_id: number) {
    return {
      key: { pasta: 'XX-9999', deal_id, contato_tipo: 'person', contato_id: 1 },
      status: 'not_found',
      last_modified_at: null,
      active_phones: null,
      // `invalidated_phones` may be absent or null per spec; both must work.
    }
  }

  it('empty input → no HTTP call, returns []', async () => {
    const fetchImpl = vi.fn()
    const c = makeClient(fetchImpl)
    expect(await c.lookupDeals([])).toEqual([])
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('happy path → POSTs to /precheck/deals/lookup with keys[] and remaps snake → camel', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, {
      results: [activeResult(115277), deletedResult(108126), notFoundResult(99999)],
    }))
    const c = makeClient(fetchImpl)
    const keys: DealKey[] = [
      { pasta: '16071653-A', deal_id: 115277, contato_tipo: 'person', contato_id: 360411 },
      { pasta: '13735652-A', deal_id: 108126, contato_tipo: 'organization', contato_id: 15476 },
      { pasta: 'XX-9999', deal_id: 99999, contato_tipo: 'person', contato_id: 1 },
    ]
    const out = await c.lookupDeals(keys)

    // Method + URL + body shape
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://test/api/v1/adb/precheck/deals/lookup')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ keys })
    expect((init.headers as Record<string, string>)['X-API-Key']).toBe('pbk_test')

    // Snake → camel remapping
    expect(out).toHaveLength(3)
    expect(out[0].status).toBe('active')
    expect(out[0].lastModifiedAt).toBe('2026-05-09T14:22:01Z')
    expect(out[0].deletedAt).toBeNull()
    expect(out[0].activePhones).toEqual({ telefone_1: '5551935646163', telefone_2: null, telefone_3: null })
    expect(out[0].invalidatedPhones).toHaveLength(1)
    expect(out[0].invalidatedPhones[0].colunaOrigem).toBe('telefone_4')
    expect(out[0].invalidatedPhones[0].invalidadoEm).toBe('2026-05-07T19:08:36Z')

    expect(out[1].status).toBe('deleted')
    expect(out[1].deletedAt).toBe('2026-04-26T08:14:32Z')
    expect(out[1].activePhones).toBeNull()

    expect(out[2].status).toBe('not_found')
    expect(out[2].lastModifiedAt).toBeNull()
    expect(out[2].invalidatedPhones).toEqual([])
  })

  it('chunks at 500 keys client-side and preserves order across chunks', async () => {
    // 1100 keys → 3 HTTP calls (500 + 500 + 100)
    const keys: DealKey[] = Array.from({ length: 1100 }, (_, i) => ({
      pasta: 'P', deal_id: i, contato_tipo: 'person', contato_id: i,
    }))
    const fetchImpl = vi.fn().mockImplementation((_url: string, init: { body?: string }) => {
      const body = JSON.parse(init.body!) as { keys: DealKey[] }
      const results = body.keys.map((k) => ({
        key: k, status: 'active', last_modified_at: '2026-05-01Z',
        active_phones: {}, invalidated_phones: [],
      }))
      return Promise.resolve(jsonResponse(200, { results }))
    })
    const c = makeClient(fetchImpl)
    const out = await c.lookupDeals(keys)

    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).keys).toHaveLength(500)
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body).keys).toHaveLength(500)
    expect(JSON.parse(fetchImpl.mock.calls[2][1].body).keys).toHaveLength(100)
    // Order preserved across chunks
    expect(out).toHaveLength(1100)
    expect(out[0].key.deal_id).toBe(0)
    expect(out[499].key.deal_id).toBe(499)
    expect(out[500].key.deal_id).toBe(500)
    expect(out[1099].key.deal_id).toBe(1099)
  })

  it('400 server error → propagates PipeboardRestError with body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      textResponse(400, '{"error":"invalid_request","field":"keys[3].contato_tipo","detail":"must be person or organization"}'),
    )
    const c = makeClient(fetchImpl)
    await expect(
      c.lookupDeals([{ pasta: 'P', deal_id: 1, contato_tipo: 'PERSON' as 'person', contato_id: 1 }]),
    ).rejects.toBeInstanceOf(PipeboardRestError)
  })

  it('honors duplicate keys (returns one result per input position, in order)', async () => {
    const key: DealKey = { pasta: 'A', deal_id: 1, contato_tipo: 'person', contato_id: 1 }
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, {
      results: [
        { key, status: 'active', last_modified_at: 'T1', active_phones: {}, invalidated_phones: [] },
        { key, status: 'active', last_modified_at: 'T1', active_phones: {}, invalidated_phones: [] },
      ],
    }))
    const c = makeClient(fetchImpl)
    const out = await c.lookupDeals([key, key])
    expect(out).toHaveLength(2)
    expect(out[0].key).toEqual(key)
    expect(out[1].key).toEqual(key)
  })

  it('tolerates missing/null invalidated_phones field (spec allows omission)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, {
      results: [{
        key: { pasta: 'A', deal_id: 1, contato_tipo: 'person', contato_id: 1 },
        status: 'active', last_modified_at: 'T', active_phones: {},
        // invalidated_phones omitted entirely
      }],
    }))
    const c = makeClient(fetchImpl)
    const out = await c.lookupDeals([{ pasta: 'A', deal_id: 1, contato_tipo: 'person', contato_id: 1 }])
    expect(out[0].invalidatedPhones).toEqual([])
  })
})
