import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { MessageQueue } from '../queue/message-queue.js'
import { PluginRegistry } from '../plugins/plugin-registry.js'
import { main } from './dispatch.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** In-memory DB with all tables initialised */
function buildDb(): Database.Database {
  const db = new Database(':memory:')
  const queue = new MessageQueue(db)
  queue.initialize()

  // Create devices + device_health tables (normally created by DeviceManager)
  db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      serial TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'offline',
      brand TEXT,
      model TEXT,
      battery_percent REAL,
      temperature_celsius REAL,
      ram_available_mb REAL,
      storage_free_bytes INTEGER,
      last_seen TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS device_health (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_serial TEXT NOT NULL,
      battery_percent REAL,
      temperature_celsius REAL,
      ram_available_mb REAL,
      storage_free_bytes INTEGER,
      wifi_connected INTEGER,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `)

  const registry = new PluginRegistry(db)
  registry.initialize()

  return db
}

/**
 * Run helper: invokes the CLI with the given args, optionally
 * injecting an in-process DB so commands run against the test's
 * in-memory SQLite handle without copying it to /tmp first.
 *
 * The previous version used `db.backup(tmpPath)` to a randomly-named
 * file in /tmp, then passed `--db <path>` to the CLI. Under Vitest
 * parallel workers this raced — multiple tests writing to /tmp at
 * the same time, plus the `Math.random()` filename and async backup
 * timing, produced an intermittent flake on the trace test ("prints
 * timeline for existing message with events"). The CLI now accepts
 * a `Database` handle directly via `main()`'s 4th argument; the
 * helper just forwards.
 */
async function run(
  args: string[],
  db?: Database.Database,
): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  const stdout = { write: (s: string) => { out += s } } as NodeJS.WritableStream
  const stderr = { write: (s: string) => { err += s } } as NodeJS.WritableStream
  const code = await main(args, stdout, stderr, db)
  return { code, out, err }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dispatch CLI', () => {
  describe('--help / no command', () => {
    it('prints usage and exits 0 with --help', async () => {
      const { code, out } = await run(['--help'])
      expect(code).toBe(0)
      expect(out).toContain('dispatch')
      expect(out).toContain('trace')
      expect(out).toContain('send')
    })

    it('exits 1 when no command given', async () => {
      const { code } = await run([])
      expect(code).toBe(1)
    })

    it('exits 1 for unknown command', async () => {
      const { code, err } = await run(['frobnicate'])
      expect(code).toBe(1)
      expect(err).toContain("unknown command 'frobnicate'")
    })
  })

  // trace ──────────────────────────────────────────────────────────────────

  describe('trace', () => {
    it('exits 2 when message not found', async () => {
      const db = buildDb()
      const { code, err } = await run(['trace', 'no-such-id'], db)
      expect(code).toBe(2)
      expect(err).toContain('no message or events found')
    })

    it('prints timeline for existing message with events', async () => {
      const db = buildDb()
      const queue = new MessageQueue(db)
      const msg = queue.enqueue({ to: '5543991938235', body: 'hello', idempotencyKey: 'ik-trace-1' })
      db.prepare('INSERT INTO message_events (message_id, event, metadata) VALUES (?, ?, ?)').run(
        msg.id, 'send:start', JSON.stringify({ device: 'serial1' }),
      )

      const { code, out } = await run(['trace', msg.id], db)
      expect(code).toBe(0)
      expect(out).toContain(msg.id)
      expect(out).toContain('send:start')
      expect(out).toContain('Timeline')
    })

    it('outputs JSON with --json flag', async () => {
      const db = buildDb()
      const queue = new MessageQueue(db)
      const msg = queue.enqueue({ to: '5543991938235', body: 'hello', idempotencyKey: 'ik-trace-json' })

      const { code, out } = await run(['trace', msg.id, '--json'], db)
      expect(code).toBe(0)
      const parsed = JSON.parse(out) as { messageId: string; events: unknown[] }
      expect(parsed.messageId).toBe(msg.id)
      expect(Array.isArray(parsed.events)).toBe(true)
    })

    it('returns 1 without message-id argument', async () => {
      const db = buildDb()
      const { code, err } = await run(['trace'], db)
      expect(code).toBe(1)
      expect(err).toContain('requires a <message-id>')
    })
  })

  // send ──────────────────────────────────────────────────────────────────

  describe('send', () => {
    it('enqueues a message and prints the ID', async () => {
      const db = buildDb()
      const { code, out } = await run(
        ['send', '--to', '5543991938235', '--from', '5541999990000', '--body', 'test msg'],
        db,
      )
      expect(code).toBe(0)
      expect(out).toContain('Enqueued')
      expect(out).toContain('ID')
    })

    it('outputs JSON with --json flag', async () => {
      const db = buildDb()
      const { code, out } = await run(
        ['send', '--json', '--to', '5543991938235', '--from', '5541999990000', '--body', 'hi'],
        db,
      )
      expect(code).toBe(0)
      const parsed = JSON.parse(out) as { id: string; idempotencyKey: string }
      expect(typeof parsed.id).toBe('string')
      expect(typeof parsed.idempotencyKey).toBe('string')
    })

    it('exits 1 when --to is missing', async () => {
      const db = buildDb()
      const { code, err } = await run(['send', '--from', '5541999990000', '--body', 'test'], db)
      expect(code).toBe(1)
      expect(err).toContain('--to is required')
    })

    it('exits 1 when --from is missing', async () => {
      const db = buildDb()
      const { code, err } = await run(['send', '--to', '5543991938235', '--body', 'test'], db)
      expect(code).toBe(1)
      expect(err).toContain('--from is required')
    })

    it('exits 1 when --body is missing', async () => {
      const db = buildDb()
      const { code, err } = await run(['send', '--to', '5543991938235', '--from', '5541999990000'], db)
      expect(code).toBe(1)
      expect(err).toContain('--body is required')
    })
  })

  // device list ──────────────────────────────────────────────────────────

  describe('device list', () => {
    it('prints "No devices found" when table is empty', async () => {
      const db = buildDb()
      const { code, out } = await run(['device', 'list'], db)
      expect(code).toBe(0)
      expect(out).toContain('No devices found')
    })

    it('lists devices when present', async () => {
      const db = buildDb()
      db.prepare(`
        INSERT INTO devices (serial, status, brand, model) VALUES ('ABC123', 'online', 'Samsung', 'A52')
      `).run()

      const { code, out } = await run(['device', 'list'], db)
      expect(code).toBe(0)
      expect(out).toContain('ABC123')
      expect(out).toContain('online')
    })

    it('outputs JSON with --json flag', async () => {
      const db = buildDb()
      db.prepare(`INSERT INTO devices (serial, status) VALUES ('SER1', 'offline')`).run()
      const { code, out } = await run(['device', 'list', '--json'], db)
      expect(code).toBe(0)
      const parsed = JSON.parse(out) as unknown[]
      expect(Array.isArray(parsed)).toBe(true)
    })
  })

  // device info ──────────────────────────────────────────────────────────

  describe('device info', () => {
    it('exits 2 for unknown serial', async () => {
      const db = buildDb()
      const { code, err } = await run(['device', 'info', 'UNKNOWN'], db)
      expect(code).toBe(2)
      expect(err).toContain('not found')
    })

    it('prints full device info + health snapshot', async () => {
      const db = buildDb()
      db.prepare(`
        INSERT INTO devices (serial, status, brand, model) VALUES ('DEV1', 'online', 'Google', 'Pixel 6')
      `).run()
      db.prepare(`
        INSERT INTO device_health (device_serial, battery_percent, temperature_celsius, ram_available_mb)
        VALUES ('DEV1', 87, 32.5, 1024)
      `).run()

      const { code, out } = await run(['device', 'info', 'DEV1'], db)
      expect(code).toBe(0)
      expect(out).toContain('DEV1')
      expect(out).toContain('online')
      expect(out).toContain('87')
    })

    it('outputs JSON with --json flag', async () => {
      const db = buildDb()
      db.prepare(`INSERT INTO devices (serial, status) VALUES ('DEV2', 'online')`).run()
      const { code, out } = await run(['device', 'info', 'DEV2', '--json'], db)
      expect(code).toBe(0)
      const parsed = JSON.parse(out) as { device: { serial: string }; lastHealth: unknown }
      expect(parsed.device.serial).toBe('DEV2')
    })
  })

  // queue stats ──────────────────────────────────────────────────────────

  describe('queue stats', () => {
    it('prints queue statistics table', async () => {
      const db = buildDb()
      const queue = new MessageQueue(db)
      queue.enqueue({ to: '5543991938235', body: 'msg1', idempotencyKey: 'qs-1' })
      queue.enqueue({ to: '5543991938235', body: 'msg2', idempotencyKey: 'qs-2' })

      const { code, out } = await run(['queue', 'stats'], db)
      expect(code).toBe(0)
      expect(out).toContain('Pending')
      expect(out).toContain('2')
    })

    it('outputs JSON with --json flag', async () => {
      const db = buildDb()
      const { code, out } = await run(['queue', 'stats', '--json'], db)
      expect(code).toBe(0)
      const parsed = JSON.parse(out) as { pending: number; processing: number }
      expect(typeof parsed.pending).toBe('number')
      expect(typeof parsed.processing).toBe('number')
    })

    it('exits 1 for unknown queue subcommand', async () => {
      const db = buildDb()
      const { code, err } = await run(['queue', 'unknown'], db)
      expect(code).toBe(1)
      expect(err).toContain('unknown queue subcommand')
    })
  })

  // keys rotate ──────────────────────────────────────────────────────────

  describe('keys rotate', () => {
    it('exits 2 when plugin not found', async () => {
      const db = buildDb()
      const { code, err } = await run(['keys', 'rotate', 'no-such-plugin'], db)
      expect(code).toBe(2)
      expect(err).toContain('not found')
    })

    it('rotates key and prints new key + warning', async () => {
      const db = buildDb()
      const registry = new PluginRegistry(db)
      registry.initialize()
      registry.register({
        name: 'test-plugin',
        version: '1.0.0',
        webhookUrl: 'https://example.com/cb',
        apiKey: 'old-key-12345',
        hmacSecret: 'secret-abc',
        events: ['message:sent'],
      })

      const { code, out } = await run(['keys', 'rotate', 'test-plugin'], db)
      expect(code).toBe(0)
      expect(out).toContain('test-plugin')
      expect(out).toContain('New key')
      expect(out).toContain('WARNING')
    })

    it('outputs JSON with --json flag', async () => {
      const db = buildDb()
      const registry = new PluginRegistry(db)
      registry.initialize()
      registry.register({
        name: 'json-plugin',
        version: '1.0.0',
        webhookUrl: 'https://example.com/cb',
        apiKey: 'old-key-json',
        hmacSecret: 'secret-xyz',
        events: [],
      })

      const { code, out } = await run(['keys', 'rotate', 'json-plugin', '--json'], db)
      expect(code).toBe(0)
      const parsed = JSON.parse(out) as { plugin: string; newApiKey: string }
      expect(parsed.plugin).toBe('json-plugin')
      expect(typeof parsed.newApiKey).toBe('string')
      expect(parsed.newApiKey.length).toBeGreaterThan(8)
    })

    it('exits 1 when plugin name is missing', async () => {
      const db = buildDb()
      const { code, err } = await run(['keys', 'rotate'], db)
      expect(code).toBe(1)
      expect(err).toContain('requires a <plugin-name>')
    })
  })

  // device (no subcommand) ────────────────────────────────────────────────

  describe('device (edge cases)', () => {
    it('exits 1 and shows help when no subcommand given', async () => {
      const db = buildDb()
      const { code, out } = await run(['device'], db)
      expect(code).toBe(1)
      expect(out).toContain('SUBCOMMANDS')
    })

    it('exits 1 for unknown device subcommand', async () => {
      const db = buildDb()
      const { code, err } = await run(['device', 'foobar'], db)
      expect(code).toBe(1)
      expect(err).toContain('unknown device subcommand')
    })
  })
})
