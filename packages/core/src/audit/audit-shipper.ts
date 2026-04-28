/**
 * audit-shipper.ts — Daily audit log shipping to S3-compatible storage.
 *
 * Behaviour:
 *  - Queries audit_log rows for the given UTC date (midnight→midnight).
 *  - JSON-serialises them, gzip-compresses with Node's built-in zlib.
 *  - Encrypts the gzip bytes with AES-256-GCM (random IV per upload).
 *  - Uploads to s3://${DISPATCH_AUDIT_S3_BUCKET}/${ISO-date}.gz.enc
 *    via @aws-sdk/client-s3 (PutObjectCommand).
 *
 * No-op conditions (returns { uploaded: false }):
 *  - DISPATCH_AUDIT_S3_BUCKET is unset.
 *  - DISPATCH_AUDIT_ENCRYPTION_KEY is unset or wrong length (logs a warning).
 *
 * Encryption wire format:
 *  [ 12-byte random IV | AES-GCM ciphertext | 16-byte auth-tag ]
 *
 * Environment variables consumed:
 *  DISPATCH_AUDIT_S3_BUCKET     — target bucket name
 *  DISPATCH_AUDIT_ENCRYPTION_KEY — 32-byte hex (64 chars), AES-256 key
 *  AWS_REGION                   — defaults to us-east-1
 *  AWS_ACCESS_KEY_ID            — picked up automatically by AWS SDK
 *  AWS_SECRET_ACCESS_KEY        — picked up automatically by AWS SDK
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { gzip, gunzip } from 'node:zlib'
import { promisify } from 'node:util'
import type Database from 'better-sqlite3'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'

const gzipAsync = promisify(gzip)
const gunzipAsync = promisify(gunzip)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ShipResult {
  uploaded: boolean
  key: string
  bytes: number
}

interface AuditRow {
  id: number
  actor: string
  action: string
  resource_type: string
  resource_id: string | null
  before_state: string | null
  after_state: string | null
  created_at: string
}

// ---------------------------------------------------------------------------
// Encryption / decryption helpers (exported for testing)
// ---------------------------------------------------------------------------

/**
 * AES-256-GCM encrypt.
 * Returns a buffer: [ IV (12 bytes) | ciphertext | auth-tag (16 bytes) ]
 */
export function encryptAuditBuffer(plaintext: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const authTag = cipher.getAuthTag() // always 16 bytes
  return Buffer.concat([iv, encrypted, authTag])
}

/**
 * AES-256-GCM decrypt — inverse of encryptAuditBuffer.
 * Throws if the auth tag is invalid (tampered data).
 */
export function decryptAuditBuffer(encrypted: Buffer, key: Buffer): Buffer {
  const iv = encrypted.subarray(0, 12)
  const authTag = encrypted.subarray(encrypted.length - 16)
  const cipherText = encrypted.subarray(12, encrypted.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(cipherText), decipher.final()])
}

// ---------------------------------------------------------------------------
// Round-trip helper (gzip + encrypt → decrypt + gunzip) — exported for tests
// ---------------------------------------------------------------------------

export async function roundTrip(plaintext: string, keyHex: string): Promise<string> {
  const key = Buffer.from(keyHex, 'hex')
  const compressed = await gzipAsync(Buffer.from(plaintext, 'utf8'))
  const encrypted = encryptAuditBuffer(compressed, key)
  const decrypted = decryptAuditBuffer(encrypted, key)
  const decompressed = await gunzipAsync(decrypted)
  return decompressed.toString('utf8')
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function shipAuditLog(
  date: Date,
  db: Database.Database,
  logger?: { warn: (msg: string) => void; info: (msg: string) => void },
): Promise<ShipResult> {
  const bucket = process.env['DISPATCH_AUDIT_S3_BUCKET']
  const keyHex = process.env['DISPATCH_AUDIT_ENCRYPTION_KEY']

  // No-op: bucket not configured
  if (!bucket) {
    return { uploaded: false, key: '', bytes: 0 }
  }

  // No-op: encryption key not configured
  if (!keyHex) {
    logger?.warn('DISPATCH_AUDIT_ENCRYPTION_KEY is unset — skipping audit log upload')
    return { uploaded: false, key: '', bytes: 0 }
  }

  if (keyHex.length !== 64) {
    logger?.warn(
      `DISPATCH_AUDIT_ENCRYPTION_KEY must be a 64-char hex string (32 bytes). Got ${keyHex.length} chars — skipping.`,
    )
    return { uploaded: false, key: '', bytes: 0 }
  }

  const encKey = Buffer.from(keyHex, 'hex')

  // Build UTC day window for `date`
  const dayStart = new Date(date)
  dayStart.setUTCHours(0, 0, 0, 0)
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000)

  const isoDate = dayStart.toISOString().slice(0, 10)
  const s3Key = `${isoDate}.gz.enc`

  // Query rows in the window
  const rows = db.prepare(
    `SELECT id, actor, action, resource_type, resource_id, before_state, after_state, created_at
     FROM audit_log
     WHERE created_at >= ? AND created_at < ?
     ORDER BY id ASC`,
  ).all(dayStart.toISOString(), dayEnd.toISOString()) as AuditRow[]

  if (rows.length === 0) {
    logger?.info(`No audit log rows for ${isoDate} — skipping upload`)
    return { uploaded: false, key: s3Key, bytes: 0 }
  }

  // Serialize as JSON lines (one object per row)
  const jsonPayload = rows
    .map(r =>
      JSON.stringify({
        id: r.id,
        actor: r.actor,
        action: r.action,
        resourceType: r.resource_type,
        resourceId: r.resource_id,
        beforeState: r.before_state,
        afterState: r.after_state,
        createdAt: r.created_at,
      }),
    )
    .join('\n')

  // Compress
  const compressed = await gzipAsync(Buffer.from(jsonPayload, 'utf8'))

  // Encrypt
  const encryptedBytes = encryptAuditBuffer(compressed, encKey)

  // Upload to S3
  const region = process.env['AWS_REGION'] ?? 'us-east-1'
  const s3 = new S3Client({ region })

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: s3Key,
      Body: encryptedBytes,
      ContentType: 'application/octet-stream',
      ContentLength: encryptedBytes.length,
      Metadata: {
        'dispatch-audit-date': isoDate,
        'dispatch-rows': String(rows.length),
        'dispatch-encryption': 'aes-256-gcm',
      },
    }),
  )

  logger?.info(
    `Shipped ${rows.length} audit log rows to s3://${bucket}/${s3Key} (${encryptedBytes.length} bytes)`,
  )

  return { uploaded: true, key: s3Key, bytes: encryptedBytes.length }
}
