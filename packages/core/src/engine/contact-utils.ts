/**
 * Escape a string for use as a value in `adb shell content insert --bind data1:s:...`
 *
 * ADB shell strips quotes and breaks on spaces/special chars.
 * Single-quoting with internal single-quote escaping is the safest approach.
 */
export function escapeForAdbContent(value: string): string {
  // Replace each single quote with: end-quote, escaped-quote, start-quote
  // 'hello' → 'hello', "it's" → 'it'"'"'s'
  const escaped = value.replace(/'/g, "'\"'\"'")
  return `'${escaped}'`
}
