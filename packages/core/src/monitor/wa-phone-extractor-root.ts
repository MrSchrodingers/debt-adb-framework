import type { AdbShellAdapter, WhatsAppAccount } from './types.js'
import { normalizeBrPhone, type PhoneNormalizerLogger } from './phone-normalizer.js'

/**
 * Root-based WhatsApp phone-number extractor.
 *
 * Background: Setup-Wizard-incomplete profiles (very common on the POCO C71
 * fleet) cannot be opened via UIAutomator — Android shows a "complete setup"
 * blocker before WhatsApp ever paints. Per-user content provider isolation
 * also prevents the contacts content-provider trick on secondary profiles.
 *
 * On rooted devices we sidestep both restrictions entirely by reading the
 * filesystem directly:
 *
 *   /data/user/{uid}/{package}/shared_prefs/{package}_preferences_light.xml
 *
 * which contains the registered phone in cleartext (`<string name="ph">…</string>`,
 * plus `cc` for country code and `registration_jid` / `self_lid` for fallbacks).
 *
 * The extractor enumerates every Android user profile via `ls /data/user/`
 * (so it works for arbitrary user counts — current devices have 8 each, but
 * the original mapper hardcoded `[0, 10, 11, 12]`), checks both `com.whatsapp`
 * and `com.whatsapp.w4b`, and reports per-tuple results so the caller can
 * persist + surface the diagnostic in the UI.
 */
export type RootExtractionSource =
  | 'shared_prefs_light'
  | 'shared_prefs_main'
  | 'me_jid_file'
  | null

export interface RootExtractionResult {
  profile_id: number
  package_name: WhatsAppAccount['packageName']
  /** Normalized 13-digit BR mobile phone, or null when not extractable. */
  phone: string | null
  /** Raw value as read from disk before normalization (for diagnostics). */
  raw_phone?: string | null
  /** Which file/key produced the value, or null when nothing worked. */
  source: RootExtractionSource
  /**
   * Failure mode when phone is null, or null on success. Common values:
   *   - `not_installed` — package missing for this user
   *   - `wa_not_initialized` — directory exists but no shared_prefs file
   *     (Setup Wizard incomplete or WhatsApp never opened)
   *   - `no_root` — `su -c id` did not return uid=0
   *   - `read_failed` — every fallback path errored
   */
  error?: string
}

const WA_PACKAGES = ['com.whatsapp', 'com.whatsapp.w4b'] as const

/**
 * Run a quick `su -c id` probe — cheap and definitive. We cannot rely on
 * `which su` because the OEM su binary may not be on PATH for adb shell.
 */
export async function isDeviceRooted(adb: AdbShellAdapter, serial: string): Promise<boolean> {
  try {
    const out = await adb.shell(serial, 'su -c id 2>&1')
    return /uid=0\(root\)/.test(out)
  } catch {
    return false
  }
}

/** List every Android user UID present on disk (`/data/user/0`, `/data/user/10`…). */
export async function listUserProfiles(adb: AdbShellAdapter, serial: string): Promise<number[]> {
  const out = await adb.shell(serial, 'su -c "ls /data/user/" 2>&1')
  const ids = new Set<number>()
  for (const token of out.split(/\s+/)) {
    const t = token.trim()
    if (!t) continue
    if (/^\d+$/.test(t)) ids.add(Number(t))
  }
  return [...ids].sort((a, b) => a - b)
}

interface ExtractParsedPhone {
  raw: string
  source: RootExtractionSource
}

/**
 * Parse a SharedPrefs XML blob looking for the registered phone.
 *
 * Order of precedence:
 *   1. `<string name="ph">…</string>` — verbatim international phone (no `cc` prefix).
 *   2. `cc` + `registration_jid` / `self_lid` — country code + JID number.
 *
 * Returns `null` when nothing usable is present.
 */
export function parsePhoneFromSharedPrefs(
  xml: string,
  source: RootExtractionSource,
): ExtractParsedPhone | null {
  // Precedence 1: `ph` is the most reliable — WA writes it on registration.
  const phMatch = xml.match(/<string name="ph">(\d+)<\/string>/)
  if (phMatch && phMatch[1].length >= 10) {
    return { raw: phMatch[1], source }
  }
  // Precedence 2: assemble from cc + jid/lid.
  const ccMatch = xml.match(/<string name="cc">(\d+)<\/string>/)
  const jidMatch = xml.match(/<string name="registration_jid">(\d+)@/)
  const lidMatch = xml.match(/<string name="self_lid">(\d+)@/)
  const num = jidMatch?.[1] ?? lidMatch?.[1]
  if (num && ccMatch) return { raw: ccMatch[1] + num, source }
  if (num) return { raw: num, source }
  return null
}

/** Parse a `me`/`me.dat`/`me/jid` blob — last-resort fallback. */
export function parsePhoneFromMeFile(text: string): string | null {
  // `me/jid` files are typically `<phone>@s.whatsapp.net` in plaintext.
  const match = text.match(/(\d{10,15})@/)
  if (match) return match[1]
  // Some WA versions store just the phone, optionally prefixed.
  const digitsOnly = text.replace(/\D/g, '')
  if (digitsOnly.length >= 10 && digitsOnly.length <= 15) return digitsOnly
  return null
}

interface ExtractDeps {
  logger?: PhoneNormalizerLogger
  /** Override default `[com.whatsapp, com.whatsapp.w4b]` (mainly for tests). */
  packages?: readonly WhatsAppAccount['packageName'][]
}

/**
 * Extract phone numbers for every (user, WA package) tuple on a rooted device.
 *
 * Idempotent + side-effect-free: callers persist results themselves via
 * `WaAccountMapper.setPhoneNumber`. Returns an empty array when the device
 * is not rooted (signals to caller: fall back to UIAutomator).
 */
export async function extractPhonesViaRoot(
  adb: AdbShellAdapter,
  serial: string,
  deps: ExtractDeps = {},
): Promise<RootExtractionResult[]> {
  const packages = deps.packages ?? WA_PACKAGES
  const logger = deps.logger

  if (!(await isDeviceRooted(adb, serial))) {
    return []
  }

  const profiles = await listUserProfiles(adb, serial)
  if (profiles.length === 0) return []

  const results: RootExtractionResult[] = []

  for (const uid of profiles) {
    for (const pkg of packages) {
      const result = await extractOne(adb, serial, uid, pkg, logger)
      results.push(result)
    }
  }

  return results
}

async function extractOne(
  adb: AdbShellAdapter,
  serial: string,
  uid: number,
  pkg: WhatsAppAccount['packageName'],
  logger: PhoneNormalizerLogger | undefined,
): Promise<RootExtractionResult> {
  const base = `/data/user/${uid}/${pkg}`

  // 0. Does the per-user package dir exist? If not, package not installed.
  let dirExists = false
  try {
    const test = await adb.shell(serial, `su -c "test -d ${base} && echo YES || echo NO"`)
    dirExists = test.trim().endsWith('YES')
  } catch {
    dirExists = false
  }
  if (!dirExists) {
    return {
      profile_id: uid,
      package_name: pkg,
      phone: null,
      raw_phone: null,
      source: null,
      error: 'not_installed',
    }
  }

  // 1. Primary: shared_prefs_light.xml
  const lightFile = `${base}/shared_prefs/${pkg}_preferences_light.xml`
  const mainFile = `${base}/shared_prefs/${pkg}_preferences.xml`
  const meFile = `${base}/files/me/jid`
  const meDat = `${base}/files/me.dat`

  const sharedPrefsAttempts: Array<{ path: string; src: RootExtractionSource }> = [
    { path: lightFile, src: 'shared_prefs_light' },
    { path: mainFile, src: 'shared_prefs_main' },
  ]
  for (const { path, src } of sharedPrefsAttempts) {
    try {
      // `cat <missing>` on Android prints an error to stderr but exits non-zero;
      // we suppress it so adb.shell doesn't reject. The presence test on the
      // contents (regex match below) is what gates parsing.
      const xml = await adb.shell(serial, `su -c "cat '${path}' 2>/dev/null"`)
      if (xml && xml.includes('<map>')) {
        const parsed = parsePhoneFromSharedPrefs(xml, src)
        if (parsed) {
          const norm = normalizeBrPhone(parsed.raw, logger)
          return {
            profile_id: uid,
            package_name: pkg,
            phone: norm.phone || null,
            raw_phone: parsed.raw,
            source: parsed.source,
          }
        }
      }
    } catch {
      // Move to next fallback
    }
  }

  // 2. Last resort: files/me/jid
  for (const path of [meFile, meDat]) {
    try {
      const out = await adb.shell(serial, `su -c "cat '${path}' 2>/dev/null"`)
      if (out && out.length > 0) {
        const raw = parsePhoneFromMeFile(out)
        if (raw) {
          const norm = normalizeBrPhone(raw, logger)
          return {
            profile_id: uid,
            package_name: pkg,
            phone: norm.phone || null,
            raw_phone: raw,
            source: 'me_jid_file',
          }
        }
      }
    } catch {
      // continue
    }
  }

  // Reached here: package dir exists but no phone was extractable. Most
  // common cause on this fleet is Setup Wizard never completed → WA was
  // never opened → shared_prefs files don't exist yet.
  return {
    profile_id: uid,
    package_name: pkg,
    phone: null,
    raw_phone: null,
    source: null,
    error: 'wa_not_initialized',
  }
}
