import { describe, it, expect, vi } from 'vitest'
import { PipeboardRawRest, NotSupportedByRawBackendError } from './pipeboard-raw-rest.js'

describe('PipeboardRawRest', () => {
  function mkFetch(resp: Partial<Response>): typeof fetch {
    return vi.fn().mockResolvedValue({
      ok: resp.ok ?? true,
      status: resp.status ?? 200,
      json: async () => (resp as { _body?: unknown })._body ?? {},
      text: async () => JSON.stringify((resp as { _body?: unknown })._body ?? {}),
    }) as unknown as typeof fetch
  }

  it('iterateDeals issues GET /precheck-raw/deals with required filters', async () => {
    const fetchImpl = mkFetch({ _body: { items: [], next_cursor: null, has_more: false } } as never)
    const c = new PipeboardRawRest({
      baseUrl: 'http://r/api/v1/sicoob',
      apiKey: 'k',
      pipelineId: 14,
      stageId: 110,
      fetchImpl,
    })
    const it1 = c.iterateDeals({}, 200)
    const first = await it1.next()
    expect(first.done).toBe(true)
    expect(fetchImpl).toHaveBeenCalled()
    const call = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]
    expect(String(call[0])).toMatch(/precheck-raw\/deals\?.*pipeline_id=14/)
    expect(String(call[0])).toMatch(/stage_id=110/)
  })

  it('writes throw NotSupportedByRawBackendError', async () => {
    const c = new PipeboardRawRest({ baseUrl: 'http://r/api/v1/sicoob', apiKey: 'k', pipelineId: 14, fetchImpl: mkFetch({}) })
    await expect(c.applyDealInvalidation({ pasta: 'x', deal_id: 1, contato_tipo: 'p', contato_id: 1 }, { motivo: 'x', jobId: null, fonte: 'dispatch_adb_precheck', phones: [], archiveIfEmpty: false })).rejects.toThrow(NotSupportedByRawBackendError)
    await expect(c.applyDealLocalization({ pasta: 'x', deal_id: 1, contato_tipo: 'p', contato_id: 1 }, { telefone: '1', source: 'cache', jobId: null, fonte: 'dispatch_adb_precheck' })).rejects.toThrow(NotSupportedByRawBackendError)
  })

  it('countPool returns server count when endpoint reachable', async () => {
    const fetchImpl = mkFetch({ _body: { count: 1234, tenant: 'sicoob' } } as never)
    const c = new PipeboardRawRest({ baseUrl: 'http://r/api/v1/sicoob', apiKey: 'k', pipelineId: 14, fetchImpl })
    expect(await c.countPool({})).toBe(1234)
    const call = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]
    expect(String(call[0])).toMatch(/precheck-raw\/deals\/count\?.*pipeline_id=14/)
  })

  it('countPool returns -1 when endpoint unreachable (graceful degrade)', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network'))
    const c = new PipeboardRawRest({ baseUrl: 'http://r/api/v1/sicoob', apiKey: 'k', pipelineId: 14, fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(await c.countPool({})).toBe(-1)
  })

  it('healthcheck calls /precheck-raw/healthz', async () => {
    const fetchImpl = mkFetch({ _body: { status: 'ok' } } as never)
    const c = new PipeboardRawRest({ baseUrl: 'http://r/api/v1/sicoob', apiKey: 'k', pipelineId: 14, fetchImpl })
    const h = await c.healthcheck()
    expect(h.ok).toBe(true)
    expect(String((fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0])).toContain('/precheck-raw/healthz')
  })
})
