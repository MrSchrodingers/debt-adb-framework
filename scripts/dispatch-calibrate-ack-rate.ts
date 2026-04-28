#!/usr/bin/env tsx
/**
 * dispatch-calibrate-ack-rate.ts
 *
 * Read-only calibrator for the WAHA ack-rate ban-prediction signal. Reads the
 * live `message_ack_history` table, runs the pure calibrator, and prints a
 * per-sender recommendation table plus a global "data sufficiency" verdict.
 *
 * This script REPLACES the originally planned Frida method-counting approach
 * (blocked on the POCO C71 stack — see ADR 0001 / project memory
 * `project_ban_prediction_pivot.md`).
 *
 * Usage (on Kali, from the project root):
 *   pnpm tsx scripts/dispatch-calibrate-ack-rate.ts
 *
 * With explicit args:
 *   pnpm tsx scripts/dispatch-calibrate-ack-rate.ts \
 *     --since 7d \
 *     --window 1h \
 *     --db /var/www/debt-adb-framework/packages/core/dispatch.db \
 *     --percentile 0.05 \
 *     --min-windows 24
 *
 * The script does NOT write anywhere — it only suggests. Apply the
 * recommendation manually in `.env` (DISPATCH_BAN_PREDICTION_*).
 */

import { createRequire } from 'node:module'
import { calibrateAckRate, type AckEvent } from '../packages/core/src/research/ack-rate-calibrator.js'

const require = createRequire(import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require('better-sqlite3') as typeof import('better-sqlite3').default

interface CliArgs {
  db: string
  since: string
  window: string
  percentile: number
  minWindows: number
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    db: process.env.DB_PATH ?? 'packages/core/dispatch.db',
    since: '7d',
    window: '1h',
    percentile: 0.05,
    minWindows: 24,
  }
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    const next = argv[i + 1]
    switch (arg) {
      case '--db':
        args.db = next
        i++
        break
      case '--since':
        args.since = next
        i++
        break
      case '--window':
        args.window = next
        i++
        break
      case '--percentile':
        args.percentile = Number(next)
        i++
        break
      case '--min-windows':
        args.minWindows = Number(next)
        i++
        break
      case '--help':
      case '-h':
        printUsage()
        process.exit(0)
        break
      default:
        if (arg.startsWith('--')) {
          console.error(`Unknown flag: ${arg}`)
          printUsage()
          process.exit(2)
        }
    }
  }
  return args
}

function printUsage(): void {
  console.log(`
dispatch-calibrate-ack-rate — WAHA ack-rate ban-prediction calibrator

Usage:
  pnpm tsx scripts/dispatch-calibrate-ack-rate.ts [options]

Options:
  --db <path>          Path to dispatch.db (default: packages/core/dispatch.db; or DB_PATH env)
  --since <duration>   Lookback window: <N>m | <N>h | <N>d (default: 7d)
  --window <duration>  Bucket size: <N>m | <N>h (default: 1h)
  --percentile <0..1>  Percentile of per-window read-ratio for threshold (default: 0.05)
  --min-windows <N>    Minimum sample windows for high confidence (default: 24)
  -h, --help           Show this help

Output:
  - Per-sender table: windows, sent, delivered, read, delivery%, read%, confidence, recommended threshold
  - Global verdict: SUFFICIENT / SPARSE / INSUFFICIENT

The script is READ-ONLY. Apply recommendations manually to .env.
`.trim())
}

function parseDuration(s: string): number {
  const m = /^(\d+)([smhd])$/.exec(s)
  if (!m) throw new Error(`Invalid duration "${s}". Examples: 30m, 6h, 7d`)
  const n = Number(m[1])
  const unit = m[2]
  switch (unit) {
    case 's':
      return n * 1000
    case 'm':
      return n * 60_000
    case 'h':
      return n * 3_600_000
    case 'd':
      return n * 86_400_000
    default:
      throw new Error(`Unknown unit "${unit}"`)
  }
}

function fmtPct(x: number): string {
  return (x * 100).toFixed(1) + '%'
}

function fmtNum(x: number, width: number): string {
  return String(x).padStart(width)
}

function main(): void {
  const args = parseArgs(process.argv)
  const sinceMs = parseDuration(args.since)
  const windowMs = parseDuration(args.window)
  const now = Date.now()
  const since = now - sinceMs

  console.log(`[calibrate] Database:    ${args.db}`)
  console.log(`[calibrate] Range:       last ${args.since} (since ${new Date(since).toISOString()})`)
  console.log(`[calibrate] Window:      ${args.window} (${windowMs} ms)`)
  console.log(`[calibrate] Percentile:  ${args.percentile} (P${(args.percentile * 100).toFixed(0)} of read-ratio per window)`)
  console.log(`[calibrate] Min windows: ${args.minWindows}`)
  console.log('')

  let db: import('better-sqlite3').Database
  try {
    db = new Database(args.db, { readonly: true, fileMustExist: true })
  } catch (err) {
    console.error(`[calibrate] FATAL: cannot open database "${args.db}": ${(err as Error).message}`)
    process.exit(1)
  }

  const tableCheck = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='message_ack_history'")
    .get()
  if (!tableCheck) {
    console.error('[calibrate] FATAL: table message_ack_history does not exist.')
    console.error('[calibrate] This means dispatch-core has not run on this DB since the schema was added.')
    console.error('[calibrate] Restart dispatch-core (which auto-creates the table) and try again.')
    process.exit(1)
  }

  const rows = db
    .prepare(`
      SELECT waha_message_id, ack_level, observed_at, sender_phone
      FROM message_ack_history
      WHERE observed_at >= ?
        AND observed_at <= ?
      ORDER BY observed_at ASC
    `)
    .all(
      msToSqliteDatetime(since),
      msToSqliteDatetime(now),
    ) as {
    waha_message_id: string
    ack_level: number
    observed_at: string
    sender_phone: string | null
  }[]

  const events: AckEvent[] = rows.map((r) => ({
    wahaMessageId: r.waha_message_id,
    ackLevel: r.ack_level,
    observedAt: sqliteDatetimeToMs(r.observed_at),
    senderPhone: r.sender_phone,
  }))

  console.log(`[calibrate] Loaded ${events.length} ack event(s)`)
  console.log('')

  if (events.length === 0) {
    console.log('No ack events in the requested range. Verdict: INSUFFICIENT')
    process.exit(0)
  }

  const result = calibrateAckRate({
    events,
    windowMs,
    minSampleSize: args.minWindows,
    percentile: args.percentile,
  })

  const senders = [...result.perSender.entries()].sort((a, b) => b[1].totalSent - a[1].totalSent)

  if (senders.length === 0) {
    console.log('No senders with attributable acks (all rows have NULL sender_phone).')
    console.log('Verdict: INSUFFICIENT — verify that message_history is populated before acks arrive.')
    process.exit(0)
  }

  const header =
    'sender'.padEnd(16) +
    ' | ' +
    'wins'.padStart(5) +
    ' | ' +
    'sent'.padStart(6) +
    ' | ' +
    'deliv'.padStart(6) +
    ' | ' +
    'read'.padStart(6) +
    ' | ' +
    'deliv%'.padStart(7) +
    ' | ' +
    ' read%'.padStart(7) +
    ' | ' +
    ' conf'.padStart(6) +
    ' | ' +
    'reco P' +
    String(Math.round(args.percentile * 100)).padStart(2, '0')
  console.log(header)
  console.log('-'.repeat(header.length))

  let sufficientSenders = 0
  for (const [sender, stats] of senders) {
    if (stats.sampleWindows >= args.minWindows) sufficientSenders++
    const row =
      sender.padEnd(16) +
      ' | ' +
      fmtNum(stats.sampleWindows, 5) +
      ' | ' +
      fmtNum(stats.totalSent, 6) +
      ' | ' +
      fmtNum(stats.totalDelivered, 6) +
      ' | ' +
      fmtNum(stats.totalRead, 6) +
      ' | ' +
      fmtPct(stats.deliveryRatio).padStart(7) +
      ' | ' +
      fmtPct(stats.readRatio).padStart(7) +
      ' | ' +
      stats.confidence.toFixed(2).padStart(6) +
      ' | ' +
      stats.recommendedThreshold.toFixed(3)
    console.log(row)
    for (const w of stats.warnings) {
      console.log('  warn: ' + w)
    }
  }

  console.log('')
  for (const w of result.globalWarnings) {
    console.log('GLOBAL warn: ' + w)
  }

  let verdict: 'SUFFICIENT' | 'SPARSE' | 'INSUFFICIENT'
  if (sufficientSenders >= 1) {
    verdict = 'SUFFICIENT'
  } else if (senders.some((s) => s[1].sampleWindows >= Math.max(1, Math.floor(args.minWindows / 2)))) {
    verdict = 'SPARSE'
  } else {
    verdict = 'INSUFFICIENT'
  }
  console.log('')
  console.log(`Verdict: ${verdict}`)
  switch (verdict) {
    case 'SUFFICIENT':
      console.log('  -> Threshold recommendations from sufficient-sample senders are trustworthy.')
      console.log('  -> Apply manually to DISPATCH_BAN_PREDICTION_* in .env (no automatic write).')
      break
    case 'SPARSE':
      console.log('  -> Some senders have meaningful data but none crossed minSampleSize.')
      console.log('  -> Continue accumulating before applying threshold; treat current values as provisional.')
      break
    case 'INSUFFICIENT':
      console.log('  -> Not enough data to calibrate. Either widen --since or accumulate more traffic.')
      break
  }

  db.close()
}

function msToSqliteDatetime(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
}

function sqliteDatetimeToMs(s: string): number {
  return new Date(s.replace(' ', 'T') + 'Z').getTime()
}

main()
