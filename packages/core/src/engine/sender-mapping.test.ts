import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { SenderMapping } from './sender-mapping.js'
import type { SenderMappingRecord } from './sender-mapping.js'

describe('SenderMapping', () => {
  let db: Database.Database
  let mapping: SenderMapping

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    mapping = new SenderMapping(db)
    mapping.initialize()
  })

  afterEach(() => {
    db.close()
  })

  describe('initialize', () => {
    it('creates sender_mapping table', () => {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sender_mapping'")
        .all() as { name: string }[]
      expect(tables).toHaveLength(1)
    })

    it('creates indexes on device_serial and active', () => {
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='sender_mapping'")
        .all() as { name: string }[]
      const indexNames = indexes.map((i) => i.name)
      expect(indexNames).toContain('idx_sender_mapping_device')
      expect(indexNames).toContain('idx_sender_mapping_active')
    })
  })

  describe('create', () => {
    it('creates a new mapping', () => {
      const result = mapping.create({
        phoneNumber: '+554396837945',
        deviceSerial: '9b01005930533036',
        profileId: 0,
        appPackage: 'com.whatsapp',
        wahaSession: 'oralsin_1_4',
        wahaApiUrl: 'https://gows-chat.debt.com.br',
      })

      expect(result.id).toBeDefined()
      expect(result.phone_number).toBe('554396837945')
      expect(result.device_serial).toBe('9b01005930533036')
      expect(result.profile_id).toBe(0)
      expect(result.app_package).toBe('com.whatsapp')
      expect(result.waha_session).toBe('oralsin_1_4')
      expect(result.waha_api_url).toBe('https://gows-chat.debt.com.br')
      expect(result.active).toBe(1)
    })

    it('rejects duplicate phone numbers', () => {
      mapping.create({
        phoneNumber: '+554396837945',
        deviceSerial: '9b01005930533036',
        profileId: 0,
        appPackage: 'com.whatsapp',
      })

      expect(() =>
        mapping.create({
          phoneNumber: '+554396837945',
          deviceSerial: 'OTHER_SERIAL',
          profileId: 0,
          appPackage: 'com.whatsapp',
        }),
      ).toThrow(/UNIQUE constraint/)
    })

    it('uses defaults for optional fields', () => {
      const result = mapping.create({
        phoneNumber: '+554396837945',
        deviceSerial: '9b01005930533036',
      })

      expect(result.profile_id).toBe(0)
      expect(result.app_package).toBe('com.whatsapp')
      expect(result.waha_session).toBeNull()
      expect(result.waha_api_url).toBeNull()
    })
  })

  describe('getByPhone', () => {
    it('returns mapping for known phone', () => {
      mapping.create({
        phoneNumber: '+554396837945',
        deviceSerial: '9b01005930533036',
        profileId: 0,
        appPackage: 'com.whatsapp',
      })

      const result = mapping.getByPhone('+554396837945')
      expect(result).not.toBeNull()
      expect(result!.phone_number).toBe('554396837945')
    })

    it('returns null for unknown phone', () => {
      const result = mapping.getByPhone('+559999999999')
      expect(result).toBeNull()
    })

    it('returns only active mappings', () => {
      mapping.create({
        phoneNumber: '+554396837945',
        deviceSerial: '9b01005930533036',
        profileId: 0,
        appPackage: 'com.whatsapp',
      })
      mapping.deactivate('554396837945')

      const result = mapping.getByPhone('+554396837945')
      expect(result).toBeNull()
    })
  })

  describe('listAll', () => {
    it('lists all active mappings', () => {
      mapping.create({
        phoneNumber: '+554396837945',
        deviceSerial: '9b01005930533036',
        profileId: 0,
        appPackage: 'com.whatsapp',
      })
      mapping.create({
        phoneNumber: '+554396837844',
        deviceSerial: '9b01005930533036',
        profileId: 0,
        appPackage: 'com.whatsapp.w4b',
      })

      const all = mapping.listAll()
      expect(all).toHaveLength(2)
    })

    it('excludes deactivated mappings by default', () => {
      mapping.create({
        phoneNumber: '+554396837945',
        deviceSerial: '9b01005930533036',
        profileId: 0,
        appPackage: 'com.whatsapp',
      })
      mapping.create({
        phoneNumber: '+554396837844',
        deviceSerial: '9b01005930533036',
        profileId: 0,
        appPackage: 'com.whatsapp.w4b',
      })
      mapping.deactivate('554396837844')

      const all = mapping.listAll()
      expect(all).toHaveLength(1)
      expect(all[0].phone_number).toBe('554396837945')
    })
  })

  describe('update', () => {
    it('updates device_serial and profile_id', () => {
      mapping.create({
        phoneNumber: '+554396837945',
        deviceSerial: '9b01005930533036',
        profileId: 0,
        appPackage: 'com.whatsapp',
      })

      const updated = mapping.update('554396837945', {
        deviceSerial: 'NEW_DEVICE_001',
        profileId: 10,
      })

      expect(updated).not.toBeNull()
      expect(updated!.device_serial).toBe('NEW_DEVICE_001')
      expect(updated!.profile_id).toBe(10)
    })

    it('returns null for unknown phone', () => {
      const result = mapping.update('+559999999999', { deviceSerial: 'NEW' })
      expect(result).toBeNull()
    })
  })

  describe('deactivate', () => {
    it('sets active = 0', () => {
      mapping.create({
        phoneNumber: '+554396837945',
        deviceSerial: '9b01005930533036',
        profileId: 0,
        appPackage: 'com.whatsapp',
      })

      mapping.deactivate('554396837945')

      // Direct query to verify (getByPhone filters inactive)
      const row = db.prepare('SELECT active FROM sender_mapping WHERE phone_number = ?').get('554396837945') as { active: number }
      expect(row.active).toBe(0)
    })
  })

  describe('delete', () => {
    it('removes the mapping entirely', () => {
      mapping.create({
        phoneNumber: '+554396837945',
        deviceSerial: '9b01005930533036',
        profileId: 0,
        appPackage: 'com.whatsapp',
      })

      const deleted = mapping.remove('554396837945')
      expect(deleted).toBe(true)

      const row = db.prepare('SELECT * FROM sender_mapping WHERE phone_number = ?').get('554396837945')
      expect(row).toBeUndefined()
    })

    it('returns false for unknown phone', () => {
      const deleted = mapping.remove('+559999999999')
      expect(deleted).toBe(false)
    })
  })

  describe('getByDeviceSerial', () => {
    it('returns all mappings for a device', () => {
      mapping.create({
        phoneNumber: '+554396837945',
        deviceSerial: '9b01005930533036',
        profileId: 0,
        appPackage: 'com.whatsapp',
      })
      mapping.create({
        phoneNumber: '+554396837844',
        deviceSerial: '9b01005930533036',
        profileId: 10,
        appPackage: 'com.whatsapp',
      })
      mapping.create({
        phoneNumber: '+554399999999',
        deviceSerial: 'OTHER_DEVICE',
        profileId: 0,
        appPackage: 'com.whatsapp',
      })

      const results = mapping.getByDeviceSerial('9b01005930533036')
      expect(results).toHaveLength(2)
      expect(results.every((r) => r.device_serial === '9b01005930533036')).toBe(true)
    })
  })

  describe('pauseSender', () => {
    it('sets paused=1 with reason and timestamp', () => {
      mapping.create({
        phoneNumber: '+554396837945',
        deviceSerial: '9b01005930533036',
      })

      mapping.pauseSender('554396837945', 'manual maintenance')

      const row = db.prepare(
        'SELECT paused, paused_at, paused_reason FROM sender_mapping WHERE phone_number = ?',
      ).get('554396837945') as { paused: number; paused_at: string | null; paused_reason: string | null }

      expect(row.paused).toBe(1)
      expect(row.paused_at).toBeTruthy()
      expect(row.paused_reason).toBe('manual maintenance')
    })

    it('sets paused without reason', () => {
      mapping.create({
        phoneNumber: '+554396837945',
        deviceSerial: '9b01005930533036',
      })

      mapping.pauseSender('554396837945')

      const row = db.prepare(
        'SELECT paused, paused_reason FROM sender_mapping WHERE phone_number = ?',
      ).get('554396837945') as { paused: number; paused_reason: string | null }

      expect(row.paused).toBe(1)
      expect(row.paused_reason).toBeNull()
    })
  })

  describe('resumeSender', () => {
    it('clears paused state', () => {
      mapping.create({
        phoneNumber: '+554396837945',
        deviceSerial: '9b01005930533036',
      })

      mapping.pauseSender('554396837945', 'testing')
      mapping.resumeSender('554396837945')

      const row = db.prepare(
        'SELECT paused, paused_at, paused_reason FROM sender_mapping WHERE phone_number = ?',
      ).get('554396837945') as { paused: number; paused_at: string | null; paused_reason: string | null }

      expect(row.paused).toBe(0)
      expect(row.paused_at).toBeNull()
      expect(row.paused_reason).toBeNull()
    })
  })

  describe('isPaused', () => {
    it('returns true for paused sender', () => {
      mapping.create({
        phoneNumber: '+554396837945',
        deviceSerial: '9b01005930533036',
      })

      mapping.pauseSender('554396837945')
      expect(mapping.isPaused('554396837945')).toBe(true)
    })

    it('returns false for non-paused sender', () => {
      mapping.create({
        phoneNumber: '+554396837945',
        deviceSerial: '9b01005930533036',
      })

      expect(mapping.isPaused('554396837945')).toBe(false)
    })

    it('returns false for unknown sender', () => {
      expect(mapping.isPaused('559999999999')).toBe(false)
    })

    it('returns false after resume', () => {
      mapping.create({
        phoneNumber: '+554396837945',
        deviceSerial: '9b01005930533036',
      })

      mapping.pauseSender('554396837945')
      mapping.resumeSender('554396837945')
      expect(mapping.isPaused('554396837945')).toBe(false)
    })
  })

  describe('listAll includes paused fields', () => {
    it('returns paused fields in records', () => {
      mapping.create({
        phoneNumber: '+554396837945',
        deviceSerial: '9b01005930533036',
      })
      mapping.pauseSender('554396837945', 'quota reached')

      const all = mapping.listAll()
      expect(all).toHaveLength(1)
      expect(all[0].paused).toBe(1)
      expect(all[0].paused_reason).toBe('quota reached')
    })
  })

  describe('resolveSenderChain', () => {
    it('returns first sender with active mapping', () => {
      mapping.create({
        phoneNumber: '+554396837945',
        deviceSerial: '9b01005930533036',
        profileId: 0,
        appPackage: 'com.whatsapp',
        wahaSession: 'oralsin_1_4',
      })

      const senders = [
        { phone: '+554396837945', session: 'oralsin_1_4', pair: 'oralsin-1-4', role: 'primary' as const },
      ]

      const result = mapping.resolveSenderChain(senders)
      expect(result).not.toBeNull()
      expect(result!.mapping.phone_number).toBe('554396837945')
      expect(result!.sender.role).toBe('primary')
    })

    it('falls back to overflow when primary has no mapping', () => {
      mapping.create({
        phoneNumber: '+554396837844',
        deviceSerial: '9b01005930533036',
        profileId: 0,
        appPackage: 'com.whatsapp',
        wahaSession: 'oralsin_2_3',
      })

      const senders = [
        { phone: '+554396837945', session: 'oralsin_1_4', pair: 'oralsin-1-4', role: 'primary' as const },
        { phone: '+554396837844', session: 'oralsin_2_3', pair: 'oralsin-2-3', role: 'overflow' as const },
      ]

      const result = mapping.resolveSenderChain(senders)
      expect(result).not.toBeNull()
      expect(result!.mapping.phone_number).toBe('554396837844')
      expect(result!.sender.role).toBe('overflow')
    })

    it('falls back to backup when overflow also missing', () => {
      mapping.create({
        phoneNumber: '+554399991111',
        deviceSerial: '9b01005930533036',
        profileId: 0,
        appPackage: 'com.whatsapp',
        wahaSession: 'oralsin_3_1',
      })

      const senders = [
        { phone: '+554396837945', session: 'oralsin_1_4', pair: 'oralsin-1-4', role: 'primary' as const },
        { phone: '+554396837844', session: 'oralsin_2_3', pair: 'oralsin-2-3', role: 'overflow' as const },
        { phone: '+554399991111', session: 'oralsin_3_1', pair: 'oralsin-3-1', role: 'backup' as const },
      ]

      const result = mapping.resolveSenderChain(senders)
      expect(result).not.toBeNull()
      expect(result!.sender.role).toBe('backup')
    })

    it('returns null when no sender has a mapping', () => {
      const senders = [
        { phone: '+554396837945', session: 'oralsin_1_4', pair: 'oralsin-1-4', role: 'primary' as const },
        { phone: '+554396837844', session: 'oralsin_2_3', pair: 'oralsin-2-3', role: 'overflow' as const },
      ]

      const result = mapping.resolveSenderChain(senders)
      expect(result).toBeNull()
    })
  })
})
