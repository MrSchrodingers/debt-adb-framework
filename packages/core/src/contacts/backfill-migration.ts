import type Database from 'better-sqlite3'
import { nanoid } from 'nanoid'
import { normalizePhone } from '../validator/br-phone-resolver.js'

export interface BackfillStats {
  contactsCreated: number
  checksCreated: number
  skippedInvalid: number
  skippedExisting: number
}

/**
 * One-shot migration: for each distinct phone with messages.status='sent',
 * seed wa_contacts with exists_on_wa=1 and append a single wa_contact_checks
 * row with source='send_success_backfill' (confidence=0.9).
 *
 * Idempotent: re-running skips phones already present in wa_contacts.
 */
export function backfillFromSentHistory(db: Database.Database): BackfillStats {
  // I5: prefer sent_at (actual send time) over updated_at (changes on any status flip).
  // COALESCE defends against rows that pre-date the sent_at column migration.
  const rows = db
    .prepare(`
      SELECT to_number, id AS message_id, COALESCE(sent_at, updated_at) AS sent_at
      FROM messages
      WHERE status = 'sent'
      ORDER BY COALESCE(sent_at, updated_at) ASC
    `)
    .all() as { to_number: string; message_id: string; sent_at: string }[]

  const stats: BackfillStats = {
    contactsCreated: 0,
    checksCreated: 0,
    skippedInvalid: 0,
    skippedExisting: 0,
  }

  const seen = new Set<string>()

  const existsStmt = db.prepare('SELECT 1 FROM wa_contacts WHERE phone_normalized = ?')
  const insertCheck = db.prepare(`
    INSERT INTO wa_contact_checks
      (id, phone_normalized, phone_variant_tried, source, result, confidence,
       evidence, device_serial, waha_session, triggered_by, latency_ms, checked_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `)
  const insertContact = db.prepare(`
    INSERT INTO wa_contacts (
      phone_normalized, phone_input_last, wa_chat_id, exists_on_wa,
      last_check_source, last_check_confidence, last_check_id, last_checked_at,
      check_count, first_seen_at, updated_at, ddd, country_code
    )
    VALUES (?,?,?,1,?,?,?,?,1,?,?,?,?)
  `)

  const tx = db.transaction((rowsIn: typeof rows) => {
    for (const row of rowsIn) {
      let norm
      try {
        norm = normalizePhone(row.to_number)
      } catch {
        stats.skippedInvalid++
        continue
      }

      if (seen.has(norm.normalized)) continue
      seen.add(norm.normalized)

      if (existsStmt.get(norm.normalized)) {
        stats.skippedExisting++
        continue
      }

      const checkId = nanoid()
      const evidence = JSON.stringify({
        migration: 'phase-9.1-backfill',
        inferred_from: { message_id: row.message_id, sent_at: row.sent_at },
        note: 'Backfilled from messages.status=sent history; not a real probe',
      })

      insertCheck.run(
        checkId,
        norm.normalized,
        norm.normalized,
        'send_success_backfill',
        'exists',
        0.9,
        evidence,
        null,
        null,
        'manual',
        null,
        row.sent_at,
      )

      insertContact.run(
        norm.normalized,
        row.to_number,
        null,
        'send_success_backfill',
        0.9,
        checkId,
        row.sent_at,
        row.sent_at,
        row.sent_at,
        norm.ddd,
        norm.countryCode,
      )

      stats.contactsCreated++
      stats.checksCreated++
    }
  })

  tx(rows)
  return stats
}
