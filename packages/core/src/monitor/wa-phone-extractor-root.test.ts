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

const WA_LIGHT_XML = `<?xml version='1.0' encoding='utf-8' standalone='yes' ?>
<map>
    <string name="cc">55</string>
    <string name="ph">5543991938235</string>
    <string name="registration_jid">5543991938235@s.whatsapp.net</string>
</map>`.trim()

const WA_LIGHT_XML_LEGACY_12_DIGIT = `<?xml version='1.0' encoding='utf-8' standalone='yes' ?>
<map>
    <string name="cc">55</string>
    <string name="ph">554391938235</string>
    <string name="registration_jid">554391938235@s.whatsapp.net</string>
</map>`.trim()

const WA_LIGHT_XML_NO_PH = `<?xml version='1.0' encoding='utf-8' standalone='yes' ?>
<map>
    <string name="cc">55</string>
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
  it('prefers <string name="ph"> when present', () => {
    const r = parsePhoneFromSharedPrefs(WA_LIGHT_XML, 'shared_prefs_light')
    expect(r).toEqual({ raw: '5543991938235', source: 'shared_prefs_light' })
  })

  it('falls back to cc + registration_jid when ph is missing', () => {
    const r = parsePhoneFromSharedPrefs(WA_LIGHT_XML_NO_PH, 'shared_prefs_light')
    expect(r?.raw).toBe('555543996835100') // 55 + cc + jid composition
    expect(r?.source).toBe('shared_prefs_light')
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

  it('extracts a canonical 13-digit phone from shared_prefs_light', async () => {
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

  it('upgrades a 12-digit legacy ph to 13 digits via normalizer', async () => {
    const adb = makeAdb((_s, cmd) => {
      if (cmd.includes('su -c id')) return 'uid=0(root)'
      if (cmd.includes('ls /data/user')) return '0'
      if (cmd.includes('test -d')) return 'YES'
      if (cmd.includes('preferences_light.xml')) return WA_LIGHT_XML_LEGACY_12_DIGIT
      return ''
    })
    const r = await extractPhonesViaRoot(adb, 'X', { packages: ['com.whatsapp'] })
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
    // 11-digit ph (no country code, but >= 10 so the parser still extracts it)
    // — normalizer should warn that the shape is unrecognized.
    const malformed = `<map><string name="ph">12345678901</string></map>`
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
