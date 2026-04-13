import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { MessageQueue } from './message-queue.js'
import type { Message } from './types.js'

describe('MessageQueue', () => {
  let db: Database.Database
  let queue: MessageQueue

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    queue = new MessageQueue(db)
    queue.initialize()
  })

  afterEach(() => {
    db.close()
  })

  describe('enqueue', () => {
    it('creates a message with status queued', () => {
      const msg = queue.enqueue({
        to: '5543991938235',
        body: 'Hello from test',
        idempotencyKey: 'test-key-1',
      })

      expect(msg.status).toBe('queued')
      expect(msg.to).toBe('5543991938235')
      expect(msg.body).toBe('Hello from test')
    })

    it('returns message with generated id', () => {
      const msg = queue.enqueue({
        to: '5543991938235',
        body: 'Hello',
        idempotencyKey: 'test-key-2',
      })

      expect(msg.id).toBeDefined()
      expect(typeof msg.id).toBe('string')
      expect(msg.id.length).toBeGreaterThan(0)
    })

    it('sets createdAt and updatedAt timestamps', () => {
      const msg = queue.enqueue({
        to: '5543991938235',
        body: 'Hello',
        idempotencyKey: 'test-key-3',
      })

      expect(msg.createdAt).toBeDefined()
      expect(msg.updatedAt).toBeDefined()
    })

    it('assigns default priority 5 when not specified', () => {
      const msg = queue.enqueue({
        to: '5543991938235',
        body: 'Hello',
        idempotencyKey: 'test-key-4',
      })

      expect(msg.priority).toBe(5)
    })

    it('accepts custom priority', () => {
      const msg = queue.enqueue({
        to: '5543991938235',
        body: 'Urgent',
        idempotencyKey: 'test-key-5',
        priority: 1,
      })

      expect(msg.priority).toBe(1)
    })

    it('rejects duplicate idempotency_key', () => {
      queue.enqueue({
        to: '5543991938235',
        body: 'First',
        idempotencyKey: 'duplicate-key',
      })

      expect(() =>
        queue.enqueue({
          to: '5543991938235',
          body: 'Second',
          idempotencyKey: 'duplicate-key',
        }),
      ).toThrow()
    })

    it('initializes lockedBy and lockedAt as null', () => {
      const msg = queue.enqueue({
        to: '5543991938235',
        body: 'Hello',
        idempotencyKey: 'test-key-6',
      })

      expect(msg.lockedBy).toBeNull()
      expect(msg.lockedAt).toBeNull()
    })
  })

  describe('dequeue', () => {
    it('returns null on empty queue', () => {
      const msg = queue.dequeue('device-001')
      expect(msg).toBeNull()
    })

    it('returns the oldest queued message', () => {
      queue.enqueue({ to: '111', body: 'First', idempotencyKey: 'k1' })
      queue.enqueue({ to: '222', body: 'Second', idempotencyKey: 'k2' })

      const msg = queue.dequeue('device-001')
      expect(msg).not.toBeNull()
      expect(msg!.body).toBe('First')
    })

    it('sets status to locked with device_serial and locked_at', () => {
      queue.enqueue({ to: '111', body: 'Hello', idempotencyKey: 'k1' })

      const msg = queue.dequeue('device-001')
      expect(msg!.status).toBe('locked')
      expect(msg!.lockedBy).toBe('device-001')
      expect(msg!.lockedAt).toBeDefined()
      expect(msg!.lockedAt).not.toBeNull()
    })

    it('skips already locked messages', () => {
      queue.enqueue({ to: '111', body: 'First', idempotencyKey: 'k1' })
      queue.enqueue({ to: '222', body: 'Second', idempotencyKey: 'k2' })

      const first = queue.dequeue('device-001')
      const second = queue.dequeue('device-002')

      expect(first!.body).toBe('First')
      expect(second!.body).toBe('Second')
    })

    it('returns null when all messages are locked', () => {
      queue.enqueue({ to: '111', body: 'Only one', idempotencyKey: 'k1' })

      queue.dequeue('device-001')
      const result = queue.dequeue('device-002')

      expect(result).toBeNull()
    })

    it('dequeues higher priority first (lower number = higher priority)', () => {
      queue.enqueue({ to: '111', body: 'Low', idempotencyKey: 'k1', priority: 10 })
      queue.enqueue({ to: '222', body: 'High', idempotencyKey: 'k2', priority: 1 })

      const msg = queue.dequeue('device-001')
      expect(msg!.body).toBe('High')
    })

    it('dequeues FIFO within same priority', () => {
      queue.enqueue({ to: '111', body: 'First', idempotencyKey: 'k1', priority: 5 })
      queue.enqueue({ to: '222', body: 'Second', idempotencyKey: 'k2', priority: 5 })

      const msg = queue.dequeue('device-001')
      expect(msg!.body).toBe('First')
    })

    it('persists lock in database', () => {
      queue.enqueue({ to: '111', body: 'Hello', idempotencyKey: 'k1' })
      const dequeued = queue.dequeue('device-001')

      const fromDb = queue.getById(dequeued!.id)
      expect(fromDb!.status).toBe('locked')
      expect(fromDb!.lockedBy).toBe('device-001')
    })
  })

  describe('cleanStaleLocks', () => {
    it('resets messages locked > 120s to queued', () => {
      queue.enqueue({ to: '111', body: 'Hello', idempotencyKey: 'k1' })
      const msg = queue.dequeue('device-001')

      // Manually backdate the locked_at to simulate stale lock
      db.prepare(
        "UPDATE messages SET locked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-130 seconds') WHERE id = ?",
      ).run(msg!.id)

      const cleaned = queue.cleanStaleLocks()
      expect(cleaned).toBe(1)

      const refreshed = queue.getById(msg!.id)
      expect(refreshed!.status).toBe('queued')
      expect(refreshed!.lockedBy).toBeNull()
      expect(refreshed!.lockedAt).toBeNull()
    })

    it('does not touch recently locked messages', () => {
      queue.enqueue({ to: '111', body: 'Hello', idempotencyKey: 'k1' })
      queue.dequeue('device-001')

      const cleaned = queue.cleanStaleLocks()
      expect(cleaned).toBe(0)
    })

    it('returns count of cleaned messages', () => {
      queue.enqueue({ to: '111', body: 'A', idempotencyKey: 'k1' })
      queue.enqueue({ to: '222', body: 'B', idempotencyKey: 'k2' })
      queue.dequeue('device-001')
      queue.dequeue('device-002')

      db.prepare(
        "UPDATE messages SET locked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-130 seconds') WHERE status = 'locked'",
      ).run()

      const cleaned = queue.cleanStaleLocks()
      expect(cleaned).toBe(2)
    })

    it('cleaned messages can be dequeued again', () => {
      queue.enqueue({ to: '111', body: 'Retry me', idempotencyKey: 'k1' })
      const original = queue.dequeue('device-001')

      db.prepare(
        "UPDATE messages SET locked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-130 seconds') WHERE id = ?",
      ).run(original!.id)

      queue.cleanStaleLocks()

      const retried = queue.dequeue('device-002')
      expect(retried).not.toBeNull()
      expect(retried!.id).toBe(original!.id)
      expect(retried!.lockedBy).toBe('device-002')
    })
  })

  describe('updateStatus', () => {
    it('transitions locked → sending', () => {
      queue.enqueue({ to: '111', body: 'Hello', idempotencyKey: 'k1' })
      const locked = queue.dequeue('device-001')

      const sending = queue.updateStatus(locked!.id, 'locked', 'sending')
      expect(sending.status).toBe('sending')
    })

    it('transitions sending → sent', () => {
      queue.enqueue({ to: '111', body: 'Hello', idempotencyKey: 'k1' })
      const locked = queue.dequeue('device-001')
      queue.updateStatus(locked!.id, 'locked', 'sending')

      const sent = queue.updateStatus(locked!.id, 'sending', 'sent')
      expect(sent.status).toBe('sent')
    })

    it('transitions sending → failed', () => {
      queue.enqueue({ to: '111', body: 'Hello', idempotencyKey: 'k1' })
      const locked = queue.dequeue('device-001')
      queue.updateStatus(locked!.id, 'locked', 'sending')

      const failed = queue.updateStatus(locked!.id, 'sending', 'failed')
      expect(failed.status).toBe('failed')
    })

    it('updates the updatedAt timestamp', () => {
      queue.enqueue({ to: '111', body: 'Hello', idempotencyKey: 'k1' })
      const locked = queue.dequeue('device-001')

      // Backdate updatedAt to guarantee it changes on next update
      db.prepare(
        "UPDATE messages SET updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?",
      ).run(locked!.id)

      const sending = queue.updateStatus(locked!.id, 'locked', 'sending')
      expect(sending.updatedAt).not.toBe('2000-01-01T00:00:00.000Z')
    })

    it('throws for non-existent message id', () => {
      expect(() => queue.updateStatus('nonexistent', 'locked', 'sending')).toThrow()
    })
  })

  describe('getAllContactPhones', () => {
    it('returns empty array when no contacts exist', () => {
      const phones = queue.getAllContactPhones()
      expect(phones).toEqual([])
    })

    it('returns all saved contact phone numbers', () => {
      queue.saveContact('5543991938235', 'Alice')
      queue.saveContact('5543999999999', 'Bob')
      queue.saveContact('5543988887777', 'Charlie')

      const phones = queue.getAllContactPhones()
      expect(phones).toHaveLength(3)
      expect(phones).toContain('5543991938235')
      expect(phones).toContain('5543999999999')
      expect(phones).toContain('5543988887777')
    })
  })

  describe('getById', () => {
    it('returns message by id', () => {
      const created = queue.enqueue({
        to: '111',
        body: 'Hello',
        idempotencyKey: 'k1',
      })

      const found = queue.getById(created.id)
      expect(found).not.toBeNull()
      expect(found!.id).toBe(created.id)
      expect(found!.body).toBe('Hello')
    })

    it('returns null for non-existent id', () => {
      const found = queue.getById('nonexistent')
      expect(found).toBeNull()
    })
  })

  describe('schema hardening (Batch 1)', () => {
    it('PRAGMA busy_timeout can be set to 5000', () => {
      db.pragma('busy_timeout = 5000')
      const result = db.pragma('busy_timeout') as unknown[]
      // better-sqlite3 returns [{busy_timeout: N}] — extract the value regardless of format
      const value = typeof result[0] === 'object' && result[0] !== null
        ? Object.values(result[0] as Record<string, unknown>)[0]
        : result[0]
      expect(value).toBe(5000)
    })

    it('idx_messages_plugin_name index exists', () => {
      const indexes = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='messages'",
      ).all() as { name: string }[]
      const names = indexes.map(i => i.name)
      expect(names).toContain('idx_messages_plugin_name')
    })

    it('messages.sent_at column exists and defaults to null', () => {
      const msg = queue.enqueue({ to: '111', body: 'Test', idempotencyKey: 'sat-1' })
      expect(msg.sentAt).toBeNull()
    })

    it('messages.sent_at is set when status transitions to sent', () => {
      const msg = queue.enqueue({ to: '111', body: 'Test', idempotencyKey: 'sat-2' })
      queue.dequeue('device-001')
      queue.updateStatus(msg.id, 'locked', 'sending')
      const sent = queue.updateStatus(msg.id, 'sending', 'sent')
      expect(sent.sentAt).not.toBeNull()
      expect(sent.sentAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })

    it('messages.priority CHECK constraint rejects out-of-range values', () => {
      expect(() =>
        queue.enqueue({ to: '111', body: 'Test', idempotencyKey: 'pri-0', priority: 0 }),
      ).toThrow()
      expect(() =>
        queue.enqueue({ to: '111', body: 'Test', idempotencyKey: 'pri-11', priority: 11 }),
      ).toThrow()
    })

    it('messages.priority accepts values 1-10', () => {
      const low = queue.enqueue({ to: '111', body: 'Low', idempotencyKey: 'pri-1', priority: 1 })
      const high = queue.enqueue({ to: '111', body: 'High', idempotencyKey: 'pri-10', priority: 10 })
      expect(low.priority).toBe(1)
      expect(high.priority).toBe(10)
    })

    it('timestamps use ISO 8601 with milliseconds', () => {
      const msg = queue.enqueue({ to: '111', body: 'ISO', idempotencyKey: 'iso-1' })
      // strftime('%Y-%m-%dT%H:%M:%fZ') produces e.g. 2026-04-13T16:00:00.123Z
      expect(msg.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    })

    it('getQueueStats works with pluginName filter', () => {
      queue.enqueue({ to: '111', body: 'A', idempotencyKey: 'gs-1', pluginName: 'oralsin' })
      queue.enqueue({ to: '222', body: 'B', idempotencyKey: 'gs-2', pluginName: 'other' })

      const allStats = queue.getQueueStats()
      expect(allStats.pending).toBe(2)

      const oralsinStats = queue.getQueueStats('oralsin')
      expect(oralsinStats.pending).toBe(1)
    })
  })

  describe('state machine (Batch 2)', () => {
    it('rejects invalid transition queued → sent', () => {
      const msg = queue.enqueue({ to: '111', body: 'Test', idempotencyKey: 'sm-1' })
      expect(() => queue.updateStatus(msg.id, 'queued', 'sent')).toThrow('Invalid state transition')
    })

    it('accepts valid transition locked → sending', () => {
      queue.enqueue({ to: '111', body: 'Test', idempotencyKey: 'sm-2' })
      const locked = queue.dequeue('device-001')
      const sending = queue.updateStatus(locked!.id, 'locked', 'sending')
      expect(sending.status).toBe('sending')
    })

    it('CAS fails when status does not match from', () => {
      const msg = queue.enqueue({ to: '111', body: 'Test', idempotencyKey: 'sm-3' })
      // Message is in 'queued', but we pass 'locked' as from
      expect(() => queue.updateStatus(msg.id, 'locked', 'sending')).toThrow('status mismatch')
    })

    it('markPermanentlyFailed sets real attempts count', () => {
      const msg = queue.enqueue({ to: '111', body: 'Test', idempotencyKey: 'sm-4' })
      queue.dequeue('device-001')
      queue.updateStatus(msg.id, 'locked', 'sending')
      const pf = queue.markPermanentlyFailed(msg.id, 3)
      expect(pf.status).toBe('permanently_failed')
      expect(pf.attempts).toBe(3)
    })

    it('requeueForRetry increments attempts and resets lock', () => {
      const msg = queue.enqueue({ to: '111', body: 'Test', idempotencyKey: 'sm-5' })
      queue.dequeue('device-001')
      queue.updateStatus(msg.id, 'locked', 'sending')
      const requeued = queue.requeueForRetry(msg.id)
      expect(requeued.status).toBe('queued')
      expect(requeued.attempts).toBe(1)
      expect(requeued.lockedBy).toBeNull()
    })
  })

  describe('enqueueBatch partial-failure (Batch 2)', () => {
    it('skips blacklisted numbers per-item', () => {
      // Add to blacklist
      db.prepare("INSERT INTO blacklist (phone_number, reason) VALUES ('111', 'spam')").run()

      const result = queue.enqueueBatch([
        { to: '111', body: 'Blocked', idempotencyKey: 'bf-1' },
        { to: '222', body: 'OK', idempotencyKey: 'bf-2' },
      ])

      expect(result.enqueued).toHaveLength(1)
      expect(result.enqueued[0].to).toBe('222')
      expect(result.skipped).toHaveLength(1)
      expect(result.skipped[0].reason).toBe('blacklisted')
    })

    it('skips duplicate idempotency_key with ON CONFLICT DO NOTHING', () => {
      queue.enqueue({ to: '111', body: 'First', idempotencyKey: 'dup-1' })

      const result = queue.enqueueBatch([
        { to: '222', body: 'Dup', idempotencyKey: 'dup-1' },
        { to: '333', body: 'New', idempotencyKey: 'dup-2' },
      ])

      expect(result.enqueued).toHaveLength(1)
      expect(result.enqueued[0].to).toBe('333')
      expect(result.skipped).toHaveLength(1)
      expect(result.skipped[0].reason).toBe('duplicate')
    })

    it('saves contacts inside the batch transaction', () => {
      const result = queue.enqueueBatch([
        { to: '111', body: 'Hi', idempotencyKey: 'ct-1', contactName: 'Alice' },
      ])

      expect(result.enqueued).toHaveLength(1)
      expect(queue.getContactName('111')).toBe('Alice')
    })

    it('maxRetries=3 produces exactly 3 send attempts (via requeueForRetry)', () => {
      const msg = queue.enqueue({ to: '111', body: 'Test', idempotencyKey: 'mr-1', maxRetries: 3 })
      expect(msg.maxRetries).toBe(3)

      // Simulate 3 failed attempts
      for (let i = 0; i < 3; i++) {
        const locked = queue.dequeue('device-001')
        expect(locked).not.toBeNull()
        queue.updateStatus(locked!.id, 'locked', 'sending')

        if (i < 2) {
          // Requeue for retry
          const requeued = queue.requeueForRetry(locked!.id)
          expect(requeued.attempts).toBe(i + 1)
        } else {
          // Last attempt — mark permanently failed with real attempts
          const pf = queue.markPermanentlyFailed(locked!.id, i + 1)
          expect(pf.attempts).toBe(3)
          expect(pf.status).toBe('permanently_failed')
        }
      }
    })
  })
})
