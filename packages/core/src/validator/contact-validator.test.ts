import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { ContactRegistry } from '../contacts/contact-registry.js'
import { ContactValidator } from './contact-validator.js'
import type { CheckStrategy, StrategyResult } from '../check-strategies/types.js'

function stubStrategy(
  source: StrategyResult['source'],
  responses: Array<Partial<StrategyResult>>,
): CheckStrategy {
  let i = 0
  return {
    source,
    available: () => true,
    probe: vi.fn(async (variant: string) => {
      const r = responses[Math.min(i++, responses.length - 1)]
      return {
        source,
        result: 'inconclusive',
        confidence: null,
        evidence: null,
        latency_ms: 1,
        variant_tried: variant,
        ...r,
      } as StrategyResult
    }),
  }
}

describe('ContactValidator', () => {
  let db: Database.Database
  let registry: ContactRegistry

  beforeEach(() => {
    db = new Database(':memory:')
    registry = new ContactRegistry(db)
    registry.initialize()
  })

  it('returns cache hit without probing (L1 fast path)', async () => {
    const adb = stubStrategy('adb_probe', [{ result: 'exists', confidence: 0.95 }])
    const waha = stubStrategy('waha', [])
    const cache = stubStrategy('cache', [{ result: 'exists', confidence: 0.95, wa_chat_id: '55...@c.us' }])
    const v = new ContactValidator(registry, adb, waha, cache)
    const res = await v.validate('+5511987654321', { triggered_by: 'pre_check' })

    expect(res.from_cache).toBe(true)
    expect(res.source).toBe('cache')
    expect(adb.probe).not.toHaveBeenCalled()
    expect(waha.probe).not.toHaveBeenCalled()
  })

  it('non-ambiguous DDD 11 — ADB exists finalizes without WAHA', async () => {
    const adb = stubStrategy('adb_probe', [{ result: 'exists', confidence: 0.95 }])
    const waha = stubStrategy('waha', [])
    const cache = stubStrategy('cache', [{ result: 'inconclusive' }])
    const v = new ContactValidator(registry, adb, waha, cache)
    const res = await v.validate('+5511987654321', {
      triggered_by: 'pre_check',
      device_serial: 'poco-1',
    })

    expect(res.exists_on_wa).toBe(1)
    expect(res.source).toBe('adb_probe')
    expect(adb.probe).toHaveBeenCalledTimes(1)
    expect(waha.probe).not.toHaveBeenCalled()
    expect(registry.lookup('5511987654321')?.exists_on_wa).toBe(1)
  })

  it('ambiguous DDD 43 inconclusive → WAHA tiebreaker decides (D8)', async () => {
    const adb = stubStrategy('adb_probe', [
      { result: 'inconclusive' },
      { result: 'not_exists', confidence: 0.95 },
    ])
    const waha = stubStrategy('waha', [{ result: 'exists', confidence: 1.0, wa_chat_id: '554391938235@c.us' }])
    const cache = stubStrategy('cache', [{ result: 'inconclusive' }])
    const v = new ContactValidator(registry, adb, waha, cache)

    const res = await v.validate('+5543991938235', {
      triggered_by: 'hygiene_job:b1',
      device_serial: 'poco-1',
      waha_session: 'acc-05',
    })

    expect(res.source).toBe('waha')
    expect(res.exists_on_wa).toBe(1)
    expect(res.wa_chat_id).toBe('554391938235@c.us')
    expect(adb.probe).toHaveBeenCalledTimes(1) // second variant not tried, WAHA resolved
  })

  it('ambiguous DDD with WAHA unavailable falls through to second ADB variant', async () => {
    const adb = stubStrategy('adb_probe', [
      { result: 'inconclusive' },
      { result: 'exists', confidence: 0.95 },
    ])
    const waha: CheckStrategy = {
      source: 'waha',
      available: () => false,
      probe: vi.fn(),
    }
    const cache = stubStrategy('cache', [{ result: 'inconclusive' }])
    const v = new ContactValidator(registry, adb, waha, cache)

    const res = await v.validate('+5543991938235', {
      triggered_by: 'pre_check',
      device_serial: 'poco-1',
    })

    expect(res.source).toBe('adb_probe')
    expect(res.exists_on_wa).toBe(1)
    expect(waha.probe).not.toHaveBeenCalled()
    expect(adb.probe).toHaveBeenCalledTimes(2)
  })

  it('records each strategy result in the registry audit trail', async () => {
    const adb = stubStrategy('adb_probe', [{ result: 'not_exists', confidence: 0.95 }])
    const waha = stubStrategy('waha', [])
    const cache = stubStrategy('cache', [{ result: 'inconclusive' }])
    const v = new ContactValidator(registry, adb, waha, cache)

    await v.validate('+5511987654321', {
      triggered_by: 'hygiene_job:b2',
      device_serial: 'poco-1',
    })
    const history = registry.history('5511987654321')
    expect(history).toHaveLength(1)
    expect(history[0].source).toBe('adb_probe')
    expect(history[0].triggered_by).toBe('hygiene_job:b2')
  })
})
