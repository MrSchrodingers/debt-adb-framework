import { describe, expect, it, vi, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { PendingWritebacks } from './pending-writebacks.js'
import { PipeboardRestError } from './pipeboard-rest.js'
import type { DealKey } from './types.js'
import type {
  DealInvalidationRequest,
  DealInvalidationResponse,
  IPipeboardClient,
} from './pipeboard-client.js'

const KEY: DealKey = {
  pasta: 'AB',
  deal_id: 1,
  contato_tipo: 'person',
  contato_id: 100,
}
const PAYLOAD: DealInvalidationRequest = {
  motivo: 'm',
  jobId: 'job-1',
  fonte: 'dispatch_adb_precheck',
  phones: [{ telefone: '5543991938235', colunaOrigem: 'telefone_1', confidence: 0.9 }],
  archiveIfEmpty: false,
}

function makeFakeClient(): IPipeboardClient & {
  invalidate: ReturnType<typeof vi.fn>
} {
  const invalidate = vi.fn<
    [DealKey, DealInvalidationRequest],
    Promise<DealInvalidationResponse>
  >()
  return {
    healthcheck: vi.fn(),
    close: vi.fn(),
    countPool: vi.fn(),
    iterateDeals: vi.fn() as never,
    applyDealInvalidation: invalidate,
    applyDealLocalization: vi.fn(),
    writeInvalid: vi.fn(),
    clearInvalidPhone: vi.fn(),
    clearLocalizadoIfMatches: vi.fn(),
    recordInvalidPhone: vi.fn(),
    archiveDealIfEmpty: vi.fn(),
    writeLocalizado: vi.fn(),
    invalidate,
  } as never
}

const silentLogger = { info: vi.fn(), warn: vi.fn() }

describe('PendingWritebacks', () => {
  beforeEach(() => vi.clearAllMocks())

  it('passes through on success — nothing enqueued', async () => {
    const db = new Database(':memory:')
    const client = makeFakeClient()
    client.invalidate.mockResolvedValue({
      requestId: 'r1',
      idempotent: false,
      applied: [],
      archived: false,
      clearedColumns: [],
    })
    const pw = new PendingWritebacks(db, { client, logger: silentLogger })
    pw.initialize()
    const res = await pw.submitInvalidation(KEY, PAYLOAD)
    expect((res as DealInvalidationResponse).requestId).toBe('r1')
    expect(pw.size()).toBe(0)
  })

  it('enqueues on retryable 503 and returns enqueued marker', async () => {
    const db = new Database(':memory:')
    const client = makeFakeClient()
    client.invalidate.mockRejectedValue(
      new PipeboardRestError(503, 'POST', '/precheck/phones/invalidate', 'down'),
    )
    const pw = new PendingWritebacks(db, { client, logger: silentLogger })
    pw.initialize()
    const res = await pw.submitInvalidation(KEY, PAYLOAD)
    expect((res as { enqueued: true; pendingId: number }).enqueued).toBe(true)
    expect(pw.size()).toBe(1)
  })

  it('does NOT enqueue on permanent failures (401/403/409)', async () => {
    const db = new Database(':memory:')
    const client = makeFakeClient()
    client.invalidate.mockRejectedValue(
      new PipeboardRestError(401, 'POST', '/precheck/phones/invalidate', 'no auth'),
    )
    const pw = new PendingWritebacks(db, { client, logger: silentLogger })
    pw.initialize()
    await expect(pw.submitInvalidation(KEY, PAYLOAD)).rejects.toThrow(PipeboardRestError)
    expect(pw.size()).toBe(0)
  })

  it('REST 503 prolongado → drena depois sem perda', async () => {
    const db = new Database(':memory:')
    const client = makeFakeClient()
    // First N submissions all 503 → enqueued.
    client.invalidate.mockRejectedValue(
      new PipeboardRestError(503, 'POST', '/precheck/phones/invalidate', 'down'),
    )
    const pw = new PendingWritebacks(db, {
      client,
      logger: silentLogger,
      now: () => 0,
    })
    pw.initialize()
    for (let i = 0; i < 5; i++) {
      await pw.submitInvalidation(
        { ...KEY, deal_id: i + 1 },
        { ...PAYLOAD, jobId: `job-${i}` },
      )
    }
    expect(pw.size()).toBe(5)
    expect(client.invalidate).toHaveBeenCalledTimes(5)

    // Pipeboard recovers — drain succeeds for everything.
    client.invalidate.mockReset().mockResolvedValue({
      requestId: 'r-drain',
      idempotent: false,
      applied: [],
      archived: false,
      clearedColumns: [],
    })
    const drain = await pw.drainOnce()
    expect(drain.drained).toBe(5)
    expect(drain.failed).toBe(0)
    expect(pw.size()).toBe(0)
    // Each drained item replayed exactly once → 5 calls total.
    expect(client.invalidate).toHaveBeenCalledTimes(5)
  })

  it('drain backs off on continued failure with exponential next_attempt_at', async () => {
    const db = new Database(':memory:')
    const client = makeFakeClient()
    client.invalidate.mockRejectedValue(
      new PipeboardRestError(503, 'POST', '/precheck/phones/invalidate', 'down'),
    )
    let now = Date.now()
    const pw = new PendingWritebacks(db, {
      client,
      logger: silentLogger,
      now: () => now,
    })
    pw.initialize()
    await pw.submitInvalidation(KEY, PAYLOAD)
    // Drain immediately → fails again, attempts=1, next_attempt scheduled later.
    const result = await pw.drainOnce()
    expect(result.drained).toBe(0)
    expect(result.failed).toBe(1)
    expect(pw.size()).toBe(1)

    // Re-draining now (without advancing clock) should be a no-op since
    // next_attempt_at is in the future.
    const result2 = await pw.drainOnce()
    expect(result2.drained + result2.failed).toBe(0)

    // Advance past the backoff window → drain picks it up again.
    now += 10 * 60_000 // 10 min ahead
    client.invalidate.mockReset().mockResolvedValue({
      requestId: 'r',
      idempotent: false,
      applied: [],
      archived: false,
      clearedColumns: [],
    })
    const result3 = await pw.drainOnce()
    expect(result3.drained).toBe(1)
    expect(pw.size()).toBe(0)
  })

  it('gives up after maxAttempts and removes the row', async () => {
    const db = new Database(':memory:')
    const client = makeFakeClient()
    client.invalidate.mockRejectedValue(
      new PipeboardRestError(503, 'POST', '/precheck/phones/invalidate', 'down'),
    )
    let now = Date.now()
    const pw = new PendingWritebacks(db, {
      client,
      logger: silentLogger,
      now: () => now,
      maxAttempts: 2,
    })
    pw.initialize()
    await pw.submitInvalidation(KEY, PAYLOAD)
    // attempt 1 → backoff
    await pw.drainOnce()
    now += 24 * 60 * 60_000
    // attempt 2 → reaches maxAttempts → removed.
    await pw.drainOnce()
    expect(pw.size()).toBe(0)
  })
})
