import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { SessionManager } from './session-manager.js'
import { DispatchEmitter } from '../events/index.js'
import type { WahaApiClient, WahaSessionInfo } from './types.js'

function createMockWahaClient(sessions: WahaSessionInfo[] = []): WahaApiClient {
  return {
    listSessions: vi.fn<() => Promise<WahaSessionInfo[]>>().mockResolvedValue(sessions),
    getSession: vi.fn<(name: string) => Promise<WahaSessionInfo>>().mockImplementation(async (name) => {
      const s = sessions.find((s) => s.name === name)
      if (!s) throw new Error(`Session ${name} not found`)
      return s
    }),
    updateSessionWebhooks: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    restartSession: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    getServerVersion: vi.fn().mockResolvedValue({ version: '2026.3.1', engine: 'GOWS', tier: 'PLUS' }),
    downloadMedia: vi.fn().mockResolvedValue(Buffer.from('')),
  }
}

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

describe('SessionManager', () => {
  let db: Database.Database
  let emitter: DispatchEmitter
  let wahaClient: WahaApiClient
  let manager: SessionManager

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    emitter = new DispatchEmitter()

    // Create whatsapp_accounts table (from Phase 2 WaAccountMapper)
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
    // Seed with test data: 2 numbers that exist in WAHA
    db.prepare(`
      INSERT INTO whatsapp_accounts (device_serial, profile_id, package_name, phone_number)
      VALUES (?, ?, ?, ?)
    `).run('POCO-001', 0, 'com.whatsapp', '554396835104')
    db.prepare(`
      INSERT INTO whatsapp_accounts (device_serial, profile_id, package_name, phone_number)
      VALUES (?, ?, ?, ?)
    `).run('POCO-001', 0, 'com.whatsapp.w4b', '554396835100')

    wahaClient = createMockWahaClient([
      makeSession({ name: 'oralsin_main_1', me: { id: '554396835104@c.us', pushName: 'Oralsin 1' } }),
      makeSession({ name: 'oralsin_main_2', me: { id: '554396835100@c.us', pushName: 'Oralsin 2' } }),
      makeSession({ name: 'SDR43996014855', me: { id: '554396014855@c.us', pushName: 'SDR' } }),
    ])

    manager = new SessionManager(db, emitter, wahaClient, {
      dispatchWebhookUrl: 'https://dispatch.debt.com.br/api/v1/webhooks/waha',
      hmacSecret: 'test-hmac-secret',
    })
    manager.initialize()
  })

  afterEach(() => {
    manager.stop()
    db.close()
  })

  describe('discoverManagedSessions', () => {
    it('returns sessions matching phone numbers in whatsapp_accounts', async () => {
      const managed = await manager.discoverManagedSessions()

      expect(managed).toHaveLength(2)
      const numbers = managed.map((m) => m.phoneNumber).sort()
      expect(numbers).toEqual(['554396835100', '554396835104'])
    })

    it('includes device serial and profile from whatsapp_accounts', async () => {
      const managed = await manager.discoverManagedSessions()

      const oralsin1 = managed.find((m) => m.phoneNumber === '554396835104')
      expect(oralsin1).toBeDefined()
      expect(oralsin1!.sessionName).toBe('oralsin_main_1')
      expect(oralsin1!.deviceSerial).toBe('POCO-001')
      expect(oralsin1!.profileId).toBe(0)
      expect(oralsin1!.status).toBe('WORKING')
    })

    it('ignores WAHA sessions for numbers NOT in whatsapp_accounts', async () => {
      const managed = await manager.discoverManagedSessions()

      const sdrSession = managed.find((m) => m.sessionName === 'SDR43996014855')
      expect(sdrSession).toBeUndefined()
    })

    it('handles WAHA sessions with null me (not yet paired)', async () => {
      ;(wahaClient.listSessions as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        makeSession({ name: 'orphan', me: null }),
        makeSession({ name: 'oralsin_main_1', me: { id: '554396835104@c.us', pushName: 'O1' } }),
      ])

      const managed = await manager.discoverManagedSessions()
      expect(managed).toHaveLength(1)
      expect(managed[0].sessionName).toBe('oralsin_main_1')
    })
  })

  describe('checkHealth', () => {
    it('does NOT generate alert for WORKING sessions', async () => {
      const events: unknown[] = []
      emitter.on('alert:new', (data) => events.push(data))

      await manager.checkHealth()

      const wahaAlerts = events.filter(
        (e) => (e as Record<string, unknown>).type === 'waha_session_down',
      )
      expect(wahaAlerts).toHaveLength(0)
    })

    it('detects FAILED session and triggers restart', async () => {
      ;(wahaClient.listSessions as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        makeSession({ name: 'oralsin_main_1', status: 'FAILED', me: { id: '554396835104@c.us', pushName: 'O1' } }),
        makeSession({ name: 'oralsin_main_2', me: { id: '554396835100@c.us', pushName: 'O2' } }),
      ])

      await manager.checkHealth()

      expect(wahaClient.restartSession).toHaveBeenCalledWith('oralsin_main_1')
    })

    it('generates alert when session is FAILED', async () => {
      ;(wahaClient.listSessions as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        makeSession({ name: 'oralsin_main_1', status: 'FAILED', me: { id: '554396835104@c.us', pushName: 'O1' } }),
      ])

      const events: unknown[] = []
      emitter.on('alert:new', (data) => events.push(data))

      await manager.checkHealth()

      expect(events).toHaveLength(1)
      const alert = events[0] as Record<string, unknown>
      expect(alert.type).toBe('waha_session_down')
      expect(alert.severity).toBe('high')
    })
  })

  describe('addWebhook', () => {
    it('adds Dispatch webhook to session via WAHA API', async () => {
      await manager.addWebhook('oralsin_main_1')

      expect(wahaClient.updateSessionWebhooks).toHaveBeenCalledWith(
        'oralsin_main_1',
        expect.arrayContaining([
          expect.objectContaining({
            url: 'https://dispatch.debt.com.br/api/v1/webhooks/waha',
            events: expect.arrayContaining(['message.any', 'session.status', 'message.ack']),
            hmac: { key: 'test-hmac-secret' },
          }),
        ]),
      )
    })

    it('preserves existing webhooks when adding Dispatch webhook', async () => {
      const existingWebhooks = [
        { url: 'https://api.oralsin.debt.com.br/api/webhooks/waha-gows/oralsin', events: ['message'] },
      ]
      ;(wahaClient.getSession as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        makeSession({ config: { webhooks: existingWebhooks } }),
      )

      await manager.addWebhook('oralsin_main_1')

      const call = (wahaClient.updateSessionWebhooks as ReturnType<typeof vi.fn>).mock.calls[0]
      const webhooks = call[1]
      // Should have both: existing Oralsin + new Dispatch
      expect(webhooks.length).toBeGreaterThanOrEqual(2)
      expect(webhooks.some((w: { url: string }) => w.url.includes('oralsin'))).toBe(true)
      expect(webhooks.some((w: { url: string }) => w.url.includes('dispatch'))).toBe(true)
    })

    it('is idempotent — does not duplicate Dispatch webhook', async () => {
      const existingWebhooks = [
        { url: 'https://dispatch.debt.com.br/api/v1/webhooks/waha', events: ['message.any'] },
      ]
      ;(wahaClient.getSession as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        makeSession({ config: { webhooks: existingWebhooks } }),
      )

      await manager.addWebhook('oralsin_main_1')

      const call = (wahaClient.updateSessionWebhooks as ReturnType<typeof vi.fn>).mock.calls[0]
      const webhooks = call[1]
      const dispatchWebhooks = webhooks.filter((w: { url: string }) => w.url.includes('dispatch'))
      expect(dispatchWebhooks).toHaveLength(1)
    })
  })

  describe('restartSession', () => {
    it('calls WAHA restart API', async () => {
      await manager.restartSession('oralsin_main_1')

      expect(wahaClient.restartSession).toHaveBeenCalledWith('oralsin_main_1')
    })
  })
})
