import type { PipedriveDeal } from './tenant-pipedrive-client.js'

export interface ExtractedLead {
  deal_id: number
  contact_phone: string
  contact_name: string
}

export interface ExtractFailure {
  deal_id: number
  reason: 'no_phone' | 'invalid_phone' | 'no_name'
  raw_phone?: string
}

export type ExtractResult = { ok: true; lead: ExtractedLead } | { ok: false; failure: ExtractFailure }

/**
 * Brazilian mobile/landline phone normalizer.
 *
 * Accepted shapes (with optional country code, spaces, dashes,
 * parentheses):
 *   - 55 + DDD (10 or 11 digits = 8/9-digit subscriber)
 *   - DDD + subscriber (without country code, prepends 55)
 *   - subscriber-only is rejected (no DDD = ambiguous)
 *
 * Returns the canonical 12 or 13-digit digits-only form, or null when
 * the value can't be coerced to a BR phone.
 */
export function normalizeBrPhone(input: string | null | undefined): string | null {
  if (!input) return null
  const digits = String(input).replace(/\D/g, '')
  if (digits.length === 0) return null

  // With country code: 55 + DDD (2) + subscriber (8 or 9) = 12 or 13 digits.
  if (digits.length === 12 || digits.length === 13) {
    if (!digits.startsWith('55')) return null
    return digits
  }
  // Without country code: DDD (2) + subscriber (8 or 9) = 10 or 11 digits.
  if (digits.length === 10 || digits.length === 11) {
    return `55${digits}`
  }
  return null
}

/**
 * Extract (phone, name) from a Pipedrive deal using the tenant's
 * configured `phone_field_key`. Falls back to person_id.name when the
 * field is absent or empty.
 *
 * Order of phone lookup:
 *   1. deal[phone_field_key] — the explicit configured field
 *   2. deal.phone — common alias
 *   3. nothing → no_phone failure
 *
 * Order of name lookup:
 *   1. deal.person_id.name (Pipedrive's expanded person)
 *   2. deal.person_name (denormalized field present in some deal views)
 *   3. deal.title — last resort
 */
export function extractLead(deal: PipedriveDeal, phoneFieldKey: string): ExtractResult {
  const rawPhone = pickString(deal[phoneFieldKey]) ?? pickString(deal.phone)
  if (!rawPhone) {
    return { ok: false, failure: { deal_id: deal.id, reason: 'no_phone' } }
  }
  const phone = normalizeBrPhone(rawPhone)
  if (!phone) {
    return {
      ok: false,
      failure: { deal_id: deal.id, reason: 'invalid_phone', raw_phone: rawPhone },
    }
  }

  const personName = deal.person_id && typeof deal.person_id === 'object'
    ? pickString((deal.person_id as { name?: unknown }).name)
    : null
  const name = personName ?? pickString(deal.person_name) ?? pickString(deal.title)
  if (!name) {
    return { ok: false, failure: { deal_id: deal.id, reason: 'no_name' } }
  }

  return {
    ok: true,
    lead: {
      deal_id: deal.id,
      contact_phone: phone,
      contact_name: name.trim(),
    },
  }
}

function pickString(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  return s.length > 0 ? s : null
}
