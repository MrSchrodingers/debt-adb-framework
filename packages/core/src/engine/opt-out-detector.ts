export interface OptOutMatch {
  matched: true
  pattern: string
  original: string
}

export interface OptOutNoMatch {
  matched: false
}

export type OptOutResult = OptOutMatch | OptOutNoMatch

/**
 * Portuguese opt-out patterns — word boundary matching to avoid false positives.
 * e.g. "pare" matches but "parede" does not.
 */
const OPT_OUT_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  // Multi-word patterns first — must match before shorter single-word patterns
  { pattern: /\bme\s+remov[ae]\b/i, label: 'me remova' },
  { pattern: /\bme\s+tir[ae]\b/i, label: 'me tire' },
  { pattern: /\bnão\s+(?:quero|envie|mande)\b/i, label: 'não quero' },
  { pattern: /\bnao\s+(?:quero|envie|mande)\b/i, label: 'nao quero' },
  // Single-word patterns
  { pattern: /\bpare\b/i, label: 'pare' },
  { pattern: /\bparar\b/i, label: 'parar' },
  { pattern: /\bstop\b/i, label: 'stop' },
  { pattern: /\bcancela(?:r)?\b/i, label: 'cancelar' },
  { pattern: /\bremov[ae]\b/i, label: 'remova' },
  { pattern: /\btira(?:r)?\b/i, label: 'tirar' },
  { pattern: /\bbloquear\b/i, label: 'bloquear' },
  { pattern: /\bdenunciar\b/i, label: 'denunciar' },
  { pattern: /\breportar\b/i, label: 'reportar' },
  { pattern: /\bsair\b/i, label: 'sair' },
  { pattern: /\bchega\b/i, label: 'chega' },
]

export class OptOutDetector {
  detect(text: string | null | undefined): OptOutResult {
    if (!text || text.trim().length === 0) return { matched: false }

    for (const { pattern, label } of OPT_OUT_PATTERNS) {
      if (pattern.test(text)) {
        return { matched: true, pattern: label, original: text }
      }
    }

    return { matched: false }
  }
}
