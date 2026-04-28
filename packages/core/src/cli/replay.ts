#!/usr/bin/env node
/**
 * dispatch-replay — CLI tool for replaying messages within a time window.
 *
 * Usage:
 *   dispatch-replay --from <ISO> [--to <ISO>] (--dry-run | --wet-run) [filters]
 *
 * Exit codes:
 *   0 — success
 *   1 — usage error (bad args)
 *   2 — partial wet-run failure (some succeeded, some failed)
 *   3 — DB error / fatal
 */

import Database from 'better-sqlite3'
import { MessageQueue } from '../queue/message-queue.js'
import type { MessageStatus } from '../queue/types.js'

// ---------------------------------------------------------------------------
// Arg parsing (no external deps — plain loop)
// ---------------------------------------------------------------------------

interface ParsedArgs {
  from?: string
  to?: string
  status: string
  plugin?: string
  phone?: string
  idempotencyKey?: string
  limit: number
  dryRun: boolean
  wetRun: boolean
  db?: string
  json: boolean
  help: boolean
  allowSentReplay: boolean
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    status: 'permanently_failed',
    limit: 1000,
    dryRun: false,
    wetRun: false,
    json: false,
    help: false,
    allowSentReplay: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--from':
        args.from = argv[++i]
        break
      case '--to':
        args.to = argv[++i]
        break
      case '--status':
        args.status = argv[++i]
        break
      case '--plugin':
        args.plugin = argv[++i]
        break
      case '--phone':
        args.phone = argv[++i]
        break
      case '--idempotency-key':
        args.idempotencyKey = argv[++i]
        break
      case '--limit': {
        const n = parseInt(argv[++i], 10)
        if (isNaN(n) || n <= 0) {
          throw new Error('--limit must be a positive integer')
        }
        args.limit = n
        break
      }
      case '--dry-run':
        args.dryRun = true
        break
      case '--wet-run':
        args.wetRun = true
        break
      case '--db':
        args.db = argv[++i]
        break
      case '--json':
        args.json = true
        break
      case '--allow-sent-replay':
        args.allowSentReplay = true
        break
      case '-h':
      case '--help':
        args.help = true
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return args
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeDigits(phone: string): string {
  return phone.replace(/\D/g, '')
}

const VALID_STATUSES: MessageStatus[] = [
  'queued',
  'sent',
  'failed',
  'permanently_failed',
  'locked',
  'sending',
  'waiting_device',
]

function printUsage(out: NodeJS.WritableStream): void {
  out.write(`
dispatch-replay — replay messages within a time window

USAGE
  dispatch-replay --from <ISO> [--to <ISO>] (--dry-run | --wet-run) [filters]

REQUIRED
  --from <ISO>          Window start (ISO-8601, e.g. 2026-04-01T00:00:00Z)
  --dry-run             List matching messages + counts; no DB writes
  --wet-run             Re-enqueue matching messages (status → queued, attempts = 0)

WINDOW
  --to <ISO>            Window end (default: now)

FILTERS
  --status <s>          Message status to match (default: permanently_failed)
                        Values: queued | sent | failed | permanently_failed |
                                locked | sending | waiting_device
  --plugin <name>       Filter by plugin_name
  --phone <phone>       Filter by to_number (normalized to digits-only)
  --idempotency-key <k> Single-message replay by idempotency_key
  --limit <N>           Max rows to process (default: 1000)

WET-RUN OPTIONS
  --allow-sent-replay   Allow replaying messages with status = 'sent'

OTHER
  --db <path>           Override DB path (default: DB_PATH env or 'dispatch.db')
  --json                Machine-readable JSON output
  -h, --help            Show this help

EXIT CODES
  0  success
  1  usage error
  2  partial wet-run failure (some succeeded, some failed)
  3  DB / fatal error

EXAMPLES
  # Dry-run: count permanently_failed in last 2h
  dispatch-replay --from 2026-04-27T10:00:00Z --dry-run

  # Wet-run: re-enqueue all failures for a specific phone
  dispatch-replay --from 2026-04-01T00:00:00Z --phone 5543991938235 --wet-run

  # Replay single message
  dispatch-replay --from 2026-01-01T00:00:00Z --idempotency-key abc123 --wet-run
`.trimStart())
}

interface MatchRow {
  id: string
  idempotency_key: string
  to_number: string
  status: string
  plugin_name: string | null
  created_at: string
  attempts: number
}

// ---------------------------------------------------------------------------
// Main (exported for testing)
// ---------------------------------------------------------------------------

export async function main(
  argv: string[],
  stdout: NodeJS.WritableStream = process.stdout,
  stderr: NodeJS.WritableStream = process.stderr,
): Promise<number> {
  // Parse args
  let args: ParsedArgs
  try {
    args = parseArgs(argv)
  } catch (err) {
    stderr.write(`error: ${(err as Error).message}\n`)
    return 1
  }

  if (args.help) {
    printUsage(stdout)
    return 0
  }

  // Validate mutex: dry-run XOR wet-run
  if (args.dryRun === args.wetRun) {
    stderr.write('error: exactly one of --dry-run | --wet-run is required\n')
    return 1
  }

  // Validate --from is present
  if (!args.from) {
    stderr.write('error: --from is required\n')
    return 1
  }

  // Validate time window
  const from = new Date(args.from)
  const to = new Date(args.to ?? new Date().toISOString())

  if (isNaN(from.getTime()) || isNaN(to.getTime())) {
    stderr.write('error: invalid --from / --to (not valid ISO-8601)\n')
    return 1
  }

  if (from > to) {
    stderr.write('error: invalid --from / --to range (--from is after --to)\n')
    return 1
  }

  // Validate status
  if (!VALID_STATUSES.includes(args.status as MessageStatus)) {
    stderr.write(`error: invalid --status '${args.status}'. Valid values: ${VALID_STATUSES.join(' | ')}\n`)
    return 1
  }

  // Refuse --status sent --wet-run without --allow-sent-replay
  if (args.wetRun && args.status === 'sent' && !args.allowSentReplay) {
    stderr.write(
      'error: refusing --status sent with --wet-run. Add --allow-sent-replay to confirm.\n',
    )
    return 1
  }

  // Open DB
  const dbPath = args.db ?? process.env['DB_PATH'] ?? 'dispatch.db'
  let db: InstanceType<typeof Database>
  try {
    // dry-run opens readonly so zero writes are possible even by accident
    db = new Database(dbPath, { readonly: args.dryRun })
  } catch (err) {
    stderr.write(`error: cannot open database at '${dbPath}': ${(err as Error).message}\n`)
    return 3
  }

  // If wet-run, initialize queue (creates tables if missing, idempotent)
  if (args.wetRun) {
    try {
      const queue = new MessageQueue(db)
      queue.initialize()
    } catch (err) {
      stderr.write(`error: DB initialization failed: ${(err as Error).message}\n`)
      db.close()
      return 3
    }
  }

  // Build and execute filter query
  const conditions: string[] = [
    "created_at >= ?",
    "created_at <= ?",
    "status = ?",
  ]
  const params: unknown[] = [
    from.toISOString(),
    to.toISOString(),
    args.status,
  ]

  if (args.plugin) {
    conditions.push('plugin_name = ?')
    params.push(args.plugin)
  }

  if (args.phone) {
    const normalized = normalizeDigits(args.phone)
    conditions.push('to_number = ?')
    params.push(normalized)
  }

  if (args.idempotencyKey) {
    conditions.push('idempotency_key = ?')
    params.push(args.idempotencyKey)
  }

  const where = `WHERE ${conditions.join(' AND ')}`

  let rows: MatchRow[]
  try {
    rows = db.prepare(
      `SELECT id, idempotency_key, to_number, status, plugin_name, created_at, attempts
       FROM messages
       ${where}
       ORDER BY created_at ASC
       LIMIT ?`,
    ).all(...params, args.limit) as MatchRow[]
  } catch (err) {
    stderr.write(`error: query failed: ${(err as Error).message}\n`)
    db.close()
    return 3
  }

  // -------------------------------------------------------------------------
  // DRY-RUN path
  // -------------------------------------------------------------------------
  if (args.dryRun) {
    if (args.json) {
      stdout.write(
        JSON.stringify({
          mode: 'dry-run',
          window: { from: from.toISOString(), to: to.toISOString() },
          filters: {
            status: args.status,
            plugin: args.plugin ?? null,
            phone: args.phone ? normalizeDigits(args.phone) : null,
            idempotencyKey: args.idempotencyKey ?? null,
            limit: args.limit,
          },
          count: rows.length,
          messages: rows.map(r => ({
            id: r.id,
            idempotencyKey: r.idempotency_key,
            to: r.to_number,
            status: r.status,
            plugin: r.plugin_name,
            createdAt: r.created_at,
            attempts: r.attempts,
          })),
        }, null, 2) + '\n',
      )
    } else {
      stdout.write(`Dry-run — window: ${from.toISOString()} → ${to.toISOString()}\n`)
      stdout.write(`Filters: status=${args.status}`)
      if (args.plugin) stdout.write(` plugin=${args.plugin}`)
      if (args.phone) stdout.write(` phone=${normalizeDigits(args.phone)}`)
      if (args.idempotencyKey) stdout.write(` idempotency_key=${args.idempotencyKey}`)
      stdout.write(`\nFound ${rows.length} message(s) (limit ${args.limit})\n`)

      if (rows.length > 0) {
        stdout.write('\n')
        // Simple text table
        const header = `${'ID'.padEnd(22)} ${'STATUS'.padEnd(20)} ${'TO'.padEnd(16)} ${'PLUGIN'.padEnd(14)} CREATED_AT`
        stdout.write(header + '\n')
        stdout.write('-'.repeat(header.length) + '\n')
        for (const r of rows) {
          stdout.write(
            `${r.id.padEnd(22)} ${r.status.padEnd(20)} ${r.to_number.padEnd(16)} ${(r.plugin_name ?? '—').padEnd(14)} ${r.created_at}\n`,
          )
        }
      }
    }

    db.close()
    return 0
  }

  // -------------------------------------------------------------------------
  // WET-RUN path
  // -------------------------------------------------------------------------
  const queue = new MessageQueue(db)
  let replayed = 0
  let skipped = 0
  const errors: Array<{ id: string; reason: string }> = []

  for (const row of rows) {
    try {
      queue.replay(row.id, args.allowSentReplay)
      replayed++
    } catch (err) {
      errors.push({ id: row.id, reason: (err as Error).message })
    }
  }

  // Count items that were found but not processed (only if errors < total, meaning some were skipped for other reasons)
  skipped = rows.length - replayed - errors.length

  db.close()

  if (args.json) {
    stdout.write(
      JSON.stringify({
        mode: 'wet-run',
        window: { from: from.toISOString(), to: to.toISOString() },
        results: { total: rows.length, replayed, skipped, errors: errors.length },
        errorDetails: errors,
      }, null, 2) + '\n',
    )
  } else {
    stdout.write(`Wet-run complete — window: ${from.toISOString()} → ${to.toISOString()}\n`)
    stdout.write(`Total matched : ${rows.length}\n`)
    stdout.write(`Replayed      : ${replayed}\n`)
    if (skipped > 0) stdout.write(`Skipped       : ${skipped}\n`)
    if (errors.length > 0) {
      stdout.write(`Errors        : ${errors.length}\n`)
      for (const e of errors) {
        stderr.write(`  [FAILED] id=${e.id}: ${e.reason}\n`)
      }
    }
  }

  if (errors.length > 0 && replayed > 0) return 2
  if (errors.length > 0 && replayed === 0) return 3
  return 0
}

// ---------------------------------------------------------------------------
// Auto-run guard
// ---------------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(code => process.exit(code))
}
