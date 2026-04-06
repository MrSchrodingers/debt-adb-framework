import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { MessageQueue } from './message-queue.js'

describe('MessageQueue.listPaginated', () => {
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

  function seedMessages(count: number, overrides: Partial<{ status: string; pluginName: string; to: string }> = {}) {
    for (let i = 0; i < count; i++) {
      const msg = queue.enqueue({
        to: overrides.to ?? `554399193${String(i).padStart(4, '0')}`,
        body: `Message ${i}`,
        idempotencyKey: `key-${crypto.randomUUID()}`,
        pluginName: overrides.pluginName,
      })
      if (overrides.status && overrides.status !== 'queued') {
        queue.updateStatus(msg.id, overrides.status as 'sent' | 'failed')
      }
    }
  }

  describe('pagination', () => {
    it('returns correct page with limit and offset', () => {
      seedMessages(10)

      const page1 = queue.listPaginated({ limit: 3, offset: 0 })
      expect(page1.data).toHaveLength(3)
      expect(page1.total).toBe(10)

      const page2 = queue.listPaginated({ limit: 3, offset: 3 })
      expect(page2.data).toHaveLength(3)
      expect(page2.total).toBe(10)

      // No overlap
      const ids1 = page1.data.map((m) => m.id)
      const ids2 = page2.data.map((m) => m.id)
      expect(ids1.filter((id) => ids2.includes(id))).toHaveLength(0)
    })

    it('defaults to limit 50 offset 0', () => {
      seedMessages(3)

      const result = queue.listPaginated({})
      expect(result.data).toHaveLength(3)
      expect(result.total).toBe(3)
    })

    it('returns empty data for offset beyond total', () => {
      seedMessages(5)

      const result = queue.listPaginated({ limit: 10, offset: 100 })
      expect(result.data).toHaveLength(0)
      expect(result.total).toBe(5)
    })
  })

  describe('filters by status', () => {
    it('filters by single status', () => {
      seedMessages(3, { status: 'sent' })
      seedMessages(2, { status: 'failed' })
      seedMessages(4) // queued

      const result = queue.listPaginated({ status: 'sent' })
      expect(result.data).toHaveLength(3)
      expect(result.total).toBe(3)
      result.data.forEach((m) => expect(m.status).toBe('sent'))
    })
  })

  describe('filters by date range', () => {
    it('filters by dateFrom and dateTo', () => {
      seedMessages(5)

      // All messages created "now", so dateFrom=yesterday should include all
      const yesterday = new Date(Date.now() - 86_400_000).toISOString().split('T')[0]
      const tomorrow = new Date(Date.now() + 86_400_000).toISOString().split('T')[0]

      const result = queue.listPaginated({ dateFrom: yesterday, dateTo: tomorrow })
      expect(result.total).toBe(5)
    })

    it('dateFrom excludes older messages', () => {
      seedMessages(3)

      // Backdate 2 messages
      const rows = db.prepare("SELECT id FROM messages LIMIT 2").all() as { id: string }[]
      for (const row of rows) {
        db.prepare("UPDATE messages SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(row.id)
      }

      const result = queue.listPaginated({ dateFrom: '2025-01-01' })
      expect(result.total).toBe(1)
    })
  })

  describe('filters by phone (partial match)', () => {
    it('matches partial phone number', () => {
      queue.enqueue({ to: '5543991938235', body: 'A', idempotencyKey: 'k1' })
      queue.enqueue({ to: '5511999887766', body: 'B', idempotencyKey: 'k2' })
      queue.enqueue({ to: '5543900001111', body: 'C', idempotencyKey: 'k3' })

      const result = queue.listPaginated({ phone: '5543' })
      expect(result.total).toBe(2)
      result.data.forEach((m) => expect(m.to).toContain('5543'))
    })
  })

  describe('returns total count', () => {
    it('total reflects filtered count, not full table', () => {
      seedMessages(5, { status: 'sent' })
      seedMessages(3) // queued

      const result = queue.listPaginated({ status: 'sent', limit: 2 })
      expect(result.data).toHaveLength(2)
      expect(result.total).toBe(5) // total of filtered set, not page size
    })
  })

  describe('filters by pluginName', () => {
    it('filters messages by plugin_name', () => {
      seedMessages(3, { pluginName: 'oralsin' })
      seedMessages(2, { pluginName: 'other' })
      seedMessages(4) // no plugin

      const result = queue.listPaginated({ pluginName: 'oralsin' })
      expect(result.total).toBe(3)
      result.data.forEach((m) => expect(m.pluginName).toBe('oralsin'))
    })
  })

  describe('ordering', () => {
    it('returns newest first', () => {
      const m1 = queue.enqueue({ to: '111', body: 'First', idempotencyKey: 'k1' })
      const m2 = queue.enqueue({ to: '222', body: 'Second', idempotencyKey: 'k2' })

      // Backdate first message so ordering is testable
      db.prepare("UPDATE messages SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(m1.id)

      const result = queue.listPaginated({})
      expect(result.data[0].id).toBe(m2.id)
      expect(result.data[1].id).toBe(m1.id)
    })
  })

  describe('combined filters', () => {
    it('combines status + phone + pluginName', () => {
      // 3 sent oralsin messages with target phone
      for (let i = 0; i < 3; i++) {
        const msg = queue.enqueue({
          to: '5543991938235',
          body: `Match ${i}`,
          idempotencyKey: `match-${i}`,
          pluginName: 'oralsin',
        })
        queue.updateStatus(msg.id, 'sent')
      }
      // 2 sent oralsin messages with different phone
      for (let i = 0; i < 2; i++) {
        const msg = queue.enqueue({
          to: '5511999887766',
          body: `NoMatch ${i}`,
          idempotencyKey: `nomatch-${i}`,
          pluginName: 'oralsin',
        })
        queue.updateStatus(msg.id, 'sent')
      }
      // 1 queued oralsin message with target phone
      queue.enqueue({
        to: '5543991938235',
        body: 'Queued',
        idempotencyKey: 'q1',
        pluginName: 'oralsin',
      })

      const result = queue.listPaginated({ status: 'sent', phone: '5543', pluginName: 'oralsin' })
      expect(result.total).toBe(3)
    })
  })
})
