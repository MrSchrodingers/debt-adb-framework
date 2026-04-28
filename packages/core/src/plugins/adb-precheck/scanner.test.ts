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
  }
  validator: { validate: ReturnType<typeof vi.fn> }
  store: {
    markStarted: ReturnType<typeof vi.fn>
    upsertDeal: ReturnType<typeof vi.fn>
    bumpProgress: ReturnType<typeof vi.fn>
    finishJob: ReturnType<typeof vi.fn>
  }
}

function buildScanner(rows: ProvConsultaRow[], validateImpl: (phone: string) => unknown): FakeDeps {
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
