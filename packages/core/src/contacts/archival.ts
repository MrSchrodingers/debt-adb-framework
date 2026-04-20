import type Database from 'better-sqlite3'

export interface ArchivalStats {
  archivedCount: number
  cutoff: string
}

/**
 * Grill D11: move wa_contact_checks older than `cutoffDays` into a provided
 * archive database. Runs quarterly in production via cron.
 *
 * This is a stateless function — the caller controls both DBs' lifecycle.
 * The archive DB MUST have the same wa_contact_checks schema.
 */
export function archiveOldChecks(
  hot: Database.Database,
  archive: Database.Database,
  cutoffDays = 365,
): ArchivalStats {
  const cutoff = new Date(Date.now() - cutoffDays * 24 * 60 * 60 * 1000).toISOString()

  const rows = hot
    .prepare(
      `SELECT id, phone_normalized, phone_variant_tried, source, result, confidence,
              evidence, device_serial, waha_session, triggered_by, latency_ms, checked_at
       FROM wa_contact_checks
       WHERE checked_at < ?`,
    )
    .all(cutoff) as Array<Record<string, unknown>>

  const insertArchive = archive.prepare(`
    INSERT OR IGNORE INTO wa_contact_checks
      (id, phone_normalized, phone_variant_tried, source, result, confidence,
       evidence, device_serial, waha_session, triggered_by, latency_ms, checked_at)
    VALUES (@id,@phone_normalized,@phone_variant_tried,@source,@result,@confidence,
            @evidence,@device_serial,@waha_session,@triggered_by,@latency_ms,@checked_at)
  `)
  const deleteHot = hot.prepare(`DELETE FROM wa_contact_checks WHERE id = ?`)

  let archivedCount = 0
  const tx = archive.transaction(() => {
    for (const row of rows) {
      insertArchive.run(row)
      archivedCount++
    }
  })
  tx()

  const txHot = hot.transaction(() => {
    for (const row of rows) deleteHot.run(row.id as string)
  })
  txHot()

  return { archivedCount, cutoff }
}
