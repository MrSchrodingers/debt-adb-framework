import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { gunzip } from 'node:zlib'
import { promisify } from 'node:util'
import { randomBytes } from 'node:crypto'
import {
  encryptAuditBuffer,
  decryptAuditBuffer,
  roundTrip,
  shipAuditLog,
} from './audit-shipper.js'

const gunzipAsync = promisify(gunzip)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor TEXT NOT NULL DEFAULT 'api',
      action TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT,
      before_state TEXT,
      after_state TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `)
  return db
}

function insertAuditRow(db: Database.Database, action: string, createdAt: string): void {
  db.prepare(
    `INSERT INTO audit_log (actor, action, resource_type, resource_id, before_state, after_state, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('test', action, 'message', 'msg-1', null, null, createdAt)
}

const TEST_KEY_HEX = randomBytes(32).toString('hex') // 64-char hex

// ---------------------------------------------------------------------------
// Encryption unit tests
// ---------------------------------------------------------------------------

describe('encryptAuditBuffer / decryptAuditBuffer', () => {
  it('round-trip encrypt → decrypt returns original plaintext', () => {
    const key = Buffer.from(TEST_KEY_HEX, 'hex')
    const plaintext = Buffer.from('Hello, audit world!', 'utf8')
    const encrypted = encryptAuditBuffer(plaintext, key)
    const decrypted = decryptAuditBuffer(encrypted, key)
    expect(decrypted.toString('utf8')).toBe('Hello, audit world!')
  })

  it('encrypted output is larger than plaintext (IV + tag overhead)', () => {
    const key = Buffer.from(TEST_KEY_HEX, 'hex')
    const plaintext = Buffer.from('x'.repeat(100), 'utf8')
    const encrypted = encryptAuditBuffer(plaintext, key)
    // 12 bytes IV + 16 bytes auth tag = 28 bytes overhead minimum
    expect(encrypted.length).toBeGreaterThan(plaintext.length + 27)
  })

  it('two encryptions of same plaintext produce different ciphertext (random IV)', () => {
    const key = Buffer.from(TEST_KEY_HEX, 'hex')
    const plaintext = Buffer.from('same content', 'utf8')
    const enc1 = encryptAuditBuffer(plaintext, key)
    const enc2 = encryptAuditBuffer(plaintext, key)
    // First 12 bytes (IV) should differ with overwhelming probability
    expect(enc1.subarray(0, 12).equals(enc2.subarray(0, 12))).toBe(false)
  })

  it('tampered auth tag causes decryption to throw', () => {
    const key = Buffer.from(TEST_KEY_HEX, 'hex')
    const encrypted = encryptAuditBuffer(Buffer.from('secret', 'utf8'), key)
    // Flip a byte in the auth tag (last 16 bytes)
    encrypted[encrypted.length - 1] ^= 0xff
    expect(() => decryptAuditBuffer(encrypted, key)).toThrow()
  })
})

// ---------------------------------------------------------------------------
// Round-trip (gzip + encrypt + decrypt + gunzip)
// ---------------------------------------------------------------------------

describe('roundTrip', () => {
  it('gzip + encrypt + decrypt + gunzip restores original string', async () => {
    const payload = JSON.stringify({ action: 'enqueue', resource: 'message' })
    const result = await roundTrip(payload, TEST_KEY_HEX)
    expect(result).toBe(payload)
  })

  it('handles multi-line JSON payload', async () => {
    const lines = Array.from({ length: 50 }, (_, i) =>
      JSON.stringify({ id: i, action: 'tick' }),
    ).join('\n')
    const result = await roundTrip(lines, TEST_KEY_HEX)
    expect(result).toBe(lines)
  })
})

// ---------------------------------------------------------------------------
// shipAuditLog — no-op conditions (no S3 calls needed)
// ---------------------------------------------------------------------------

describe('shipAuditLog — no-op conditions', () => {
  beforeEach(() => {
    delete process.env['DISPATCH_AUDIT_S3_BUCKET']
    delete process.env['DISPATCH_AUDIT_ENCRYPTION_KEY']
  })

  it('is a no-op when DISPATCH_AUDIT_S3_BUCKET is unset', async () => {
    const db = buildDb()
    const result = await shipAuditLog(new Date(), db)
    expect(result.uploaded).toBe(false)
    expect(result.key).toBe('')
  })

  it('is a no-op when DISPATCH_AUDIT_ENCRYPTION_KEY is unset, emits warning', async () => {
    process.env['DISPATCH_AUDIT_S3_BUCKET'] = 'my-bucket'
    const db = buildDb()
    const warns: string[] = []
    const result = await shipAuditLog(new Date(), db, {
      warn: (m: string) => warns.push(m),
      info: () => {},
    })
    expect(result.uploaded).toBe(false)
    expect(warns.some(w => w.includes('DISPATCH_AUDIT_ENCRYPTION_KEY'))).toBe(true)
  })

  it('is a no-op when encryption key is the wrong length, emits warning', async () => {
    process.env['DISPATCH_AUDIT_S3_BUCKET'] = 'my-bucket'
    process.env['DISPATCH_AUDIT_ENCRYPTION_KEY'] = 'tooshort'
    const db = buildDb()
    const warns: string[] = []
    const result = await shipAuditLog(new Date(), db, {
      warn: (m: string) => warns.push(m),
      info: () => {},
    })
    expect(result.uploaded).toBe(false)
    expect(warns.some(w => w.includes('64-char'))).toBe(true)
  })

  it('is a no-op when no rows exist for the UTC date window, emits info', async () => {
    process.env['DISPATCH_AUDIT_S3_BUCKET'] = 'my-bucket'
    process.env['DISPATCH_AUDIT_ENCRYPTION_KEY'] = TEST_KEY_HEX
    const db = buildDb()
    const infos: string[] = []
    const result = await shipAuditLog(new Date('2020-01-01'), db, {
      warn: () => {},
      info: (m: string) => infos.push(m),
    })
    expect(result.uploaded).toBe(false)
    expect(infos.some(m => m.includes('skipping upload'))).toBe(true)
  })

  it('s3Key format is YYYY-MM-DD.gz.enc (correct UTC date)', async () => {
    process.env['DISPATCH_AUDIT_S3_BUCKET'] = 'my-bucket'
    process.env['DISPATCH_AUDIT_ENCRYPTION_KEY'] = TEST_KEY_HEX
    const db = buildDb()

    // No rows for this old date → returns early without S3 call
    const result = await shipAuditLog(new Date('2024-03-15T12:00:00Z'), db)
    expect(result.key).toBe('2024-03-15.gz.enc')
    expect(result.uploaded).toBe(false) // no rows, so no upload
  })
})

// ---------------------------------------------------------------------------
// shipAuditLog — S3 upload path (mock S3Client.send)
// ---------------------------------------------------------------------------

describe('shipAuditLog — S3 upload', () => {
  beforeEach(() => {
    process.env['DISPATCH_AUDIT_S3_BUCKET'] = 'dispatch-audit-test'
    process.env['DISPATCH_AUDIT_ENCRYPTION_KEY'] = TEST_KEY_HEX
  })

  afterEach(() => {
    delete process.env['DISPATCH_AUDIT_S3_BUCKET']
    delete process.env['DISPATCH_AUDIT_ENCRYPTION_KEY']
    vi.restoreAllMocks()
  })

  it('calls S3 PutObjectCommand with correct bucket + key and returns bytes > 0', async () => {
    const putCalls: unknown[] = []

    // Patch S3Client at the module level via vi.doMock or by monkey-patching the class
    // Simpler: use vi.spyOn on the S3Client prototype after importing the module
    const s3Module = await import('@aws-sdk/client-s3')
    vi.spyOn(s3Module.S3Client.prototype, 'send').mockImplementation(async (cmd: unknown) => {
      putCalls.push(cmd)
      return {}
    })

    const db = buildDb()
    const now = new Date()
    const todayStart = new Date(now)
    todayStart.setUTCHours(0, 0, 0, 0)

    insertAuditRow(db, 'enqueue', new Date(todayStart.getTime() + 1000).toISOString())
    insertAuditRow(db, 'send', new Date(todayStart.getTime() + 3600_000).toISOString())

    const result = await shipAuditLog(now, db)

    expect(result.uploaded).toBe(true)
    expect(result.bytes).toBeGreaterThan(0)
    expect(result.key).toMatch(/^\d{4}-\d{2}-\d{2}\.gz\.enc$/)
    expect(putCalls.length).toBe(1)

    // Verify the uploaded bytes decrypt + decompress back to valid JSON lines
    const cmd = putCalls[0] as { input: { Body: Buffer; Bucket: string; Key: string } }
    expect(cmd.input.Bucket).toBe('dispatch-audit-test')

    const decrypted = decryptAuditBuffer(cmd.input.Body, Buffer.from(TEST_KEY_HEX, 'hex'))
    const decompressed = await gunzipAsync(decrypted)
    const lines = decompressed.toString('utf8').split('\n')
    expect(lines.length).toBe(2)
    const first = JSON.parse(lines[0]) as { action: string }
    expect(first.action).toBe('enqueue')
  })
})
