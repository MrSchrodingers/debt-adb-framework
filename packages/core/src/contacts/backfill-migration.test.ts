import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { ContactRegistry } from './contact-registry.js'
import { backfillFromSentHistory } from './backfill-migration.js'
import { MessageQueue } from '../queue/message-queue.js'

describe('backfillFromSentHistory', () => {
  let db: Database.Database
  let registry: ContactRegistry
  let queue: MessageQueue

  beforeEach(() => {
    db = new Database(':memory:')
    queue = new MessageQueue(db)
    queue.initialize()
    registry = new ContactRegistry(db)
    registry.initialize()

    // Seed messages with status='sent' for 2 distinct phones + 1 failed
    db.prepare(`
      INSERT INTO messages (id, to_number, body, idempotency_key, status, sender_number, created_at, updated_at)
      VALUES
        ('msg-1', '+5543991938235', 'hi', 'k1', 'sent', '554391938000', '2025-11-20T10:00:00Z', '2025-11-20T10:00:05Z'),
        ('msg-2', '+5543991938235', 'hi2', 'k2', 'sent', '554391938000', '2025-12-01T10:00:00Z', '2025-12-01T10:00:05Z'),
        ('msg-3', '+5511987654321', 'hi',  'k3', 'sent', '554391938000', '2026-01-15T09:00:00Z', '2026-01-15T09:00:05Z'),
        ('msg-4', '+5521999888777', 'hi',  'k4', 'failed', '554391938000', '2026-02-01T09:00:00Z', '2026-02-01T09:00:05Z')
    `).run()
  })

  it('populates wa_contacts and wa_contact_checks from messages.status=sent, idempotent (T13)', () => {
    const firstRun = backfillFromSentHistory(db)
    expect(firstRun.contactsCreated).toBe(2)
    expect(firstRun.checksCreated).toBe(2)

    const contact1 = registry.lookup('5543991938235')
    expect(contact1).not.toBeNull()
    expect(contact1!.exists_on_wa).toBe(1)
    expect(contact1!.last_check_source).toBe('send_success_backfill')
    expect(contact1!.last_check_confidence).toBe(0.9)

    const history1 = registry.history('5543991938235')
    expect(history1).toHaveLength(1)
    expect(history1[0].source).toBe('send_success_backfill')
    const evidence = JSON.parse(history1[0].evidence ?? '{}') as { migration: string }
    expect(evidence.migration).toBe('phase-9.1-backfill')

    // Failed messages skipped
    expect(registry.lookup('5521999888777')).toBeNull()

    // Second run is idempotent — no duplicates
    const secondRun = backfillFromSentHistory(db)
    expect(secondRun.contactsCreated).toBe(0)
    expect(secondRun.checksCreated).toBe(0)

    expect(registry.history('5543991938235')).toHaveLength(1)
  })
})
