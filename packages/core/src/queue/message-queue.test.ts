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

      const sending = queue.updateStatus(locked!.id, 'sending')
      expect(sending.status).toBe('sending')
    })

    it('transitions sending → sent', () => {
      queue.enqueue({ to: '111', body: 'Hello', idempotencyKey: 'k1' })
      const locked = queue.dequeue('device-001')
      queue.updateStatus(locked!.id, 'sending')

      const sent = queue.updateStatus(locked!.id, 'sent')
      expect(sent.status).toBe('sent')
    })

    it('transitions sending → failed', () => {
      queue.enqueue({ to: '111', body: 'Hello', idempotencyKey: 'k1' })
      const locked = queue.dequeue('device-001')
      queue.updateStatus(locked!.id, 'sending')

      const failed = queue.updateStatus(locked!.id, 'failed')
      expect(failed.status).toBe('failed')
    })

    it('updates the updatedAt timestamp', () => {
      queue.enqueue({ to: '111', body: 'Hello', idempotencyKey: 'k1' })
      const locked = queue.dequeue('device-001')

      // Backdate updatedAt to guarantee it changes on next update
      db.prepare(
        "UPDATE messages SET updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?",
      ).run(locked!.id)

      const sending = queue.updateStatus(locked!.id, 'sending')
      expect(sending.updatedAt).not.toBe('2000-01-01T00:00:00.000Z')
    })

    it('throws for non-existent message id', () => {
      expect(() => queue.updateStatus('nonexistent', 'sending')).toThrow()
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
})
