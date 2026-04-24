import type { ProvConsultaRow } from './types.js'

const PHONE_COLUMNS = [
  'whatsapp_hot',
  'telefone_hot_1',
  'telefone_hot_2',
  'telefone_1',
  'telefone_2',
  'telefone_3',
  'telefone_4',
  'telefone_5',
  'telefone_6',
] as const satisfies readonly (keyof ProvConsultaRow)[]

export type PhoneColumn = (typeof PHONE_COLUMNS)[number]

export interface ExtractedPhone {
  column: PhoneColumn
  raw: string
  normalized: string
}

const BR_CC = '55'

/**
 * Normalize a raw phone string to BR E.164 (5511988887777 form, no +).
 * Returns null when input cannot be confidently normalized.
 *
 * Rules:
 *   - strip non-digits
 *   - if starts with 55 and length ∈ {12,13} → keep as-is
 *   - if length ∈ {10,11} (DDD + number) → prefix 55
 *   - anything else → null (caller should push to "no_ddd" bucket)
 */
export function normalizeBrPhone(raw: string | null | undefined): string | null {
  if (!raw) return null
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 12 || digits.length === 13) {
    return digits.startsWith(BR_CC) ? digits : null
  }
  if (digits.length === 10 || digits.length === 11) {
    return BR_CC + digits
  }
  return null
}

/**
 * Extract all candidate phones from a prov_consultas row, deduping by
 * normalized E.164. Priority order follows business preference (whatsapp_hot
 * first, then hot, then generic telefone_N). The first occurrence wins.
 */
export function extractPhones(row: ProvConsultaRow): ExtractedPhone[] {
  const seen = new Set<string>()
  const out: ExtractedPhone[] = []
  for (const col of PHONE_COLUMNS) {
    const raw = row[col]
    if (!raw) continue
    const normalized = normalizeBrPhone(raw)
    if (!normalized) continue
    if (seen.has(normalized)) continue
    seen.add(normalized)
    out.push({ column: col, raw: String(raw), normalized })
  }
  return out
}
