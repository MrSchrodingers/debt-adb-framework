import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { WaAccountMapper } from './wa-account-mapper.js'
import type { WhatsAppAccount } from './types.js'

describe('WaAccountMapper', () => {
  let db: Database.Database
  let mapper: WaAccountMapper

  const fakeShell = vi.fn<(serial: string, command: string) => Promise<string>>()

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    mapper = new WaAccountMapper(db, { shell: fakeShell })
    mapper.initialize()
    fakeShell.mockReset()
  })

  afterEach(() => {
    db.close()
  })

  describe('initialize', () => {
    it('creates whatsapp_accounts table', () => {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='whatsapp_accounts'")
        .all()
      expect(tables).toHaveLength(1)
    })

    it('creates table with required columns', () => {
      const columns = db.prepare('PRAGMA table_info(whatsapp_accounts)').all() as { name: string }[]
      const names = columns.map((c) => c.name)
      expect(names).toContain('device_serial')
      expect(names).toContain('profile_id')
      expect(names).toContain('package_name')
      expect(names).toContain('phone_number')
    })
  })

  describe('mapAccounts', () => {
    it('detects WhatsApp on user 0', async () => {
      fakeShell.mockImplementation(async (_serial: string, cmd: string) => {
        if (cmd.includes('pm list packages --user 0') && cmd.includes('whatsapp'))
          return 'package:com.whatsapp'
        if (cmd.includes('content query') && cmd.includes("account_type='com.whatsapp") && cmd.includes("content query") && cmd.includes('--user 0'))
          return 'Row: 0 sync1=5543968350100@s.whatsapp.net'
        return ''
      })

      const accounts = await mapper.mapAccounts('ABC123')

      expect(accounts).toHaveLength(1)
      expect(accounts[0].phoneNumber).toBe('5543968350100')
      expect(accounts[0].packageName).toBe('com.whatsapp')
      expect(accounts[0].profileId).toBe(0)
    })

    it('detects both WA and WABA on same profile', async () => {
      fakeShell.mockImplementation(async (_serial: string, cmd: string) => {
        if (cmd.includes('pm list packages --user 0') && cmd.includes('whatsapp'))
          return 'package:com.whatsapp\npackage:com.whatsapp.w4b'
        if (cmd.includes('content query') && cmd.includes("account_type='com.whatsapp") && cmd.includes("content query") && !cmd.includes('w4b') && cmd.includes('--user 0'))
          return 'Row: 0 sync1=5543968350100@s.whatsapp.net'
        if (cmd.includes('content query') && cmd.includes("account_type=") && cmd.includes("com.whatsapp.w4b") && cmd.includes("content query") && cmd.includes('--user 0'))
          return 'Row: 0 sync1=5543968350101@s.whatsapp.net'
        return ''
      })

      const accounts = await mapper.mapAccounts('ABC123')

      expect(accounts).toHaveLength(2)
      const packages = accounts.map((a) => a.packageName)
      expect(packages).toContain('com.whatsapp')
      expect(packages).toContain('com.whatsapp.w4b')
    })

    it('iterates user profiles 0, 10, 11, 12', async () => {
      const profilesSeen = new Set<string>()
      fakeShell.mockImplementation(async (_serial: string, cmd: string) => {
        const userMatch = cmd.match(/--user (\d+)/)
        if (userMatch) profilesSeen.add(userMatch[1])
        if (cmd.includes('pm list packages') && cmd.includes('--user 10'))
          return 'package:com.whatsapp'
        if (cmd.includes('content query') && cmd.includes("account_type='com.whatsapp") && cmd.includes("content query") && cmd.includes('--user 10'))
          return 'Row: 0 sync1=5543968350095@s.whatsapp.net'
        return ''
      })

      await mapper.mapAccounts('ABC123')

      expect(profilesSeen).toContain('0')
      expect(profilesSeen).toContain('10')
      expect(profilesSeen).toContain('11')
      expect(profilesSeen).toContain('12')
    })

    it('persists accounts in SQLite', async () => {
      fakeShell.mockImplementation(async (_serial: string, cmd: string) => {
        if (cmd.includes('pm list packages --user 0') && cmd.includes('whatsapp'))
          return 'package:com.whatsapp'
        if (cmd.includes('content query') && cmd.includes("account_type='com.whatsapp") && cmd.includes("content query") && cmd.includes('--user 0'))
          return 'Row: 0 sync1=5543968350100@s.whatsapp.net'
        return ''
      })

      await mapper.mapAccounts('ABC123')

      const rows = db
        .prepare('SELECT * FROM whatsapp_accounts WHERE device_serial = ?')
        .all('ABC123')
      expect(rows).toHaveLength(1)
    })

    it('handles profile with no WhatsApp installed', async () => {
      fakeShell.mockImplementation(async () => '')

      const accounts = await mapper.mapAccounts('ABC123')

      expect(accounts).toHaveLength(0)
    })

    it('handles unreadable shared_prefs gracefully', async () => {
      fakeShell.mockImplementation(async (_serial: string, cmd: string) => {
        if (cmd.includes('pm list packages --user 0') && cmd.includes('whatsapp'))
          return 'package:com.whatsapp'
        if (cmd.includes('shared_prefs'))
          throw new Error('Permission denied')
        return ''
      })

      const accounts = await mapper.mapAccounts('ABC123')

      expect(accounts).toHaveLength(1)
      expect(accounts[0].phoneNumber).toBeNull()
    })

    describe('root SharedPrefs fallback (3rd attempt)', () => {
      const SHARED_PREFS_XML = `<map>
<string name="cc">55</string>
<string name="registration_jid">5543991938235@s.whatsapp.net</string>
<string name="self_lid">5543991938235@lid</string>
</map>`

      const SHARED_PREFS_XML_LID_ONLY = `<map>
<string name="cc">55</string>
<string name="self_lid">5543991938235@lid</string>
</map>`

      it('extracts cc + registration_jid via root when content provider and run-as fail', async () => {
        fakeShell.mockImplementation(async (_serial: string, cmd: string) => {
          if (cmd.includes('pm list packages --user 0') && cmd.includes('whatsapp'))
            return 'package:com.whatsapp'
          if (cmd.includes('content query')) throw new Error('content provider unavailable')
          if (cmd.includes('run-as')) throw new Error('run-as not allowed')
          if (cmd.startsWith('su -c') && cmd.includes('cp')) return ''
          if (cmd.startsWith('cat /sdcard/dispatch_wa_prefs_')) return SHARED_PREFS_XML
          if (cmd.startsWith('rm -f')) return ''
          return ''
        })

        const accounts = await mapper.mapAccounts('ABC123')

        const wa = accounts.find((a) => a.packageName === 'com.whatsapp' && a.profileId === 0)
        expect(wa).toBeDefined()
        expect(wa!.phoneNumber).toBe('555543991938235')
      })

      it('extracts cc + self_lid when registration_jid is missing', async () => {
        fakeShell.mockImplementation(async (_serial: string, cmd: string) => {
          if (cmd.includes('pm list packages --user 0') && cmd.includes('whatsapp'))
            return 'package:com.whatsapp'
          if (cmd.includes('content query')) throw new Error('content provider unavailable')
          if (cmd.includes('run-as')) throw new Error('run-as not allowed')
          if (cmd.startsWith('su -c') && cmd.includes('cp')) return ''
          if (cmd.startsWith('cat /sdcard/dispatch_wa_prefs_')) return SHARED_PREFS_XML_LID_ONLY
          if (cmd.startsWith('rm -f')) return ''
          return ''
        })

        const accounts = await mapper.mapAccounts('ABC123')

        const wa = accounts.find((a) => a.packageName === 'com.whatsapp' && a.profileId === 0)
        expect(wa).toBeDefined()
        expect(wa!.phoneNumber).toBe('555543991938235')
      })

      it('cleans up temp file after extraction', async () => {
        const shellCalls: string[] = []
        fakeShell.mockImplementation(async (_serial: string, cmd: string) => {
          shellCalls.push(cmd)
          if (cmd.includes('pm list packages --user 0') && cmd.includes('whatsapp'))
            return 'package:com.whatsapp'
          if (cmd.includes('content query')) throw new Error('content provider unavailable')
          if (cmd.includes('run-as')) throw new Error('run-as not allowed')
          if (cmd.startsWith('su -c') && cmd.includes('cp')) return ''
          if (cmd.startsWith('cat /sdcard/dispatch_wa_prefs_')) return SHARED_PREFS_XML
          if (cmd.startsWith('rm -f')) return ''
          return ''
        })

        await mapper.mapAccounts('ABC123')

        const cleanupCalls = shellCalls.filter((c) => c.startsWith('rm -f /sdcard/dispatch_wa_prefs_'))
        expect(cleanupCalls.length).toBeGreaterThanOrEqual(1)
        expect(cleanupCalls[0]).toContain('dispatch_wa_prefs_0.xml')
      })

      it('fails gracefully when root is not available', async () => {
        fakeShell.mockImplementation(async (_serial: string, cmd: string) => {
          if (cmd.includes('pm list packages --user 0') && cmd.includes('whatsapp'))
            return 'package:com.whatsapp'
          if (cmd.includes('content query')) throw new Error('content provider unavailable')
          if (cmd.includes('run-as')) throw new Error('run-as not allowed')
          if (cmd.startsWith('su -c')) throw new Error('su: not found')
          return ''
        })

        const accounts = await mapper.mapAccounts('ABC123')

        const wa = accounts.find((a) => a.packageName === 'com.whatsapp' && a.profileId === 0)
        expect(wa).toBeDefined()
        expect(wa!.phoneNumber).toBeNull()
      })

      it('prefers registration_jid over self_lid when both are present', async () => {
        const xmlBothKeys = `<map>
<string name="cc">55</string>
<string name="registration_jid">5543000000001@s.whatsapp.net</string>
<string name="self_lid">5543000000002@lid</string>
</map>`

        fakeShell.mockImplementation(async (_serial: string, cmd: string) => {
          if (cmd.includes('pm list packages --user 0') && cmd.includes('whatsapp'))
            return 'package:com.whatsapp'
          if (cmd.includes('content query')) throw new Error('content provider unavailable')
          if (cmd.includes('run-as')) throw new Error('run-as not allowed')
          if (cmd.startsWith('su -c') && cmd.includes('cp')) return ''
          if (cmd.startsWith('cat /sdcard/dispatch_wa_prefs_')) return xmlBothKeys
          if (cmd.startsWith('rm -f')) return ''
          return ''
        })

        const accounts = await mapper.mapAccounts('ABC123')

        const wa = accounts.find((a) => a.packageName === 'com.whatsapp' && a.profileId === 0)
        expect(wa!.phoneNumber).toBe('555543000000001')
      })
    })

    it('updates existing accounts on re-map', async () => {
      fakeShell.mockImplementation(async (_serial: string, cmd: string) => {
        if (cmd.includes('pm list packages --user 0') && cmd.includes('whatsapp'))
          return 'package:com.whatsapp'
        if (cmd.includes('shared_prefs') && cmd.includes('user 0'))
          return '<map><string name="registration_jid">5543968350100@s.whatsapp.net</string></map>'
        return ''
      })

      await mapper.mapAccounts('ABC123')
      await mapper.mapAccounts('ABC123')

      const rows = db
        .prepare('SELECT * FROM whatsapp_accounts WHERE device_serial = ?')
        .all('ABC123')
      expect(rows).toHaveLength(1)
    })
  })

  describe('getAccountsByDevice', () => {
    it('returns accounts for a specific device', async () => {
      db.prepare(`
        INSERT INTO whatsapp_accounts (device_serial, profile_id, package_name, phone_number)
        VALUES (?, ?, ?, ?)
      `).run('ABC123', 0, 'com.whatsapp', '5543968350100')

      const accounts = mapper.getAccountsByDevice('ABC123')

      expect(accounts).toHaveLength(1)
      expect(accounts[0].phoneNumber).toBe('5543968350100')
    })
  })

  describe('getAccountByNumber', () => {
    it('returns account matching phone number', () => {
      db.prepare(`
        INSERT INTO whatsapp_accounts (device_serial, profile_id, package_name, phone_number)
        VALUES (?, ?, ?, ?)
      `).run('ABC123', 0, 'com.whatsapp', '5543968350100')

      const account = mapper.getAccountByNumber('5543968350100')

      expect(account).toBeDefined()
      expect(account!.deviceSerial).toBe('ABC123')
      expect(account!.profileId).toBe(0)
    })

    it('returns null for unknown number', () => {
      const account = mapper.getAccountByNumber('9999999999')
      expect(account).toBeNull()
    })
  })

  describe('setPhoneNumber', () => {
    it('inserts a new mapping when none exists', () => {
      mapper.setPhoneNumber('ABC123', 10, 'com.whatsapp', '5543991938235')

      const accounts = mapper.getAccountsByDevice('ABC123')
      expect(accounts).toHaveLength(1)
      expect(accounts[0].profileId).toBe(10)
      expect(accounts[0].packageName).toBe('com.whatsapp')
      expect(accounts[0].phoneNumber).toBe('5543991938235')
    })

    it('overwrites an existing phone number for the same tuple', () => {
      mapper.setPhoneNumber('ABC123', 0, 'com.whatsapp', '5543000000001')
      mapper.setPhoneNumber('ABC123', 0, 'com.whatsapp', '5543000000002')

      const accounts = mapper.getAccountsByDevice('ABC123')
      expect(accounts).toHaveLength(1)
      expect(accounts[0].phoneNumber).toBe('5543000000002')
    })

    it('keeps WA and WAB mappings on the same profile independent', () => {
      mapper.setPhoneNumber('ABC123', 11, 'com.whatsapp', '5543000000001')
      mapper.setPhoneNumber('ABC123', 11, 'com.whatsapp.w4b', '5543000000002')

      const accounts = mapper.getAccountsByDevice('ABC123').sort(
        (a, b) => a.packageName.localeCompare(b.packageName),
      )
      expect(accounts).toHaveLength(2)
      expect(accounts[0].phoneNumber).toBe('5543000000001')
      expect(accounts[1].phoneNumber).toBe('5543000000002')
    })

    it('accepts null to clear an existing mapping', () => {
      mapper.setPhoneNumber('ABC123', 0, 'com.whatsapp', '5543000000001')
      mapper.setPhoneNumber('ABC123', 0, 'com.whatsapp', null)

      const accounts = mapper.getAccountsByDevice('ABC123')
      expect(accounts).toHaveLength(1)
      expect(accounts[0].phoneNumber).toBeNull()
    })
  })
})
