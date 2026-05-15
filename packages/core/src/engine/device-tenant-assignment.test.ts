import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { DeviceTenantAssignment } from './device-tenant-assignment.js'

describe('DeviceTenantAssignment', () => {
  let db: Database.Database
  let dta: DeviceTenantAssignment

  beforeEach(() => {
    db = new Database(':memory:')
    dta = new DeviceTenantAssignment(db)
  })

  afterEach(() => {
    db.close()
  })

  it('claim succeeds for a free device', () => {
    const r = dta.claim('dev1', 'oralsin-sdr', 'debt-sdr')
    expect(r.ok).toBe(true)
  })

  it('claim is idempotent for same tenant+plugin', () => {
    dta.claim('dev1', 'oralsin-sdr', 'debt-sdr')
    const r = dta.claim('dev1', 'oralsin-sdr', 'debt-sdr')
    expect(r.ok).toBe(true)
  })

  it('claim fails when device already claimed by other tenant', () => {
    dta.claim('dev1', 'oralsin-sdr', 'debt-sdr')
    const r = dta.claim('dev1', 'sicoob-sdr', 'debt-sdr')
    expect(r.ok).toBe(false)
    if (!r.ok && r.reason === 'already_claimed') {
      expect(r.current_tenant).toBe('oralsin-sdr')
      expect(r.current_plugin).toBe('debt-sdr')
    }
  })

  it('claim fails when device claimed by different plugin (same tenant)', () => {
    dta.claim('dev1', 'oralsin-sdr', 'debt-sdr')
    const r = dta.claim('dev1', 'oralsin-sdr', 'other-plugin')
    expect(r.ok).toBe(false)
    if (!r.ok && r.reason === 'already_claimed') {
      expect(r.current_plugin).toBe('debt-sdr')
    }
  })

  it('release returns ok=false for non-owner plugin (I2)', () => {
    dta.claim('dev1', 'oralsin-sdr', 'debt-sdr')
    const r = dta.release('dev1', 'malicious-plugin')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('not_owner')
    expect(dta.getAssignment('dev1')).not.toBeNull()
  })

  it('release succeeds for the owner plugin', () => {
    dta.claim('dev1', 'oralsin-sdr', 'debt-sdr')
    const r = dta.release('dev1', 'debt-sdr')
    expect(r.ok).toBe(true)
    expect(dta.getAssignment('dev1')).toBeNull()
  })

  it('release on unknown device is no-op (ok: true)', () => {
    const r = dta.release('devX', 'debt-sdr')
    expect(r.ok).toBe(true)
  })

  it('list returns all assignments', () => {
    dta.claim('dev1', 'oralsin-sdr', 'debt-sdr')
    dta.claim('dev2', 'sicoob-sdr', 'debt-sdr')
    expect(dta.list()).toHaveLength(2)
  })

  it('releaseByPlugin removes all assignments owned by a plugin', () => {
    dta.claim('dev1', 'oralsin-sdr', 'debt-sdr')
    dta.claim('dev2', 'sicoob-sdr', 'debt-sdr')
    dta.claim('dev3', 'other', 'other-plugin')
    const released = dta.releaseByPlugin('debt-sdr')
    expect(released).toBe(2)
    expect(dta.list()).toHaveLength(1)
    expect(dta.getAssignment('dev3')).not.toBeNull()
  })

  it('getAssignment returns row with claimed_at timestamp', () => {
    dta.claim('dev1', 'oralsin-sdr', 'debt-sdr')
    const a = dta.getAssignment('dev1')
    expect(a).not.toBeNull()
    expect(a!.tenant_name).toBe('oralsin-sdr')
    expect(a!.claimed_by_plugin).toBe('debt-sdr')
    expect(a!.claimed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})
