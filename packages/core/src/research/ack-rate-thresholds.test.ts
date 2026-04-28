import { describe, it, expect, beforeEach } from 'vitest'
import { createRequire } from 'node:module'
import { AckRateThresholds } from './ack-rate-thresholds.js'

const require = createRequire(import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require('better-sqlite3') as typeof import('better-sqlite3').default

describe('AckRateThresholds', () => {
  let db: import('better-sqlite3').Database
  let store: AckRateThresholds

  beforeEach(() => {
    db = new Database(':memory:')
    store = new AckRateThresholds(db)
    store.initialize()
  })

  it('initialize() is idempotent', () => {
    expect(() => store.initialize()).not.toThrow()
  })

  it('apply() rejects threshold outside [0, 1]', () => {
    expect(() =>
      store.apply({ senderPhone: '5511999', threshold: -0.1, windowMs: 3_600_000 }),
    ).toThrow(/threshold/)
    expect(() =>
      store.apply({ senderPhone: '5511999', threshold: 1.5, windowMs: 3_600_000 }),
    ).toThrow(/threshold/)
  })

  it('apply() rejects non-positive windowMs', () => {
    expect(() =>
      store.apply({ senderPhone: '5511999', threshold: 0.5, windowMs: 0 }),
    ).toThrow(/windowMs/)
  })

  it('apply() persists a new active threshold for a sender', () => {
    const id = store.apply({ senderPhone: '5511999', threshold: 0.4, windowMs: 3_600_000 })
    expect(id).toBeTruthy()

    const active = store.getActive('5511999')
    expect(active).not.toBeNull()
    expect(active?.id).toBe(id)
    expect(active?.threshold).toBe(0.4)
    expect(active?.windowMs).toBe(3_600_000)
    expect(active?.appliedBy).toBe('operator')
    expect(active?.supersededBy).toBeNull()
  })

  it('apply() supersedes the previous active row for the same sender', () => {
    const oldId = store.apply({ senderPhone: '5511999', threshold: 0.4, windowMs: 3_600_000 })
    const newId = store.apply({ senderPhone: '5511999', threshold: 0.6, windowMs: 7_200_000 })

    const active = store.getActive('5511999')
    expect(active?.id).toBe(newId)
    expect(active?.threshold).toBe(0.6)

    const history = store.history('5511999')
    expect(history).toHaveLength(2)
    const oldRow = history.find((r) => r.id === oldId)
    expect(oldRow?.supersededBy).toBe(newId)
  })

  it('apply() does NOT touch other senders when superseding', () => {
    store.apply({ senderPhone: '5511111', threshold: 0.3, windowMs: 3_600_000 })
    const otherId = store.apply({ senderPhone: '5522222', threshold: 0.7, windowMs: 3_600_000 })
    store.apply({ senderPhone: '5511111', threshold: 0.4, windowMs: 3_600_000 })

    const otherActive = store.getActive('5522222')
    expect(otherActive?.id).toBe(otherId)
    expect(otherActive?.supersededBy).toBeNull()
  })

  it('listActive() returns one row per sender', () => {
    store.apply({ senderPhone: '5511111', threshold: 0.3, windowMs: 3_600_000 })
    store.apply({ senderPhone: '5511111', threshold: 0.4, windowMs: 3_600_000 })
    store.apply({ senderPhone: '5522222', threshold: 0.5, windowMs: 3_600_000 })

    const list = store.listActive()
    expect(list).toHaveLength(2)
    const senders = list.map((r) => r.senderPhone).sort()
    expect(senders).toEqual(['5511111', '5522222'])
  })

  it('records appliedBy when supplied', () => {
    store.apply({ senderPhone: '5511999', threshold: 0.4, windowMs: 3_600_000, appliedBy: 'alice' })
    const active = store.getActive('5511999')
    expect(active?.appliedBy).toBe('alice')
  })

  it('getActive() returns null for unknown sender', () => {
    expect(store.getActive('nope')).toBeNull()
  })
})
