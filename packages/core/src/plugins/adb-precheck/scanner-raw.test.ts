import { describe, it, expect, vi } from 'vitest'
import Database from 'better-sqlite3'
import { PrecheckScanner } from './scanner.js'
import { PrecheckJobStore } from './job-store.js'
import { ContactRegistry } from '../../contacts/contact-registry.js'
import { ContactValidator } from '../../validator/contact-validator.js'
import { CacheOnlyStrategy } from '../../check-strategies/cache-only-strategy.js'

describe('PrecheckScanner — raw mode skips writebacks', () => {
  it('does NOT call applyDealInvalidation when tenant is raw', async () => {
    const db = new Database(':memory:')
    const registry = new ContactRegistry(db)
    registry.initialize()
    const store = new PrecheckJobStore(db)
    store.initialize()
    const cache = new CacheOnlyStrategy(registry)
    const validator = new ContactValidator(registry, undefined, undefined, cache)

    const applyInvalidation = vi.fn()
    const applyLocalization = vi.fn()
    const recordInvalidPhone = vi.fn()
    const archiveDealIfEmpty = vi.fn()
    const writeLocalizado = vi.fn()
    const pg = {
      iterateDeals: async function* () {
        yield [
          {
            pasta: 'p1', deal_id: 1, contato_tipo: 'person', contato_id: 1,
            contato_nome: 'X', contato_relacao: 'principal',
            stage_nome: 's', pipeline_nome: 'p', update_time: null,
            whatsapp_hot: '5543991234567', telefone_hot_1: null, telefone_hot_2: null,
            telefone_1: null, telefone_2: null, telefone_3: null,
            telefone_4: null, telefone_5: null, telefone_6: null,
            localizado: false, telefone_localizado: null,
          },
        ]
      },
      countPool: async () => -1,
      applyDealInvalidation: applyInvalidation,
      applyDealLocalization: applyLocalization,
      healthcheck: async () => ({ ok: true, server_time: '' }),
      close: async () => {},
      writeInvalid: vi.fn(),
      clearInvalidPhone: vi.fn(),
      clearLocalizadoIfMatches: vi.fn(),
      recordInvalidPhone,
      archiveDealIfEmpty,
      writeLocalizado,
      lookupDeals: vi.fn(),
    }

    const scanner = new PrecheckScanner({
      pg: pg as never,
      store,
      validator,
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      shouldCancel: () => false,
      tenant: 'sicoob',
      tenantMode: 'raw',
    } as never)

    const job = store.createJob({ limit: 1, writeback_invalid: false, hygienization_mode: false, tenant: 'sicoob' }, 'ext_x', { pipedriveEnabled: false, hygienizationMode: false, tenant: 'sicoob' })
    await scanner.runJob(job.id, { limit: 1, writeback_invalid: false, hygienization_mode: false, tenant: 'sicoob' })

    expect(applyInvalidation).not.toHaveBeenCalled()
    expect(applyLocalization).not.toHaveBeenCalled()
    expect(recordInvalidPhone).not.toHaveBeenCalled()
    expect(archiveDealIfEmpty).not.toHaveBeenCalled()
    expect(writeLocalizado).not.toHaveBeenCalled()
  })
})
