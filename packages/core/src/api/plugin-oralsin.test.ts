import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { MessageQueue } from '../queue/message-queue.js'
import { PluginRegistry } from '../plugins/plugin-registry.js'
import { ReceiptTracker } from '../engine/receipt-tracker.js'
import { SenderMapping } from '../engine/sender-mapping.js'
import { buildOralsinStats } from './plugin-oralsin.js'

describe('Oralsin Plugin Monitoring API', () => {
  let db: Database.Database
  let queue: MessageQueue
  let pluginRegistry: PluginRegistry
  let receiptTracker: ReceiptTracker
  let senderMapping: SenderMapping

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('journal_mode = WAL')

    queue = new MessageQueue(db)
    queue.initialize()

    pluginRegistry = new PluginRegistry(db)
    pluginRegistry.initialize()

    const emitter = {
      emit: () => {},
      on: () => {},
    } as unknown as import('../events/index.js').DispatchEmitter
    receiptTracker = new ReceiptTracker(db, queue, emitter)
    receiptTracker.initialize()

    senderMapping = new SenderMapping(db)
    senderMapping.initialize()
  })

  afterEach(() => {
    db.close()
  })

  // ── Helpers ──

  function seedOralsinMessage(overrides: {
    status?: string
    fallbackUsed?: number
    fallbackProvider?: string
    createdAt?: string
    updatedAt?: string
    senderNumber?: string
  } = {}) {
    const msg = queue.enqueue({
      to: '5543991938235',
      body: 'Test notification',
      idempotencyKey: `oralsin-${crypto.randomUUID()}`,
      pluginName: 'oralsin',
      senderNumber: overrides.senderNumber ?? null,
    })

    if (overrides.status && overrides.status !== 'queued') {
      queue.updateStatus(msg.id, overrides.status as 'sent' | 'failed')
    }

    if (overrides.fallbackUsed !== undefined || overrides.fallbackProvider !== undefined) {
      db.prepare(
        "UPDATE messages SET fallback_used = ?, fallback_provider = ? WHERE id = ?",
      ).run(overrides.fallbackUsed ?? 0, overrides.fallbackProvider ?? null, msg.id)
    }

    if (overrides.createdAt || overrides.updatedAt) {
      const sets: string[] = []
      const vals: string[] = []
      if (overrides.createdAt) { sets.push('created_at = ?'); vals.push(overrides.createdAt) }
      if (overrides.updatedAt) { sets.push('updated_at = ?'); vals.push(overrides.updatedAt) }
      vals.push(msg.id)
      db.prepare(`UPDATE messages SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
    }

    return msg
  }

  function seedOtherPluginMessage() {
    return queue.enqueue({
      to: '5500000000000',
      body: 'Other plugin msg',
      idempotencyKey: `other-${crypto.randomUUID()}`,
      pluginName: 'other-plugin',
    })
  }

  function seedFailedCallback(pluginName: string, messageId: string, callbackType = 'result') {
    db.prepare(`
      INSERT INTO failed_callbacks (id, plugin_name, message_id, callback_type, payload, webhook_url, attempts, last_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `fc-${crypto.randomUUID()}`,
      pluginName,
      messageId,
      callbackType,
      '{}',
      'http://example.com/webhook',
      3,
      'HTTP 503',
    )
  }

  function seedSenderMapping(phoneNumber: string, deviceSerial = 'emulator-5554', profileId = 0) {
    return senderMapping.create({
      phoneNumber,
      deviceSerial,
      profileId,
      wahaSession: `session-${phoneNumber}`,
    })
  }

  // ── Overview Tests ──

  describe('buildOralsinStats().overview()', () => {
    it('returns all zeros for empty database', () => {
      const stats = buildOralsinStats(db)
      const overview = stats.overview()

      expect(overview.totalToday).toBe(0)
      expect(overview.sentToday).toBe(0)
      expect(overview.failedToday).toBe(0)
      expect(overview.pendingNow).toBe(0)
      expect(overview.deliveredToday).toBe(0)
      expect(overview.readToday).toBe(0)
      expect(overview.avgLatencyMs).toBe(0)
      expect(overview.fallbackRate).toBe(0)
      expect(overview.failedCallbacks).toBe(0)
      expect(overview.hourly).toHaveLength(24)
    })

    it('counts only oralsin plugin messages', () => {
      seedOralsinMessage({ status: 'sent' })
      seedOralsinMessage({ status: 'sent' })
      seedOralsinMessage({ status: 'failed' })
      seedOtherPluginMessage()

      const stats = buildOralsinStats(db)
      const overview = stats.overview()

      expect(overview.totalToday).toBe(3)
      expect(overview.sentToday).toBe(2)
      expect(overview.failedToday).toBe(1)
    })

    it('counts pending messages (queued + locked + sending)', () => {
      seedOralsinMessage({}) // queued
      seedOralsinMessage({}) // queued
      seedOralsinMessage({ status: 'sent' })

      const stats = buildOralsinStats(db)
      const overview = stats.overview()

      expect(overview.pendingNow).toBe(2)
    })

    it('computes fallback rate as percentage of sent with fallback_used=1', () => {
      // 2 sent with fallback, 2 sent without
      seedOralsinMessage({ status: 'sent', fallbackUsed: 1, fallbackProvider: 'waha' })
      seedOralsinMessage({ status: 'sent', fallbackUsed: 1, fallbackProvider: 'waha' })
      seedOralsinMessage({ status: 'sent', fallbackUsed: 0 })
      seedOralsinMessage({ status: 'sent', fallbackUsed: 0 })

      const stats = buildOralsinStats(db)
      const overview = stats.overview()

      expect(overview.fallbackRate).toBeCloseTo(50, 0)
    })

    it('counts failed callbacks for oralsin plugin', () => {
      const msg = seedOralsinMessage({ status: 'sent' })
      seedFailedCallback('oralsin', msg.id, 'result')
      seedFailedCallback('oralsin', msg.id, 'ack')
      seedFailedCallback('other-plugin', msg.id, 'result') // should NOT be counted

      const stats = buildOralsinStats(db)
      const overview = stats.overview()

      expect(overview.failedCallbacks).toBe(2)
    })

    it('computes avgLatencyMs from sent messages', () => {
      const now = new Date()
      const createdAt = new Date(now.getTime() - 5000).toISOString()
      const updatedAt = now.toISOString()

      seedOralsinMessage({ status: 'sent', createdAt, updatedAt })

      const stats = buildOralsinStats(db)
      const overview = stats.overview()

      expect(overview.avgLatencyMs).toBeGreaterThan(4000)
      expect(overview.avgLatencyMs).toBeLessThan(6000)
    })

    it('returns 24 hourly buckets', () => {
      seedOralsinMessage({ status: 'sent' })
      const stats = buildOralsinStats(db)
      const overview = stats.overview()

      expect(overview.hourly).toHaveLength(24)
      const currentHour = new Date().getUTCHours()
      const bucket = overview.hourly.find((h) => h.hour === currentHour)
      expect(bucket).toBeDefined()
      expect(bucket!.sent).toBe(1)
    })

    it('counts deliveredToday and readToday from pending_correlations', () => {
      const msg1 = seedOralsinMessage({ status: 'sent' })
      const msg2 = seedOralsinMessage({ status: 'sent' })

      // Mark msg1 as delivered + read
      db.prepare(`
        INSERT INTO pending_correlations (message_id, to_number_normalized, sender_number_normalized, sent_at, delivered_emitted, read_emitted)
        VALUES (?, ?, ?, datetime('now'), 1, 1)
      `).run(msg1.id, '5543991938235', '5511999999999')

      // Mark msg2 as delivered only
      db.prepare(`
        INSERT INTO pending_correlations (message_id, to_number_normalized, sender_number_normalized, sent_at, delivered_emitted, read_emitted)
        VALUES (?, ?, ?, datetime('now'), 1, 0)
      `).run(msg2.id, '5543991938235', '5511999999999')

      const stats = buildOralsinStats(db)
      const overview = stats.overview()

      expect(overview.deliveredToday).toBe(2)
      expect(overview.readToday).toBe(1)
    })
  })

  // ── Messages Tests ──

  describe('buildOralsinStats().messages()', () => {
    it('returns empty result for empty database', () => {
      const stats = buildOralsinStats(db)
      const result = stats.messages()

      expect(result.data).toHaveLength(0)
      expect(result.total).toBe(0)
    })

    it('returns only oralsin messages', () => {
      seedOralsinMessage({ status: 'sent' })
      seedOralsinMessage({ status: 'queued' })
      seedOtherPluginMessage()

      const stats = buildOralsinStats(db)
      const result = stats.messages()

      expect(result.total).toBe(2)
      expect(result.data).toHaveLength(2)
      expect(result.data.every((m) => m.status !== undefined)).toBe(true)
    })

    it('paginates correctly with limit and offset', () => {
      for (let i = 0; i < 5; i++) seedOralsinMessage({})

      const stats = buildOralsinStats(db)
      const page1 = stats.messages({ limit: 2, offset: 0 })
      const page2 = stats.messages({ limit: 2, offset: 2 })
      const page3 = stats.messages({ limit: 2, offset: 4 })

      expect(page1.total).toBe(5)
      expect(page1.data).toHaveLength(2)
      expect(page2.data).toHaveLength(2)
      expect(page3.data).toHaveLength(1)
    })

    it('returns delivered and read booleans from pending_correlations JOIN', () => {
      const msg = seedOralsinMessage({ status: 'sent' })

      db.prepare(`
        INSERT INTO pending_correlations (message_id, to_number_normalized, sender_number_normalized, sent_at, delivered_emitted, read_emitted)
        VALUES (?, ?, ?, datetime('now'), 1, 0)
      `).run(msg.id, '5543991938235', '5511999999999')

      const stats = buildOralsinStats(db)
      const result = stats.messages()
      const found = result.data.find((m) => m.id === msg.id)

      expect(found).toBeDefined()
      expect(found!.delivered).toBe(true)
      expect(found!.read).toBe(false)
    })

    it('includes all required fields in each message', () => {
      seedOralsinMessage({ status: 'sent', fallbackUsed: 1, fallbackProvider: 'waha' })

      const stats = buildOralsinStats(db)
      const result = stats.messages()
      const msg = result.data[0]

      expect(msg).toHaveProperty('id')
      expect(msg).toHaveProperty('toNumber')
      expect(msg).toHaveProperty('body')
      expect(msg).toHaveProperty('senderNumber')
      expect(msg).toHaveProperty('status')
      expect(msg).toHaveProperty('priority')
      expect(msg).toHaveProperty('attempts')
      expect(msg).toHaveProperty('fallbackUsed')
      expect(msg).toHaveProperty('fallbackProvider')
      expect(msg).toHaveProperty('correlationId')
      expect(msg).toHaveProperty('idempotencyKey')
      expect(msg).toHaveProperty('wahaMessageId')
      expect(msg).toHaveProperty('delivered')
      expect(msg).toHaveProperty('read')
      expect(msg).toHaveProperty('createdAt')
      expect(msg).toHaveProperty('updatedAt')
    })
  })

  // ── SenderStats Tests ──

  describe('buildOralsinStats().senderStats()', () => {
    it('returns empty array when no senders', () => {
      const stats = buildOralsinStats(db)
      expect(stats.senderStats()).toHaveLength(0)
    })

    it('returns per-sender breakdown from sender_mapping', () => {
      seedSenderMapping('5511111111111', 'device-A', 0)
      seedSenderMapping('5522222222222', 'device-B', 1)

      seedOralsinMessage({ status: 'sent', senderNumber: '5511111111111' })
      seedOralsinMessage({ status: 'sent', senderNumber: '5511111111111' })
      seedOralsinMessage({ status: 'failed', senderNumber: '5511111111111' })
      seedOralsinMessage({ status: 'sent', senderNumber: '5522222222222' })

      const stats = buildOralsinStats(db)
      const result = stats.senderStats()

      expect(result).toHaveLength(2)

      const s1 = result.find((s) => s.phoneNumber === '5511111111111')
      expect(s1).toBeDefined()
      expect(s1!.total).toBe(3)
      expect(s1!.sent).toBe(2)
      expect(s1!.failed).toBe(1)
      expect(s1!.deviceSerial).toBe('device-A')
      expect(s1!.profileId).toBe(0)

      const s2 = result.find((s) => s.phoneNumber === '5522222222222')
      expect(s2).toBeDefined()
      expect(s2!.total).toBe(1)
      expect(s2!.sent).toBe(1)
      expect(s2!.failed).toBe(0)
    })

    it('includes all required fields in sender stats', () => {
      seedSenderMapping('5511111111111', 'device-A', 0)
      const stats = buildOralsinStats(db)
      const result = stats.senderStats()

      expect(result[0]).toHaveProperty('phoneNumber')
      expect(result[0]).toHaveProperty('profileId')
      expect(result[0]).toHaveProperty('deviceSerial')
      expect(result[0]).toHaveProperty('wahaSession')
      expect(result[0]).toHaveProperty('active')
      expect(result[0]).toHaveProperty('total')
      expect(result[0]).toHaveProperty('sent')
      expect(result[0]).toHaveProperty('failed')
      expect(result[0]).toHaveProperty('lastSentAt')
      expect(result[0]).toHaveProperty('avgLatencyMs')
    })

    it('returns zero counts for senders with no oralsin messages', () => {
      seedSenderMapping('5599999999999', 'device-Z', 0)
      // No messages sent from this number

      const stats = buildOralsinStats(db)
      const result = stats.senderStats()

      expect(result).toHaveLength(1)
      expect(result[0].total).toBe(0)
      expect(result[0].sent).toBe(0)
      expect(result[0].failed).toBe(0)
    })
  })

  // ── CallbackLog Tests ──

  describe('buildOralsinStats().callbackLog()', () => {
    it('returns empty array when no failed callbacks', () => {
      const stats = buildOralsinStats(db)
      expect(stats.callbackLog()).toHaveLength(0)
    })

    it('returns only oralsin failed callbacks', () => {
      const msg = seedOralsinMessage({ status: 'sent' })
      seedFailedCallback('oralsin', msg.id, 'result')
      seedFailedCallback('oralsin', msg.id, 'ack')
      seedFailedCallback('other-plugin', msg.id, 'result')

      const stats = buildOralsinStats(db)
      const result = stats.callbackLog()

      expect(result).toHaveLength(2)
      expect(result.every((r) => r.pluginName === 'oralsin')).toBe(true)
    })

    it('includes all required fields in callback log', () => {
      const msg = seedOralsinMessage({ status: 'sent' })
      seedFailedCallback('oralsin', msg.id, 'result')

      const stats = buildOralsinStats(db)
      const result = stats.callbackLog()

      expect(result[0]).toHaveProperty('id')
      expect(result[0]).toHaveProperty('messageId')
      expect(result[0]).toHaveProperty('callbackType')
      expect(result[0]).toHaveProperty('attempts')
      expect(result[0]).toHaveProperty('lastError')
      expect(result[0]).toHaveProperty('createdAt')
      expect(result[0]).toHaveProperty('lastAttemptAt')
      expect(result[0]).toHaveProperty('pluginName')
    })
  })
})
