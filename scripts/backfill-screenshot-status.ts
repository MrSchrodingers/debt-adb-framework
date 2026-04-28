#!/usr/bin/env tsx
/**
 * backfill-screenshot-status.ts
 *
 * One-shot script to populate screenshot_status on legacy messages that have
 * NULL in that column (rows written before Task 7.5 added the column).
 *
 * Logic:
 *   - screenshot_path IS NULL  → screenshot_status = 'never_persisted'
 *   - screenshot_path NOT NULL → screenshot_status = 'persisted'
 *
 * Idempotent: rows where screenshot_status IS NOT NULL are untouched.
 *
 * Usage (on Kali, from the project root):
 *   pnpm tsx scripts/backfill-screenshot-status.ts
 *
 * Or with a custom DB path:
 *   DB_PATH=/var/www/adb_tools/dispatch.db pnpm tsx scripts/backfill-screenshot-status.ts
 */

import Database from 'better-sqlite3'

const dbPath = process.env.DB_PATH ?? 'packages/core/dispatch.db'

console.log(`[backfill] Opening database: ${dbPath}`)
const db = new Database(dbPath)

// Verify the column exists (guard against running on a pre-7.5 schema that
// hasn't been migrated yet — better-sqlite3 will throw on unknown columns).
const cols = db.prepare('PRAGMA table_info(messages)').all() as { name: string }[]
if (!cols.some(c => c.name === 'screenshot_status')) {
  console.error('[backfill] ERROR: screenshot_status column not found. Run the app once to trigger schema migration, then retry.')
  process.exit(1)
}

const result = db.prepare(`
  UPDATE messages
  SET screenshot_status = CASE
    WHEN screenshot_path IS NULL THEN 'never_persisted'
    ELSE 'persisted'
  END
  WHERE screenshot_status IS NULL
`).run()

console.log(`[backfill] Updated ${result.changes} row(s)`)

interface StatusRow {
  screenshot_status: string
  n: number
}

const counts = db.prepare(
  'SELECT screenshot_status, COUNT(*) as n FROM messages GROUP BY screenshot_status',
).all() as StatusRow[]

console.log('\n[backfill] Distribution after backfill:')
console.table(counts)

db.close()
console.log('[backfill] Done.')
