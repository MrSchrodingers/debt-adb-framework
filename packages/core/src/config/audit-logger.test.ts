import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { AuditLogger } from './audit-logger.js'

function createDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor TEXT NOT NULL DEFAULT 'api',
      action TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT,
      before_state TEXT,
      after_state TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_audit_log_resource ON audit_log(resource_type, resource_id);
    CREATE INDEX IF NOT EXISTS idx_audit_log_time ON audit_log(created_at);
  `)
  return db
}

describe('AuditLogger', () => {
  let db: Database.Database
  let logger: AuditLogger

  beforeEach(() => {
    db = createDb()
    logger = new AuditLogger(db)
  })

  describe('log', () => {
    it('logs action with before/after state', () => {
      logger.log({
        actor: 'admin',
        action: 'update',
        resourceType: 'sender_mapping',
        resourceId: '5543991938235',
        beforeState: { active: true, device: 'ABC123' },
        afterState: { active: false, device: 'ABC123' },
      })

      const { entries } = logger.query()
      expect(entries).toHaveLength(1)
      expect(entries[0].actor).toBe('admin')
      expect(entries[0].action).toBe('update')
      expect(entries[0].resourceType).toBe('sender_mapping')
      expect(entries[0].resourceId).toBe('5543991938235')
      expect(entries[0].beforeState).toEqual({ active: true, device: 'ABC123' })
      expect(entries[0].afterState).toEqual({ active: false, device: 'ABC123' })
      expect(entries[0].createdAt).toBeTruthy()
    })

    it('logs action without before/after state', () => {
      logger.log({
        action: 'create',
        resourceType: 'plugin',
        resourceId: 'oralsin',
      })

      const { entries } = logger.query()
      expect(entries).toHaveLength(1)
      expect(entries[0].actor).toBe('api') // default actor
      expect(entries[0].action).toBe('create')
      expect(entries[0].resourceType).toBe('plugin')
      expect(entries[0].resourceId).toBe('oralsin')
      expect(entries[0].beforeState).toBeNull()
      expect(entries[0].afterState).toBeNull()
    })
  })

  describe('query', () => {
    beforeEach(() => {
      // Seed 5 entries with varied attributes
      logger.log({ action: 'create', resourceType: 'sender_mapping', resourceId: 'phone1', afterState: { phone: 'phone1' } })
      logger.log({ action: 'update', resourceType: 'sender_mapping', resourceId: 'phone1', beforeState: { active: true }, afterState: { active: false } })
      logger.log({ action: 'delete', resourceType: 'sender_mapping', resourceId: 'phone2', beforeState: { phone: 'phone2' } })
      logger.log({ action: 'update', resourceType: 'plugin', resourceId: 'oralsin', beforeState: { enabled: true }, afterState: { enabled: false } })
      logger.log({ action: 'rotate_key', resourceType: 'plugin', resourceId: 'oralsin' })
    })

    it('returns entries filtered by resource_type', () => {
      const { entries, total } = logger.query({ resourceType: 'plugin' })
      expect(total).toBe(2)
      expect(entries).toHaveLength(2)
      expect(entries.every(e => e.resourceType === 'plugin')).toBe(true)
    })

    it('returns entries filtered by action', () => {
      const { entries, total } = logger.query({ action: 'update' })
      expect(total).toBe(2)
      expect(entries).toHaveLength(2)
      expect(entries.every(e => e.action === 'update')).toBe(true)
    })

    it('returns entries filtered by resource_id', () => {
      const { entries, total } = logger.query({ resourceId: 'oralsin' })
      expect(total).toBe(2)
      expect(entries).toHaveLength(2)
      expect(entries.every(e => e.resourceId === 'oralsin')).toBe(true)
    })

    it('supports date range filter', () => {
      // All entries were created "now" — use a range that encompasses now
      const now = new Date()
      const startDate = new Date(now.getTime() - 60_000).toISOString()
      const endDate = new Date(now.getTime() + 60_000).toISOString()

      const { total: withinRange } = logger.query({ startDate, endDate })
      expect(withinRange).toBe(5)

      // Use a past date range that should match nothing
      const { total: outsideRange } = logger.query({
        startDate: '2020-01-01T00:00:00.000Z',
        endDate: '2020-01-02T00:00:00.000Z',
      })
      expect(outsideRange).toBe(0)
    })

    it('supports pagination (limit + offset)', () => {
      const page1 = logger.query({ limit: 2, offset: 0 })
      expect(page1.entries).toHaveLength(2)
      expect(page1.total).toBe(5) // total count is unaffected by pagination

      const page2 = logger.query({ limit: 2, offset: 2 })
      expect(page2.entries).toHaveLength(2)
      expect(page2.total).toBe(5)

      const page3 = logger.query({ limit: 2, offset: 4 })
      expect(page3.entries).toHaveLength(1)
      expect(page3.total).toBe(5)

      // No overlap between pages
      const allIds = [...page1.entries, ...page2.entries, ...page3.entries].map(e => e.id)
      expect(new Set(allIds).size).toBe(5)
    })

    it('returns entries in reverse chronological order (newest first)', () => {
      const { entries } = logger.query()
      // IDs are auto-incrementing, so higher ID = newer
      for (let i = 0; i < entries.length - 1; i++) {
        expect(entries[i].id).toBeGreaterThan(entries[i + 1].id)
      }
    })

    it('combines multiple filters', () => {
      const { entries, total } = logger.query({
        resourceType: 'sender_mapping',
        action: 'update',
      })
      expect(total).toBe(1)
      expect(entries).toHaveLength(1)
      expect(entries[0].resourceId).toBe('phone1')
    })

    it('returns empty result when no entries match', () => {
      const { entries, total } = logger.query({ resourceType: 'nonexistent' })
      expect(entries).toHaveLength(0)
      expect(total).toBe(0)
    })
  })
})
