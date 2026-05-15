import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { PendingWritebacks } from './pending-writebacks.js'
import { initSdrSchema } from '../db/migrations.js'

const T0 = Date.UTC(2026, 4, 14, 15, 0)

describe('PendingWritebacks', () => {
  let db: Database.Database
  let wb: PendingWritebacks

  beforeEach(() => {
    db = new Database(':memory:')
    initSdrSchema(db)
    wb = new PendingWritebacks(db, () => T0)
  })

  afterEach(() => db.close())

  it('enqueue inserts a row with attempts=0 and next_attempt_at=now', () => {
    const id = wb.enqueue({
      tenant: 'oralsin-sdr',
      leadId: 'L1',
      action: 'update_stage',
      payload: { stage_id: 6, deal_id: 100 },
    })
    expect(id).toBeTruthy()
    const due = wb.duePending()
    expect(due).toHaveLength(1)
    expect(due[0].attempts).toBe(0)
    expect(due[0].abandoned_at).toBeNull()
  })

  it('recordSuccess deletes the row', () => {
    const id = wb.enqueue({ tenant: 't', leadId: 'L1', action: 'add_note', payload: { content: 'x' } })
    wb.recordSuccess(id)
    expect(wb.duePending()).toHaveLength(0)
  })

  it('recordFailure applies exponential backoff', () => {
    const id = wb.enqueue({ tenant: 't', leadId: 'L1', action: 'add_note', payload: {} })
    const r1 = wb.recordFailure(id, 'err1')
    expect(r1.abandoned).toBe(false)
    // Next attempt should be +1 minute.
    expect(Date.parse(r1.nextAttemptAt) - T0).toBe(60_000)

    // Backoff grows.
    const r2 = wb.recordFailure(id, 'err2')
    expect(r2.abandoned).toBe(false)
    expect(Date.parse(r2.nextAttemptAt) - T0).toBe(5 * 60_000)
  })

  it('recordFailure abandons after the last backoff slot', () => {
    const id = wb.enqueue({ tenant: 't', leadId: 'L1', action: 'add_note', payload: {} })
    // Schedule: BACKOFF_MIN has 6 entries; the 6th failure abandons.
    for (let i = 0; i < 5; i++) {
      wb.recordFailure(id, `err${i}`)
    }
    const last = wb.recordFailure(id, 'final')
    expect(last.abandoned).toBe(true)
  })

  it('duePending returns only rows whose next_attempt_at has elapsed', () => {
    const future = new Database(':memory:')
    initSdrSchema(future)
    const wbF = new PendingWritebacks(future, () => T0)
    const id = wbF.enqueue({ tenant: 't', leadId: 'L1', action: 'add_note', payload: {} })
    // Push next_attempt_at into the future.
    future
      .prepare(`UPDATE sdr_pending_writebacks SET next_attempt_at = ? WHERE id = ?`)
      .run(new Date(T0 + 60_000).toISOString(), id)
    expect(wbF.duePending()).toHaveLength(0)
    future.close()
  })

  it('duePending excludes abandoned rows', () => {
    const id = wb.enqueue({ tenant: 't', leadId: 'L1', action: 'add_note', payload: {} })
    db.prepare(`UPDATE sdr_pending_writebacks SET abandoned_at = ? WHERE id = ?`).run(new Date(T0).toISOString(), id)
    expect(wb.duePending()).toHaveLength(0)
  })
})
