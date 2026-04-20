import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { ContactRegistry } from './contact-registry.js'

describe('ContactRegistry', () => {
  let db: Database.Database
  let registry: ContactRegistry

  beforeEach(() => {
    db = new Database(':memory:')
    registry = new ContactRegistry(db)
    registry.initialize()
  })

  it('lookup returns null for an unknown phone (T6)', () => {
    expect(registry.lookup('5543991938235')).toBeNull()
  })

  it('record inserts rows in both wa_contacts and wa_contact_checks (T7)', () => {
    const result = registry.record('5543991938235', {
      phone_input: '+5543991938235',
      phone_variant_tried: '5543991938235',
      source: 'adb_probe',
      result: 'exists',
      confidence: 0.95,
      evidence: { uiautomator_snippet: '<EditText ...>', has_input_field: true },
      device_serial: 'poco-c71-01',
      waha_session: null,
      triggered_by: 'pre_check',
      latency_ms: 4500,
      ddd: '43',
      wa_chat_id: '5543991938235@c.us',
    })

    expect(result.checkId).toMatch(/.+/)

    const contactRow = db
      .prepare('SELECT * FROM wa_contacts WHERE phone_normalized = ?')
      .get('5543991938235') as { phone_normalized: string; exists_on_wa: number }
    expect(contactRow.phone_normalized).toBe('5543991938235')
    expect(contactRow.exists_on_wa).toBe(1)

    const checkRow = db
      .prepare('SELECT * FROM wa_contact_checks WHERE id = ?')
      .get(result.checkId) as { source: string; result: string }
    expect(checkRow.source).toBe('adb_probe')
    expect(checkRow.result).toBe('exists')
  })

  it('lookup after record returns the stored state (T8)', () => {
    const { checkId } = registry.record('5543991938235', {
      phone_input: '+5543991938235',
      phone_variant_tried: '5543991938235',
      source: 'waha',
      result: 'exists',
      confidence: 1.0,
      evidence: { numberExists: true },
      device_serial: null,
      waha_session: 'acc-11',
      triggered_by: 'pre_check',
      latency_ms: 289,
      ddd: '43',
      wa_chat_id: '5543991938235@c.us',
    })

    const contact = registry.lookup('5543991938235')
    expect(contact).not.toBeNull()
    expect(contact!.phone_normalized).toBe('5543991938235')
    expect(contact!.exists_on_wa).toBe(1)
    expect(contact!.wa_chat_id).toBe('5543991938235@c.us')
    expect(contact!.last_check_source).toBe('waha')
    expect(contact!.last_check_confidence).toBe(1.0)
    expect(contact!.last_check_id).toBe(checkId)
    expect(contact!.check_count).toBe(1)
    expect(contact!.ddd).toBe('43')
  })

  it('record(result=not_exists) sets recheck_due_at to NULL — D1 permanent (T9)', () => {
    registry.record('554399999001', {
      phone_input: '554399999001',
      phone_variant_tried: '554399999001',
      source: 'adb_probe',
      result: 'not_exists',
      confidence: 0.95,
      evidence: { has_invite_cta: true },
      device_serial: 'poco-c71-03',
      waha_session: null,
      triggered_by: 'hygiene_job:batch-001',
      latency_ms: 4800,
      ddd: '43',
    })

    const row = db
      .prepare('SELECT exists_on_wa, recheck_due_at FROM wa_contacts WHERE phone_normalized = ?')
      .get('554399999001') as { exists_on_wa: number; recheck_due_at: string | null }

    expect(row.exists_on_wa).toBe(0)
    expect(row.recheck_due_at).toBeNull()
  })

  it('history preserves all records — append-only (T10)', () => {
    const base = {
      phone_input: '+5543991938235',
      phone_variant_tried: '5543991938235',
      device_serial: 'poco-c71-01',
      waha_session: null,
      triggered_by: 'pre_check' as const,
      confidence: 0.95,
      evidence: null,
      latency_ms: 4500,
      ddd: '43',
    }
    registry.record('5543991938235', { ...base, source: 'adb_probe', result: 'exists' })
    registry.record('5543991938235', { ...base, source: 'send_success', result: 'exists' })

    const history = registry.history('5543991938235')
    expect(history).toHaveLength(2)
    expect(history.map((h) => h.source).sort()).toEqual(['adb_probe', 'send_success'])
  })

  it('history is ordered by checked_at DESC (T11)', async () => {
    const base = {
      phone_input: '+5543991938235',
      phone_variant_tried: '5543991938235',
      device_serial: 'poco-c71-01',
      waha_session: null,
      triggered_by: 'pre_check' as const,
      confidence: 0.95,
      evidence: null,
      latency_ms: 4500,
      ddd: '43',
    }
    registry.record('5543991938235', { ...base, source: 'send_success_backfill', result: 'exists' })
    await new Promise((r) => setTimeout(r, 10))
    registry.record('5543991938235', { ...base, source: 'adb_probe', result: 'exists' })
    await new Promise((r) => setTimeout(r, 10))
    registry.record('5543991938235', { ...base, source: 'waha', result: 'exists' })

    const history = registry.history('5543991938235')
    expect(history[0].source).toBe('waha')
    expect(history[1].source).toBe('adb_probe')
    expect(history[2].source).toBe('send_success_backfill')
  })

  it('forceRecheckDue adds manual_recheck check without altering exists_on_wa (T12)', () => {
    registry.record('554399999001', {
      phone_input: '554399999001',
      phone_variant_tried: '554399999001',
      source: 'adb_probe',
      result: 'not_exists',
      confidence: 0.95,
      evidence: null,
      device_serial: 'poco-c71-03',
      waha_session: null,
      triggered_by: 'hygiene_job:batch-001',
      latency_ms: 4800,
      ddd: '43',
    })

    const before = registry.lookup('554399999001')
    expect(before!.exists_on_wa).toBe(0)

    registry.forceRecheckDue('554399999001', 'operador viu número ativo em outra fonte')

    const after = registry.lookup('554399999001')
    expect(after!.exists_on_wa).toBe(0) // preserved
    expect(after!.recheck_due_at).not.toBeNull()

    const manualChecks = registry
      .history('554399999001')
      .filter((c) => c.source === 'manual_recheck')
    expect(manualChecks).toHaveLength(1)
    const evidence = JSON.parse(manualChecks[0].evidence ?? '{}') as { reason: string }
    expect(evidence.reason).toMatch(/operador/)
  })

  it('forceRecheckDue on unknown phone throws and creates no orphan check (I1)', () => {
    expect(() => registry.forceRecheckDue('999999999999', 'test')).toThrow(/unknown phone/i)
    const orphanChecks = db
      .prepare('SELECT COUNT(*) AS n FROM wa_contact_checks WHERE phone_normalized = ?')
      .get('999999999999') as { n: number }
    expect(orphanChecks.n).toBe(0)
  })

  it('record with decisive result clears recheck_due_at set by forceRecheckDue (I2)', () => {
    const base = {
      phone_input: '+5543991938235',
      phone_variant_tried: '5543991938235',
      device_serial: 'poco-c71-01',
      waha_session: null,
      triggered_by: 'pre_check' as const,
      confidence: 0.95,
      evidence: null,
      latency_ms: 4500,
      ddd: '43',
    }
    registry.record('5543991938235', { ...base, source: 'adb_probe', result: 'not_exists' })
    // at this point recheck_due_at is NULL per D1
    registry.forceRecheckDue('5543991938235', 'operator override')
    const afterForce = registry.lookup('5543991938235')
    expect(afterForce!.recheck_due_at).not.toBeNull()

    // new decisive probe should clear the recheck_due_at
    registry.record('5543991938235', { ...base, source: 'adb_probe', result: 'exists' })
    const afterProbe = registry.lookup('5543991938235')
    expect(afterProbe!.recheck_due_at).toBeNull()
    expect(afterProbe!.exists_on_wa).toBe(1)
  })

  it('record with result=error inserts check but does NOT touch wa_contacts state (M5/D10)', () => {
    const base = {
      phone_input: '+5543991938235',
      phone_variant_tried: '5543991938235',
      device_serial: 'poco-c71-01',
      waha_session: null,
      triggered_by: 'hygiene_job:batch-1' as const,
      confidence: 0.95,
      evidence: null,
      latency_ms: 4500,
      ddd: '43',
    }
    // seed with exists=true
    registry.record('5543991938235', { ...base, source: 'adb_probe', result: 'exists' })
    const before = registry.lookup('5543991938235')!
    expect(before.exists_on_wa).toBe(1)

    // error must not mutate wa_contacts (preserves previous decisive state)
    registry.record('5543991938235', {
      ...base,
      source: 'adb_probe',
      result: 'error',
      evidence: { error_code: 'probe_failed' },
    })
    const after = registry.lookup('5543991938235')!
    expect(after.exists_on_wa).toBe(1) // preserved
    expect(after.last_check_source).toBe('adb_probe') // preserved (not overwritten)
    expect(after.check_count).toBe(before.check_count) // NOT incremented
    // but the check IS recorded for audit
    expect(registry.history('5543991938235').filter((c) => c.result === 'error')).toHaveLength(1)
  })

  it('second record on same phone updates last_check_* and increments check_count (M2)', () => {
    const base = {
      phone_input: '+5543991938235',
      phone_variant_tried: '5543991938235',
      device_serial: 'poco-c71-01',
      waha_session: null,
      triggered_by: 'pre_check' as const,
      confidence: 0.95,
      evidence: null,
      latency_ms: 4500,
      ddd: '43',
    }
    const first = registry.record('5543991938235', {
      ...base,
      phone_input: '+5543991938235',
      source: 'adb_probe',
      result: 'exists',
      wa_chat_id: '5543991938235@c.us',
    })
    const second = registry.record('5543991938235', {
      ...base,
      phone_input: '55 43 99193-8235',
      source: 'waha',
      result: 'exists',
      confidence: 1.0,
      wa_chat_id: null, // must NOT overwrite the previously recorded chatId
    })

    const contact = registry.lookup('5543991938235')!
    expect(contact.check_count).toBe(2)
    expect(contact.last_check_id).toBe(second.checkId)
    expect(contact.last_check_id).not.toBe(first.checkId)
    expect(contact.last_check_source).toBe('waha')
    expect(contact.last_check_confidence).toBe(1.0)
    expect(contact.phone_input_last).toBe('55 43 99193-8235')
    expect(contact.wa_chat_id).toBe('5543991938235@c.us') // COALESCE preserved
  })
})
