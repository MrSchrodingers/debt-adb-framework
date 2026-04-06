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
        if (cmd.includes('content query') && cmd.includes("account_type='com.whatsapp'") && cmd.includes('--user 0'))
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
        if (cmd.includes('content query') && cmd.includes("account_type='com.whatsapp'") && !cmd.includes('w4b') && cmd.includes('--user 0'))
          return 'Row: 0 sync1=5543968350100@s.whatsapp.net'
        if (cmd.includes('content query') && cmd.includes("account_type='com.whatsapp.w4b'") && cmd.includes('--user 0'))
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
        if (cmd.includes('content query') && cmd.includes("account_type='com.whatsapp'") && cmd.includes('--user 10'))
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
        if (cmd.includes('content query') && cmd.includes("account_type='com.whatsapp'") && cmd.includes('--user 0'))
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
})
