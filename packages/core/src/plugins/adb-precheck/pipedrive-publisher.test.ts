import { describe, it, expect, vi } from 'vitest'
import { PipedrivePublisher } from './pipedrive-publisher.js'
import type { PipedriveClient } from './pipedrive-client.js'
import type {
  PipedriveDealAllFailIntent,
  PipedrivePastaSummaryIntent,
  PipedrivePhoneFailIntent,
} from './types.js'

function fakeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }
}

function fakeClient(impl?: (intent: unknown) => Promise<{ ok: boolean; attempts: number; status: number | null }>): { client: PipedriveClient; dispatch: ReturnType<typeof vi.fn> } {
  const dispatch = vi.fn(impl ?? (async () => ({ ok: true, attempts: 1, status: 200 })))
  return {
    client: { dispatch } as unknown as PipedriveClient,
    dispatch,
  }
}

const phoneFail: PipedrivePhoneFailIntent = {
  scenario: 'phone_fail',
  deal_id: 1,
  pasta: 'P',
  phone: '5543991938235',
  column: 'telefone_1',
  strategy: 'adb',
  confidence: 0.9,
  job_id: 'job',
  occurred_at: '2026-04-28T18:00:00Z',
}

const dealFail: PipedriveDealAllFailIntent = {
  scenario: 'deal_all_fail',
  deal_id: 1,
  pasta: 'P',
  phones: [{ column: 'telefone_1', phone: '5543991938235', outcome: 'invalid', strategy: 'adb', confidence: 0.9 }],
  motivo: 'todos_telefones_invalidos',
  job_id: 'job',
  occurred_at: '2026-04-28T18:00:00Z',
}

const pastaSummary: PipedrivePastaSummaryIntent = {
  scenario: 'pasta_summary',
  pasta: 'P',
  first_deal_id: 1,
  job_id: 'job',
  job_started: null,
  job_ended: null,
  total_deals: 1, ok_deals: 0, archived_deals: 1,
  total_phones_checked: 1, ok_phones: 0,
  strategy_counts: { adb: 1, waha: 0, cache: 0 },
}

describe('PipedrivePublisher — basic dispatch', () => {
  it('enqueues a phone fail and drains it to the client', async () => {
    const { client, dispatch } = fakeClient()
    const pub = new PipedrivePublisher(client, fakeLogger())
    pub.enqueuePhoneFail(phoneFail)
    await pub.flush()
    expect(dispatch).toHaveBeenCalledTimes(1)
    const arg = dispatch.mock.calls[0][0] as { kind: string; payload: { deal_id: number } }
    expect(arg.kind).toBe('activity')
    expect(arg.payload.deal_id).toBe(1)
  })

  it('handles deal-fail and pasta-summary scenarios', async () => {
    const { client, dispatch } = fakeClient()
    const pub = new PipedrivePublisher(client, fakeLogger())
    pub.enqueueDealAllFail(dealFail)
    pub.enqueuePastaSummary(pastaSummary)
    await pub.flush()
    expect(dispatch).toHaveBeenCalledTimes(2)
    const kinds = dispatch.mock.calls.map((c) => (c[0] as { kind: string }).kind).sort()
    expect(kinds).toEqual(['activity', 'note'])
  })
})

describe('PipedrivePublisher — dedup', () => {
  it('deduplicates identical phone fails (same deal+phone+job)', async () => {
    const { client, dispatch } = fakeClient()
    const pub = new PipedrivePublisher(client, fakeLogger())
    pub.enqueuePhoneFail(phoneFail)
    pub.enqueuePhoneFail(phoneFail) // dup
    pub.enqueuePhoneFail({ ...phoneFail, phone: '5511988880000' }) // distinct
    await pub.flush()
    expect(dispatch).toHaveBeenCalledTimes(2)
  })

  it('deduplicates pasta summaries within same job', async () => {
    const { client, dispatch } = fakeClient()
    const pub = new PipedrivePublisher(client, fakeLogger())
    pub.enqueuePastaSummary(pastaSummary)
    pub.enqueuePastaSummary(pastaSummary)
    await pub.flush()
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('different job_ids are not deduped', async () => {
    const { client, dispatch } = fakeClient()
    const pub = new PipedrivePublisher(client, fakeLogger())
    pub.enqueuePhoneFail(phoneFail)
    pub.enqueuePhoneFail({ ...phoneFail, job_id: 'job2' })
    await pub.flush()
    expect(dispatch).toHaveBeenCalledTimes(2)
  })
})

describe('PipedrivePublisher — async behavior', () => {
  it('does not block enqueue on slow client (fire-and-forget)', async () => {
    let resolve!: () => void
    const slow = new Promise<void>((r) => { resolve = r })
    const { client, dispatch } = fakeClient(async () => {
      await slow
      return { ok: true, attempts: 1, status: 200 }
    })
    const pub = new PipedrivePublisher(client, fakeLogger())
    const t0 = Date.now()
    pub.enqueuePhoneFail(phoneFail)
    pub.enqueuePhoneFail({ ...phoneFail, phone: '5511988880000' })
    const elapsed = Date.now() - t0
    // Enqueue must return synchronously fast (< 50ms) regardless of dispatch latency.
    expect(elapsed).toBeLessThan(50)
    expect(dispatch).toHaveBeenCalledTimes(1) // first one started, second pending
    resolve()
    await pub.flush()
    expect(dispatch).toHaveBeenCalledTimes(2)
  })

  it('continues draining after a client returns ok:false', async () => {
    const { client, dispatch } = fakeClient(async () => ({ ok: false, attempts: 3, status: 500 }))
    const pub = new PipedrivePublisher(client, fakeLogger())
    pub.enqueuePhoneFail(phoneFail)
    pub.enqueuePhoneFail({ ...phoneFail, phone: '5511988880000' })
    await pub.flush()
    expect(dispatch).toHaveBeenCalledTimes(2)
  })

  it('drain loop survives a thrown exception from client', async () => {
    let calls = 0
    const { client, dispatch } = fakeClient(async () => {
      calls++
      if (calls === 1) throw new Error('boom')
      return { ok: true, attempts: 1, status: 200 }
    })
    const logger = fakeLogger()
    const pub = new PipedrivePublisher(client, logger)
    pub.enqueuePhoneFail(phoneFail)
    pub.enqueuePhoneFail({ ...phoneFail, phone: '5511988880000' })
    await pub.flush()
    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(logger.error).toHaveBeenCalled()
  })
})
