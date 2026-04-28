import { describe, it, expect, beforeEach } from 'vitest'
import { createRequire } from 'node:module'
import { AckPersistFailures } from './ack-persist-failures.js'

const require = createRequire(import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require('better-sqlite3') as typeof import('better-sqlite3').default

describe('AckPersistFailures', () => {
  let db: import('better-sqlite3').Database
  let store: AckPersistFailures

  beforeEach(() => {
    db = new Database(':memory:')
    store = new AckPersistFailures(db)
    store.initialize()
  })

  it('initialize() is idempotent', () => {
    expect(() => store.initialize()).not.toThrow()
  })

  it('insert() returns a non-empty id and persists the row', () => {
    const id = store.insert({ wahaMessageId: 'wa-1', ackLevel: 3, error: 'boom' })
    expect(id).toBeTruthy()
    const recent = store.recentSince(Date.now() - 60_000, 10)
    expect(recent).toHaveLength(1)
    expect(recent[0].wahaMessageId).toBe('wa-1')
    expect(recent[0].ackLevel).toBe(3)
    expect(recent[0].error).toBe('boom')
  })

  it('countSince() counts only rows newer than the cutoff', () => {
    store.insert({ wahaMessageId: 'wa-1', ackLevel: 1, error: 'e1' })
    store.insert({ wahaMessageId: 'wa-2', ackLevel: 2, error: 'e2' })
    expect(store.countSince(Date.now() - 60_000)).toBe(2)
    // 1 hour into the future — no rows should match
    expect(store.countSince(Date.now() + 3_600_000)).toBe(0)
  })

  it('recentSince() returns rows newest-first and respects limit', () => {
    store.insert({ wahaMessageId: 'wa-1', ackLevel: 1, error: 'e1' })
    store.insert({ wahaMessageId: 'wa-2', ackLevel: 2, error: 'e2' })
    store.insert({ wahaMessageId: 'wa-3', ackLevel: 3, error: 'e3' })
    const list = store.recentSince(Date.now() - 60_000, 2)
    expect(list).toHaveLength(2)
    // Inserted last should appear first under DESC order
    expect(list[0].wahaMessageId).toBe('wa-3')
  })
})
