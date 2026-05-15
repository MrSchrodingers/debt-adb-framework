import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { OperatorAlerts } from './operator-alerts.js'
import { initSdrSchema } from './db/migrations.js'

describe('OperatorAlerts', () => {
  let db: Database.Database
  let alerts: OperatorAlerts

  beforeEach(() => {
    db = new Database(':memory:')
    initSdrSchema(db)
    alerts = new OperatorAlerts(db)
  })

  afterEach(() => db.close())

  it('raises a new alert and returns a stable id', () => {
    const id = alerts.raise({
      tenant: 'oralsin-sdr',
      leadId: 'L1',
      messageId: 'M1',
      responseText: 'sei la',
      reason: 'classifier_ambiguous',
      llmReason: 'low_conf',
    })
    expect(id).toBeTruthy()
    expect(alerts.countUnresolved()).toBe(1)
  })

  it('is idempotent per (lead, message, reason)', () => {
    const a = alerts.raise({
      tenant: 't',
      leadId: 'L1',
      messageId: 'M1',
      responseText: 'x',
      reason: 'classifier_ambiguous',
    })
    const b = alerts.raise({
      tenant: 't',
      leadId: 'L1',
      messageId: 'M1',
      responseText: 'x',
      reason: 'classifier_ambiguous',
    })
    expect(b).toBe(a)
    expect(alerts.countUnresolved()).toBe(1)
  })

  it('different reasons on the same message raise distinct alerts', () => {
    const a = alerts.raise({ tenant: 't', leadId: 'L1', messageId: 'M1', responseText: 'x', reason: 'r1' })
    const b = alerts.raise({ tenant: 't', leadId: 'L1', messageId: 'M1', responseText: 'x', reason: 'r2' })
    expect(b).not.toBe(a)
    expect(alerts.countUnresolved()).toBe(2)
  })

  it('resolve marks resolved_at and resolution', () => {
    const id = alerts.raise({ tenant: 't', leadId: 'L1', messageId: 'M1', responseText: 'x', reason: 'r1' })
    expect(alerts.resolve(id, 'manual:interested')).toBe(true)
    expect(alerts.countUnresolved()).toBe(0)
  })

  it('resolve is a no-op on an already-resolved alert', () => {
    const id = alerts.raise({ tenant: 't', leadId: 'L1', messageId: 'M1', responseText: 'x', reason: 'r1' })
    alerts.resolve(id, 'manual:interested')
    expect(alerts.resolve(id, 'again')).toBe(false)
  })

  it('listUnresolved returns rows in ascending raised_at order', () => {
    alerts.raise({ tenant: 't', leadId: 'L1', messageId: 'M1', responseText: 'a', reason: 'r1' })
    alerts.raise({ tenant: 't', leadId: 'L2', messageId: 'M2', responseText: 'b', reason: 'r1' })
    const rows = alerts.listUnresolved()
    expect(rows).toHaveLength(2)
    expect(rows[0].lead_id).toBe('L1')
  })
})
