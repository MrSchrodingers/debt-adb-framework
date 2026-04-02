import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { SessionManager } from './session-manager.js'
import { MessageQueue } from '../queue/index.js'
import { DispatchEmitter } from '../events/index.js'
import type { WahaApiClient, WahaSessionInfo } from './types.js'

function makeSession(overrides: Partial<WahaSessionInfo> = {}): WahaSessionInfo {
  return {
    name: 'oralsin_main_1',
    status: 'WORKING',
    config: { webhooks: [] },
    me: { id: '554396835104@c.us', pushName: 'Contato | Oralsin-Debt' },
    presence: 'offline',
    timestamps: { activity: Date.now() },
    ...overrides,
  }
}

describe('WAHA-ADB Independence', () => {
  let db: Database.Database
  let emitter: DispatchEmitter
  let queue: MessageQueue
  let wahaClient: WahaApiClient
  let sessionManager: SessionManager

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    emitter = new DispatchEmitter()

    // Initialize queue (Phase 1)
    queue = new MessageQueue(db)
    queue.initialize()

    // Create whatsapp_accounts table (Phase 2)
    db.exec(`
      CREATE TABLE IF NOT EXISTS whatsapp_accounts (
        device_serial TEXT NOT NULL,
        profile_id INTEGER NOT NULL,
        package_name TEXT NOT NULL,
        phone_number TEXT,
        status TEXT DEFAULT 'active',
        PRIMARY KEY (device_serial, profile_id, package_name)
      )
    `)
    db.prepare(`
      INSERT INTO whatsapp_accounts (device_serial, profile_id, package_name, phone_number)
      VALUES (?, ?, ?, ?)
    `).run('POCO-001', 0, 'com.whatsapp', '554396835104')

    wahaClient = {
      listSessions: vi.fn<() => Promise<WahaSessionInfo[]>>().mockResolvedValue([
        makeSession({ name: 'oralsin_main_1', status: 'FAILED', me: { id: '554396835104@c.us', pushName: 'O1' } }),
      ]),
      getSession: vi.fn().mockResolvedValue(makeSession({ status: 'FAILED' })),
      updateSessionWebhooks: vi.fn().mockResolvedValue(undefined),
      restartSession: vi.fn().mockResolvedValue(undefined),
      getServerVersion: vi.fn().mockResolvedValue({ version: '2026.3.1', engine: 'GOWS', tier: 'PLUS' }),
      downloadMedia: vi.fn().mockResolvedValue(Buffer.from('')),
    }

    sessionManager = new SessionManager(db, emitter, wahaClient)
    sessionManager.initialize()
  })

  afterEach(() => {
    sessionManager.stop()
    db.close()
  })

  it('WAHA session banned generates waha_session_down alert', async () => {
    ;(wahaClient.listSessions as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      makeSession({
        name: 'oralsin_main_1',
        status: 'FAILED',
        me: { id: '554396835104@c.us', pushName: 'O1' },
      }),
    ])

    const alerts: unknown[] = []
    emitter.on('alert:new', (data) => alerts.push(data))

    await sessionManager.checkHealth()

    expect(alerts.length).toBeGreaterThanOrEqual(1)
    const wahaAlert = alerts.find((a) => (a as Record<string, unknown>).type === 'waha_session_down')
    expect(wahaAlert).toBeDefined()
  })

  it('WAHA session banned but ADB message queue continues processing', async () => {
    // Enqueue a message
    const msg = queue.enqueue({
      to: '5543991938235',
      body: 'Test payment reminder',
      idempotencyKey: 'test-independence-001',
      senderNumber: '554396835104',
    })
    expect(msg.status).toBe('queued')

    // WAHA session goes down
    await sessionManager.checkHealth()

    // ADB queue should still work — dequeue should return the message
    const dequeued = queue.dequeue('POCO-001')
    expect(dequeued).not.toBeNull()
    expect(dequeued!.id).toBe(msg.id)
    expect(dequeued!.body).toBe('Test payment reminder')
  })

  it('WAHA ban and ADB send operate completely independently', async () => {
    // 1. Enqueue multiple messages
    queue.enqueue({
      to: '5543991938235',
      body: 'Message 1',
      idempotencyKey: 'indep-001',
      senderNumber: '554396835104',
    })
    queue.enqueue({
      to: '5543991938235',
      body: 'Message 2',
      idempotencyKey: 'indep-002',
      senderNumber: '554396835104',
    })

    // 2. WAHA session is FAILED (banned)
    await sessionManager.checkHealth()

    // 3. Queue operations are unaffected
    const first = queue.dequeue('POCO-001')
    expect(first).not.toBeNull()
    expect(first!.body).toBe('Message 1')

    // Simulate send completion
    queue.updateStatus(first!.id, 'sent')

    const second = queue.dequeue('POCO-001')
    expect(second).not.toBeNull()
    expect(second!.body).toBe('Message 2')
  })

  it('WAHA session recovery does not interfere with active ADB sends', async () => {
    // 1. Session starts FAILED
    await sessionManager.checkHealth()

    // 2. Enqueue and dequeue (ADB working)
    const msg = queue.enqueue({
      to: '5543991938235',
      body: 'During recovery',
      idempotencyKey: 'recovery-001',
      senderNumber: '554396835104',
    })
    const locked = queue.dequeue('POCO-001')
    expect(locked).not.toBeNull()

    // 3. Session recovers (status changes to WORKING)
    ;(wahaClient.listSessions as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      makeSession({ name: 'oralsin_main_1', status: 'WORKING', me: { id: '554396835104@c.us', pushName: 'O1' } }),
    ])
    await sessionManager.checkHealth()

    // 4. The locked message is still locked by ADB — no interference
    const stillLocked = queue.getById(msg.id)
    expect(stillLocked!.status).toBe('locked')
    expect(stillLocked!.lockedBy).toBe('POCO-001')
  })
})
