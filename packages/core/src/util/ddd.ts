import { VALID_BR_DDDS } from '../validator/br-phone-resolver.js'

export { VALID_BR_DDDS }

/**
 * Idempotent DDD extractor. Handles 13-digit (55+DDD+9+8digits), 12-digit
 * (55+DDD+8digits landline), 11-digit (DDD+9+8digits without country code),
 * and 10-digit (DDD+8digits without country code) BR phone formats.
 */
export function extractDdd(phone: string): string | null {
  const digits = phone.replace(/\D/g, '')
  const stripped = digits.startsWith('55') && digits.length >= 12 ? digits.slice(2) : digits
  if (stripped.length < 10) return null
  const ddd = stripped.slice(0, 2)
  return VALID_BR_DDDS.has(ddd) ? ddd : null
}
