import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { InboxAutomation } from './inbox-automation.js'
import { ManagedSessions } from './managed-sessions.js'
import type { ChatwootApiClient, ChatwootInbox } from './types.js'
import type { WahaApiClient, WahaSessionInfo } from '../waha/types.js'

function createMockChatwootClient(): ChatwootApiClient {
  return {
    listInboxes: vi.fn<() => Promise<ChatwootInbox[]>>().mockResolvedValue([]),
    createInbox: vi.fn<(name: string) => Promise<ChatwootInbox>>().mockResolvedValue({
      id: 200,
      name: 'Dispatch — 554396835104',
      channel_type: 'api',
      inbox_identifier: 'xyz789',
    }),
    getInbox: vi.fn<(id: number) => Promise<ChatwootInbox>>().mockResolvedValue({
      id: 200,
      name: 'Dispatch — 554396835104',
      channel_type: 'api',
    }),
  }
}

function createMockWahaClient(): WahaApiClient {
  return {
    listSessions: vi.fn<() => Promise<WahaSessionInfo[]>>().mockResolvedValue([]),
    getSession: vi.fn<(name: string) => Promise<WahaSessionInfo>>().mockResolvedValue({
      name: 'oralsin_1_2',
      status: 'WORKING',
      config: { webhooks: [] },
      me: { id: '554396835102@c.us', pushName: 'Contato | Oralsin-Debt' },
      presence: 'offline',
      timestamps: { activity: Date.now() },
    }),
    updateSessionWebhooks: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    restartSession: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    getServerVersion: vi.fn().mockResolvedValue({ version: '2026.3.1', engine: 'GOWS', tier: 'PLUS' }),
    downloadMedia: vi.fn().mockResolvedValue(Buffer.from('')),
  }
}

describe('InboxAutomation', () => {
  let db: Database.Database
  let managedSessions: ManagedSessions
  let chatwootClient: ChatwootApiClient
  let wahaClient: WahaApiClient
  let automation: InboxAutomation

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    managedSessions = new ManagedSessions(db)
    managedSessions.initialize()
    chatwootClient = createMockChatwootClient()
    wahaClient = createMockWahaClient()
    automation = new InboxAutomation(chatwootClient, wahaClient, managedSessions)
  })

  afterEach(() => {
    db.close()
  })

  describe('createInboxForSession', () => {
    it('creates Chatwoot inbox and configures WAHA Chatwoot App', async () => {
      const result = await automation.createInboxForSession('oralsin_1_2')

      expect(result.success).toBe(true)
      expect(result.chatwootInboxId).toBe(200)
      expect(chatwootClient.createInbox).toHaveBeenCalledWith(
        expect.stringContaining('554396835102'),
      )
    })

    it('persists session as managed after successful creation', async () => {
      await automation.createInboxForSession('oralsin_1_2')

      const record = managedSessions.get('oralsin_1_2')
      expect(record).not.toBeNull()
      expect(record!.chatwootInboxId).toBe(200)
      expect(record!.phoneNumber).toBe('554396835102')
      expect(record!.managed).toBe(true)
    })

    it('returns error if WAHA session not found', async () => {
      vi.mocked(wahaClient.getSession).mockRejectedValueOnce(new Error('Session not found'))

      const result = await automation.createInboxForSession('nonexistent')

      expect(result.success).toBe(false)
      expect(result.error).toContain('Session not found')
    })

    it('returns error if Chatwoot inbox creation fails', async () => {
      vi.mocked(chatwootClient.createInbox).mockRejectedValueOnce(new Error('Chatwoot API 422'))

      const result = await automation.createInboxForSession('oralsin_1_2')

      expect(result.success).toBe(false)
      expect(result.error).toContain('422')
    })

    it('uses custom inbox name when provided', async () => {
      await automation.createInboxForSession('oralsin_1_2', { inboxName: 'Custom Name' })

      expect(chatwootClient.createInbox).toHaveBeenCalledWith('Custom Name')
    })

    it('generates default inbox name from session info', async () => {
      await automation.createInboxForSession('oralsin_1_2')

      expect(chatwootClient.createInbox).toHaveBeenCalledWith(
        expect.stringMatching(/Dispatch.*554396835102/),
      )
    })
  })

  describe('listSessionsWithStatus', () => {
    it('enriches WAHA sessions with managed and Chatwoot status', async () => {
      vi.mocked(wahaClient.listSessions).mockResolvedValueOnce([
        {
          name: 'oralsin_1_2',
          status: 'WORKING',
          config: { webhooks: [] },
          me: { id: '554396835102@c.us', pushName: 'Contato' },
          presence: 'offline',
          timestamps: { activity: Date.now() },
        },
        {
          name: 'oralsin_1_3',
          status: 'WORKING',
          config: { webhooks: [] },
          me: { id: '554396837887@c.us', pushName: 'Contato' },
          presence: 'offline',
          timestamps: { activity: Date.now() },
        },
      ])

      // Mark oralsin_1_2 as managed
      managedSessions.add({
        sessionName: 'oralsin_1_2',
        phoneNumber: '554396835102',
        deviceSerial: 'POCO-001',
        profileId: 10,
        chatwootInboxId: 175,
      })

      const result = await automation.listSessionsWithStatus()

      expect(result).toHaveLength(2)
      const s1 = result.find((s) => s.sessionName === 'oralsin_1_2')!
      expect(s1.managed).toBe(true)
      expect(s1.chatwootInboxId).toBe(175)

      const s2 = result.find((s) => s.sessionName === 'oralsin_1_3')!
      expect(s2.managed).toBe(false)
      expect(s2.chatwootInboxId).toBeNull()
    })

    it('returns empty array when no WAHA sessions exist', async () => {
      const result = await automation.listSessionsWithStatus()
      expect(result).toEqual([])
    })
  })

  describe('bulkSetManaged', () => {
    it('marks multiple sessions as managed', async () => {
      vi.mocked(wahaClient.listSessions).mockResolvedValueOnce([
        {
          name: 'oralsin_1_2',
          status: 'WORKING',
          config: { webhooks: [] },
          me: { id: '554396835102@c.us', pushName: 'Contato' },
          presence: 'offline',
          timestamps: { activity: Date.now() },
        },
        {
          name: 'oralsin_1_3',
          status: 'WORKING',
          config: { webhooks: [] },
          me: { id: '554396837887@c.us', pushName: 'Contato' },
          presence: 'offline',
          timestamps: { activity: Date.now() },
        },
      ])

      const results = await automation.bulkSetManaged(['oralsin_1_2', 'oralsin_1_3'])

      expect(results).toHaveLength(2)
      expect(managedSessions.listManaged()).toHaveLength(2)
    })

    it('skips sessions that are already managed', async () => {
      managedSessions.add({
        sessionName: 'oralsin_1_2',
        phoneNumber: '554396835102',
        deviceSerial: 'POCO-001',
        profileId: 10,
        chatwootInboxId: 175,
      })

      vi.mocked(wahaClient.getSession).mockResolvedValueOnce({
        name: 'oralsin_1_2',
        status: 'WORKING',
        config: { webhooks: [] },
        me: { id: '554396835102@c.us', pushName: 'Contato' },
        presence: 'offline',
        timestamps: { activity: Date.now() },
      })

      const results = await automation.bulkSetManaged(['oralsin_1_2'])

      expect(results).toHaveLength(1)
      expect(results[0].alreadyManaged).toBe(true)
    })
  })

  describe('getQrCode', () => {
    it('returns QR code base64 from WAHA API', async () => {
      vi.mocked(wahaClient.getSession).mockResolvedValueOnce({
        name: 'new_session',
        status: 'SCAN_QR_CODE',
        config: { webhooks: [] },
        me: null,
        presence: null,
        timestamps: { activity: Date.now() },
      })

      // Mock the QR endpoint separately
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ qr: 'base64-qr-data' }), { status: 200 }),
      )

      const qr = await automation.getQrCode('new_session')
      expect(qr).toBe('base64-qr-data')
    })

    it('throws if session is not in SCAN_QR_CODE status', async () => {
      vi.mocked(wahaClient.getSession).mockResolvedValueOnce({
        name: 'oralsin_1_2',
        status: 'WORKING',
        config: { webhooks: [] },
        me: { id: '554396835102@c.us', pushName: 'Contato' },
        presence: 'offline',
        timestamps: { activity: Date.now() },
      })

      await expect(automation.getQrCode('oralsin_1_2')).rejects.toThrow(
        /not in SCAN_QR_CODE/,
      )
    })
  })
})
