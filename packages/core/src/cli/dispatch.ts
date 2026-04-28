#!/usr/bin/env node
/**
 * dispatch — Rich CLI tool for Dispatch ADB Framework operations.
 *
 * Usage:
 *   dispatch <command> [subcommand] [options]
 *
 * Commands:
 *   trace <message-id>                     Print message timeline (events + screenshot path)
 *   send --to <phone> --from <sender> --body "<text>"  Enqueue a message directly via DB
 *   device list                            List active devices
 *   device info <serial>                   Full device row + last health
 *   queue stats                            Print queue statistics as a table
 *   replay --from <iso>                    Defer to dispatch-replay subprocess
 *   keys rotate <plugin-name>              Rotate API key for a plugin
 *
 * Global flags:
 *   --db <path>    Override DB path (default: DB_PATH env or dispatch.db)
 *   --json         Machine-readable JSON output
 *   -h, --help     Show help
 *
 * Exit codes:
 *   0 — success
 *   1 — usage error
 *   2 — not found (trace/device/plugin)
 *   3 — DB / fatal error
 */

import { spawnSync } from 'node:child_process'
import { nanoid } from 'nanoid'
import Database from 'better-sqlite3'
import { MessageQueue } from '../queue/message-queue.js'
import { PluginRegistry } from '../plugins/plugin-registry.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GlobalArgs {
  db?: string
  json: boolean
  help: boolean
  command?: string
  rest: string[]
}

interface TraceRow {
  event: string
  metadata: string | null
  created_at: string
}

interface DeviceRow {
  serial: string
  status: string
  brand: string | null
  model: string | null
  battery_percent: number | null
  temperature_celsius: number | null
  ram_available_mb: number | null
  storage_free_bytes: number | null
  last_seen: string | null
  created_at: string
}

interface HealthRow {
  battery_percent: number | null
  temperature_celsius: number | null
  ram_available_mb: number | null
  storage_free_bytes: number | null
  created_at: string
}

// ---------------------------------------------------------------------------
// Help strings
// ---------------------------------------------------------------------------

function printUsage(out: NodeJS.WritableStream): void {
  out.write(`
dispatch — Rich CLI tool for Dispatch ADB Framework

USAGE
  dispatch <command> [subcommand] [flags]

COMMANDS
  trace <message-id>
    Fetch and print message timeline (events + screenshot path).

  send --to <phone> --from <sender> --body "<text>"
    One-shot enqueue via direct DB write (bypasses HTTP API).

  device list
    Print active devices from the devices table.

  device info <serial>
    Full device row + last_health entry for the given serial.

  queue stats
    Print queue statistics as a table.

  replay --from <iso> [replay flags]
    Delegate to dispatch-replay subprocess (pass-through all args).

  keys rotate <plugin-name>
    Rotate the API key for a plugin. Prints new key + security warning.

GLOBAL FLAGS
  --db <path>   SQLite database path (default: DB_PATH env or dispatch.db)
  --json        Machine-readable JSON output for all commands
  -h, --help    Show this help

PER-COMMAND HELP
  dispatch trace --help
  dispatch send --help
  dispatch device --help
  dispatch queue --help
  dispatch replay --help
  dispatch keys --help

EXIT CODES
  0  success
  1  usage error
  2  not found
  3  DB / fatal error
`.trimStart())
}

function printTraceHelp(out: NodeJS.WritableStream): void {
  out.write(`
dispatch trace <message-id> [flags]

Print the full event timeline for a message, including each recorded event,
its metadata (JSON), timestamp, and the screenshot path if captured.

FLAGS
  --db <path>  SQLite path (default: DB_PATH env or dispatch.db)
  --json       Output as JSON
  -h, --help   Show this help
`.trimStart())
}

function printSendHelp(out: NodeJS.WritableStream): void {
  out.write(`
dispatch send --to <phone> --from <sender> --body "<text>" [flags]

Enqueue a message directly into the DB without going through the HTTP API.
This is a local operator tool — no authentication required.

REQUIRED
  --to <phone>      Recipient phone number (digits only)
  --from <sender>   Sender phone number (digits only)
  --body "<text>"   Message body text

OPTIONAL
  --priority <1-10>  Message priority (default: 5)
  --plugin <name>    Plugin name to associate with this message
  --db <path>        SQLite path
  --json             Print only the message ID as JSON
  -h, --help         Show this help
`.trimStart())
}

function printDeviceHelp(out: NodeJS.WritableStream): void {
  out.write(`
dispatch device <subcommand> [flags]

SUBCOMMANDS
  list           List all devices
  info <serial>  Full device info + last health snapshot

FLAGS
  --db <path>  SQLite path
  --json       Output as JSON
  -h, --help   Show this help
`.trimStart())
}

function printQueueHelp(out: NodeJS.WritableStream): void {
  out.write(`
dispatch queue <subcommand> [flags]

SUBCOMMANDS
  stats  Print queue statistics

FLAGS
  --db <path>    SQLite path
  --json         Output as JSON
  -h, --help     Show this help
`.trimStart())
}

function printKeysHelp(out: NodeJS.WritableStream): void {
  out.write(`
dispatch keys rotate <plugin-name> [flags]

Rotate the API key for the named plugin. The new key is printed to stdout.
Distribute it to the plugin's configuration immediately — the old key is
invalidated on rotation.

WARNING: Existing integrations using the old key will fail until they are
updated. Coordinate rotations with plugin maintainers.

FLAGS
  --db <path>  SQLite path
  --json       Output as JSON
  -h, --help   Show this help
`.trimStart())
}

// ---------------------------------------------------------------------------
// Arg parsing helpers
// ---------------------------------------------------------------------------

/** Extract global flags; returns remaining args for the command to parse */
function parseGlobal(argv: string[]): GlobalArgs {
  const result: GlobalArgs = { json: false, help: false, rest: [] }
  let i = 0
  while (i < argv.length) {
    const a = argv[i]
    if (a === '--db') {
      result.db = argv[++i]
    } else if (a === '--json') {
      result.json = true
    } else if (a === '-h' || a === '--help') {
      result.help = true
    } else if (!result.command) {
      result.command = a
    } else {
      result.rest.push(a)
    }
    i++
  }
  return result
}

function openDb(
  dbPath: string,
  stderr: NodeJS.WritableStream,
): Database.Database | null {
  try {
    return new Database(dbPath)
  } catch (err) {
    stderr.write(`error: cannot open database at '${dbPath}': ${(err as Error).message}\n`)
    return null
  }
}

// ---------------------------------------------------------------------------
// Command: trace
// ---------------------------------------------------------------------------

async function cmdTrace(
  args: string[],
  g: GlobalArgs,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    printTraceHelp(stdout)
    return 0
  }

  // First positional arg is the message ID
  const msgId = args.find(a => !a.startsWith('-'))
  if (!msgId) {
    stderr.write('error: trace requires a <message-id> argument\n')
    return 1
  }

  const dbPath = g.db ?? process.env['DB_PATH'] ?? 'dispatch.db'
  const db = openDb(dbPath, stderr)
  if (!db) return 3

  try {
    // Fetch events
    const events = db.prepare(
      'SELECT event, metadata, created_at FROM message_events WHERE message_id = ? ORDER BY id ASC',
    ).all(msgId) as TraceRow[]

    // Fetch message row for screenshot_path + status
    const msgRow = db.prepare(
      'SELECT id, status, to_number, screenshot_path, created_at, updated_at FROM messages WHERE id = ?',
    ).get(msgId) as {
      id: string
      status: string
      to_number: string
      screenshot_path: string | null
      created_at: string
      updated_at: string
    } | undefined

    if (!msgRow && events.length === 0) {
      if (g.json) {
        stdout.write(JSON.stringify({ error: 'not_found', messageId: msgId }) + '\n')
      } else {
        stderr.write(`error: no message or events found for id '${msgId}'\n`)
      }
      db.close()
      return 2
    }

    if (g.json) {
      stdout.write(JSON.stringify({
        messageId: msgId,
        message: msgRow ? {
          status: msgRow.status,
          to: msgRow.to_number,
          screenshotPath: msgRow.screenshot_path,
          createdAt: msgRow.created_at,
          updatedAt: msgRow.updated_at,
        } : null,
        events: events.map(e => ({
          event: e.event,
          metadata: e.metadata ? JSON.parse(e.metadata) as unknown : null,
          createdAt: e.created_at,
        })),
      }, null, 2) + '\n')
    } else {
      stdout.write(`Message: ${msgId}\n`)
      if (msgRow) {
        stdout.write(`  Status    : ${msgRow.status}\n`)
        stdout.write(`  To        : ${msgRow.to_number}\n`)
        stdout.write(`  Created   : ${msgRow.created_at}\n`)
        stdout.write(`  Updated   : ${msgRow.updated_at}\n`)
        if (msgRow.screenshot_path) {
          stdout.write(`  Screenshot: ${msgRow.screenshot_path}\n`)
        }
      }
      stdout.write(`\nTimeline (${events.length} event(s)):\n`)
      if (events.length === 0) {
        stdout.write('  (no events recorded)\n')
      } else {
        for (const e of events) {
          const meta = e.metadata ? ` ${e.metadata}` : ''
          stdout.write(`  ${e.created_at}  ${e.event}${meta}\n`)
        }
      }
    }

    db.close()
    return 0
  } catch (err) {
    stderr.write(`error: ${(err as Error).message}\n`)
    db.close()
    return 3
  }
}

// ---------------------------------------------------------------------------
// Command: send
// ---------------------------------------------------------------------------

async function cmdSend(
  args: string[],
  g: GlobalArgs,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    printSendHelp(stdout)
    return 0
  }

  let to: string | undefined
  let from: string | undefined
  let body: string | undefined
  let priority = 5
  let pluginName: string | undefined

  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--to') to = args[++i]
    else if (a === '--from') from = args[++i]
    else if (a === '--body') body = args[++i]
    else if (a === '--priority') {
      const n = parseInt(args[++i], 10)
      if (isNaN(n) || n < 1 || n > 10) {
        stderr.write('error: --priority must be 1-10\n')
        return 1
      }
      priority = n
    } else if (a === '--plugin') {
      pluginName = args[++i]
    } else {
      stderr.write(`error: unknown send flag: ${a}\n`)
      return 1
    }
  }

  if (!to) { stderr.write('error: --to is required\n'); return 1 }
  if (!from) { stderr.write('error: --from is required\n'); return 1 }
  if (!body) { stderr.write('error: --body is required\n'); return 1 }

  const dbPath = g.db ?? process.env['DB_PATH'] ?? 'dispatch.db'
  const db = openDb(dbPath, stderr)
  if (!db) return 3

  try {
    const queue = new MessageQueue(db)
    queue.initialize()

    const idempotencyKey = nanoid()
    const msg = queue.enqueue({
      to,
      body,
      idempotencyKey,
      priority,
      senderNumber: from,
      pluginName,
    })

    if (g.json) {
      stdout.write(JSON.stringify({ id: msg.id, idempotencyKey: msg.idempotencyKey }) + '\n')
    } else {
      stdout.write(`Enqueued message:\n`)
      stdout.write(`  ID              : ${msg.id}\n`)
      stdout.write(`  Idempotency key : ${msg.idempotencyKey}\n`)
      stdout.write(`  To              : ${msg.to}\n`)
      stdout.write(`  From            : ${msg.senderNumber}\n`)
      stdout.write(`  Status          : ${msg.status}\n`)
    }

    db.close()
    return 0
  } catch (err) {
    stderr.write(`error: ${(err as Error).message}\n`)
    db.close()
    return 3
  }
}

// ---------------------------------------------------------------------------
// Command: device list / info
// ---------------------------------------------------------------------------

async function cmdDevice(
  args: string[],
  g: GlobalArgs,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): Promise<number> {
  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    printDeviceHelp(stdout)
    return args.length === 0 ? 1 : 0
  }

  const sub = args[0]
  const subArgs = args.slice(1)

  if (sub === 'list') {
    return cmdDeviceList(subArgs, g, stdout, stderr)
  } else if (sub === 'info') {
    return cmdDeviceInfo(subArgs, g, stdout, stderr)
  } else {
    stderr.write(`error: unknown device subcommand '${sub}'. Use: list | info <serial>\n`)
    return 1
  }
}

async function cmdDeviceList(
  _args: string[],
  g: GlobalArgs,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): Promise<number> {
  const dbPath = g.db ?? process.env['DB_PATH'] ?? 'dispatch.db'
  const db = openDb(dbPath, stderr)
  if (!db) return 3

  try {
    const rows = db.prepare(
      `SELECT serial, status, brand, model, battery_percent, temperature_celsius,
              ram_available_mb, storage_free_bytes, last_seen, created_at
       FROM devices
       ORDER BY status DESC, serial ASC`,
    ).all() as DeviceRow[]

    if (g.json) {
      stdout.write(JSON.stringify(rows.map(r => ({
        serial: r.serial,
        status: r.status,
        brand: r.brand,
        model: r.model,
        batteryPercent: r.battery_percent,
        temperatureCelsius: r.temperature_celsius,
        ramAvailableMb: r.ram_available_mb,
        storageFreebytes: r.storage_free_bytes,
        lastSeen: r.last_seen,
        createdAt: r.created_at,
      })), null, 2) + '\n')
    } else {
      if (rows.length === 0) {
        stdout.write('No devices found.\n')
      } else {
        const header = `${'SERIAL'.padEnd(20)} ${'STATUS'.padEnd(12)} ${'BRAND'.padEnd(12)} ${'MODEL'.padEnd(16)} LAST_SEEN`
        stdout.write(header + '\n')
        stdout.write('-'.repeat(header.length) + '\n')
        for (const r of rows) {
          stdout.write(
            `${r.serial.padEnd(20)} ${r.status.padEnd(12)} ${(r.brand ?? '—').padEnd(12)} ${(r.model ?? '—').padEnd(16)} ${r.last_seen ?? '—'}\n`,
          )
        }
      }
    }

    db.close()
    return 0
  } catch (err) {
    stderr.write(`error: ${(err as Error).message}\n`)
    db.close()
    return 3
  }
}

async function cmdDeviceInfo(
  args: string[],
  g: GlobalArgs,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): Promise<number> {
  const serial = args.find(a => !a.startsWith('-'))
  if (!serial) {
    stderr.write('error: device info requires a <serial> argument\n')
    return 1
  }

  const dbPath = g.db ?? process.env['DB_PATH'] ?? 'dispatch.db'
  const db = openDb(dbPath, stderr)
  if (!db) return 3

  try {
    const device = db.prepare(
      `SELECT serial, status, brand, model, battery_percent, temperature_celsius,
              ram_available_mb, storage_free_bytes, last_seen, created_at
       FROM devices WHERE serial = ?`,
    ).get(serial) as DeviceRow | undefined

    if (!device) {
      if (g.json) {
        stdout.write(JSON.stringify({ error: 'not_found', serial }) + '\n')
      } else {
        stderr.write(`error: device '${serial}' not found\n`)
      }
      db.close()
      return 2
    }

    const health = db.prepare(
      `SELECT battery_percent, temperature_celsius, ram_available_mb,
              storage_free_bytes, created_at
       FROM device_health
       WHERE device_serial = ?
       ORDER BY id DESC LIMIT 1`,
    ).get(serial) as HealthRow | undefined

    if (g.json) {
      stdout.write(JSON.stringify({
        device: {
          serial: device.serial,
          status: device.status,
          brand: device.brand,
          model: device.model,
          lastSeen: device.last_seen,
          createdAt: device.created_at,
        },
        lastHealth: health ? {
          batteryPercent: health.battery_percent,
          temperatureCelsius: health.temperature_celsius,
          ramAvailableMb: health.ram_available_mb,
          storageFreeBytes: health.storage_free_bytes,
          recordedAt: health.created_at,
        } : null,
      }, null, 2) + '\n')
    } else {
      stdout.write(`Device: ${serial}\n`)
      stdout.write(`  Status      : ${device.status}\n`)
      stdout.write(`  Brand       : ${device.brand ?? '—'}\n`)
      stdout.write(`  Model       : ${device.model ?? '—'}\n`)
      stdout.write(`  Last seen   : ${device.last_seen ?? '—'}\n`)
      stdout.write(`  Created at  : ${device.created_at}\n`)
      stdout.write(`\nLast Health Snapshot:\n`)
      if (health) {
        stdout.write(`  Battery     : ${health.battery_percent ?? '—'}%\n`)
        stdout.write(`  Temperature : ${health.temperature_celsius ?? '—'}°C\n`)
        stdout.write(`  RAM free    : ${health.ram_available_mb ?? '—'} MB\n`)
        stdout.write(`  Storage free: ${health.storage_free_bytes ?? '—'} B\n`)
        stdout.write(`  Recorded at : ${health.created_at}\n`)
      } else {
        stdout.write('  (no health data recorded)\n')
      }
    }

    db.close()
    return 0
  } catch (err) {
    stderr.write(`error: ${(err as Error).message}\n`)
    db.close()
    return 3
  }
}

// ---------------------------------------------------------------------------
// Command: queue stats
// ---------------------------------------------------------------------------

async function cmdQueue(
  args: string[],
  g: GlobalArgs,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): Promise<number> {
  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    printQueueHelp(stdout)
    return args.length === 0 ? 1 : 0
  }

  const sub = args[0]

  if (sub !== 'stats') {
    stderr.write(`error: unknown queue subcommand '${sub}'. Use: stats\n`)
    return 1
  }

  const dbPath = g.db ?? process.env['DB_PATH'] ?? 'dispatch.db'
  const db = openDb(dbPath, stderr)
  if (!db) return 3

  try {
    const queue = new MessageQueue(db)
    queue.initialize()
    const stats = queue.getQueueStats()

    if (g.json) {
      stdout.write(JSON.stringify(stats, null, 2) + '\n')
    } else {
      stdout.write('Queue Statistics\n')
      stdout.write('─'.repeat(40) + '\n')
      stdout.write(`  Pending              : ${stats.pending}\n`)
      stdout.write(`  Processing           : ${stats.processing}\n`)
      stdout.write(`  Failed (last 1h)     : ${stats.failedLastHour}\n`)
      stdout.write(
        `  Oldest pending age   : ${stats.oldestPendingAgeSeconds !== null ? `${stats.oldestPendingAgeSeconds}s` : '—'}\n`,
      )
    }

    db.close()
    return 0
  } catch (err) {
    stderr.write(`error: ${(err as Error).message}\n`)
    db.close()
    return 3
  }
}

// ---------------------------------------------------------------------------
// Command: replay (delegate to dispatch-replay subprocess)
// ---------------------------------------------------------------------------

async function cmdReplay(
  args: string[],
  g: GlobalArgs,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    // Pass --help through to dispatch-replay
    const result = spawnSync('dispatch-replay', ['--help'], {
      stdio: ['inherit', 'pipe', 'pipe'],
      encoding: 'utf-8',
    })
    if (result.stdout) stdout.write(result.stdout)
    if (result.stderr) stderr.write(result.stderr)
    return result.status ?? 0
  }

  // Build forwarded args: include --db if set globally
  const forwardArgs = [...args]
  if (g.db && !forwardArgs.includes('--db')) {
    forwardArgs.push('--db', g.db)
  }
  if (g.json && !forwardArgs.includes('--json')) {
    forwardArgs.push('--json')
  }

  const result = spawnSync('dispatch-replay', forwardArgs, {
    stdio: ['inherit', 'pipe', 'pipe'],
    encoding: 'utf-8',
  })

  if (result.stdout) stdout.write(result.stdout)
  if (result.stderr) stderr.write(result.stderr)

  if (result.error) {
    stderr.write(`error: failed to spawn dispatch-replay: ${result.error.message}\n`)
    return 3
  }

  return result.status ?? 0
}

// ---------------------------------------------------------------------------
// Command: keys rotate
// ---------------------------------------------------------------------------

async function cmdKeys(
  args: string[],
  g: GlobalArgs,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): Promise<number> {
  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    printKeysHelp(stdout)
    return args.length === 0 ? 1 : 0
  }

  const sub = args[0]

  if (sub !== 'rotate') {
    stderr.write(`error: unknown keys subcommand '${sub}'. Use: rotate <plugin-name>\n`)
    return 1
  }

  const pluginName = args.find((a, i) => i > 0 && !a.startsWith('-'))
  if (!pluginName) {
    stderr.write('error: keys rotate requires a <plugin-name> argument\n')
    return 1
  }

  const dbPath = g.db ?? process.env['DB_PATH'] ?? 'dispatch.db'
  const db = openDb(dbPath, stderr)
  if (!db) return 3

  try {
    const registry = new PluginRegistry(db)
    registry.initialize()

    // Verify plugin exists before attempting rotation
    const plugin = registry.getPlugin(pluginName)
    if (!plugin) {
      if (g.json) {
        stdout.write(JSON.stringify({ error: 'not_found', plugin: pluginName }) + '\n')
      } else {
        stderr.write(`error: plugin '${pluginName}' not found\n`)
      }
      db.close()
      return 2
    }

    const newKey = registry.rotateApiKey(pluginName)

    if (g.json) {
      stdout.write(JSON.stringify({ plugin: pluginName, newApiKey: newKey }) + '\n')
    } else {
      stdout.write(`Plugin : ${pluginName}\n`)
      stdout.write(`New key: ${newKey}\n`)
      stdout.write('\nWARNING: The old API key has been invalidated immediately.\n')
      stdout.write('Update the plugin configuration before the next request.\n')
    }

    db.close()
    return 0
  } catch (err) {
    stderr.write(`error: ${(err as Error).message}\n`)
    db.close()
    return 3
  }
}

// ---------------------------------------------------------------------------
// Main (exported for testing)
// ---------------------------------------------------------------------------

export async function main(
  argv: string[],
  stdout: NodeJS.WritableStream = process.stdout,
  stderr: NodeJS.WritableStream = process.stderr,
): Promise<number> {
  const g = parseGlobal(argv)

  if (g.help && !g.command) {
    printUsage(stdout)
    return 0
  }

  if (!g.command) {
    printUsage(stderr)
    return 1
  }

  switch (g.command) {
    case 'trace':
      return cmdTrace(g.rest, g, stdout, stderr)
    case 'send':
      return cmdSend(g.rest, g, stdout, stderr)
    case 'device':
      return cmdDevice(g.rest, g, stdout, stderr)
    case 'queue':
      return cmdQueue(g.rest, g, stdout, stderr)
    case 'replay':
      return cmdReplay(g.rest, g, stdout, stderr)
    case 'keys':
      return cmdKeys(g.rest, g, stdout, stderr)
    default:
      stderr.write(`error: unknown command '${g.command}'\n`)
      stderr.write("Run 'dispatch --help' for available commands.\n")
      return 1
  }
}

// ---------------------------------------------------------------------------
// Auto-run guard
// ---------------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(code => process.exit(code))
}
