/**
 * Brazilian mobile phone normalizer for WhatsApp account mapping.
 *
 * Background: WhatsApp registration data found via root filesystem extraction
 * (shared_prefs/wa.db) sometimes stores 12-digit numbers (legacy format
 * pre-2012, before the mandatory 9-prefix on mobile DDDs). This helper
 * upgrades them to canonical 13-digit BR mobile (E.164 without "+").
 *
 * Rules:
 *  - Strip every non-digit character first.
 *  - 13 digits starting with `55`+DDD+`9` → already canonical, return as-is.
 *  - 12 digits starting with `55`+DDD+(NOT 9) → insert `9` after the DDD.
 *    Example: `554391938235` → `5543991938235`.
 *  - Anything else (wrong length, non-BR country code, malformed) is logged
 *    via the optional logger and returned unchanged so callers can persist
 *    the raw value rather than dropping it.
 *
 * The function is intentionally permissive: it never throws. The strict
 * validator at `validator/br-phone-resolver.ts` is for user-facing /messages
 * input; this helper runs over every device-discovered phone, where bad
 * data is reality and silently dropping rows is worse than logging + storing.
 */
export interface PhoneNormalizerLogger {
  warn(payload: Record<string, unknown>, message: string): void
}

export interface NormalizeResult {
  /** Canonical phone (13 digits) or the raw input when normalization is impossible. */
  phone: string
  /** True iff the input was already canonical (13 digits, starts with 55, 9-prefix). */
  alreadyCanonical: boolean
  /** True iff a 9-prefix was injected to upgrade a 12-digit number to 13 digits. */
  upgraded: boolean
}

export function normalizeBrPhone(
  raw: string | null | undefined,
  logger?: PhoneNormalizerLogger,
): NormalizeResult {
  const input = (raw ?? '').toString()
  const digits = input.replace(/\D/g, '')

  if (digits.length === 13 && digits.startsWith('55') && digits[4] === '9') {
    return { phone: digits, alreadyCanonical: true, upgraded: false }
  }

  if (digits.length === 12 && digits.startsWith('55')) {
    // Legacy mobile (or landline). Insert 9 after DDD to upgrade mobile.
    // Landlines never have leading 9 — but POCO devices in this fleet are
    // 100% mobile WhatsApp accounts, so the upgrade is always correct here.
    const ddd = digits.slice(2, 4)
    const subscriber = digits.slice(4)
    const upgraded = `55${ddd}9${subscriber}`
    return { phone: upgraded, alreadyCanonical: false, upgraded: true }
  }

  if (digits.length === 11 && digits[2] === '9') {
    // BR mobile WITHOUT country code (DDD + 9 + subscriber). Prepend `55`.
    // Catches the bug-induced "43996835100" pattern that the v1 of the root
    // extractor produced before cc + ph composition was wired in.
    return { phone: `55${digits}`, alreadyCanonical: false, upgraded: true }
  }

  // Unrecognized shape — log and return the digits we managed to extract,
  // or the original raw input if there were none.
  logger?.warn(
    { raw, digits, length: digits.length },
    'phone-normalizer: unrecognized phone shape, returning as-is',
  )
  return { phone: digits || input, alreadyCanonical: false, upgraded: false }
}
