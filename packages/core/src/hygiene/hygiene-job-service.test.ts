import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { HygieneJobService } from './hygiene-job-service.js'
import { HygieneJobConflictError } from './types.js'

describe('HygieneJobService', () => {
  let db: Database.Database
  let svc: HygieneJobService

  beforeEach(() => {
    db = new Database(':memory:')
    svc = new HygieneJobService(db)
    svc.initialize()
  })

  const baseLgpd = {
    lawful_basis: 'legitimate_interest' as const,
    purpose: 'debt-recovery hygiene',
    data_controller: 'Debt Oralsin CNPJ 00.000.000/0001-00',
  }

  it('create inserts job + items and returns job_id', () => {
    const result = svc.create({
      plugin_name: 'adb-debt',
      external_ref: 'batch-001',
      lgpd: baseLgpd,
      items: [
        { phone_input: '+5543991938235', external_id: 'deal-1' },
        { phone_input: '+5511987654321', external_id: 'deal-2' },
      ],
    })
    expect(result.deduplicated).toBe(false)
    expect(result.total_items).toBe(2)
    expect(result.status).toBe('queued')

    const job = svc.get(result.job_id)
    expect(job?.total_items).toBe(2)
    expect(job?.lawful_basis).toBe('legitimate_interest')

    const items = svc.getItems(result.job_id)
    expect(items).toHaveLength(2)
    expect(items[0].status).toBe('pending')
  })

  it('create is idempotent on (plugin_name, external_ref) — D9', () => {
    const input = {
      plugin_name: 'adb-debt',
      external_ref: 'batch-001',
      lgpd: baseLgpd,
      items: [{ phone_input: '+5543991938235' }],
    }
    const first = svc.create(input)
    const second = svc.create(input)

    expect(second.deduplicated).toBe(true)
    expect(second.job_id).toBe(first.job_id)
    expect(svc.getItems(first.job_id)).toHaveLength(1)
  })

  it('create throws HygieneJobConflictError when external_ref matches but items differ — D9', () => {
    svc.create({
      plugin_name: 'adb-debt',
      external_ref: 'batch-001',
      lgpd: baseLgpd,
      items: [{ phone_input: '+5543991938235' }],
    })

    expect(() =>
      svc.create({
        plugin_name: 'adb-debt',
        external_ref: 'batch-001',
        lgpd: baseLgpd,
        items: [{ phone_input: '+5543991938235' }, { phone_input: '+5511987654321' }],
      }),
    ).toThrow(HygieneJobConflictError)
  })

  it('cancel flips status to cancelled', () => {
    const { job_id } = svc.create({
      plugin_name: 'adb-debt',
      lgpd: baseLgpd,
      items: [{ phone_input: '+5543991938235' }],
    })
    expect(svc.cancel(job_id)).toBe(true)
    expect(svc.get(job_id)?.status).toBe('cancelled')
    expect(svc.cancel(job_id)).toBe(false)
  })

  it('list filters by plugin_name and status', () => {
    svc.create({ plugin_name: 'adb-debt', lgpd: baseLgpd, items: [{ phone_input: '+5543991938235' }] })
    svc.create({ plugin_name: 'oralsin', lgpd: baseLgpd, items: [{ phone_input: '+5511987654321' }] })

    expect(svc.list({ plugin_name: 'adb-debt' })).toHaveLength(1)
    expect(svc.list({ plugin_name: 'oralsin' })).toHaveLength(1)
    expect(svc.list({ status: 'queued' })).toHaveLength(2)
  })
})
