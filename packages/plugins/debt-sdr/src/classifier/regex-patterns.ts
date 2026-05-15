/**
 * Response classification categories produced by the regex/LLM cascade.
 *
 * - identity_confirm / identity_deny: identity-gate phase only
 * - interested / not_interested / question: response-handling phase
 * - opted_out: blocks future sends regardless of phase
 * - ambiguous: regex miss + LLM low confidence or error
 */
export type ClassificationCategory =
  | 'identity_confirm'
  | 'identity_deny'
  | 'interested'
  | 'not_interested'
  | 'question'
  | 'opted_out'
  | 'ambiguous'

/**
 * Deterministic patterns matched in PRIORITY order. PT-BR informal +
 * minor variants. Each pattern is intentionally narrow — regex hits
 * commit to a final classification (confidence 1.0), so false positives
 * here are worse than misses (misses fall through to the LLM stage).
 */
export const PATTERNS: Record<Exclude<ClassificationCategory, 'ambiguous'>, RegExp[]> = {
  // Opt-out has highest priority — "não sou eu, para de mandar" must
  // route to opt-out, not identity_deny.
  opted_out: [
    /\bpar[ae]\s+de\s+(me\s+)?(mandar|enviar|escrever|chamar|incomodar)\b/i,
    /\bcancela(r)?\b/i,
    /\bn[aã]o me (envie|mande|chame|liga|ligue|escreva)\s+mais\b/i,
    /\bdescadastr/i,
    /\bsa(i|ir|ia)\s+(d(ess?a|esta|aquela|o|a))\s+(lista|grupo|campanha)\b/i,
    /\bn[aã]o tenho interesse.*n[aã]o\s+(envie|mande|escreva)/i,
    /\bbloque(i|ei|ando|aram|e)\b/i,
    /\bstop\b/i,
    /\bunsubscribe\b/i,
    /\bremov(a|er)\s+(da )?(lista|cadastro|do)\b/i,
  ],

  // "Wrong number" / "I'm not the person" — blocks the lead, marks
  // identity_deny so the FSM can blacklist temporarily.
  identity_deny: [
    /\bn[aã]o sou (eu|esse|essa|esta|aquele|aquela|o|a)\b/i,
    /\b(n[uú]mero|telefone|cel(ular)?)\s+errado\b/i,
    /\bn[aã]o conhe[çc]o\b/i,
    /\bn[aã]o\s+sei\s+quem\b/i,
    /\b(é|eh|foi)\s+engano\b/i,
    /\b(t[áa]|ta)\s+enganad/i,
    /\bvoc[eê]\s+(est[aá]|t[aá])\s+enganad/i,
    /\bnunca ouvi\b/i,
    /\botra pessoa\b/i,
    /\boutra pessoa\b/i,
  ],

  // Affirmative identity. Order matters — keep "sim, sou eu" before
  // generic greeting-only matches.
  identity_confirm: [
    /^\s*sim\s*[\.,!]*\s*$/i,
    /^\s*sou\s*(eu)?\s*[\.,!]*\s*$/i,
    /\bsim,?\s*sou\s+(eu|o|a)\b/i,
    /\bsou\s+(o|a)\s+\w+/i,
    /^\s*(oi|ol[aá]|opa|fala|e[ai]\s*a[ií])\s*[\.,!?]*\s*$/i,
    /\bbom\s+dia\s*[\.,!]*\s*$/i,
    /\bboa\s+(tarde|noite)\s*[\.,!]*\s*$/i,
    // "é eu", "é comigo" only — "é isso" is too generic and collides
    // with questions like "o que é isso?".
    /(^|\s)(é|eh)\s+(eu|comigo)(\s+mesmo)?\b/i,
  ],

  not_interested: [
    /\bn[aã]o\s+(tenho|estou|t[oô])\s+interess/i,
    /\b(agora\s+)?n[aã]o\s+(quero|preciso|posso|consigo)\b/i,
    /\bn[aã]o\s+obrigad[oa]\b/i,
    /\bdispenso\b/i,
    /\bj[aá]\s+resolvi\b/i,
    /\bj[aá]\s+(tenho|comprei|contratei|tem)\b/i,
    /\bsem\s+interesse\b/i,
  ],

  interested: [
    /\b(tenho|estou|fiquei|fiquei\s+com)\s+interess/i,
    /\b(me\s+)?(conta|explica|fala|manda)\s+mais\b/i,
    /\bquero\s+(saber|ouvir|ver|entender)\b/i,
    /\bqual\s+(a|é)\s+(proposta|oferta|condi[çc][aã]o)\b/i,
    /\bbora\b/i,
    /\baceito\b/i,
    /\bpode\s+(mandar|enviar|chamar|me\s+ligar)\b/i,
  ],

  question: [
    /\?\s*$/,
    /\bcomo\s+(funciona|assim|seria)\b/i,
    /\bo\s+que\s+(é|seria)\b/i,
    /\bn[aã]o\s+entendi\b/i,
    /\bpode\s+(explicar|esclarecer)\b/i,
  ],
}

/**
 * Resolution order when multiple categories match. Opt-out wins over
 * identity_deny ("não sou eu, para de mandar"). identity_deny wins over
 * identity_confirm. The rest cascade naturally.
 */
export const PRIORITY: Array<keyof typeof PATTERNS> = [
  'opted_out',
  'identity_deny',
  'identity_confirm',
  'not_interested',
  'interested',
  'question',
]
