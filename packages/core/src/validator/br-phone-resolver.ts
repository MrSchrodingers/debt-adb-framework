export interface NormalizedPhone {
  normalized: string
  countryCode: string
  ddd: string
  isAmbiguousDdd: boolean
  variants: string[]
}

export class InvalidPhoneError extends Error {
  constructor(input: string, reason: string) {
    super(`${reason} (input="${input}")`)
    this.name = 'InvalidPhoneError'
  }
}

const NON_AMBIGUOUS_DDDS = new Set(['11','12','13','14','15','16','17','18','19','21','22','24','27','28'])

// ANATEL-allocated BR DDDs (Area Codes)
export const VALID_BR_DDDS = new Set([
  '11','12','13','14','15','16','17','18','19',          // SP
  '21','22','24',                                         // RJ
  '27','28',                                              // ES
  '31','32','33','34','35','37','38',                     // MG
  '41','42','43','44','45','46','47','48','49',           // PR/SC
  '51','53','54','55',                                    // RS (52 unused)
  '61','62','63','64','65','66','67','68','69',           // DF/GO/TO/MT/MS/AC/RO
  '71','73','74','75','77','79',                          // BA/SE
  '81','82','83','84','85','86','87','88','89',           // PE/AL/PB/RN/CE/PI
  '91','92','93','94','95','96','97','98','99',           // North/NE
])

export function normalizePhone(input: string): NormalizedPhone {
  const digits = input.replace(/\D/g, '')
  if (digits.length !== 12 && digits.length !== 13) {
    throw new InvalidPhoneError(input, `unexpected length ${digits.length} — BR E.164 must be 12 or 13 digits`)
  }
  if (!digits.startsWith('55')) {
    throw new InvalidPhoneError(input, `non-BR country code "${digits.slice(0, 2)}" — only 55 supported`)
  }
  const ddd = digits.slice(2, 4)
  if (!VALID_BR_DDDS.has(ddd)) {
    throw new InvalidPhoneError(input, `invalid BR DDD "${ddd}"`)
  }
  // BR 13-digit mobile must have '9' as the first subscriber digit
  if (digits.length === 13 && digits[4] !== '9') {
    throw new InvalidPhoneError(input, 'BR 13-digit number must have "9" as the first subscriber digit')
  }
  const isAmbiguousDdd = !NON_AMBIGUOUS_DDDS.has(ddd)
  const variants = computeVariants(digits, ddd, isAmbiguousDdd)
  return {
    normalized: digits,
    countryCode: '55',
    ddd,
    isAmbiguousDdd,
    variants,
  }
}

function computeVariants(digits: string, ddd: string, isAmbiguous: boolean): string[] {
  // Only BR mobile numbers have the digit-9 ambiguity.
  if (!isAmbiguous || digits.length !== 13) return [digits]
  // Ambiguous DDD + 13 digits (with leading 9): also try variant without the 9
  const without9 = `55${ddd}${digits.slice(5)}`
  return [digits, without9]
}
