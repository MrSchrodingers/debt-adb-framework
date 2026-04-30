import Database from 'better-sqlite3'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { QualityHistory } from './quality-history.js'
import { QualityWatcher } from './quality-watcher.js'
import type { QualityScoreInputs } from './quality-score.js'
import type { QualityScoreComponents } from './quality-score.js'

interface CapturedAction {
  type: 'pause' | 'alert'
  phone?: string
  reason?: string
  payload?: unknown
}

interface Stub {
  composer: ReturnType<typeof vi.fn>
  pauseSender: ReturnType<typeof vi.fn>
  isPaused: ReturnType<typeof vi.fn>
  alert: ReturnType<typeof vi.fn>
  listSenders: ReturnType<typeof vi.fn>
  actions: CapturedAction[]
}

function makeStub(returns: { senders?: string[]; isPaused?: boolean }): Stub {
  const actions: CapturedAction[] = []
  return {
    composer: vi.fn(),
    listSenders: vi.fn(() => returns.senders ?? ['551111']),
    isPaused: vi.fn(() => returns.isPaused ?? false),
    pauseSender: vi.fn((phone: string, reason?: string) => {
      actions.push({ type: 'pause', phone, reason })
    }),
    alert: vi.fn((payload: unknown) => {
      actions.push({ type: 'alert', payload })
    }),
    actions,
  }
}

function inputs(overrides: Partial<QualityScoreInputs> = {}): QualityScoreInputs {
  return {
    ackReadRatio: 0.9,
    ackFleetMedianReadRatio: 0.85,
    daysSinceLastBan: null,
    accountAgeDays: 120,
    warmupTier: 4,
    warmupTierMax: 4,
    volumeToday: 100,
    volumeDailyCap: 100,
    daysSinceFingerprintRotation: 7,
    fingerprintTtlDays: 30,
    inboundLast7d: 50,
    outboundLast7d: 200,
    ...overrides,
  }
}

describe('QualityWatcher', () => {
  let db: Database.Database
  let history: QualityHistory
  let stub: Stub
  let watcher: QualityWatcher

  beforeEach(() => {
    db = new Database(':memory:')
    history = new QualityHistory(db)
    history.initialize()
    stub = makeStub({ senders: ['551111'] })
    stub.composer.mockReturnValue(inputs())
    watcher = new QualityWatcher({
      history,
      composer: stub.composer as unknown as (sender: string) => QualityScoreInputs,
      listSenders: stub.listSenders as unknown as () => string[],
      pauseSender: stub.pauseSender as unknown as (phone: string, reason: string) => void,
      isPaused: stub.isPaused as unknown as (phone: string) => boolean,
      alert: stub.alert as unknown as (e: { kind: string; senderPhone: string; total: number; reason: string }) => void,
      thresholds: { absolute: 40, deltaWindow24h: -30 },
    })
  })

  it('persists a sample for each sender on tick', () => {
    watcher.tick()
    const got = history.latest('551111')
    expect(got).not.toBeNull()
  })

  it('does not pause healthy senders (score >= 40, no big delta)', () => {
    watcher.tick()
    expect(stub.pauseSender).not.toHaveBeenCalled()
  })

  it('pauses sender when score below absolute threshold', () => {
    stub.composer.mockReturnValue(
      inputs({ ackReadRatio: 0.05, daysSinceLastBan: 1, accountAgeDays: 1, warmupTier: 1 }),
    )
    watcher.tick()
    expect(stub.pauseSender).toHaveBeenCalledWith('551111', expect.stringMatching(/score|quality/i))
    expect(stub.alert).toHaveBeenCalled()
    const alertPayload = stub.alert.mock.calls[0][0] as { kind: string }
    expect(alertPayload.kind).toBe('low_score')
  })

  it('pauses sender on delta drop > -30 in 24h', () => {
    history.record({
      senderPhone: '551111',
      total: 80,
      components: {} as QualityScoreComponents,
      computedAt: new Date(Date.now() - 25 * 3_600_000).toISOString().replace('T', ' ').slice(0, 19),
    })
    stub.composer.mockReturnValue(
      inputs({ ackReadRatio: 0.1, daysSinceLastBan: 3, inboundLast7d: 0 }),
    )
    watcher.tick()
    expect(stub.pauseSender).toHaveBeenCalled()
    const alertPayload = stub.alert.mock.calls[0][0] as { kind: string }
    expect(alertPayload.kind).toBe('rapid_decline')
  })

  it('idempotent: does not double-alert if sender already paused', () => {
    stub.isPaused.mockReturnValue(true)
    stub.composer.mockReturnValue(inputs({ ackReadRatio: 0.05, accountAgeDays: 1, warmupTier: 1 }))
    watcher.tick()
    expect(stub.pauseSender).not.toHaveBeenCalled()
    expect(stub.alert).not.toHaveBeenCalled()
  })

  it('persists components_json with full breakdown', () => {
    watcher.tick()
    const sample = history.latest('551111')!
    expect(sample.components.ackRate).toBeGreaterThan(0)
    expect(sample.components.banHistory).toBe(1)
  })

  it('processes multiple senders independently', () => {
    stub.listSenders.mockReturnValue(['551111', '552222', '553333'])
    stub.composer.mockImplementation((phone: string) => {
      if (phone === '551111') {
        return inputs({ ackReadRatio: 0.05, daysSinceLastBan: 1, accountAgeDays: 1, warmupTier: 1 })
      }
      if (phone === '552222') return inputs()
      return inputs({ ackReadRatio: 0.95 })
    })
    watcher.tick()
    expect(stub.pauseSender).toHaveBeenCalledTimes(1)
    expect(stub.pauseSender).toHaveBeenCalledWith('551111', expect.any(String))
    // All three persisted
    expect(history.latest('551111')).not.toBeNull()
    expect(history.latest('552222')).not.toBeNull()
    expect(history.latest('553333')).not.toBeNull()
  })

  it('continues after composer throws for one sender', () => {
    stub.listSenders.mockReturnValue(['551111', '552222'])
    let calls = 0
    stub.composer.mockImplementation((phone: string) => {
      calls++
      if (phone === '551111') throw new Error('boom')
      return inputs()
    })
    watcher.tick()
    expect(calls).toBe(2)
    expect(history.latest('552222')).not.toBeNull()
    expect(history.latest('551111')).toBeNull()
  })
})
