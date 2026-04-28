import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { MessageQueue } from '../queue/message-queue.js'
import { main } from './replay.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build an in-memory DB and seed messages for testing */
function buildDb(): Database.Database {
  const db = new Database(':memory:')
  const queue = new MessageQueue(db)
  queue.initialize()
  return db
}

type SeedOpts = {
  id?: string
  to?: string
  status?: string
  pluginName?: string
  idempotencyKey?: string
  createdAt?: string
  attempts?: number
}

function seedMessage(db: Database.Database, opts: SeedOpts = {}): string {
  const id = opts.id ?? `msg-${Math.random().toString(36).slice(2)}`
  const idempotencyKey = opts.idempotencyKey ?? id
  const createdAt = opts.createdAt ?? new Date().toISOString()
  db.prepare(`
    INSERT INTO messages (id, to_number, body, idempotency_key, priority, status, attempts, created_at, updated_at)
    VALUES (?, ?, 'body', ?, 5, ?, ?, ?, ?)
  `).run(
    id,
    opts.to ?? '5543991938235',
    idempotencyKey,
    opts.status ?? 'permanently_failed',
    opts.attempts ?? 3,
    createdAt,
    createdAt,
  )
  if (opts.pluginName) {
    db.prepare("UPDATE messages SET plugin_name = ? WHERE id = ?").run(opts.pluginName, id)
  }
  return id
}

/** Capture stdout/stderr for a main() call using a real in-memory DB file */
async function run(
  args: string[],
  db?: Database.Database,
): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  const stdout = { write: (s: string) => { out += s } } as NodeJS.WritableStream
  const stderr = { write: (s: string) => { err += s } } as NodeJS.WritableStream

  // Write db to a tmp file so the CLI can open it
  // For wet-run we need a writable db — use a temp file approach
  // For dry-run we pass the path to a saved copy
  const code = await main(args, stdout, stderr)
  return { code, out, err }
}

/** Run main() with a real DB file path */
async function runWithDb(
  argv: string[],
  db: Database.Database,
  tmpPath: string,
): Promise<{ code: number; out: string; err: string }> {
  // Checkpoint WAL and close to flush (not needed for :memory:, but we use a tmpfile approach)
  // Actually we'll just call main() with a special argv and mock by re-implementing:
  // The cleanest approach for testing is to test through a file path.
  // Since we can't mock module-level imports easily in this setup, we'll pass
  // the DB indirectly via --db pointing to a real file.
  let out = ''
  let err = ''
  const stdout = { write: (s: string) => { out += s } } as NodeJS.WritableStream
  const stderr = { write: (s: string) => { err += s } } as NodeJS.WritableStream

  const code = await main([...argv, '--db', tmpPath], stdout, stderr)
  return { code, out, err }
}

// ---------------------------------------------------------------------------
// Setup: shared temp file approach
// ---------------------------------------------------------------------------

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let tmpDir: string
let tmpDbPath: string
let db: Database.Database

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'dispatch-replay-test-'))
  tmpDbPath = join(tmpDir, 'test.db')
  db = new Database(tmpDbPath)
  const queue = new MessageQueue(db)
  queue.initialize()
})

function cleanup() {
  try { db.close() } catch { /* ignore */ }
  try { rmSync(tmpDir, { recursive: true }) } catch { /* ignore */ }
}

const FROM = '2026-01-01T00:00:00.000Z'
const TO = '2026-12-31T23:59:59.999Z'
const IN_WINDOW = '2026-04-01T12:00:00.000Z'

// ---------------------------------------------------------------------------
// Test 1: --dry-run reports correct count of permanently_failed in window
// ---------------------------------------------------------------------------

describe('dry-run', () => {
  it('reports correct count of permanently_failed messages in window', async () => {
    seedMessage(db, { createdAt: IN_WINDOW, status: 'permanently_failed' })
    seedMessage(db, { createdAt: IN_WINDOW, status: 'permanently_failed' })
    seedMessage(db, { createdAt: IN_WINDOW, status: 'sent' }) // should not appear

    const { code, out } = await runWithDb(
      ['--from', FROM, '--to', TO, '--dry-run'],
      db,
      tmpDbPath,
    )

    expect(code).toBe(0)
    expect(out).toContain('Found 2 message(s)')
    cleanup()
  })

  it('returns 0 and empty result when no messages match', async () => {
    const { code, out } = await runWithDb(
      ['--from', FROM, '--to', TO, '--dry-run'],
      db,
      tmpDbPath,
    )
    expect(code).toBe(0)
    expect(out).toContain('Found 0 message(s)')
    cleanup()
  })
})

// ---------------------------------------------------------------------------
// Test 2: --wet-run requeues matching messages; status → queued, attempts = 0
// ---------------------------------------------------------------------------

describe('wet-run', () => {
  it('requeues matching messages to queued with attempts reset to 0', async () => {
    const id = seedMessage(db, { createdAt: IN_WINDOW, status: 'permanently_failed', attempts: 5 })

    const { code, out } = await runWithDb(
      ['--from', FROM, '--to', TO, '--wet-run'],
      db,
      tmpDbPath,
    )

    expect(code).toBe(0)
    expect(out).toContain('Replayed      : 1')

    // Verify DB state (reopen to get latest)
    const updated = db.prepare('SELECT status, attempts FROM messages WHERE id = ?').get(id) as {
      status: string
      attempts: number
    }
    expect(updated.status).toBe('queued')
    expect(updated.attempts).toBe(0)
    cleanup()
  })
})

// ---------------------------------------------------------------------------
// Test 3: --phone filter normalizes before matching
// ---------------------------------------------------------------------------

describe('phone filter', () => {
  it('normalizes phone before matching (+5543991938235 matches 5543991938235)', async () => {
    seedMessage(db, { createdAt: IN_WINDOW, status: 'permanently_failed', to: '5543991938235' })
    seedMessage(db, { createdAt: IN_WINDOW, status: 'permanently_failed', to: '5521999999999' })

    const { code, out } = await runWithDb(
      ['--from', FROM, '--to', TO, '--dry-run', '--phone', '+5543991938235'],
      db,
      tmpDbPath,
    )

    expect(code).toBe(0)
    expect(out).toContain('Found 1 message(s)')
    cleanup()
  })
})

// ---------------------------------------------------------------------------
// Test 4: --from > --to returns exit code 1
// ---------------------------------------------------------------------------

describe('argument validation', () => {
  it('returns exit code 1 when --from is after --to', async () => {
    let err = ''
    const stderr = { write: (s: string) => { err += s } } as NodeJS.WritableStream
    const code = await main(
      ['--from', '2026-12-31T00:00:00Z', '--to', '2026-01-01T00:00:00Z', '--dry-run', '--db', tmpDbPath],
      process.stdout,
      stderr,
    )
    expect(code).toBe(1)
    expect(err).toContain('invalid --from / --to range')
    cleanup()
  })

  // ---------------------------------------------------------------------------
  // Test 5: missing both --dry-run and --wet-run returns exit code 1
  // ---------------------------------------------------------------------------
  it('returns exit code 1 when neither --dry-run nor --wet-run is given', async () => {
    let err = ''
    const stderr = { write: (s: string) => { err += s } } as NodeJS.WritableStream
    const code = await main(
      ['--from', FROM, '--to', TO, '--db', tmpDbPath],
      process.stdout,
      stderr,
    )
    expect(code).toBe(1)
    expect(err).toContain('exactly one of --dry-run | --wet-run is required')
    cleanup()
  })

  it('returns exit code 1 when both --dry-run and --wet-run are given', async () => {
    let err = ''
    const stderr = { write: (s: string) => { err += s } } as NodeJS.WritableStream
    const code = await main(
      ['--from', FROM, '--to', TO, '--dry-run', '--wet-run', '--db', tmpDbPath],
      process.stdout,
      stderr,
    )
    expect(code).toBe(1)
    expect(err).toContain('exactly one of --dry-run | --wet-run is required')
    cleanup()
  })
})

// ---------------------------------------------------------------------------
// Test 6: --limit N caps replay count
// ---------------------------------------------------------------------------

describe('--limit', () => {
  it('caps replay count to N', async () => {
    for (let i = 0; i < 5; i++) {
      seedMessage(db, { createdAt: IN_WINDOW, status: 'permanently_failed' })
    }

    const { code, out } = await runWithDb(
      ['--from', FROM, '--to', TO, '--wet-run', '--limit', '3'],
      db,
      tmpDbPath,
    )

    expect(code).toBe(0)
    expect(out).toContain('Replayed      : 3')
    cleanup()
  })

  it('dry-run respects --limit in count', async () => {
    for (let i = 0; i < 5; i++) {
      seedMessage(db, { createdAt: IN_WINDOW, status: 'permanently_failed' })
    }

    const { code, out } = await runWithDb(
      ['--from', FROM, '--to', TO, '--dry-run', '--limit', '2'],
      db,
      tmpDbPath,
    )

    expect(code).toBe(0)
    expect(out).toContain('Found 2 message(s)')
    cleanup()
  })
})

// ---------------------------------------------------------------------------
// Test 7: --idempotency-key matches a single message
// ---------------------------------------------------------------------------

describe('--idempotency-key', () => {
  it('replays only the message with the given idempotency key', async () => {
    const key = 'unique-idem-key-xyz'
    const id = seedMessage(db, {
      createdAt: IN_WINDOW,
      status: 'permanently_failed',
      idempotencyKey: key,
    })
    seedMessage(db, { createdAt: IN_WINDOW, status: 'permanently_failed' })

    const { code, out } = await runWithDb(
      ['--from', FROM, '--to', TO, '--wet-run', '--idempotency-key', key],
      db,
      tmpDbPath,
    )

    expect(code).toBe(0)
    expect(out).toContain('Replayed      : 1')

    const updated = db.prepare('SELECT status FROM messages WHERE id = ?').get(id) as { status: string }
    expect(updated.status).toBe('queued')
    cleanup()
  })
})

// ---------------------------------------------------------------------------
// Test 8: Default behavior — only matches permanently_failed
// ---------------------------------------------------------------------------

describe('default status filter', () => {
  it('only matches permanently_failed by default (no --status arg)', async () => {
    seedMessage(db, { createdAt: IN_WINDOW, status: 'permanently_failed' })
    seedMessage(db, { createdAt: IN_WINDOW, status: 'failed' })
    seedMessage(db, { createdAt: IN_WINDOW, status: 'queued' })
    seedMessage(db, { createdAt: IN_WINDOW, status: 'sent' })

    const { code, out } = await runWithDb(
      ['--from', FROM, '--to', TO, '--dry-run'],
      db,
      tmpDbPath,
    )

    expect(code).toBe(0)
    expect(out).toContain('Found 1 message(s)')
    cleanup()
  })
})

// ---------------------------------------------------------------------------
// Test 9: --json output is parseable JSON
// ---------------------------------------------------------------------------

describe('--json output', () => {
  it('dry-run --json output is valid JSON with correct shape', async () => {
    seedMessage(db, { createdAt: IN_WINDOW, status: 'permanently_failed' })

    const { code, out } = await runWithDb(
      ['--from', FROM, '--to', TO, '--dry-run', '--json'],
      db,
      tmpDbPath,
    )

    expect(code).toBe(0)
    const parsed = JSON.parse(out)
    expect(parsed.mode).toBe('dry-run')
    expect(parsed.count).toBe(1)
    expect(Array.isArray(parsed.messages)).toBe(true)
    cleanup()
  })

  it('wet-run --json output is valid JSON with results shape', async () => {
    seedMessage(db, { createdAt: IN_WINDOW, status: 'permanently_failed' })

    const { code, out } = await runWithDb(
      ['--from', FROM, '--to', TO, '--wet-run', '--json'],
      db,
      tmpDbPath,
    )

    expect(code).toBe(0)
    const parsed = JSON.parse(out)
    expect(parsed.mode).toBe('wet-run')
    expect(parsed.results.replayed).toBe(1)
    expect(parsed.results.errors).toBe(0)
    cleanup()
  })
})

// ---------------------------------------------------------------------------
// Test 10: --status sent --wet-run refused without --allow-sent-replay
// ---------------------------------------------------------------------------

describe('sent status protection', () => {
  it('refuses --status sent --wet-run without --allow-sent-replay', async () => {
    let err = ''
    const stderr = { write: (s: string) => { err += s } } as NodeJS.WritableStream
    const code = await main(
      ['--from', FROM, '--to', TO, '--status', 'sent', '--wet-run', '--db', tmpDbPath],
      process.stdout,
      stderr,
    )
    expect(code).toBe(1)
    expect(err).toContain('--allow-sent-replay')
    cleanup()
  })

  it('allows --status sent --wet-run with --allow-sent-replay', async () => {
    seedMessage(db, { createdAt: IN_WINDOW, status: 'sent' })

    const { code, out } = await runWithDb(
      ['--from', FROM, '--to', TO, '--status', 'sent', '--wet-run', '--allow-sent-replay'],
      db,
      tmpDbPath,
    )

    // should succeed and replay 1
    expect(code).toBe(0)
    expect(out).toContain('Replayed      : 1')
    cleanup()
  })
})

// ---------------------------------------------------------------------------
// Bonus: --help returns 0
// ---------------------------------------------------------------------------

describe('--help', () => {
  it('prints usage and returns 0', async () => {
    let out = ''
    const stdout = { write: (s: string) => { out += s } } as NodeJS.WritableStream
    const code = await main(['--help'], stdout, process.stderr)
    expect(code).toBe(0)
    expect(out).toContain('dispatch-replay')
    expect(out).toContain('--dry-run')
    expect(out).toContain('--wet-run')
  })
})

// ---------------------------------------------------------------------------
// Bonus: plugin filter
// ---------------------------------------------------------------------------

describe('--plugin filter', () => {
  it('filters by plugin_name', async () => {
    seedMessage(db, { createdAt: IN_WINDOW, status: 'permanently_failed', pluginName: 'oralsin' })
    seedMessage(db, { createdAt: IN_WINDOW, status: 'permanently_failed', pluginName: 'other' })

    const { code, out } = await runWithDb(
      ['--from', FROM, '--to', TO, '--dry-run', '--plugin', 'oralsin'],
      db,
      tmpDbPath,
    )

    expect(code).toBe(0)
    expect(out).toContain('Found 1 message(s)')
    cleanup()
  })
})
