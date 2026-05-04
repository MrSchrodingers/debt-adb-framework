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
        applied: [{ telefone: '5543991938235', status: 'applied' }],
        deal_archived: false,
        cleared_columns: ['telefone_1'],
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
    expect(res.applied).toEqual([{ telefone: '5543991938235', status: 'applied' }])
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
