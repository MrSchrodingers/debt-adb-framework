import { PATTERNS, PRIORITY, type ClassificationCategory } from './regex-patterns.js'

export interface RegexHit {
  category: ClassificationCategory
  confidence: 1.0
  matched_pattern: string
}

/**
 * Stage-1 classifier — checks the text against the deterministic regex
 * pattern bank in PRIORITY order. Returns null when nothing matches so
 * the orchestrator can fall through to the LLM stage. Confidence is
 * fixed at 1.0 by design: regex hits are assumed authoritative because
 * the pattern bank is narrow and high-precision (false positives matter
 * more than recall).
 */
export function regexClassify(text: string): RegexHit | null {
  const normalized = text.trim()
  if (normalized.length === 0) return null

  for (const cat of PRIORITY) {
    for (const pattern of PATTERNS[cat]) {
      if (pattern.test(normalized)) {
        return {
          category: cat,
          confidence: 1.0,
          matched_pattern: pattern.source,
        }
      }
    }
  }
  return null
}
