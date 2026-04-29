import { describe, it, expect, vi } from 'vitest'
import {
  extractPhonesViaRoot,
  isDeviceRooted,
  listUserProfiles,
  parsePhoneFromSharedPrefs,
  parsePhoneFromMeFile,
} from './wa-phone-extractor-root.js'
import type { AdbShellAdapter } from './types.js'

function makeAdb(handler: (serial: string, cmd: string) => string | Promise<string>): AdbShellAdapter {
  return {
    shell: async (serial, cmd) => Promise.resolve(handler(serial, cmd)),
  }
}

// Real-world SharedPrefs schema verified on a live POCO C71:
//   ph contains DDD+9+subscriber WITHOUT the country code.
//   cc is the country code (always 55 in this fleet).
//   registration_jid often has the legacy 12-digit format (no 9 prefix).
const WA_LIGHT_XML = `<?xml version='1.0' encoding='utf-8' standalone='yes' ?>
<map>
    <string name="self_lid">135665836662940@lid</string>
    <string name="cc">55</string>
    <string name="ph">43991938235</string>
    <string name="registration_jid">554391938235</string>
</map>`.trim()

// Edge case: ph is already 13 digits (alternate WA version).
const WA_LIGHT_XML_FULL_PH = `<?xml version='1.0' encoding='utf-8' standalone='yes' ?>
<map>
    <string name="cc">55</string>
    <string name="ph">5543991938235</string>
</map>`.trim()

// Edge case: only registration_jid available (no ph, no cc), 13-digit JID.
const WA_LIGHT_XML_JID_ONLY = `<?xml version='1.0' encoding='utf-8' standalone='yes' ?>
<map>
    <string name="registration_jid">5543996835100@s.whatsapp.net</string>
</map>`.trim()

describe('isDeviceRooted', () => {
  it('returns true when su -c id reports uid=0(root)', async () => {
    const adb = makeAdb((_s, cmd) => {
      expect(cmd).toContain('su -c id')
      return 'uid=0(root) gid=0(root) groups=0(root) context=u:r:su:s0'
    })
    expect(await isDeviceRooted(adb, 'X')).toBe(true)
  })

  it('returns false when su is unavailable', async () => {
    const adb = makeAdb(() => 'su: not found')
    expect(await isDeviceRooted(adb, 'X')).toBe(false)
  })

  it('returns false when adb.shell throws', async () => {
    const adb: AdbShellAdapter = {
      shell: () => Promise.reject(new Error('offline')),
    }
    expect(await isDeviceRooted(adb, 'X')).toBe(false)
  })
})

describe('listUserProfiles', () => {
  it('parses every numeric directory name from ls /data/user/', async () => {
    const adb = makeAdb(() => '0 10 11 12 13 14 15 16')
    expect(await listUserProfiles(adb, 'X')).toEqual([0, 10, 11, 12, 13, 14, 15, 16])
  })

  it('handles newline-separated ls output', async () => {
    const adb = makeAdb(() => '0\n10\n11\n')
    expect(await listUserProfiles(adb, 'X')).toEqual([0, 10, 11])
  })

  it('drops non-numeric entries (lost+found, errors)', async () => {
    const adb = makeAdb(() => '0 10 lost+found ls: cannot access')
    expect(await listUserProfiles(adb, 'X')).toEqual([0, 10])
  })
})

describe('parsePhoneFromSharedPrefs', () => {
  it('composes cc + ph (real-world POCO C71 schema)', () => {
    const r = parsePhoneFromSharedPrefs(WA_LIGHT_XML, 'shared_prefs_light')
    expect(r).toEqual({ raw: '5543991938235', source: 'shared_prefs_light' })
  })

  it('uses ph as-is when it already contains the country code (≥ 12 digits)', () => {
    const r = parsePhoneFromSharedPrefs(WA_LIGHT_XML_FULL_PH, 'shared_prefs_light')
    expect(r?.raw).toBe('5543991938235')
  })

  it('falls back to registration_jid when ph is absent and jid already ≥ 12 digits', () => {
    const r = parsePhoneFromSharedPrefs(WA_LIGHT_XML_JID_ONLY, 'shared_prefs_light')
    expect(r?.raw).toBe('5543996835100')
  })

  it('ignores self_lid (it is a Linked-ID, not a phone)', () => {
    const xml = '<map><string name="self_lid">135665836662940@lid</string></map>'
    expect(parsePhoneFromSharedPrefs(xml, 'shared_prefs_light')).toBeNull()
  })

  it('returns null when nothing usable is in the XML', () => {
    expect(parsePhoneFromSharedPrefs('<map></map>', 'shared_prefs_light')).toBeNull()
  })
})

describe('parsePhoneFromMeFile', () => {
  it('extracts phone from <digits>@s.whatsapp.net', () => {
    expect(parsePhoneFromMeFile('5543991938235@s.whatsapp.net')).toBe('5543991938235')
  })

  it('falls back to digits-only when no @ separator', () => {
    expect(parsePhoneFromMeFile('5543991938235')).toBe('5543991938235')
  })

  it('returns null on garbage', () => {
    expect(parsePhoneFromMeFile('xxxx')).toBeNull()
  })
})

describe('extractPhonesViaRoot', () => {
  it('returns [] when the device is not rooted (signals UIAutomator fallback)', async () => {
    const adb = makeAdb(() => 'su: not found')
    expect(await extractPhonesViaRoot(adb, 'X')).toEqual([])
  })

  it('returns [] when no user profiles exist', async () => {
    const adb = makeAdb((_s, cmd) => {
      if (cmd.includes('su -c id')) return 'uid=0(root) gid=0(root)'
      if (cmd.includes('ls /data/user')) return ''
      return ''
    })
    expect(await extractPhonesViaRoot(adb, 'X')).toEqual([])
  })

  it('extracts canonical 13-digit phone from cc + ph composition (POCO schema)', async () => {
    const adb = makeAdb((_s, cmd) => {
      if (cmd.includes('su -c id')) return 'uid=0(root)'
      if (cmd.includes('ls /data/user')) return '0'
      if (cmd.includes('test -d')) return 'YES'
      if (cmd.includes('preferences_light.xml')) return WA_LIGHT_XML
      return ''
    })
    const r = await extractPhonesViaRoot(adb, 'X', { packages: ['com.whatsapp'] })
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({
      profile_id: 0,
      package_name: 'com.whatsapp',
      phone: '5543991938235',
      raw_phone: '5543991938235',
      source: 'shared_prefs_light',
    })
  })

  it('upgrades a 12-digit registration_jid via the normalizer when ph is absent', async () => {
    const xml = `<map><string name="cc">55</string><string name="registration_jid">554391938235</string></map>`
    const adb = makeAdb((_s, cmd) => {
      if (cmd.includes('su -c id')) return 'uid=0(root)'
      if (cmd.includes('ls /data/user')) return '0'
      if (cmd.includes('test -d')) return 'YES'
      if (cmd.includes('preferences_light.xml')) return xml
      return ''
    })
    const r = await extractPhonesViaRoot(adb, 'X', { packages: ['com.whatsapp'] })
    // jid is 12 digits → returned as-is by parser; normalizer adds 9-prefix.
    expect(r[0]).toMatchObject({
      profile_id: 0,
      phone: '5543991938235',
      raw_phone: '554391938235',
    })
  })

  it('reports wa_not_initialized when dir exists but shared_prefs is missing', async () => {
    const adb = makeAdb((_s, cmd) => {
      if (cmd.includes('su -c id')) return 'uid=0(root)'
      if (cmd.includes('ls /data/user')) return '0'
      if (cmd.includes('test -d')) return 'YES'
      if (cmd.includes('cat')) return '' // no file → empty cat
      return ''
    })
    const r = await extractPhonesViaRoot(adb, 'X', { packages: ['com.whatsapp'] })
    expect(r[0]).toMatchObject({
      profile_id: 0,
      phone: null,
      source: null,
      error: 'wa_not_initialized',
    })
  })

  it('reports not_installed when the per-user package dir is absent', async () => {
    const adb = makeAdb((_s, cmd) => {
      if (cmd.includes('su -c id')) return 'uid=0(root)'
      if (cmd.includes('ls /data/user')) return '0 10'
      if (cmd.includes('test -d')) return 'NO'
      return ''
    })
    const r = await extractPhonesViaRoot(adb, 'X', { packages: ['com.whatsapp'] })
    expect(r).toHaveLength(2)
    expect(r.every((x) => x.error === 'not_installed' && x.phone === null)).toBe(true)
  })

  it('iterates every (profile, package) tuple — 8 profiles × 2 packages = 16 results', async () => {
    const adb = makeAdb((_s, cmd) => {
      if (cmd.includes('su -c id')) return 'uid=0(root)'
      if (cmd.includes('ls /data/user')) return '0 10 11 12 13 14 15 16'
      if (cmd.includes('test -d')) return 'NO'
      return ''
    })
    const r = await extractPhonesViaRoot(adb, 'X')
    expect(r).toHaveLength(8 * 2)
  })

  it('passes the shared logger through to the normalizer for malformed phones', async () => {
    const logger = { warn: vi.fn() }
    // 14-digit ph with non-BR cc — parser accepts (ph >= 12), normalizer
    // can't recognize the shape and must log a warning.
    const malformed = `<map><string name="ph">12345678901234</string></map>`
    const adb = makeAdb((_s, cmd) => {
      if (cmd.includes('su -c id')) return 'uid=0(root)'
      if (cmd.includes('ls /data/user')) return '0'
      if (cmd.includes('test -d')) return 'YES'
      if (cmd.includes('preferences_light.xml')) return malformed
      return ''
    })
    await extractPhonesViaRoot(adb, 'X', { packages: ['com.whatsapp'], logger })
    expect(logger.warn).toHaveBeenCalled()
  })
})
