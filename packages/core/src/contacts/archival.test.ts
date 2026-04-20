import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { ContactRegistry } from './contact-registry.js'
import { archiveOldChecks } from './archival.js'

describe('archiveOldChecks', () => {
  let hot: Database.Database
  let archive: Database.Database
  let registry: ContactRegistry

  beforeEach(() => {
    hot = new Database(':memory:')
    registry = new ContactRegistry(hot)
    registry.initialize()

    archive = new Database(':memory:')
    new ContactRegistry(archive).initialize()
  })

  it('moves checks older than cutoff from hot DB to archive DB', () => {
    // seed a record
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
    })
    // manually backdate the check
    const oneYearAgo = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString()
    hot.prepare('UPDATE wa_contact_checks SET checked_at = ?').run(oneYearAgo)

    const stats = archiveOldChecks(hot, archive, 365)
    expect(stats.archivedCount).toBe(1)

    expect(
      (hot.prepare('SELECT COUNT(*) AS n FROM wa_contact_checks').get() as { n: number }).n,
    ).toBe(0)
    expect(
      (archive.prepare('SELECT COUNT(*) AS n FROM wa_contact_checks').get() as { n: number }).n,
    ).toBe(1)
  })

  it('leaves recent checks in hot DB', () => {
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
    })

    const stats = archiveOldChecks(hot, archive, 365)
    expect(stats.archivedCount).toBe(0)
    expect(
      (hot.prepare('SELECT COUNT(*) AS n FROM wa_contact_checks').get() as { n: number }).n,
    ).toBe(1)
  })
})
