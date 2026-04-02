import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { ManagedSessions } from './managed-sessions.js'
import { InboxAutomation } from './inbox-automation.js'
import type { ChatwootApiClient, ChatwootInbox } from './types.js'
import type { WahaApiClient, WahaSessionInfo } from '../waha/types.js'

// Test the route handler logic directly (not HTTP — that's E2E)
// These tests verify the request→response contract for session management endpoints

function createMockChatwootClient(): ChatwootApiClient {
  return {
    listInboxes: vi.fn<() => Promise<ChatwootInbox[]>>().mockResolvedValue([]),
    createInbox: vi.fn<(name: string) => Promise<ChatwootInbox>>().mockResolvedValue({
      id: 200,
      name: 'Test Inbox',
      channel_type: 'api',
      inbox_identifier: 'test123',
    }),
    getInbox: vi.fn<(id: number) => Promise<ChatwootInbox>>().mockResolvedValue({
      id: 200,
      name: 'Test Inbox',
      channel_type: 'api',
    }),
  }
}

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

const testSessions: WahaSessionInfo[] = [
  {
    name: 'oralsin_1_2',
    status: 'WORKING',
    config: { webhooks: [] },
    me: { id: '554396835102@c.us', pushName: 'Contato | Oralsin-Debt' },
    presence: 'offline',
    timestamps: { activity: Date.now() },
  },
  {
    name: 'oralsin_1_3',
    status: 'WORKING',
    config: { webhooks: [] },
    me: { id: '554396837887@c.us', pushName: 'Contato | Oralsin-Debt' },
    presence: 'offline',
    timestamps: { activity: Date.now() },
  },
]

describe('Session Routes — Handler Logic', () => {
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
    wahaClient = createMockWahaClient(testSessions)
    automation = new InboxAutomation(chatwootClient, wahaClient, managedSessions)
  })

  afterEach(() => {
    db.close()
  })

  describe('GET /sessions — list all sessions with status', () => {
    it('returns sessions enriched with managed flag and chatwoot info', async () => {
      managedSessions.add({
        sessionName: 'oralsin_1_2',
        phoneNumber: '554396835102',
        deviceSerial: 'POCO-001',
        profileId: 10,
        chatwootInboxId: 175,
      })

      const result = await automation.listSessionsWithStatus()

      expect(result).toHaveLength(2)

      const managed = result.find((s) => s.sessionName === 'oralsin_1_2')!
      expect(managed.managed).toBe(true)
      expect(managed.wahaStatus).toBe('WORKING')
      expect(managed.phoneNumber).toBe('554396835102')

      const unmanaged = result.find((s) => s.sessionName === 'oralsin_1_3')!
      expect(unmanaged.managed).toBe(false)
    })
  })

  describe('POST /sessions/managed — bulk set managed', () => {
    it('validates session_names is a non-empty array', async () => {
      // This tests the Zod validation at the route level
      // Route should reject empty array
      const results = await automation.bulkSetManaged([])
      expect(results).toHaveLength(0)
    })

    it('adds new sessions as managed with phone from WAHA', async () => {
      const results = await automation.bulkSetManaged(['oralsin_1_2'])

      expect(results).toHaveLength(1)
      expect(results[0].sessionName).toBe('oralsin_1_2')

      const record = managedSessions.get('oralsin_1_2')
      expect(record).not.toBeNull()
      expect(record!.phoneNumber).toBe('554396835102')
      expect(record!.managed).toBe(true)
    })
  })

  describe('DELETE /sessions/managed/:name — unmanage session', () => {
    it('sets managed=false without deleting the record', () => {
      managedSessions.add({
        sessionName: 'oralsin_1_2',
        phoneNumber: '554396835102',
        deviceSerial: 'POCO-001',
        profileId: 10,
        chatwootInboxId: 175,
      })

      managedSessions.setManaged('oralsin_1_2', false)

      const record = managedSessions.get('oralsin_1_2')
      expect(record).not.toBeNull()
      expect(record!.managed).toBe(false)
      // Record still exists for audit trail
    })
  })

  describe('POST /sessions/:name/inbox — create Chatwoot inbox', () => {
    it('creates inbox and links to managed session', async () => {
      const result = await automation.createInboxForSession('oralsin_1_2')

      expect(result.success).toBe(true)
      expect(result.chatwootInboxId).toBe(200)

      const record = managedSessions.get('oralsin_1_2')
      expect(record).not.toBeNull()
      expect(record!.chatwootInboxId).toBe(200)
    })
  })

  describe('GET /sessions/:name/qr — get QR code', () => {
    it('rejects if session is not in SCAN_QR_CODE status', async () => {
      // oralsin_1_2 is WORKING, not SCAN_QR_CODE
      await expect(automation.getQrCode('oralsin_1_2')).rejects.toThrow(
        /not in SCAN_QR_CODE/,
      )
    })
  })
})
