import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { MessageQueue } from '../queue/message-queue.js'
import { getMetricsSummary, getMetricsHourly, getMetricsByStatus, getMetricsByPlugin } from './metrics.js'

describe('Metrics', () => {
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

  function seedMessage(overrides: {
    status?: string
    pluginName?: string
    createdAt?: string
    updatedAt?: string
  } = {}) {
    const msg = queue.enqueue({
      to: '5543991938235',
      body: 'Test',
      idempotencyKey: `key-${crypto.randomUUID()}`,
      pluginName: overrides.pluginName,
    })

    if (overrides.status && overrides.status !== 'queued') {
      queue.updateStatus(msg.id, 'queued', 'locked')
      queue.updateStatus(msg.id, 'locked', 'sending')
      queue.updateStatus(msg.id, 'sending', overrides.status as 'sent' | 'failed')
    }

    // Allow manual timestamp overrides for testing
    if (overrides.createdAt || overrides.updatedAt) {
      const sets: string[] = []
      const vals: string[] = []
      if (overrides.createdAt) {
        sets.push('created_at = ?')
        vals.push(overrides.createdAt)
      }
      if (overrides.updatedAt) {
        sets.push('updated_at = ?')
        vals.push(overrides.updatedAt)
      }
      vals.push(msg.id)
      db.prepare(`UPDATE messages SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
    }

    return msg
  }

  describe('getMetricsSummary', () => {
    it('returns correct rates with sent and failed messages', () => {
      // 8 sent, 2 failed = 80% success rate
      for (let i = 0; i < 8; i++) seedMessage({ status: 'sent' })
      for (let i = 0; i < 2; i++) seedMessage({ status: 'failed' })

      const summary = getMetricsSummary(db)
      expect(summary.successRate).toBeCloseTo(80, 0)
      expect(summary.totalToday).toBe(10)
      expect(summary.totalFailed).toBe(2)
    })

    it('computes avgLatencyMs from sent messages', () => {
      // Seed a sent message with known timestamps
      const now = new Date()
      const createdAt = new Date(now.getTime() - 5000).toISOString() // 5s ago
      const updatedAt = now.toISOString()

      seedMessage({ status: 'sent', createdAt, updatedAt })

      const summary = getMetricsSummary(db)
      // Latency should be ~5000ms (allowing tolerance for timestamp precision)
      expect(summary.avgLatencyMs).toBeGreaterThan(4000)
      expect(summary.avgLatencyMs).toBeLessThan(6000)
    })

    it('returns zero rates when no messages', () => {
      const summary = getMetricsSummary(db)
      expect(summary.successRate).toBe(0)
      expect(summary.avgLatencyMs).toBe(0)
      expect(summary.totalToday).toBe(0)
      expect(summary.totalFailed).toBe(0)
    })
  })

  describe('getMetricsHourly', () => {
    it('returns 24 entries', () => {
      const hourly = getMetricsHourly(db)
      expect(hourly).toHaveLength(24)
    })

    it('counts messages in correct hour buckets', () => {
      // Insert a message for the current hour
      seedMessage({ status: 'sent' })
      seedMessage({ status: 'failed' })
      seedMessage({}) // queued

      const hourly = getMetricsHourly(db)
      const currentHour = new Date().getUTCHours()
      const currentBucket = hourly.find((h) => h.hour === currentHour)

      expect(currentBucket).toBeDefined()
      expect(currentBucket!.sent).toBe(1)
      expect(currentBucket!.failed).toBe(1)
      expect(currentBucket!.queued).toBe(1)
    })
  })

  describe('getMetricsByStatus', () => {
    it('counts match actual statuses', () => {
      for (let i = 0; i < 3; i++) seedMessage({}) // queued
      for (let i = 0; i < 5; i++) seedMessage({ status: 'sent' })
      for (let i = 0; i < 2; i++) seedMessage({ status: 'failed' })

      const byStatus = getMetricsByStatus(db)
      expect(byStatus.queued).toBe(3)
      expect(byStatus.sent).toBe(5)
      expect(byStatus.failed).toBe(2)
      expect(byStatus.sending).toBe(0)
    })
  })

  describe('getMetricsByPlugin', () => {
    it('groups correctly by plugin name', () => {
      for (let i = 0; i < 4; i++) seedMessage({ pluginName: 'oralsin' })
      for (let i = 0; i < 2; i++) seedMessage({ pluginName: 'other' })
      seedMessage({}) // no plugin

      const byPlugin = getMetricsByPlugin(db)

      const oralsin = byPlugin.find((p) => p.plugin === 'oralsin')
      expect(oralsin).toBeDefined()
      expect(oralsin!.count).toBe(4)

      const other = byPlugin.find((p) => p.plugin === 'other')
      expect(other).toBeDefined()
      expect(other!.count).toBe(2)
    })

    it('returns empty array when no messages have plugins', () => {
      seedMessage({}) // no plugin

      const byPlugin = getMetricsByPlugin(db)
      expect(byPlugin).toHaveLength(0)
    })
  })
})
