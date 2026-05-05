import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { ManagedSessions } from './managed-sessions.js'
import type { ManagedSessionRecord } from './types.js'

describe('ManagedSessions', () => {
  let db: Database.Database
  let sessions: ManagedSessions

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    sessions = new ManagedSessions(db)
    sessions.initialize()
  })

  afterEach(() => {
    db.close()
  })

  describe('initialize', () => {
    it('creates managed_sessions table in SQLite', () => {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='managed_sessions'")
        .all()
      expect(tables).toHaveLength(1)
    })

    it('creates table with required columns', () => {
      const columns = db.prepare('PRAGMA table_info(managed_sessions)').all() as { name: string }[]
      const names = columns.map((c) => c.name)
      expect(names).toContain('session_name')
      expect(names).toContain('phone_number')
      expect(names).toContain('device_serial')
      expect(names).toContain('profile_id')
      expect(names).toContain('chatwoot_inbox_id')
      expect(names).toContain('managed')
      expect(names).toContain('created_at')
    })

    it('session_name is primary key', () => {
      sessions.add({
        sessionName: 'oralsin_1_2',
        phoneNumber: '554396835102',
        deviceSerial: 'POCO-001',
        profileId: 10,
        chatwootInboxId: 175,
      })
      // Inserting duplicate should throw
      expect(() =>
        sessions.add({
          sessionName: 'oralsin_1_2',
          phoneNumber: '554396835102',
          deviceSerial: 'POCO-001',
          profileId: 10,
          chatwootInboxId: 175,
        }),
      ).toThrow()
    })
  })

  describe('add', () => {
    it('inserts a managed session record', () => {
      const id = sessions.add({
        sessionName: 'oralsin_1_2',
        phoneNumber: '554396835102',
        deviceSerial: 'POCO-001',
        profileId: 10,
        chatwootInboxId: 175,
      })

      expect(id).toBe('oralsin_1_2')
      const record = sessions.get('oralsin_1_2')
      expect(record).toBeDefined()
      expect(record!.phoneNumber).toBe('554396835102')
      expect(record!.deviceSerial).toBe('POCO-001')
      expect(record!.profileId).toBe(10)
      expect(record!.chatwootInboxId).toBe(175)
      expect(record!.managed).toBe(true)
      expect(record!.createdAt).toBeDefined()
    })

    it('allows null device_serial and profile_id', () => {
      sessions.add({
        sessionName: 'external_session',
        phoneNumber: '554399999999',
        deviceSerial: null,
        profileId: null,
        chatwootInboxId: 200,
      })

      const record = sessions.get('external_session')
      expect(record!.deviceSerial).toBeNull()
      expect(record!.profileId).toBeNull()
    })
  })

  describe('get', () => {
    it('returns null for non-existent session', () => {
      expect(sessions.get('nonexistent')).toBeNull()
    })

    it('returns session record by name', () => {
      sessions.add({
        sessionName: 'oralsin_1_3',
        phoneNumber: '554396837887',
        deviceSerial: 'POCO-001',
        profileId: 11,
        chatwootInboxId: 176,
      })

      const record = sessions.get('oralsin_1_3')
      expect(record).not.toBeNull()
      expect(record!.sessionName).toBe('oralsin_1_3')
    })
  })

  describe('listAll', () => {
    it('returns empty array when no sessions exist', () => {
      expect(sessions.listAll()).toEqual([])
    })

    it('returns all sessions ordered by session_name', () => {
      sessions.add({ sessionName: 'oralsin_1_3', phoneNumber: '554396837887', deviceSerial: 'POCO-001', profileId: 11, chatwootInboxId: null })
      sessions.add({ sessionName: 'oralsin_1_2', phoneNumber: '554396835102', deviceSerial: 'POCO-001', profileId: 10, chatwootInboxId: 175 })

      const all = sessions.listAll()
      expect(all).toHaveLength(2)
      expect(all[0].sessionName).toBe('oralsin_1_2')
      expect(all[1].sessionName).toBe('oralsin_1_3')
    })
  })

  describe('listManaged', () => {
    it('returns only sessions with managed=true', () => {
      sessions.add({ sessionName: 'oralsin_1_2', phoneNumber: '554396835102', deviceSerial: 'POCO-001', profileId: 10, chatwootInboxId: 175 })
      sessions.add({ sessionName: 'oralsin_1_3', phoneNumber: '554396837887', deviceSerial: 'POCO-001', profileId: 11, chatwootInboxId: 176 })
      sessions.setManaged('oralsin_1_3', false)

      const managed = sessions.listManaged()
      expect(managed).toHaveLength(1)
      expect(managed[0].sessionName).toBe('oralsin_1_2')
    })
  })

  describe('setManaged', () => {
    it('sets managed=false for a session', () => {
      sessions.add({ sessionName: 'oralsin_1_2', phoneNumber: '554396835102', deviceSerial: 'POCO-001', profileId: 10, chatwootInboxId: 175 })
      sessions.setManaged('oralsin_1_2', false)

      const record = sessions.get('oralsin_1_2')
      expect(record!.managed).toBe(false)
    })

    it('sets managed=true for a session', () => {
      sessions.add({ sessionName: 'oralsin_1_2', phoneNumber: '554396835102', deviceSerial: 'POCO-001', profileId: 10, chatwootInboxId: 175 })
      sessions.setManaged('oralsin_1_2', false)
      sessions.setManaged('oralsin_1_2', true)

      const record = sessions.get('oralsin_1_2')
      expect(record!.managed).toBe(true)
    })

    it('throws for non-existent session', () => {
      expect(() => sessions.setManaged('nonexistent', true)).toThrow()
    })
  })

  describe('updateChatwootInboxId', () => {
    it('updates the chatwoot_inbox_id for a session', () => {
      sessions.add({ sessionName: 'oralsin_1_2', phoneNumber: '554396835102', deviceSerial: 'POCO-001', profileId: 10, chatwootInboxId: null })
      sessions.updateChatwootInboxId('oralsin_1_2', 175)

      const record = sessions.get('oralsin_1_2')
      expect(record!.chatwootInboxId).toBe(175)
    })
  })

  describe('remove', () => {
    it('deletes a managed session', () => {
      sessions.add({ sessionName: 'oralsin_1_2', phoneNumber: '554396835102', deviceSerial: 'POCO-001', profileId: 10, chatwootInboxId: 175 })
      sessions.remove('oralsin_1_2')

      expect(sessions.get('oralsin_1_2')).toBeNull()
    })

    it('does not throw for non-existent session', () => {
      expect(() => sessions.remove('nonexistent')).not.toThrow()
    })
  })

  describe('findByPhoneNumber', () => {
    it('finds sessions by phone number', () => {
      sessions.add({ sessionName: 'oralsin_1_2', phoneNumber: '554396835102', deviceSerial: 'POCO-001', profileId: 10, chatwootInboxId: 175 })
      sessions.add({ sessionName: 'oralsin_2_2', phoneNumber: '554396835102', deviceSerial: 'POCO-002', profileId: 10, chatwootInboxId: 180 })

      const found = sessions.findByPhoneNumber('554396835102')
      expect(found).toHaveLength(2)
    })

    it('returns empty array when no match', () => {
      expect(sessions.findByPhoneNumber('000000000')).toEqual([])
    })
  })

  describe('findByDeviceSerial', () => {
    it('finds sessions by device serial', () => {
      sessions.add({ sessionName: 'oralsin_1_2', phoneNumber: '554396835102', deviceSerial: 'POCO-001', profileId: 10, chatwootInboxId: 175 })
      sessions.add({ sessionName: 'oralsin_1_3', phoneNumber: '554396837887', deviceSerial: 'POCO-001', profileId: 11, chatwootInboxId: 176 })
      sessions.add({ sessionName: 'oralsin_2_1', phoneNumber: '554396835095', deviceSerial: 'POCO-002', profileId: 0, chatwootInboxId: 177 })

      const found = sessions.findByDeviceSerial('POCO-001')
      expect(found).toHaveLength(2)
    })
  })

  describe('detachFromDevice', () => {
    it('clears device_serial and profile_id of an attached session', () => {
      sessions.add({
        sessionName: 'oralsin_2_1',
        phoneNumber: '554396835095',
        deviceSerial: 'POCO-001',
        profileId: 10,
        chatwootInboxId: null,
      })

      sessions.detachFromDevice('oralsin_2_1')

      const r = sessions.get('oralsin_2_1')
      expect(r!.deviceSerial).toBeNull()
      expect(r!.profileId).toBeNull()
      // Phone and managed flag stay intact — detach only undoes the pin.
      expect(r!.phoneNumber).toBe('554396835095')
      expect(r!.managed).toBe(true)
    })

    it('is idempotent on a session that is already unattached', () => {
      sessions.add({
        sessionName: 'oralsin_2_3',
        phoneNumber: '',
        deviceSerial: null,
        profileId: null,
        chatwootInboxId: null,
      })
      // First call: no-op (nothing to clear) but must not throw.
      expect(() => sessions.detachFromDevice('oralsin_2_3')).not.toThrow()
      expect(() => sessions.detachFromDevice('oralsin_2_3')).not.toThrow()
    })

    it('throws when the session does not exist', () => {
      expect(() => sessions.detachFromDevice('does_not_exist')).toThrow(/not found/)
    })
  })
})
