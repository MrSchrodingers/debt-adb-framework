import { describe, it, expect, vi } from 'vitest'
import { PrecheckScanner } from './scanner.js'
import type { ScannerDeps } from './scanner.js'
import type { ProvConsultaRow } from './types.js'

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
  }
}

function buildScanner(
  rows: ProvConsultaRow[],
  validateImpl: (phone: string) => unknown,
  opts: {
    cachedScans?: Map<string, string> // dealKey -> ISO scanned_at
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
  }
  const validator = { validate: vi.fn(async (p: string) => validateImpl(p)) }
  const store = {
    markStarted: vi.fn(),
    upsertDeal: vi.fn(),
    bumpProgress: vi.fn(),
    finishJob: vi.fn(),
    getDealLastScannedAt: vi.fn((k: { pasta: string; deal_id: number; contato_tipo: string; contato_id: number }) => {
      const id = `${k.pasta}|${k.deal_id}|${k.contato_tipo}|${k.contato_id}`
      return cachedScans.get(id) ?? null
    }),
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

    expect(pg.recordInvalidPhone).toHaveBeenCalledTimes(1)
    const [key, record] = pg.recordInvalidPhone.mock.calls[0]!
    expect(key).toEqual({ pasta: 'PASTA-001', deal_id: 42, contato_tipo: 'PRINCIPAL', contato_id: 7 })
    expect(record).toMatchObject({
      telefone: '5543991938235',
      motivo: 'whatsapp_nao_existe',
      colunaOrigem: 'telefone_1',
      invalidadoPor: 'dispatch_adb_precheck',
      jobId: 'job-X',
      confidence: 0.93,
    })
  })

  it('calls archiveDealIfEmpty with motivo=todos_telefones_invalidos when no valid phone survived', async () => {
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

    expect(pg.writeInvalid).toHaveBeenCalledOnce()
    expect(pg.archiveDealIfEmpty).toHaveBeenCalledWith(
      expect.objectContaining({ deal_id: 42 }),
      'todos_telefones_invalidos',
    )
  })

  it('does NOT archive when at least one phone is valid', async () => {
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

    expect(pg.recordInvalidPhone).toHaveBeenCalledTimes(1)
    expect(pg.archiveDealIfEmpty).not.toHaveBeenCalled()
    expect(pg.writeInvalid).not.toHaveBeenCalled()
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

    expect(pg.recordInvalidPhone).not.toHaveBeenCalled()
    expect(pg.archiveDealIfEmpty).not.toHaveBeenCalled()
    expect(pg.clearInvalidPhone).not.toHaveBeenCalled()
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
    pg.archiveDealIfEmpty.mockResolvedValueOnce(true) // first call returns archived

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
    pg.archiveDealIfEmpty.mockResolvedValueOnce(false)

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
