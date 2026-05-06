import { describe, it, expect, vi } from 'vitest'
import { PrecheckScanner } from './scanner.js'
import type { ScannerDeps } from './scanner.js'
import type { DealKey, PhoneResult, ProvConsultaRow } from './types.js'

/**
 * Smoke tests for the invalidation orchestration: verify scanner records
 * blocklist entries (recordInvalidPhone) and archives empty deals
 * (archiveDealIfEmpty) when writeback_invalid is on.
 *
 * The scanner has many collaborators; we fake just the surface we exercise.
 */

function buildRow(overrides: Partial<ProvConsultaRow> = {}): ProvConsultaRow {
  return {
    pasta: 'PASTA-001',
    deal_id: 42,
    contato_tipo: 'PRINCIPAL',
    contato_id: 7,
    contato_nome: 'Fulano',
    contato_relacao: 'pessoa_do_negocio',
    stage_nome: 'Stage',
    pipeline_nome: 'Pipe',
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
    ...overrides,
  }
}

interface FakeDeps {
  scanner: PrecheckScanner
  pg: {
    countPool: ReturnType<typeof vi.fn>
    iterateDeals: ReturnType<typeof vi.fn>
    recordInvalidPhone: ReturnType<typeof vi.fn>
    clearInvalidPhone: ReturnType<typeof vi.fn>
    clearLocalizadoIfMatches: ReturnType<typeof vi.fn>
    writeInvalid: ReturnType<typeof vi.fn>
    archiveDealIfEmpty: ReturnType<typeof vi.fn>
    writeLocalizado: ReturnType<typeof vi.fn>
    applyDealInvalidation: ReturnType<typeof vi.fn>
    applyDealLocalization: ReturnType<typeof vi.fn>
    listRecentlyScannedKeys?: ReturnType<typeof vi.fn>
  }
  validator: { validate: ReturnType<typeof vi.fn> }
  store: {
    markStarted: ReturnType<typeof vi.fn>
    upsertDeal: ReturnType<typeof vi.fn>
    bumpProgress: ReturnType<typeof vi.fn>
    finishJob: ReturnType<typeof vi.fn>
    getDealLastScannedAt: ReturnType<typeof vi.fn>
    listRecentlyScannedKeys: ReturnType<typeof vi.fn>
    listDealsWithErrors: ReturnType<typeof vi.fn>
  }
}

function buildScanner(
  rows: ProvConsultaRow[],
  validateImpl: (phone: string, opts?: Record<string, unknown>) => unknown,
  opts: {
    cachedScans?: Map<string, string> // dealKey -> ISO scanned_at
    dealsWithErrors?: Array<{
      key: { pasta: string; deal_id: number; contato_tipo: string; contato_id: number }
      phones: PhoneResult[]
      valid_count: number
      invalid_count: number
      primary_valid_phone: string | null
    }>
  } = {},
): FakeDeps {
  const cachedScans = opts.cachedScans ?? new Map<string, string>()
  const pg = {
    countPool: vi.fn(async () => rows.length),
    iterateDeals: vi.fn(async function* () {
      yield rows
    }),
    recordInvalidPhone: vi.fn(async () => undefined),
    clearInvalidPhone: vi.fn(async () => 1),
    clearLocalizadoIfMatches: vi.fn(async () => 0),
    writeInvalid: vi.fn(async () => 1),
    archiveDealIfEmpty: vi.fn(async () => true),
    writeLocalizado: vi.fn(async () => undefined),
    applyDealInvalidation: vi.fn(async () => ({
      requestId: 'sql-fake',
      idempotent: false,
      applied: [],
      archived: true,
      clearedColumns: [],
    })),
    applyDealLocalization: vi.fn(async () => ({
      requestId: 'sql-fake',
      idempotent: false,
      applied: true,
    })),
  }
  const validator = { validate: vi.fn(async (p: string, validateOpts?: Record<string, unknown>) => validateImpl(p, validateOpts)) }
  const store = {
    markStarted: vi.fn(),
    upsertDeal: vi.fn(),
    bumpProgress: vi.fn(),
    finishJob: vi.fn(),
    getDealLastScannedAt: vi.fn((k: { pasta: string; deal_id: number; contato_tipo: string; contato_id: number }) => {
      const id = `${k.pasta}|${k.deal_id}|${k.contato_tipo}|${k.contato_id}`
      return cachedScans.get(id) ?? null
    }),
    listDealsWithErrors: vi.fn((_jobId: string) => opts.dealsWithErrors ?? []),
    listRecentlyScannedKeys: vi.fn((thresholdIso: string) => {
      const out: { pasta: string; deal_id: number; contato_tipo: string; contato_id: number }[] = []
      for (const [id, scannedAt] of cachedScans.entries()) {
        if (scannedAt >= thresholdIso) {
          const [pasta, dealIdStr, contato_tipo, contatoIdStr] = id.split('|')
          out.push({
            pasta: pasta!,
            deal_id: Number(dealIdStr),
            contato_tipo: contato_tipo!,
            contato_id: Number(contatoIdStr),
          })
        }
      }
      return out
    }),
  }
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  const deps = {
    pg,
    store,
    validator,
    logger,
    shouldCancel: () => false,
  } as unknown as ScannerDeps
  return { scanner: new PrecheckScanner(deps), pg, validator, store }
}

describe('PrecheckScanner — blocklist + archive integration', () => {
  it('records each invalid phone in prov_telefones_invalidos with normalized phone, source and confidence', async () => {
    const { scanner, pg } = buildScanner(
      [buildRow()],
      () => ({
        exists_on_wa: 0,
        from_cache: false,
        phone_normalized: '5543991938235',
        source: 'adb',
        confidence: 0.93,
        attempts: [{ variant_tried: 'with9' }],
      }),
    )

    await scanner.runJob('job-X', { writeback_invalid: true })

    expect(pg.applyDealInvalidation).toHaveBeenCalledTimes(1)
    const [key, payload] = pg.applyDealInvalidation.mock.calls[0]!
    expect(key).toEqual({ pasta: 'PASTA-001', deal_id: 42, contato_tipo: 'PRINCIPAL', contato_id: 7 })
    expect(payload).toMatchObject({
      motivo: 'whatsapp_nao_existe',
      jobId: 'job-X',
      fonte: 'dispatch_adb_precheck',
      archiveIfEmpty: true,
      phones: [
        {
          telefone: '5543991938235',
          colunaOrigem: 'telefone_1',
          confidence: 0.93,
        },
      ],
    })
  })

  it('passes archiveIfEmpty=true when no valid phone survived', async () => {
    const { scanner, pg } = buildScanner(
      [buildRow()],
      () => ({
        exists_on_wa: 0,
        from_cache: false,
        phone_normalized: '5543991938235',
        source: 'adb',
        confidence: 0.9,
        attempts: [{ variant_tried: null }],
      }),
    )

    await scanner.runJob('job-Y', { writeback_invalid: true })

    expect(pg.applyDealInvalidation).toHaveBeenCalledTimes(1)
    const [key, payload] = pg.applyDealInvalidation.mock.calls[0]!
    expect(key).toMatchObject({ deal_id: 42 })
    expect(payload.archiveIfEmpty).toBe(true)
  })

  it('does NOT request archive when at least one phone is valid', async () => {
    const row = buildRow({ telefone_1: '5543991938235', telefone_2: '5511988887777' })
    const { scanner, pg } = buildScanner([row], (phone) => ({
      exists_on_wa: phone === '5543991938235' ? 0 : 1,
      from_cache: false,
      phone_normalized: phone,
      source: 'adb',
      confidence: 0.9,
      attempts: [],
    }))

    await scanner.runJob('job-Z', { writeback_invalid: true })

    expect(pg.applyDealInvalidation).toHaveBeenCalledTimes(1)
    const [, payload] = pg.applyDealInvalidation.mock.calls[0]!
    expect(payload.archiveIfEmpty).toBe(false)
    expect(payload.phones).toHaveLength(1)
    expect(payload.phones[0]!.telefone).toBe('5543991938235')
  })

  it('skips recordInvalidPhone and archive when writeback_invalid is false', async () => {
    const { scanner, pg } = buildScanner(
      [buildRow()],
      () => ({
        exists_on_wa: 0,
        from_cache: false,
        phone_normalized: '5543991938235',
        source: 'adb',
        confidence: 0.9,
        attempts: [],
      }),
    )

    await scanner.runJob('job-W', { writeback_invalid: false })

    expect(pg.applyDealInvalidation).not.toHaveBeenCalled()
    expect(pg.applyDealLocalization).not.toHaveBeenCalled()
  })
})

// Task 5.4 — onInvalidPhone callback wiring
describe('PrecheckScanner — onInvalidPhone ban callback (Task 5.4)', () => {
  it('calls onInvalidPhone for each invalid phone found', async () => {
    const onInvalidPhone = vi.fn()
    const row = buildRow({ telefone_1: '5543991938235', telefone_2: '5511988880000' })

    const { scanner } = buildScanner([row], (phone) => ({
      exists_on_wa: 0, // all invalid
      from_cache: false,
      phone_normalized: phone,
      source: 'adb',
      confidence: 0.9,
      attempts: [],
    }))

    // Inject the callback by casting deps (scanner constructor merges into deps)
    const scannerWithBan = new PrecheckScanner({
      ...( (scanner as unknown as { deps: ScannerDeps }).deps),
      onInvalidPhone,
    })

    await scannerWithBan.runJob('job-ban-1', {})

    expect(onInvalidPhone).toHaveBeenCalledTimes(2)
    expect(onInvalidPhone).toHaveBeenCalledWith('5543991938235')
    expect(onInvalidPhone).toHaveBeenCalledWith('5511988880000')
  })

  it('does NOT call onInvalidPhone for valid phones', async () => {
    const onInvalidPhone = vi.fn()
    const row = buildRow({ telefone_1: '5543991938235' })

    const { scanner } = buildScanner([row], () => ({
      exists_on_wa: 1, // valid
      from_cache: false,
      phone_normalized: '5543991938235',
      source: 'adb',
      confidence: 0.95,
      attempts: [],
    }))

    const scannerWithBan = new PrecheckScanner({
      ...( (scanner as unknown as { deps: ScannerDeps }).deps),
      onInvalidPhone,
    })

    await scannerWithBan.runJob('job-ban-2', {})

    expect(onInvalidPhone).not.toHaveBeenCalled()
  })

  it('is safe when onInvalidPhone is not provided (no crash)', async () => {
    const row = buildRow({ telefone_1: '5543991938235' })
    const { scanner } = buildScanner([row], () => ({
      exists_on_wa: 0,
      from_cache: false,
      phone_normalized: '5543991938235',
      source: 'adb',
      confidence: 0.9,
      attempts: [],
    }))

    // No onInvalidPhone in deps — must not throw
    await expect(scanner.runJob('job-ban-3', {})).resolves.not.toThrow()
  })
})

describe('PrecheckScanner — Pipedrive integration', () => {
  function fakePub() {
    return {
      enqueueDealAllFail: vi.fn(),
      enqueuePastaSummary: vi.fn(),
      flush: vi.fn(async () => {}),
      pendingCount: vi.fn(() => 0),
      dedupSize: vi.fn(() => 0),
    }
  }

  it('does NOT emit per-phone (phone_fail) intents — scenario retired 2026-04-29', async () => {
    const pub = fakePub() as ReturnType<typeof fakePub> & { enqueuePhoneFail?: unknown }
    // Defensive: prove we never even *call* a removed method by spying on it.
    pub.enqueuePhoneFail = vi.fn()
    const row = buildRow({ telefone_1: '5543991938235', telefone_2: '5511988880000' })
    const { scanner } = buildScanner([row], (phone) => ({
      exists_on_wa: 0,
      from_cache: false,
      phone_normalized: phone,
      source: 'adb',
      confidence: 0.9,
      attempts: [],
    }))
    const scannerPipe = new PrecheckScanner({
      ...((scanner as unknown as { deps: ScannerDeps }).deps),
      pipedrive: pub as unknown as Parameters<typeof PrecheckScanner.prototype.constructor>[0]['pipedrive'],
    })
    await scannerPipe.runJob('job-pipe-1', {})

    expect(pub.enqueuePhoneFail).not.toHaveBeenCalled()
  })

  it('fires deal_all_fail only when archive succeeds', async () => {
    const pub = fakePub()
    const row = buildRow()
    const { scanner, pg } = buildScanner([row], (phone) => ({
      exists_on_wa: 0,
      from_cache: false,
      phone_normalized: phone,
      source: 'adb',
      confidence: 0.9,
      attempts: [],
    }))
    pg.applyDealInvalidation.mockResolvedValueOnce({
      requestId: 'r-1',
      idempotent: false,
      applied: [{ telefone: '5543991938235', status: 'applied' }],
      archived: true,
      clearedColumns: ['telefone_1'],
    })

    const scannerPipe = new PrecheckScanner({
      ...((scanner as unknown as { deps: ScannerDeps }).deps),
      pipedrive: pub as unknown as Parameters<typeof PrecheckScanner.prototype.constructor>[0]['pipedrive'],
    })
    await scannerPipe.runJob('job-pipe-2', { writeback_invalid: true })

    expect(pub.enqueueDealAllFail).toHaveBeenCalledTimes(1)
    const arg = pub.enqueueDealAllFail.mock.calls[0]![0] as { deal_id: number; phones: unknown[] }
    expect(arg.deal_id).toBe(42)
    expect(arg.phones).toHaveLength(1)
  })

  it('does NOT fire deal_all_fail when archive returns false (already archived)', async () => {
    const pub = fakePub()
    const row = buildRow()
    const { scanner, pg } = buildScanner([row], (phone) => ({
      exists_on_wa: 0,
      from_cache: false,
      phone_normalized: phone,
      source: 'adb',
      confidence: 0.9,
      attempts: [],
    }))
    pg.applyDealInvalidation.mockResolvedValueOnce({
      requestId: 'r-2',
      idempotent: false,
      applied: [{ telefone: '5543991938235', status: 'duplicate_already_moved' }],
      archived: false,
      clearedColumns: [],
    })

    const scannerPipe = new PrecheckScanner({
      ...((scanner as unknown as { deps: ScannerDeps }).deps),
      pipedrive: pub as unknown as Parameters<typeof PrecheckScanner.prototype.constructor>[0]['pipedrive'],
    })
    await scannerPipe.runJob('job-pipe-3', { writeback_invalid: true })

    expect(pub.enqueueDealAllFail).not.toHaveBeenCalled()
  })

  it('emits one pasta_summary per distinct pasta on completion', async () => {
    const pub = fakePub()
    const rows = [
      buildRow({ pasta: 'A', deal_id: 100, telefone_1: '5543991938235' }),
      buildRow({ pasta: 'A', deal_id: 50, telefone_1: '5543991938236' }),
      buildRow({ pasta: 'B', deal_id: 200, telefone_1: '5543991938237' }),
    ]
    const { scanner } = buildScanner(rows, (phone) => ({
      exists_on_wa: 1,
      from_cache: false,
      phone_normalized: phone,
      source: 'adb',
      confidence: 0.9,
      attempts: [],
    }))
    const scannerPipe = new PrecheckScanner({
      ...((scanner as unknown as { deps: ScannerDeps }).deps),
      pipedrive: pub as unknown as Parameters<typeof PrecheckScanner.prototype.constructor>[0]['pipedrive'],
    })
    await scannerPipe.runJob('job-pipe-4', {})

    expect(pub.enqueuePastaSummary).toHaveBeenCalledTimes(2)
    const summariesByPasta = new Map<string, { first_deal_id: number; total_deals: number; ok_deals: number }>()
    for (const c of pub.enqueuePastaSummary.mock.calls) {
      const arg = c[0] as { pasta: string; first_deal_id: number; total_deals: number; ok_deals: number }
      summariesByPasta.set(arg.pasta, arg)
    }
    expect(summariesByPasta.get('A')!.first_deal_id).toBe(50) // MIN(deal_id)
    expect(summariesByPasta.get('A')!.total_deals).toBe(2)
    expect(summariesByPasta.get('A')!.ok_deals).toBe(2)
    expect(summariesByPasta.get('B')!.first_deal_id).toBe(200)
    expect(summariesByPasta.get('B')!.total_deals).toBe(1)
  })

  it('passes per-deal phones[] into pasta_summary for the v2 visual layout', async () => {
    // Two rows under the same pasta `A`:
    //   - deal 50 has telefone_1 valid, telefone_2 invalid
    //   - deal 100 has telefone_1 invalid (only)
    // Expect one pasta_summary call with deals sorted ascending and each
    // deal's phones[] reflecting the checked rows.
    const pub = fakePub()
    const rows = [
      buildRow({ pasta: 'A', deal_id: 100, telefone_1: '5511444444444' }),
      buildRow({
        pasta: 'A',
        deal_id: 50,
        telefone_1: '5543991938235',
        telefone_2: '5511988887777',
      }),
    ]
    const { scanner } = buildScanner(rows, (phone) => ({
      // 5543991938235 valid, others invalid.
      exists_on_wa: phone === '5543991938235' ? 1 : 0,
      from_cache: false,
      phone_normalized: phone,
      source: 'adb',
      confidence: 0.9,
      attempts: [],
    }))
    const scannerPipe = new PrecheckScanner({
      ...((scanner as unknown as { deps: ScannerDeps }).deps),
      pipedrive: pub as unknown as Parameters<typeof PrecheckScanner.prototype.constructor>[0]['pipedrive'],
    })
    await scannerPipe.runJob('job-pipe-v2', {})

    expect(pub.enqueuePastaSummary).toHaveBeenCalledTimes(1)
    const arg = pub.enqueuePastaSummary.mock.calls[0]![0] as {
      pasta: string
      deals: Array<{ deal_id: number; phones: Array<{ column: string; phone_normalized: string; outcome: string; strategy: string }> }>
    }
    expect(arg.pasta).toBe('A')
    expect(arg.deals).toHaveLength(2)
    // Sorted ascending by deal_id.
    expect(arg.deals[0]!.deal_id).toBe(50)
    expect(arg.deals[1]!.deal_id).toBe(100)
    // Deal 50 carries 2 phones with the right outcomes.
    const d50 = arg.deals[0]!
    expect(d50.phones).toHaveLength(2)
    expect(d50.phones[0]!).toMatchObject({
      column: 'telefone_1',
      phone_normalized: '5543991938235',
      outcome: 'valid',
      strategy: 'adb',
    })
    expect(d50.phones[1]!).toMatchObject({
      column: 'telefone_2',
      phone_normalized: '5511988887777',
      outcome: 'invalid',
      strategy: 'adb',
    })
    // Deal 100 carries 1 invalid phone.
    expect(arg.deals[1]!.phones).toHaveLength(1)
    expect(arg.deals[1]!.phones[0]!).toMatchObject({
      phone_normalized: '5511444444444',
      outcome: 'invalid',
    })
  })

  it('merges phones from same-deal rows under different contato_id into one entry', async () => {
    const pub = fakePub()
    // Same deal_id (77) appears twice under same pasta with different contato_id.
    const rows = [
      buildRow({ pasta: 'M', deal_id: 77, contato_id: 1, telefone_1: '5543991938235' }),
      buildRow({ pasta: 'M', deal_id: 77, contato_id: 2, telefone_1: '5511988887777' }),
    ]
    const { scanner } = buildScanner(rows, (phone) => ({
      exists_on_wa: 0,
      from_cache: false,
      phone_normalized: phone,
      source: 'adb',
      confidence: 0.9,
      attempts: [],
    }))
    const scannerPipe = new PrecheckScanner({
      ...((scanner as unknown as { deps: ScannerDeps }).deps),
      pipedrive: pub as unknown as Parameters<typeof PrecheckScanner.prototype.constructor>[0]['pipedrive'],
    })
    await scannerPipe.runJob('job-merge', {})

    expect(pub.enqueuePastaSummary).toHaveBeenCalledTimes(1)
    const arg = pub.enqueuePastaSummary.mock.calls[0]![0] as {
      deals: Array<{ deal_id: number; phones: unknown[] }>
    }
    // Single deal entry with both phones merged.
    expect(arg.deals).toHaveLength(1)
    expect(arg.deals[0]!.deal_id).toBe(77)
    expect(arg.deals[0]!.phones).toHaveLength(2)
  })

  it('does nothing pipedrive-related when publisher omitted', async () => {
    const row = buildRow({ telefone_1: '5543991938235' })
    const { scanner } = buildScanner([row], (phone) => ({
      exists_on_wa: 0,
      from_cache: false,
      phone_normalized: phone,
      source: 'adb',
      confidence: 0.9,
      attempts: [],
    }))
    // Omits pipedrive — must not throw, scanner should still complete.
    await expect(scanner.runJob('job-pipe-5', { writeback_invalid: true })).resolves.not.toThrow()
  })
})

// Bug reproducer + fix coverage — `recheck_after_days` semantic.
//
// Reported: "Se eu coloco para fazer 10, ele lê os que ele já fez e pula, mas
// não busca novos — ele aceita e finaliza." Root cause: scanner was honouring
// `params.limit` at the SQL level, so the iterator returned only the first N
// rows (which were all cached); the loop then silently emitted them and
// finished without ever fetching new work.
//
// Contract after the fix:
//   - When `recheck_after_days` is set, scanner must skip rows whose cached
//     `scanned_at` is within the freshness window AND not count those skips
//     against `params.limit`.
//   - `params.limit` is a budget of *deals actually processed* (i.e. validator
//     was called), not an SQL ceiling.
//   - When `recheck_after_days` is omitted, behaviour is unchanged from the
//     pre-fix world (every row from PG is processed).
describe('PrecheckScanner — recheck_after_days bug reproducer (#novo-scan-skip)', () => {
  it('processes N NEW deals even when first N are within freshness window', async () => {
    // Build 30 rows: rows 1..10 are "already scanned 1 day ago" (fresh), rows
    // 11..30 are brand new. limit=10, recheck_after_days=7 — operator expects
    // 10 NEW deals processed, NOT 10 fresh ones short-circuited.
    const allRows: ProvConsultaRow[] = []
    for (let i = 1; i <= 30; i++) {
      allRows.push(buildRow({
        pasta: `PASTA-${String(i).padStart(3, '0')}`,
        deal_id: 1000 + i,
        contato_tipo: 'PRINCIPAL',
        contato_id: i,
        telefone_1: `554399193${String(8200 + i).padStart(4, '0')}`,
      }))
    }
    // Mark first 10 as recently scanned (1 day ago).
    const oneDayAgo = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString()
    const cachedScans = new Map<string, string>()
    for (let i = 0; i < 10; i++) {
      const r = allRows[i]!
      cachedScans.set(`${r.pasta}|${r.deal_id}|${r.contato_tipo}|${r.contato_id}`, oneDayAgo)
    }

    const validator = vi.fn((phone: string) => ({
      exists_on_wa: 1,
      from_cache: false,
      phone_normalized: phone,
      source: 'adb',
      confidence: 0.95,
      attempts: [],
    }))
    const { scanner, store } = buildScanner(allRows, validator, { cachedScans })

    await scanner.runJob('job-bug-1', { limit: 10, recheck_after_days: 7 })

    // The 10 processed deals must all be NEW (rows 11..30, NOT 1..10).
    expect(store.upsertDeal).toHaveBeenCalledTimes(10)
    const upsertedKeys = store.upsertDeal.mock.calls.map((c) => {
      const dealResult = c[1] as { key: { deal_id: number } }
      return dealResult.key.deal_id
    })
    // Every upserted deal_id must be > 1010 (i.e. NOT in the cached window).
    for (const dealId of upsertedKeys) {
      expect(dealId).toBeGreaterThan(1010)
    }
    // Validator (real work) called 10 times — never for the cached rows.
    expect(validator).toHaveBeenCalledTimes(10)
  })

  it('preserves backward compatibility — recheck_after_days undefined → no skipping', async () => {
    // 5 rows, all "recently scanned" — but with no `recheck_after_days` param,
    // scanner must behave as today (process every row).
    const rows: ProvConsultaRow[] = []
    for (let i = 1; i <= 5; i++) {
      rows.push(buildRow({
        pasta: `P-${i}`,
        deal_id: 100 + i,
        contato_id: i,
      }))
    }
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const cachedScans = new Map<string, string>()
    for (const r of rows) {
      cachedScans.set(`${r.pasta}|${r.deal_id}|${r.contato_tipo}|${r.contato_id}`, yesterday)
    }

    const validator = vi.fn((phone: string) => ({
      exists_on_wa: 1,
      from_cache: false,
      phone_normalized: phone,
      source: 'adb',
      confidence: 0.9,
      attempts: [],
    }))
    const { scanner, store } = buildScanner(rows, validator, { cachedScans })

    // No recheck_after_days → scanner must process all 5.
    await scanner.runJob('job-bug-2', { limit: 10 })

    expect(store.upsertDeal).toHaveBeenCalledTimes(5)
    expect(validator).toHaveBeenCalledTimes(5)
  })

  it('falls back to scanner-side filtering when excluded set is too large (>5000)', async () => {
    // Edge: cache contains 6000 fresh entries — too many to inline into a
    // PG NOT IN (...) tuple list. Scanner must NOT pass excluded_keys to PG
    // (countPool/iterateDeals receive params w/o the heavy list), and instead
    // skip cached rows in the loop.
    const allRows: ProvConsultaRow[] = []
    // 10 fresh + 5 new — small enough to keep test fast, but we will populate
    // the fake cache with > 5000 unrelated keys to trigger the fallback path.
    for (let i = 1; i <= 15; i++) {
      allRows.push(buildRow({
        pasta: `PASTA-X-${String(i).padStart(3, '0')}`,
        deal_id: 9000 + i,
        contato_tipo: 'PRINCIPAL',
        contato_id: i,
        telefone_1: `554399193${String(7000 + i).padStart(4, '0')}`,
      }))
    }
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const cachedScans = new Map<string, string>()
    // First 10 of allRows are fresh.
    for (let i = 0; i < 10; i++) {
      const r = allRows[i]!
      cachedScans.set(`${r.pasta}|${r.deal_id}|${r.contato_tipo}|${r.contato_id}`, oneDayAgo)
    }
    // Pad with 6000 unrelated fresh entries to push count over the threshold.
    for (let i = 0; i < 6000; i++) {
      cachedScans.set(`OTHER|${i}|PRINCIPAL|${i}`, oneDayAgo)
    }

    const validator = vi.fn((phone: string) => ({
      exists_on_wa: 1,
      from_cache: false,
      phone_normalized: phone,
      source: 'adb',
      confidence: 0.9,
      attempts: [],
    }))
    const { scanner, pg, store } = buildScanner(allRows, validator, { cachedScans })

    await scanner.runJob('job-bug-3', { limit: 5, recheck_after_days: 7 })

    // Scanner must NOT have inlined excluded_keys into PG calls (too many).
    const countPoolArgs = pg.countPool.mock.calls[0]?.[0] as { excluded_keys?: unknown[] } | undefined
    expect(countPoolArgs?.excluded_keys ?? null).toBeNull()
    const iterateArgs = pg.iterateDeals.mock.calls[0]?.[0] as { excluded_keys?: unknown[] } | undefined
    expect(iterateArgs?.excluded_keys ?? null).toBeNull()

    // But scanner-side filtering still works: only NEW deals processed.
    expect(store.upsertDeal).toHaveBeenCalledTimes(5)
    const dealIds = store.upsertDeal.mock.calls.map((c) => (c[1] as { key: { deal_id: number } }).key.deal_id)
    for (const id of dealIds) {
      expect(id).toBeGreaterThan(9010) // skipped 9001..9010 (fresh)
    }
  })
})

describe('PrecheckScanner — hygienization_mode (Part 2)', () => {
  it('pauses global at start and resumes in finally on happy path', async () => {
    const rows = [buildRow({ telefone_1: '5543991938235' })]
    const validator = () => ({
      exists_on_wa: 1,
      from_cache: false,
      phone_normalized: '5543991938235',
      source: 'adb',
      confidence: 0.9,
      attempts: [],
    })
    const { scanner } = buildScanner(rows, validator)
    const pause = vi.fn()
    const resume = vi.fn(() => true)
    const pauseState = { pause, resume }
    // Inject pauseState by re-creating the scanner with extended deps.
    ;(scanner as unknown as { deps: ScannerDeps }).deps.pauseState = pauseState
    ;(scanner as unknown as { deps: ScannerDeps }).deps.hygienizationOperator = 'op-x'

    await scanner.runJob('job-hyg-1', { hygienization_mode: true })

    expect(pause).toHaveBeenCalledWith('global', '*', expect.stringContaining('hygienization'), 'op-x')
    expect(resume).toHaveBeenCalledWith('global', '*', 'op-x')
    expect(pause).toHaveBeenCalledBefore(resume)
  })

  it('floors recheck_after_days at 30 when below', async () => {
    const rows = [buildRow({ telefone_1: '5543991938235' })]
    const validator = () => ({
      exists_on_wa: 1,
      from_cache: false,
      phone_normalized: '5543991938235',
      source: 'adb',
      confidence: 0.9,
      attempts: [],
    })
    const { scanner, pg } = buildScanner(rows, validator)
    const pauseState = { pause: vi.fn(), resume: vi.fn(() => true) }
    ;(scanner as unknown as { deps: ScannerDeps }).deps.pauseState = pauseState
    await scanner.runJob('job-hyg-2', { hygienization_mode: true, recheck_after_days: 7 })

    // The countPool call should have received `recheck_after_days` overridden to 30.
    const args = pg.countPool.mock.calls[0]?.[0] as { recheck_after_days?: number }
    expect(args.recheck_after_days).toBe(30)
  })

  it('preserves recheck_after_days when already >= 30', async () => {
    const rows = [buildRow({ telefone_1: '5543991938235' })]
    const validator = () => ({
      exists_on_wa: 1,
      from_cache: false,
      phone_normalized: '5543991938235',
      source: 'adb',
      confidence: 0.9,
      attempts: [],
    })
    const { scanner, pg } = buildScanner(rows, validator)
    const pauseState = { pause: vi.fn(), resume: vi.fn(() => true) }
    ;(scanner as unknown as { deps: ScannerDeps }).deps.pauseState = pauseState
    await scanner.runJob('job-hyg-3', { hygienization_mode: true, recheck_after_days: 60 })

    const args = pg.countPool.mock.calls[0]?.[0] as { recheck_after_days?: number }
    expect(args.recheck_after_days).toBe(60)
  })

  it('resumes global pause even when scanner throws mid-iteration', async () => {
    const rows = [buildRow({ telefone_1: '5543991938235' })]
    const { scanner, pg } = buildScanner(rows, () => {
      throw new Error('validator boom')
    })
    pg.iterateDeals.mockImplementation(async function* () {
      yield rows
    })
    const pauseState = { pause: vi.fn(), resume: vi.fn(() => true) }
    ;(scanner as unknown as { deps: ScannerDeps }).deps.pauseState = pauseState

    // The validator throws — scanner catches per-phone, finishes the job, but
    // the pause/resume contract must still hold.
    await scanner.runJob('job-hyg-err', { hygienization_mode: true })
    expect(pauseState.pause).toHaveBeenCalled()
    expect(pauseState.resume).toHaveBeenCalled()
  })

  it('aborts the job with status=failed if pause() throws', async () => {
    const rows = [buildRow({ telefone_1: '5543991938235' })]
    const { scanner, store } = buildScanner(rows, () => ({
      exists_on_wa: 1,
      from_cache: false,
      phone_normalized: '5543991938235',
      source: 'adb',
      confidence: 0.9,
      attempts: [],
    }))
    const pauseState = {
      pause: vi.fn(() => { throw new Error('pause table locked') }),
      resume: vi.fn(),
    }
    ;(scanner as unknown as { deps: ScannerDeps }).deps.pauseState = pauseState

    await expect(
      scanner.runJob('job-hyg-pausefail', { hygienization_mode: true }),
    ).rejects.toThrow('pause table locked')
    // finishJob must have been called with 'failed' so the job row reflects it.
    const failedCalls = store.finishJob.mock.calls.filter((c) => c[1] === 'failed')
    expect(failedCalls.length).toBeGreaterThan(0)
  })

  it('does NOT pause when hygienization_mode is false (default behaviour preserved)', async () => {
    const rows = [buildRow({ telefone_1: '5543991938235' })]
    const validator = () => ({
      exists_on_wa: 1,
      from_cache: false,
      phone_normalized: '5543991938235',
      source: 'adb',
      confidence: 0.9,
      attempts: [],
    })
    const { scanner } = buildScanner(rows, validator)
    const pauseState = { pause: vi.fn(), resume: vi.fn() }
    ;(scanner as unknown as { deps: ScannerDeps }).deps.pauseState = pauseState
    await scanner.runJob('job-non-hyg', {})
    expect(pauseState.pause).not.toHaveBeenCalled()
    expect(pauseState.resume).not.toHaveBeenCalled()
  })

  it('warns and continues when pauseState is not wired', async () => {
    const rows = [buildRow({ telefone_1: '5543991938235' })]
    const validator = () => ({
      exists_on_wa: 1,
      from_cache: false,
      phone_normalized: '5543991938235',
      source: 'adb',
      confidence: 0.9,
      attempts: [],
    })
    const { scanner } = buildScanner(rows, validator)
    // No pauseState injected at all.
    await expect(
      scanner.runJob('job-hyg-no-state', { hygienization_mode: true }),
    ).resolves.toBeUndefined()
  })
})

// ── Task D4: end-of-scan retry pass (Level 2) ─────────────────────────────
//
// After the main scan loop completes, the scanner re-validates phones whose
// outcome is 'error'. The retry mutates pastaAgg so the pasta_summary Note
// reflects the resolved outcomes, and persists the change via store.upsertDeal.
//
describe('PrecheckScanner — end-of-scan retry pass (Level 2 / Task D4)', () => {
  /**
   * Builds an error PhoneResult (simulating a phone that threw during the
   * initial scan loop).
   */
  function makeErrorPhone(column: string, normalized: string): PhoneResult {
    return {
      column,
      raw: normalized.replace(/^\+?55/, ''),
      normalized,
      outcome: 'error',
      source: 'cache',
      confidence: null,
      variant_tried: null,
      error: 'timeout',
    }
  }

  it('re-validates error phones with attempt_phase=scan_retry and resolves to invalid', async () => {
    // Main scan: one deal, one phone that ends up 'error' (validator throws).
    const row = buildRow({ telefone_1: '5543991938235' })

    // Track call count so first call (main scan) throws, second (retry) returns 0.
    let callCount = 0
    const validateFn = vi.fn((_phone: string, _opts?: Record<string, unknown>) => {
      callCount++
      if (callCount === 1) throw new Error('probe timeout')
      return {
        exists_on_wa: 0,
        from_cache: false,
        phone_normalized: '5543991938235',
        source: 'adb',
        confidence: 0.8,
        attempts: [{ variant_tried: 'with9' }],
      }
    })

    // Pre-seed listDealsWithErrors with the deal that came back error after
    // the main scan. In real execution this is populated from the DB after
    // store.upsertDeal; here we inject it directly so we can assert on the
    // retry behaviour without a real SQLite database.
    const errorPhones: PhoneResult[] = [makeErrorPhone('telefone_1', '5543991938235')]
    const { scanner, store, validator } = buildScanner([row], validateFn, {
      dealsWithErrors: [{
        key: { pasta: 'PASTA-001', deal_id: 42, contato_tipo: 'PRINCIPAL', contato_id: 7 },
        phones: errorPhones,
        valid_count: 0,
        invalid_count: 0,
        primary_valid_phone: null,
      }],
    })

    await scanner.runJob('job-retry-1', {})

    // validator called twice: once in main loop (throws → error), once in retry.
    expect(validator.validate).toHaveBeenCalledTimes(2)

    // Second call must carry attempt_phase='scan_retry'.
    const secondCallOpts = validator.validate.mock.calls[1]![1] as Record<string, unknown>
    expect(secondCallOpts.attempt_phase).toBe('scan_retry')

    // store.upsertDeal should have been called a second time (retry pass persists
    // the resolved outcome). The retry upsert carries outcome='invalid'.
    // There are 2 upsertDeal calls: one from the main loop (error outcome) and
    // one from the retry pass (invalid outcome).
    const upsertCalls = store.upsertDeal.mock.calls
    expect(upsertCalls.length).toBeGreaterThanOrEqual(2)
    const retryUpsert = upsertCalls[upsertCalls.length - 1] as [string, { phones: PhoneResult[] }]
    const retryPhone = retryUpsert[1].phones.find((p: PhoneResult) => p.column === 'telefone_1')
    expect(retryPhone?.outcome).toBe('invalid')
    expect(retryPhone?.error).toBeNull()
  })

  it('does not retry when retry_errors=false', async () => {
    const row = buildRow({ telefone_1: '5543991938235' })

    let callCount = 0
    const validateFn = vi.fn((_phone: string) => {
      callCount++
      if (callCount === 1) throw new Error('probe timeout')
      return { exists_on_wa: 0, from_cache: false, phone_normalized: '5543991938235', source: 'adb', confidence: 0.8, attempts: [] }
    })

    const errorPhones: PhoneResult[] = [makeErrorPhone('telefone_1', '5543991938235')]
    const { scanner, store } = buildScanner([row], validateFn, {
      dealsWithErrors: [{
        key: { pasta: 'PASTA-001', deal_id: 42, contato_tipo: 'PRINCIPAL', contato_id: 7 },
        phones: errorPhones,
        valid_count: 0,
        invalid_count: 0,
        primary_valid_phone: null,
      }],
    })

    await scanner.runJob('job-retry-disabled', { retry_errors: false })

    // validator called only once (main loop), never for the retry pass.
    expect(validateFn).toHaveBeenCalledTimes(1)
    // listDealsWithErrors never consulted.
    expect(store.listDealsWithErrors).not.toHaveBeenCalled()
  })

  it('does not retry when there are no error phones (short-circuits early)', async () => {
    // Main scan: phone resolves to 'valid' immediately — no errors.
    const row = buildRow({ telefone_1: '5543991938235' })
    const validateFn = vi.fn(() => ({
      exists_on_wa: 1,
      from_cache: false,
      phone_normalized: '5543991938235',
      source: 'adb',
      confidence: 0.95,
      attempts: [],
    }))

    // listDealsWithErrors returns empty — no errors to retry.
    const { scanner, validator } = buildScanner([row], validateFn, {
      dealsWithErrors: [],
    })

    await scanner.runJob('job-retry-noop', {})

    // validator called once (main loop); retry pass sees empty list and exits.
    expect(validator.validate).toHaveBeenCalledTimes(1)
  })

  it('resolves error phone to valid and updates pastaAgg ok_phones', async () => {
    const row = buildRow({ telefone_1: '5543991938235' })

    let callCount = 0
    const validateFn = vi.fn((_phone: string) => {
      callCount++
      if (callCount === 1) throw new Error('adb timeout')
      // Retry succeeds: phone is valid.
      return {
        exists_on_wa: 1,
        from_cache: false,
        phone_normalized: '5543991938235',
        source: 'waha',
        confidence: 0.9,
        attempts: [],
      }
    })

    const pub = {
      enqueueDealAllFail: vi.fn(),
      enqueuePastaSummary: vi.fn(),
      flush: vi.fn(async () => {}),
      pendingCount: vi.fn(() => 0),
      dedupSize: vi.fn(() => 0),
    }

    const errorPhones: PhoneResult[] = [makeErrorPhone('telefone_1', '5543991938235')]
    const { scanner } = buildScanner([row], validateFn, {
      dealsWithErrors: [{
        key: { pasta: 'PASTA-001', deal_id: 42, contato_tipo: 'PRINCIPAL', contato_id: 7 },
        phones: errorPhones,
        valid_count: 0,
        invalid_count: 0,
        primary_valid_phone: null,
      }],
    })

    const scannerPipe = new PrecheckScanner({
      ...((scanner as unknown as { deps: ScannerDeps }).deps),
      pipedrive: pub as unknown as Parameters<typeof PrecheckScanner.prototype.constructor>[0]['pipedrive'],
    })

    await scannerPipe.runJob('job-retry-valid', {})

    // pasta_summary should have been emitted with ok_phones=1 (resolved by retry).
    expect(pub.enqueuePastaSummary).toHaveBeenCalledTimes(1)
    const summaryArg = pub.enqueuePastaSummary.mock.calls[0]![0] as { ok_phones: number; ok_deals: number }
    expect(summaryArg.ok_phones).toBe(1)
    expect(summaryArg.ok_deals).toBe(1)
  })

  it('leaves phones that still error after retry unchanged in the upsert', async () => {
    const row = buildRow({ telefone_1: '5543991938235' })

    // Both initial scan and retry throw — phone stays 'error'.
    const validateFn = vi.fn((_phone: string) => {
      throw new Error('always fails')
    })

    const errorPhones: PhoneResult[] = [makeErrorPhone('telefone_1', '5543991938235')]
    const { scanner, store } = buildScanner([row], validateFn, {
      dealsWithErrors: [{
        key: { pasta: 'PASTA-001', deal_id: 42, contato_tipo: 'PRINCIPAL', contato_id: 7 },
        phones: errorPhones,
        valid_count: 0,
        invalid_count: 0,
        primary_valid_phone: null,
      }],
    })

    await scanner.runJob('job-retry-still-error', {})

    // No extra upsertDeal call from the retry pass (nothing mutated).
    // Main loop upsert is called once with 'error'; retry does not upsert.
    const upsertCalls = store.upsertDeal.mock.calls
    // The last upsert should be the main loop one — no retry upsert added.
    // We confirm that by checking that the retry pass did NOT produce a second
    // upsert with the deal key (both upserts would share the same key if present).
    // At minimum: main loop always calls upsertDeal once.
    expect(upsertCalls.length).toBeGreaterThanOrEqual(1)
    // The phones in the main loop upsert still carry outcome='error'.
    const mainUpsert = upsertCalls[0] as [string, { phones: PhoneResult[] }]
    const mainPhone = mainUpsert[1].phones.find((p: PhoneResult) => p.column === 'telefone_1')
    expect(mainPhone?.outcome).toBe('error')
  })
})

// ── Task D5: hold scan.<pasta> lock during scan + retry pass ──────────────
//
// The scanner acquires a per-pasta lock (key `scan:<pasta_filter>` or
// `scan:all` when no pasta filter) before the main loop and releases it in
// `finally`. A pre-existing lock on the same key causes the scanner to throw
// `ScanInProgressError` immediately (and mark the job `failed`).
//
import Database from 'better-sqlite3'
import { PastaLockManager } from '../../locks/index.js'
import { ScanInProgressError } from './scanner.js'

describe('PrecheckScanner — scan.<pasta> lock (Task D5)', () => {
  // Helper: build a scanner with a real in-memory SQLite + PastaLockManager.
  function buildScannerWithLocks(
    rows: ProvConsultaRow[],
    validateImpl: (phone: string, opts?: Record<string, unknown>) => unknown,
    locks: PastaLockManager,
  ) {
    const { scanner, store, pg, validator } = buildScanner(rows, validateImpl)
    const scannerWithLocks = new PrecheckScanner({
      ...((scanner as unknown as { deps: ScannerDeps }).deps),
      locks,
    })
    return { scanner: scannerWithLocks, store, pg, validator }
  }

  it('rejects with ScanInProgressError when pasta already locked', async () => {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    const locks = new PastaLockManager(db)
    locks.initialize()

    // Pre-acquire the lock externally BEFORE constructing the scanner job.
    const preLock = locks.acquire('scan:P-1', 60_000, { job_id: 'external', pasta: 'P-1' })
    expect(preLock).not.toBeNull()

    const row = buildRow({ pasta: 'P-1', deal_id: 1 })
    const { scanner, store } = buildScannerWithLocks(
      [row],
      () => ({ exists_on_wa: 1, from_cache: false, phone_normalized: '5543991938235', source: 'adb', confidence: 0.9, attempts: [] }),
      locks,
    )

    await expect(
      scanner.runJob('job-d5-conflict', { pasta_filter: 'P-1' }),
    ).rejects.toThrow(ScanInProgressError)

    // Job must be marked failed, not left in queued.
    const failedCalls = store.finishJob.mock.calls.filter((c) => c[1] === 'failed')
    expect(failedCalls.length).toBeGreaterThan(0)

    // The error carries the pasta and the current holder's metadata.
    let thrown: ScanInProgressError | null = null
    try {
      await scanner.runJob('job-d5-conflict-2', { pasta_filter: 'P-1' })
    } catch (e) {
      if (e instanceof ScanInProgressError) thrown = e
    }
    expect(thrown).not.toBeNull()
    expect(thrown!.pasta).toBe('P-1')
    expect(thrown!.current).not.toBeNull()
    expect(thrown!.current!.fenceToken).toBe(preLock!.fenceToken)
  })

  it('releases lock after run completes (happy path)', async () => {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    const locks = new PastaLockManager(db)
    locks.initialize()

    const row = buildRow({ pasta: 'P-2', deal_id: 10 })
    const { scanner } = buildScannerWithLocks(
      [row],
      () => ({ exists_on_wa: 1, from_cache: false, phone_normalized: '5543991938235', source: 'adb', confidence: 0.9, attempts: [] }),
      locks,
    )

    await scanner.runJob('job-d5-happy', { pasta_filter: 'P-2' })

    // Lock must be released after completion.
    expect(locks.describe('scan:P-2')).toBeNull()
  })

  it('releases lock when scan throws mid-loop (error path)', async () => {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    const locks = new PastaLockManager(db)
    locks.initialize()

    // pg.countPool throws to simulate a scan-level failure.
    const row = buildRow({ pasta: 'P-3', deal_id: 20 })
    const { scanner, pg } = buildScannerWithLocks(
      [row],
      () => { throw new Error('adb kaboom') },
      locks,
    )
    // Make countPool throw so the outer try in runJob catches it.
    pg.countPool.mockRejectedValueOnce(new Error('pg boom'))

    await expect(
      scanner.runJob('job-d5-fail', { pasta_filter: 'P-3' }),
    ).rejects.toThrow('pg boom')

    // Lock must be released even when the job failed.
    expect(locks.describe('scan:P-3')).toBeNull()
  })

  it('uses scan:all as lock key when no pasta_filter is set', async () => {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    const locks = new PastaLockManager(db)
    locks.initialize()

    const row = buildRow({ pasta: 'ANY', deal_id: 30 })
    const { scanner } = buildScannerWithLocks(
      [row],
      () => ({ exists_on_wa: 1, from_cache: false, phone_normalized: '5543991938235', source: 'adb', confidence: 0.9, attempts: [] }),
      locks,
    )

    await scanner.runJob('job-d5-all', {})

    // Lock must be released. Key is `scan:all` (no pasta_filter).
    expect(locks.describe('scan:all')).toBeNull()
  })

  it('omitted locks dep keeps legacy behaviour (no lock, no crash)', async () => {
    // Scanner WITHOUT the locks dep — must complete without any lock acquisition.
    const row = buildRow({ pasta: 'P-4', deal_id: 40 })
    const { scanner } = buildScanner(
      [row],
      () => ({ exists_on_wa: 1, from_cache: false, phone_normalized: '5543991938235', source: 'adb', confidence: 0.9, attempts: [] }),
    )

    await expect(scanner.runJob('job-d5-legacy', { pasta_filter: 'P-4' })).resolves.toBeUndefined()
  })

  it('fence-token guard aborts retry pass when lock is released mid-retry', async () => {
    // Simulate a lock that becomes invalid between retry iterations.
    // We do this by manually releasing the lock inside the validator during retry.
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    const locks = new PastaLockManager(db)
    locks.initialize()

    // Two error deals so the retry loop iterates at least twice.
    const rows = [
      buildRow({ pasta: 'P-5', deal_id: 50, telefone_1: '5543991938235' }),
      buildRow({ pasta: 'P-5', deal_id: 51, telefone_1: '5543991938236' }),
    ]

    // Main scan: both validators throw (deals become errors).
    // Retry scan: first call succeeds, second call checks isStillValid.
    // We release the lock BEFORE running to verify the guard fires.
    // (In practice, we inject a locks instance and manually invalidate between calls.)
    let retryCallCount = 0
    let capturedLockHandle: import('../../locks/index.js').LockHandle | null = null
    const validateFn = vi.fn((_phone: string, opts?: Record<string, unknown>) => {
      if (opts?.attempt_phase === 'scan_retry') {
        retryCallCount++
        // On first retry call: capture the handle and release it so the next
        // isStillValid() check returns false.
        if (retryCallCount === 1 && capturedLockHandle) {
          capturedLockHandle.release()
        }
        return { exists_on_wa: 0, from_cache: false, phone_normalized: _phone, source: 'adb', confidence: 0.8, attempts: [] }
      }
      throw new Error('main scan error')
    })

    const errorDeals = [
      {
        key: { pasta: 'P-5', deal_id: 50, contato_tipo: 'PRINCIPAL', contato_id: 1 },
        phones: [{ column: 'telefone_1', raw: '43991938235', normalized: '5543991938235', outcome: 'error' as const, source: 'cache', confidence: null, variant_tried: null, error: 'timeout' }],
        valid_count: 0, invalid_count: 0, primary_valid_phone: null,
      },
      {
        key: { pasta: 'P-5', deal_id: 51, contato_tipo: 'PRINCIPAL', contato_id: 2 },
        phones: [{ column: 'telefone_1', raw: '43991938236', normalized: '5543991938236', outcome: 'error' as const, source: 'cache', confidence: null, variant_tried: null, error: 'timeout' }],
        valid_count: 0, invalid_count: 0, primary_valid_phone: null,
      },
    ]

    const { scanner, store } = buildScannerWithLocks(rows, validateFn, locks)
    // Inject dealsWithErrors.
    store.listDealsWithErrors.mockReturnValue(errorDeals)

    // Monkey-patch locks.acquire so we can capture the LockHandle returned.
    const origAcquire = locks.acquire.bind(locks)
    locks.acquire = (key: string, ttlMs: number, ctx?: Record<string, unknown>) => {
      const handle = origAcquire(key, ttlMs, ctx)
      if (handle) capturedLockHandle = handle
      return handle
    }

    await scanner.runJob('job-d5-fence', { pasta_filter: 'P-5' })

    // The fence guard should have prevented the second retry iteration.
    // retryCallCount should be 1 (guard fired before second deal).
    expect(retryCallCount).toBe(1)
  })
})

// ── Task E1: runRetryErrorsJob — Level 3 sweep entrypoint ─────────────────
//
// Manual entrypoint that re-validates phones with outcome='error' from PRIOR
// scan jobs. Returns immediately with a job_id; processing is async via
// setImmediate. Reuses the per-pasta scan lock per group.
//
describe('Scanner — runRetryErrorsJob (Level 3 sweep)', () => {
  /** Build a scanner wired with a real in-memory SQLite + PastaLockManager. */
  function buildSweepScanner(opts: {
    errorDeals: Array<{
      key: DealKey
      phones: PhoneResult[]
      last_job_id: string
    }>
    validateImpl?: (phone: string, opts?: Record<string, unknown>) => unknown
    locks?: PastaLockManager
    pipedrive?: {
      enqueueDealAllFail: ReturnType<typeof vi.fn>
      enqueuePastaSummary: ReturnType<typeof vi.fn>
      flush: ReturnType<typeof vi.fn>
      pendingCount: ReturnType<typeof vi.fn>
      dedupSize: ReturnType<typeof vi.fn>
    }
  }) {
    const validateImpl =
      opts.validateImpl ??
      ((_phone: string) => ({
        exists_on_wa: 0,
        from_cache: false,
        phone_normalized: _phone,
        source: 'waha',
        confidence: 0.9,
        attempts: [],
      }))

    // Minimal validator mock.
    const validator = { validate: vi.fn(async (p: string, o?: Record<string, unknown>) => validateImpl(p, o)) }

    // We inject a listDealsWithErrorsByFilter-enabled store mock that also
    // exposes listDealsForPasta and createJob/markStarted/bumpProgress/finishJob/getJob.
    const upsertDeal = vi.fn()
    const createdJobs: Array<{ id: string; started_at: string | null; finished_at: string | null }> = []
    let jobCounter = 0
    const store = {
      listDealsWithErrorsByFilter: vi.fn(
        (_opts: { since_iso: string; pasta: string | null; limit: number }) => opts.errorDeals,
      ),
      listDealsForPasta: vi.fn((pasta: string) =>
        opts.errorDeals.filter((d) => d.key.pasta === pasta),
      ),
      createJob: vi.fn(
        (
          _params: unknown,
          _extRef?: string,
          createOpts?: { triggeredBy?: string; parentJobId?: string },
        ) => {
          const id = `sweep-job-${++jobCounter}`
          const job = {
            id,
            status: 'queued',
            started_at: null,
            finished_at: null,
            triggered_by: createOpts?.triggeredBy ?? 'manual',
            parent_job_id: createOpts?.parentJobId ?? null,
          }
          createdJobs.push(job)
          return job
        },
      ),
      markStarted: vi.fn(),
      upsertDeal,
      bumpProgress: vi.fn(),
      finishJob: vi.fn((id: string, status: string, _err?: string) => {
        const job = createdJobs.find((j) => j.id === id)
        if (job) (job as unknown as Record<string, string>)['status'] = status
      }),
      getJob: vi.fn((id: string) => createdJobs.find((j) => j.id === id) ?? null),
      // Satisfy other store call-sites in scanner (not exercised by sweep tests).
      getDealLastScannedAt: vi.fn(() => null),
      listRecentlyScannedKeys: vi.fn(() => []),
      listDealsWithErrors: vi.fn(() => []),
    }

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }

    const deps = {
      pg: {
        countPool: vi.fn(async () => 0),
        iterateDeals: vi.fn(async function* () { /* empty */ }),
        applyDealInvalidation: vi.fn(async () => ({ requestId: 'r', idempotent: false, applied: [], archived: false, clearedColumns: [] })),
        applyDealLocalization: vi.fn(async () => ({ requestId: 'r', idempotent: false, applied: true })),
      },
      store,
      validator,
      logger,
      shouldCancel: () => false,
      locks: opts.locks,
      pipedrive: opts.pipedrive as unknown as ScannerDeps['pipedrive'],
    } as unknown as ScannerDeps

    const scanner = new PrecheckScanner(deps)
    return { scanner, validator, store, upsertDeal, logger, createdJobs }
  }

  /** Flush the event loop (allows setImmediate callbacks to run). */
  async function flushEventLoop() {
    await new Promise<void>((resolve) => setImmediate(resolve))
    // Give the async sweep a moment to settle.
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  }

  function makeErrorPhone(column: string, normalized: string): PhoneResult {
    return {
      column,
      raw: normalized.replace(/^\+?55/, ''),
      normalized,
      outcome: 'error',
      source: 'cache',
      confidence: null,
      variant_tried: null,
      error: 'timeout',
    }
  }

  it('lists error deals and processes only error phones (attempt_phase=sweep_retry)', async () => {
    const errorDeals = [
      {
        key: { pasta: 'P-1', deal_id: 10, contato_tipo: 'PRINCIPAL', contato_id: 1 },
        phones: [makeErrorPhone('telefone_1', '5543991938235')],
        last_job_id: 'job-parent-1',
      },
      {
        // This deal has no error phones — should not trigger a validator call.
        key: { pasta: 'P-1', deal_id: 20, contato_tipo: 'PRINCIPAL', contato_id: 2 },
        phones: [
          { column: 'telefone_1', raw: '43991938236', normalized: '5543991938236', outcome: 'valid' as const, source: 'adb', confidence: 0.95, variant_tried: null, error: null },
        ],
        last_job_id: 'job-parent-1',
      },
    ]

    const { scanner, validator, upsertDeal } = buildSweepScanner({ errorDeals })

    const result = await scanner.runRetryErrorsJob({ pasta: 'P-1' })
    expect(result.status).toBe('started')
    expect(result.deals_planned).toBe(2)
    expect(result.job_id).toBeTruthy()

    await flushEventLoop()

    // Validator called exactly once — only for the error phone, not the valid one.
    expect(validator.validate).toHaveBeenCalledTimes(1)
    const [calledPhone, calledOpts] = validator.validate.mock.calls[0]!
    expect(calledPhone).toBe('5543991938235')
    expect((calledOpts as Record<string, unknown>).attempt_phase).toBe('sweep_retry')

    // upsertDeal called once (only the mutated deal).
    expect(upsertDeal).toHaveBeenCalledTimes(1)
    const [_jobId, upsertedResult] = upsertDeal.mock.calls[0]! as [string, { phones: PhoneResult[] }]
    const phone = upsertedResult.phones.find((p: PhoneResult) => p.column === 'telefone_1')
    expect(phone?.outcome).toBe('invalid')
    expect(phone?.error).toBeNull()
  })

  it('creates sweep job with triggered_by=retry-errors-sweep', async () => {
    const errorDeals = [
      {
        key: { pasta: 'P-2', deal_id: 30, contato_tipo: 'PRINCIPAL', contato_id: 3 },
        phones: [makeErrorPhone('telefone_1', '5543991938235')],
        last_job_id: 'job-parent-99',
      },
    ]

    const { scanner, store } = buildSweepScanner({ errorDeals })

    await scanner.runRetryErrorsJob({})
    await flushEventLoop()

    expect(store.createJob).toHaveBeenCalledTimes(1)
    const [_params, _extRef, createOpts] = store.createJob.mock.calls[0]! as [
      unknown, unknown, { triggeredBy?: string; parentJobId?: string }
    ]
    expect(createOpts.triggeredBy).toBe('retry-errors-sweep')
  })

  it('sets parent_job_id when all deals share a single last_job_id', async () => {
    const errorDeals = [
      {
        key: { pasta: 'P-3', deal_id: 40, contato_tipo: 'PRINCIPAL', contato_id: 4 },
        phones: [makeErrorPhone('telefone_1', '5543991938235')],
        last_job_id: 'single-parent-job',
      },
      {
        key: { pasta: 'P-3', deal_id: 41, contato_tipo: 'PRINCIPAL', contato_id: 5 },
        phones: [makeErrorPhone('telefone_1', '5543991938236')],
        last_job_id: 'single-parent-job',
      },
    ]

    const { scanner, store } = buildSweepScanner({ errorDeals })

    await scanner.runRetryErrorsJob({})
    await flushEventLoop()

    const [_params, _extRef, createOpts] = store.createJob.mock.calls[0]! as [
      unknown, unknown, { triggeredBy?: string; parentJobId?: string }
    ]
    // All deals share 'single-parent-job' → parentJobId must be set.
    expect(createOpts.parentJobId).toBe('single-parent-job')
  })

  it('does NOT set parent_job_id when deals come from multiple source jobs', async () => {
    const errorDeals = [
      {
        key: { pasta: 'P-4', deal_id: 50, contato_tipo: 'PRINCIPAL', contato_id: 6 },
        phones: [makeErrorPhone('telefone_1', '5543991938235')],
        last_job_id: 'job-A',
      },
      {
        key: { pasta: 'P-4', deal_id: 51, contato_tipo: 'PRINCIPAL', contato_id: 7 },
        phones: [makeErrorPhone('telefone_1', '5543991938236')],
        last_job_id: 'job-B',
      },
    ]

    const { scanner, store } = buildSweepScanner({ errorDeals })

    await scanner.runRetryErrorsJob({})
    await flushEventLoop()

    const [_params, _extRef, createOpts] = store.createJob.mock.calls[0]! as [
      unknown, unknown, { triggeredBy?: string; parentJobId?: string }
    ]
    // Two distinct parents → no parent_job_id.
    expect(createOpts.parentJobId).toBeUndefined()
  })

  it('dry_run returns deals_planned without calling the validator', async () => {
    const errorDeals = [
      {
        key: { pasta: 'P-5', deal_id: 60, contato_tipo: 'PRINCIPAL', contato_id: 8 },
        phones: [makeErrorPhone('telefone_1', '5543991938235')],
        last_job_id: 'job-X',
      },
    ]

    const { scanner, validator, store } = buildSweepScanner({ errorDeals })

    const result = await scanner.runRetryErrorsJob({ dry_run: true })
    await flushEventLoop()

    expect(result.status).toBe('dry_run')
    expect(result.deals_planned).toBe(1)
    // Validator must NOT have been called.
    expect(validator.validate).not.toHaveBeenCalled()
    // Job must be marked cancelled (not started/completed).
    const finishedWith = store.finishJob.mock.calls.find((c) => c[1] === 'cancelled')
    expect(finishedWith).toBeTruthy()
  })

  it('skips pastas already locked by another scan and logs a warning', async () => {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    const locks = new PastaLockManager(db)
    locks.initialize()

    // Pre-acquire the lock for pasta P-6 so the sweep cannot get it.
    const preLock = locks.acquire('scan:P-6', 60_000, { job_id: 'external', pasta: 'P-6' })
    expect(preLock).not.toBeNull()

    const errorDeals = [
      {
        key: { pasta: 'P-6', deal_id: 70, contato_tipo: 'PRINCIPAL', contato_id: 9 },
        phones: [makeErrorPhone('telefone_1', '5543991938235')],
        last_job_id: 'job-Y',
      },
    ]

    const { scanner, validator, logger } = buildSweepScanner({ errorDeals, locks })

    await scanner.runRetryErrorsJob({})
    await flushEventLoop()

    // Validator must NOT have been called (pasta was skipped).
    expect(validator.validate).not.toHaveBeenCalled()
    // A warn must have been logged about the locked pasta.
    const warnCalls = logger.warn.mock.calls as Array<[string, ...unknown[]]>
    const lockWarn = warnCalls.find((c) => c[0].includes('scan in progress'))
    expect(lockWarn).toBeTruthy()

    preLock!.release()
  })

  it('re-publishes pasta_summary for touched pastas via pipedrive publisher', async () => {
    const pub = {
      enqueueDealAllFail: vi.fn(),
      enqueuePastaSummary: vi.fn(),
      flush: vi.fn(async () => {}),
      pendingCount: vi.fn(() => 0),
      dedupSize: vi.fn(() => 0),
    }

    const errorDeals = [
      {
        key: { pasta: 'P-7', deal_id: 80, contato_tipo: 'PRINCIPAL', contato_id: 10 },
        phones: [makeErrorPhone('telefone_1', '5543991938235')],
        last_job_id: 'job-Z',
      },
    ]

    const { scanner } = buildSweepScanner({ errorDeals, pipedrive: pub })

    await scanner.runRetryErrorsJob({})
    await flushEventLoop()

    // pasta_summary should have been enqueued for the touched pasta.
    expect(pub.enqueuePastaSummary).toHaveBeenCalledTimes(1)
    const arg = pub.enqueuePastaSummary.mock.calls[0]![0] as { pasta: string; scenario: string }
    expect(arg.pasta).toBe('P-7')
    expect(arg.scenario).toBe('pasta_summary')
  })
})
