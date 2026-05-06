/**
 * Defense against stale-UI false positives in the ADB probe (root cause:
 * uiautomator dump captured an XML from a previous probe attempt that
 * WhatsApp hadn't transitioned away from yet).
 *
 * Returns true when the probed variant's digit sequence appears in any
 * digit run of length >= 8 within the XML. Tolerates WhatsApp's display
 * formatting (spaces, hyphens, parens, country code +) by extracting all
 * digit runs and concatenating with a non-digit separator before substring
 * search.
 *
 * Also accepts the 12-digit form (without the leading mobile "9") for
 * 13-digit variants — covers the case where WhatsApp displays the number
 * without the prefix-9 even though the probe used the 13-digit canonical.
 */
export function xmlContainsVariantDigits(xml: string, variant: string): boolean {
  // Extract each quoted attribute value from the XML (e.g. text="..." content)
  // and the concatenated digit sequence of each value. Phone numbers in the
  // WhatsApp UI appear in a single attribute value formatted with spaces,
  // hyphens, and parens (e.g. "+55 12 98171-9662"). Stripping non-digits from
  // each attribute value gives us the canonical digit string to match against.
  // We also scan each raw digit run of length >= 8 to catch numbers already
  // in unformatted form (e.g. resource-id suffixes are excluded because they
  // are too short or don't form phone-length runs).
  const without9 =
    variant.length === 13 && variant[4] === '9'
      ? variant.slice(0, 4) + variant.slice(5)
      : null

  // Strategy 1: per-attribute-value digit concatenation.
  // Matches formatted numbers like "+55 12 98171-9662" that span multiple
  // whitespace-separated groups within a single attribute value.
  // Returns true when two digit strings "match" as phone numbers.
  // Matching means either:
  //   - `haystack` contains `needle` as a substring (haystack is the XML
  //     digits, needle is the canonical variant), OR
  //   - `needle` ends with `haystack` and `haystack.length >= 8` (the XML
  //     shows only the local portion without country code, e.g. "(12) 98171-9662"
  //     → "12981719662" is a suffix of the full variant "5512981719662").
  const digitMatch = (haystack: string, needle: string): boolean => {
    if (haystack.includes(needle)) return true
    // Accept a suffix match only when the missing prefix is at most 2 digits
    // (the country code). This covers display formats like "(12) 98171-9662"
    // which omit the leading "55" but NOT partial matches like "81719662"
    // which omit the area code and prefix-9 as well.
    if (needle.endsWith(haystack) && haystack.length >= needle.length - 2) return true
    return false
  }

  // Strategy 1: per-attribute-value digit concatenation.
  // Matches formatted numbers like "+55 12 98171-9662" that span multiple
  // whitespace-separated groups within a single attribute value.
  const attrValues = xml.match(/"([^"]*)"/g) ?? []
  for (const raw of attrValues) {
    const digits = raw.replace(/\D/g, '')
    // Only consider values that, after stripping non-digits, are long enough
    // to plausibly contain a phone number (>= 8 digits).
    if (digits.length < 8) continue
    if (digitMatch(digits, variant)) return true
    if (without9 !== null && digitMatch(digits, without9)) return true
  }

  // Strategy 2: raw digit runs of length >= 8.
  // Catches numbers already in concatenated form (e.g. "5512981719662")
  // that appear outside quoted attribute values.
  const runs = (xml.match(/\d+/g) ?? []).filter((s) => s.length >= 8)
  for (const run of runs) {
    if (digitMatch(run, variant)) return true
    if (without9 !== null && digitMatch(run, without9)) return true
  }

  return false
}
