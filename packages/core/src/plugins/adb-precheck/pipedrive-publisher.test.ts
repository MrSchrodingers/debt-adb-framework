import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
import { PipedrivePublisher } from './pipedrive-publisher.js'
import type { PipedriveClient } from './pipedrive-client.js'
import { PipedriveActivityStore } from './pipedrive-activity-store.js'
import { PastaLockManager } from '../../locks/pasta-lock-manager.js'
import type {
  PipedriveDealAllFailIntent,
  PipedrivePastaSummaryIntent,
} from './types.js'

const require = createRequire(import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require('better-sqlite3') as typeof import('better-sqlite3').default

function fakeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }
}

function fakeClient(
  impl?: (intent: unknown) => Promise<{
    ok: boolean
    attempts: number
    status: number | null
    error?: string
    responseId?: number | null
  }>,
): { client: PipedriveClient; dispatch: ReturnType<typeof vi.fn> } {
  const dispatch = vi.fn(impl ?? (async () => ({ ok: true, attempts: 1, status: 200 })))
  return {
    client: { dispatch } as unknown as PipedriveClient,
    dispatch,
  }
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
  it('enqueues a deal_all_fail and drains it to the client', async () => {
    const { client, dispatch } = fakeClient()
    const pub = new PipedrivePublisher(client, fakeLogger())
    pub.enqueueDealAllFail(dealFail)
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
  it('deduplicates identical deal_all_fails (same deal+job)', async () => {
    const { client, dispatch } = fakeClient()
    const pub = new PipedrivePublisher(client, fakeLogger())
    pub.enqueueDealAllFail(dealFail)
    pub.enqueueDealAllFail(dealFail) // dup
    pub.enqueueDealAllFail({ ...dealFail, deal_id: 2 }) // distinct
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

  it('different job_ids are not deduped (in-memory only, no store)', async () => {
    const { client, dispatch } = fakeClient()
    const pub = new PipedrivePublisher(client, fakeLogger())
    pub.enqueueDealAllFail(dealFail)
    pub.enqueueDealAllFail({ ...dealFail, job_id: 'job2' })
    await pub.flush()
    expect(dispatch).toHaveBeenCalledTimes(2)
  })

  it('store-backed dedup: skips re-publish for same (scenario, deal, pasta) across jobs', async () => {
    const db = new Database(':memory:')
    const store = new PipedriveActivityStore(db)
    store.initialize()
    const { client, dispatch } = fakeClient()
    const pub = new PipedrivePublisher(client, fakeLogger(), store)
    pub.enqueueDealAllFail(dealFail)
    await pub.flush()
    expect(dispatch).toHaveBeenCalledTimes(1)
    pub.enqueueDealAllFail({ ...dealFail, job_id: 'job2' })
    await pub.flush()
    expect(dispatch).toHaveBeenCalledTimes(1)
    db.close()
  })

  it('store-backed dedup: re-publish allowed after window expires', async () => {
    const db = new Database(':memory:')
    const store = new PipedriveActivityStore(db)
    store.initialize()
    const { client, dispatch } = fakeClient()
    const pub = new PipedrivePublisher(client, fakeLogger(), store, null, 1)
    pub.enqueueDealAllFail(dealFail)
    await pub.flush()
    await new Promise((r) => setTimeout(r, 5))
    pub.enqueueDealAllFail({ ...dealFail, job_id: 'job2' })
    await pub.flush()
    expect(dispatch).toHaveBeenCalledTimes(2)
    db.close()
  })

  it('store-backed dedup: failed runs do not block retry on next scan', async () => {
    const db = new Database(':memory:')
    const store = new PipedriveActivityStore(db)
    store.initialize()
    let calls = 0
    const { client, dispatch } = fakeClient(async () => {
      calls++
      return calls === 1
        ? { ok: false, attempts: 3, status: 500, error: 'boom' }
        : { ok: true, attempts: 1, status: 201 }
    })
    const pub = new PipedrivePublisher(client, fakeLogger(), store)
    pub.enqueueDealAllFail(dealFail)
    await pub.flush()
    pub.enqueueDealAllFail({ ...dealFail, job_id: 'job2' })
    await pub.flush()
    expect(dispatch).toHaveBeenCalledTimes(2)
    db.close()
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
    pub.enqueueDealAllFail(dealFail)
    pub.enqueueDealAllFail({ ...dealFail, deal_id: 2 })
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
    pub.enqueueDealAllFail(dealFail)
    pub.enqueueDealAllFail({ ...dealFail, deal_id: 2 })
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
    pub.enqueueDealAllFail(dealFail)
    pub.enqueueDealAllFail({ ...dealFail, deal_id: 2 })
    await pub.flush()
    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(logger.error).toHaveBeenCalled()
  })
})

describe('PipedrivePublisher — persistence (with store)', () => {
  it('writes a retrying row before dispatch and updates to success', async () => {
    const db = new Database(':memory:')
    const store = new PipedriveActivityStore(db)
    store.initialize()
    const { client } = fakeClient(async () => ({ ok: true, attempts: 1, status: 201 }))
    const pub = new PipedrivePublisher(client, fakeLogger(), store)
    pub.enqueueDealAllFail(dealFail)
    await pub.flush()
    const list = store.list({ scenario: 'deal_all_fail' })
    expect(list.total).toBe(1)
    const row = list.items[0]
    expect(row.pipedrive_response_status).toBe('success')
    expect(row.http_status).toBe(201)
    expect(row.attempts).toBe(1)
    expect(row.completed_at).not.toBeNull()
    expect(row.pipedrive_endpoint).toBe('/activities')
    db.close()
  })

  it('writes failed row when client returns ok:false', async () => {
    const db = new Database(':memory:')
    const store = new PipedriveActivityStore(db)
    store.initialize()
    const { client } = fakeClient(async () => ({ ok: false, attempts: 3, status: 500, error: 'http_500: boom' }))
    const pub = new PipedrivePublisher(client, fakeLogger(), store)
    pub.enqueueDealAllFail(dealFail)
    await pub.flush()
    const row = store.list({ scenario: 'deal_all_fail' }).items[0]
    expect(row.pipedrive_response_status).toBe('failed')
    expect(row.http_status).toBe(500)
    expect(row.attempts).toBe(3)
    expect(row.error_msg).toBe('http_500: boom')
    db.close()
  })

  it('persists deal_all_fail to /activities and pasta_summary to /notes', async () => {
    const db = new Database(':memory:')
    const store = new PipedriveActivityStore(db)
    store.initialize()
    const { client } = fakeClient()
    const pub = new PipedrivePublisher(client, fakeLogger(), store)
    pub.enqueueDealAllFail(dealFail)
    pub.enqueuePastaSummary(pastaSummary)
    await pub.flush()
    const dealRow = store.list({ scenario: 'deal_all_fail' }).items[0]
    const pastaRow = store.list({ scenario: 'pasta_summary' }).items[0]
    expect(dealRow.pipedrive_endpoint).toBe('/activities')
    expect(pastaRow.pipedrive_endpoint).toBe('/notes')
    expect(JSON.parse(dealRow.pipedrive_payload_json)).toHaveProperty('subject')
    expect(JSON.parse(pastaRow.pipedrive_payload_json)).toHaveProperty('content')
    db.close()
  })

  it('manual=true is propagated to the row', async () => {
    const db = new Database(':memory:')
    const store = new PipedriveActivityStore(db)
    store.initialize()
    const { client } = fakeClient()
    const pub = new PipedrivePublisher(client, fakeLogger(), store)
    pub.enqueueDealAllFail(dealFail, { manual: true, triggered_by: 'alice' })
    await pub.flush()
    const row = store.list({ scenario: 'deal_all_fail' }).items[0]
    expect(row.manual).toBe(1)
    expect(row.triggered_by).toBe('alice')
    db.close()
  })

  it('persists pipedrive_response_id (data.id) on successful dispatch', async () => {
    const db = new Database(':memory:')
    const store = new PipedriveActivityStore(db)
    store.initialize()
    // Client returns a freshly-minted entity id, mimicking POST /v1/activities
    // which responds 201 with {success:true, data:{id: 987654, ...}}.
    const { client } = fakeClient(async () => ({ ok: true, attempts: 1, status: 201, responseId: 987654 }))
    const pub = new PipedrivePublisher(client, fakeLogger(), store)
    pub.enqueueDealAllFail(dealFail)
    await pub.flush()
    const row = store.list({ scenario: 'deal_all_fail' }).items[0]
    expect(row.pipedrive_response_status).toBe('success')
    expect(row.pipedrive_response_id).toBe(987654)
    db.close()
  })

  it('leaves pipedrive_response_id null when client returns no responseId (legacy path)', async () => {
    const db = new Database(':memory:')
    const store = new PipedriveActivityStore(db)
    store.initialize()
    const { client } = fakeClient(async () => ({ ok: true, attempts: 1, status: 201 }))
    const pub = new PipedrivePublisher(client, fakeLogger(), store)
    pub.enqueueDealAllFail(dealFail)
    await pub.flush()
    const row = store.list({ scenario: 'deal_all_fail' }).items[0]
    expect(row.pipedrive_response_status).toBe('success')
    expect(row.pipedrive_response_id).toBeNull()
    db.close()
  })
})

describe('PipedrivePublisher — upsert (PUT path)', () => {
  function makeStore() {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    const store = new PipedriveActivityStore(db)
    store.initialize()
    return { db, store }
  }

  function makeLocks(db: ReturnType<typeof Database>) {
    const mgr = new PastaLockManager(db)
    mgr.initialize()
    return mgr
  }

  // Minimum required fields for PipedrivePastaSummaryIntent.
  const pastaSummaryP1: PipedrivePastaSummaryIntent = {
    scenario: 'pasta_summary',
    pasta: 'P-1',
    first_deal_id: 1,
    job_id: 'j1',
    job_started: null,
    job_ended: null,
    total_deals: 1,
    ok_deals: 1,
    archived_deals: 0,
    total_phones_checked: 1,
    ok_phones: 1,
    strategy_counts: { adb: 1, waha: 0, cache: 0 },
  }

  it('first call creates note via POST (no update_target_id)', async () => {
    const { db, store } = makeStore()
    const locks = makeLocks(db)
    const seenIntents: unknown[] = []
    const { client } = fakeClient(async (intent: unknown) => {
      seenIntents.push(intent)
      return { ok: true, status: 201, attempts: 1, responseId: 999 }
    })
    const pub = new PipedrivePublisher(client, fakeLogger(), store, null, undefined, locks)
    pub.enqueuePastaSummary(pastaSummaryP1)
    await pub.flush()
    expect(seenIntents.length).toBe(1)
    const intent = seenIntents[0] as { update_target_id?: string }
    expect(intent.update_target_id).toBeUndefined()
    // Row must be recorded as a POST.
    const rows = db.prepare('SELECT http_verb FROM pipedrive_activities ORDER BY created_at ASC').all() as Array<{ http_verb: string }>
    expect(rows[0].http_verb).toBe('POST')
    db.close()
  })

  it('second call PUTs the existing note with update_target_id and records revises_row_id', async () => {
    const { db, store } = makeStore()
    const locks = makeLocks(db)
    let dispatchCount = 0
    const seenIntents: unknown[] = []
    const { client } = fakeClient(async (intent: unknown) => {
      seenIntents.push(intent)
      dispatchCount++
      return dispatchCount === 1
        ? { ok: true, status: 201, attempts: 1, responseId: 999 }
        : { ok: true, status: 200, attempts: 1, responseId: 999 }
    })
    const pub = new PipedrivePublisher(client, fakeLogger(), store, null, undefined, locks)

    // First publish → POST, stores responseId=999.
    pub.enqueuePastaSummary(pastaSummaryP1)
    await pub.flush()

    // Second publish → must be PUT targeting note 999.
    const secondIntent: PipedrivePastaSummaryIntent = { ...pastaSummaryP1, job_id: 'j2', first_deal_id: 2 }
    pub.enqueuePastaSummary(secondIntent)
    await pub.flush()

    expect(dispatchCount).toBe(2)
    const putIntent = seenIntents[1] as { update_target_id?: string; kind: string }
    expect(putIntent.update_target_id).toBe('999')

    const rows = db
      .prepare('SELECT id, http_verb, revises_row_id FROM pipedrive_activities ORDER BY created_at ASC')
      .all() as Array<{ id: string; http_verb: string; revises_row_id: string | null }>

    expect(rows.length).toBe(2)
    expect(rows[0].http_verb).toBe('POST')
    expect(rows[1].http_verb).toBe('PUT')
    // The PUT row must point back to the POST row's id.
    expect(rows[1].revises_row_id).toBe(rows[0].id)
    db.close()
  })

  it('PUT 404 falls back to POST and orphans the previous row', async () => {
    const { db, store } = makeStore()
    const locks = makeLocks(db)
    let dispatchCount = 0
    const { client } = fakeClient(async () => {
      dispatchCount++
      if (dispatchCount === 1) return { ok: true, status: 201, attempts: 1, responseId: 999 }
      if (dispatchCount === 2) return { ok: false, status: 404, attempts: 1, error: 'not found' }
      return { ok: true, status: 201, attempts: 1, responseId: 1001 }
    })
    const pub = new PipedrivePublisher(client, fakeLogger(), store, null, undefined, locks)

    // First publish → POST.
    pub.enqueuePastaSummary(pastaSummaryP1)
    await pub.flush()

    // Second publish → PUT 404 → fallback POST.
    const secondIntent: PipedrivePastaSummaryIntent = { ...pastaSummaryP1, job_id: 'j2', first_deal_id: 2 }
    pub.enqueuePastaSummary(secondIntent)
    await pub.flush()

    // Three dispatch calls: initial POST, failed PUT, fallback POST.
    expect(dispatchCount).toBe(3)

    // The original POST row gets orphaned when the PUT 404 fallback fires.
    const orphanedCount = (
      db
        .prepare("SELECT COUNT(*) AS n FROM pipedrive_activities WHERE pipedrive_response_status = 'orphaned'")
        .get() as { n: number }
    ).n
    expect(orphanedCount).toBe(1)

    // The fallback POST should have succeeded with responseId=1001.
    const successRows = db
      .prepare("SELECT pipedrive_response_id, http_verb FROM pipedrive_activities WHERE pipedrive_response_status = 'success' ORDER BY created_at ASC")
      .all() as Array<{ pipedrive_response_id: number | null; http_verb: string }>

    // 1 success row: the fallback POST (the original POST row was orphaned).
    expect(successRows.length).toBe(1)
    expect(successRows[0].http_verb).toBe('POST')
    expect(successRows[0].pipedrive_response_id).toBe(1001)
    db.close()
  })

  it('dedup is bypassed for PUT (same pasta different jobs always dispatched)', async () => {
    const { db, store } = makeStore()
    const locks = makeLocks(db)
    let dispatchCount = 0
    const { client } = fakeClient(async () => {
      dispatchCount++
      return { ok: true, status: dispatchCount === 1 ? 201 : 200, attempts: 1, responseId: 999 }
    })
    // Short idempotency window (1ms) would normally block second publish via store dedup,
    // but PUT bypasses dedup entirely.
    const pub = new PipedrivePublisher(client, fakeLogger(), store, null, 30 * 24 * 60 * 60_000, locks)

    pub.enqueuePastaSummary(pastaSummaryP1)
    await pub.flush()

    // Second publish for same pasta with a different job_id → should PUT, not be deduped.
    const secondIntent: PipedrivePastaSummaryIntent = { ...pastaSummaryP1, job_id: 'j2', first_deal_id: 2 }
    pub.enqueuePastaSummary(secondIntent)
    await pub.flush()

    // Both calls must go through: the PUT bypasses idempotency.
    expect(dispatchCount).toBe(2)
    db.close()
  })
})
