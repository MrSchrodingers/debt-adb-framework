import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { DispatchEmitter } from '../events/index.js'
import { SenderHealth } from './sender-health.js'
import {
  resetMetrics,
  messagesSentTotal,
  messagesFailedTotal,
  quarantineEventsTotal,
  senderQuarantined,
  sendDurationSeconds,
  getMetricsText,
} from '../config/metrics.js'

function createTestDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE IF NOT EXISTS sender_health (
      sender_number TEXT PRIMARY KEY,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      quarantined_until TEXT,
      timelock_until TEXT,
      pause_reason TEXT,
      last_failure_at TEXT,
      last_success_at TEXT,
      total_failures INTEGER NOT NULL DEFAULT 0,
      total_successes INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `)
  return db
}

describe('Event Enrichment', () => {
  let db: InstanceType<typeof Database>
  let emitter: DispatchEmitter

  beforeEach(() => {
    db = createTestDb()
    emitter = new DispatchEmitter()
    resetMetrics()
  })

  afterEach(() => {
    vi.useRealTimers()
    db.close()
  })

  describe('message:sent enriched fields', () => {
    it('accepts optional enrichment fields (strategyMethod, appPackage, senderNumber)', () => {
      const handler = vi.fn()
      emitter.on('message:sent', handler)

      emitter.emit('message:sent', {
        id: 'msg-1',
        sentAt: new Date().toISOString(),
        durationMs: 1234,
        deviceSerial: 'abc123',
        contactRegistered: true,
        dialogsDismissed: 0,
        strategyMethod: 'intent',
        appPackage: 'com.whatsapp',
        isFirstContact: true,
        interMessageDelayMs: 45000,
        senderNumber: '+5543996835100',
      })

      expect(handler).toHaveBeenCalledTimes(1)
      const data = handler.mock.calls[0][0]
      expect(data.strategyMethod).toBe('intent')
      expect(data.appPackage).toBe('com.whatsapp')
      expect(data.isFirstContact).toBe(true)
      expect(data.interMessageDelayMs).toBe(45000)
      expect(data.senderNumber).toBe('+5543996835100')
    })

    it('works without enrichment fields (backward compatible)', () => {
      const handler = vi.fn()
      emitter.on('message:sent', handler)

      emitter.emit('message:sent', {
        id: 'msg-2',
        sentAt: new Date().toISOString(),
        durationMs: 500,
        deviceSerial: 'abc123',
        contactRegistered: false,
        dialogsDismissed: 1,
      })

      expect(handler).toHaveBeenCalledTimes(1)
      const data = handler.mock.calls[0][0]
      expect(data.strategyMethod).toBeUndefined()
      expect(data.appPackage).toBeUndefined()
      expect(data.senderNumber).toBeUndefined()
    })
  })

  describe('message:failed enriched fields', () => {
    it('accepts optional enrichment fields (attempts, wasQuarantined, senderNumber)', () => {
      const handler = vi.fn()
      emitter.on('message:failed', handler)

      emitter.emit('message:failed', {
        id: 'msg-3',
        error: 'screen locked',
        attempts: 2,
        wasQuarantined: false,
        lastStrategyMethod: 'content-provider',
        senderNumber: '+5543996835100',
      })

      expect(handler).toHaveBeenCalledTimes(1)
      const data = handler.mock.calls[0][0]
      expect(data.attempts).toBe(2)
      expect(data.wasQuarantined).toBe(false)
      expect(data.lastStrategyMethod).toBe('content-provider')
      expect(data.senderNumber).toBe('+5543996835100')
    })

    it('works without enrichment fields (backward compatible)', () => {
      const handler = vi.fn()
      emitter.on('message:failed', handler)

      emitter.emit('message:failed', {
        id: 'msg-4',
        error: 'timeout',
      })

      expect(handler).toHaveBeenCalledTimes(1)
      const data = handler.mock.calls[0][0]
      expect(data.attempts).toBeUndefined()
      expect(data.wasQuarantined).toBeUndefined()
    })
  })

  describe('sender:quarantined event from SenderHealth', () => {
    it('emitted when health reaches threshold', () => {
      const handler = vi.fn()
      emitter.on('sender:quarantined', handler)

      const health = new SenderHealth(db, { quarantineAfterFailures: 3 }, emitter)
      health.recordFailure('+5543996835100')
      health.recordFailure('+5543996835100')
      expect(handler).not.toHaveBeenCalled()

      health.recordFailure('+5543996835100')
      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler.mock.calls[0][0]).toEqual({
        sender: '+5543996835100',
        failureCount: 3,
        quarantinedUntil: expect.any(String),
      })
    })

    it('not emitted below threshold', () => {
      const handler = vi.fn()
      emitter.on('sender:quarantined', handler)

      const health = new SenderHealth(db, { quarantineAfterFailures: 5 }, emitter)
      health.recordFailure('+5543996835100')
      health.recordFailure('+5543996835100')
      health.recordFailure('+5543996835100')

      expect(handler).not.toHaveBeenCalled()
    })
  })

  describe('sender:released event from SenderHealth', () => {
    it('emitted when quarantine expires', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-04-09T12:00:00.000Z'))

      const handler = vi.fn()
      emitter.on('sender:released', handler)

      const health = new SenderHealth(db, { quarantineAfterFailures: 1, quarantineDurationMs: 60_000 }, emitter)
      health.recordFailure('+5543996835100')
      expect(health.isQuarantined('+5543996835100')).toBe(true)
      expect(handler).not.toHaveBeenCalled()

      vi.setSystemTime(new Date('2026-04-09T12:01:01.000Z'))
      expect(health.isQuarantined('+5543996835100')).toBe(false)
      expect(handler).toHaveBeenCalledTimes(1)

      const data = handler.mock.calls[0][0]
      expect(data.sender).toBe('+5543996835100')
      expect(data.quarantineDurationActualMs).toBeGreaterThan(60_000)
    })

    it('not emitted while still quarantined', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-04-09T12:00:00.000Z'))

      const handler = vi.fn()
      emitter.on('sender:released', handler)

      const health = new SenderHealth(db, { quarantineAfterFailures: 1, quarantineDurationMs: 60_000 }, emitter)
      health.recordFailure('+5543996835100')

      // Only 30s passed — still quarantined
      vi.setSystemTime(new Date('2026-04-09T12:00:30.000Z'))
      expect(health.isQuarantined('+5543996835100')).toBe(true)
      expect(handler).not.toHaveBeenCalled()
    })
  })

  describe('Prometheus metrics receive enriched labels', () => {
    it('message:sent counter uses enriched sender and method labels', async () => {
      const data = {
        id: 'msg-5',
        sentAt: new Date().toISOString(),
        durationMs: 2500,
        deviceSerial: 'abc123',
        contactRegistered: false,
        dialogsDismissed: 0,
        strategyMethod: 'intent',
        appPackage: 'com.whatsapp',
        senderNumber: '+5543996835100',
      }

      messagesSentTotal.inc({
        sender: data.senderNumber ?? 'unknown',
        method: data.strategyMethod ?? 'unknown',
        app_package: data.appPackage ?? 'unknown',
      })
      sendDurationSeconds.observe(
        { method: data.strategyMethod ?? 'unknown' },
        data.durationMs / 1000,
      )

      const text = await getMetricsText()
      expect(text).toContain('dispatch_messages_sent_total{sender="+5543996835100",method="intent",app_package="com.whatsapp"} 1')
      expect(text).toContain('dispatch_send_duration_seconds_sum{method="intent"} 2.5')
    })

    it('message:sent counter falls back to unknown for unenriched events', async () => {
      messagesSentTotal.inc({
        sender: 'unknown',
        method: 'unknown',
        app_package: 'unknown',
      })

      const text = await getMetricsText()
      expect(text).toContain('dispatch_messages_sent_total{sender="unknown",method="unknown",app_package="unknown"} 1')
    })

    it('message:failed counter classifies error_type by attempts', async () => {
      // Transient (attempts <= 3)
      const transientAttempts = 2
      messagesFailedTotal.inc({
        sender: '+5543996835100',
        error_type: transientAttempts !== undefined && transientAttempts > 3 ? 'exhausted' : 'transient',
      })

      // Exhausted (attempts > 3)
      const exhaustedAttempts = 5
      messagesFailedTotal.inc({
        sender: '+5543996835100',
        error_type: exhaustedAttempts !== undefined && exhaustedAttempts > 3 ? 'exhausted' : 'transient',
      })

      const text = await getMetricsText()
      expect(text).toContain('dispatch_messages_failed_total{sender="+5543996835100",error_type="transient"} 1')
      expect(text).toContain('dispatch_messages_failed_total{sender="+5543996835100",error_type="exhausted"} 1')
    })

    it('sender:quarantined increments counter and sets gauge', async () => {
      quarantineEventsTotal.inc({ sender: '+5543996835100' })
      senderQuarantined.set({ sender: '+5543996835100' }, 1)

      const text = await getMetricsText()
      expect(text).toContain('dispatch_quarantine_events_total{sender="+5543996835100"} 1')
      expect(text).toContain('dispatch_sender_quarantined{sender="+5543996835100"} 1')
    })

    it('sender:released clears quarantine gauge', async () => {
      senderQuarantined.set({ sender: '+5543996835100' }, 1)
      senderQuarantined.set({ sender: '+5543996835100' }, 0)

      const text = await getMetricsText()
      expect(text).toContain('dispatch_sender_quarantined{sender="+5543996835100"} 0')
    })
  })
})
