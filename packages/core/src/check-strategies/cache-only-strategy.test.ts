import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { ContactRegistry } from '../contacts/contact-registry.js'
import { CacheOnlyStrategy } from './cache-only-strategy.js'

describe('CacheOnlyStrategy', () => {
  let db: Database.Database
  let registry: ContactRegistry
  let strat: CacheOnlyStrategy

  beforeEach(() => {
    db = new Database(':memory:')
    registry = new ContactRegistry(db)
    registry.initialize()
    strat = new CacheOnlyStrategy(registry)
  })

  it('returns inconclusive on cache miss', async () => {
    const r = await strat.probe('5543991938235')
    expect(r.result).toBe('inconclusive')
    expect((r.evidence as { lookup: string }).lookup).toBe('miss')
  })

  it('returns exists when registry knows the phone as valid', async () => {
    registry.record('5543991938235', {
      phone_input: '+5543991938235',
      phone_variant_tried: '5543991938235',
      source: 'adb_probe',
      result: 'exists',
      confidence: 0.95,
      evidence: null,
      device_serial: 'poco-1',
      waha_session: null,
      triggered_by: 'pre_check',
      latency_ms: 4000,
      ddd: '43',
      wa_chat_id: '5543991938235@c.us',
    })
    const r = await strat.probe('5543991938235')
    expect(r.result).toBe('exists')
    expect(r.wa_chat_id).toBe('5543991938235@c.us')
    expect(r.confidence).toBe(0.95)
  })

  it('returns not_exists when registry has it as invalid', async () => {
    registry.record('554399999001', {
      phone_input: '554399999001',
      phone_variant_tried: '554399999001',
      source: 'adb_probe',
      result: 'not_exists',
      confidence: 0.95,
      evidence: null,
      device_serial: 'poco-1',
      waha_session: null,
      triggered_by: 'hygiene_job:b1',
      latency_ms: 4200,
      ddd: '43',
    })
    const r = await strat.probe('554399999001')
    expect(r.result).toBe('not_exists')
  })
})
