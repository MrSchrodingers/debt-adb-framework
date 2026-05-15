import type Database from 'better-sqlite3'
import { ulid } from 'ulid'
import type { Classification } from './classifier.js'

export interface RecordParams {
  lead_id: string
  message_id: string
  response_text: string
  classification: Classification
}

export interface LlmCategoryRollup {
  category: string
  count: number
  sample_texts: string[]
}

/**
 * Persists every classification call to `sdr_classifier_log`. The audit
 * trail serves three purposes:
 *
 * 1. Operator UI — surface every ambiguous / low_conf row for manual
 *    review and reclassification (Task 39 routes consume this).
 * 2. Regex training — periodic analysis of frequent LLM hits feeds
 *    new regex patterns back into regex-patterns.ts (topLlmCategories).
 * 3. Cost / latency telemetry — Prometheus scrapes derive from this
 *    table (Task 40).
 */
export class ClassifierLog {
  constructor(private readonly db: Database.Database) {}

  record(params: RecordParams): void {
    const c = params.classification
    const llm_reason = c.reason ?? null
    this.db
      .prepare(
        `INSERT INTO sdr_classifier_log
           (id, lead_id, message_id, response_text, category, confidence, source, llm_reason, latency_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ulid(),
        params.lead_id,
        params.message_id,
        params.response_text,
        c.category,
        c.confidence,
        c.source,
        llm_reason,
        Math.round(c.latency_ms),
      )
  }

  /**
   * Aggregate LLM-hit rows grouped by category. Output feeds the
   * "promote this LLM hit to a regex" workflow — operators look at the
   * top categories and write new patterns for the most common phrasings.
   * `sample_texts` is bounded so the rollup doesn't grow with the table.
   *
   * SQLite's `GROUP_CONCAT(X, sep)` joins rows with the given separator.
   * `char(31)` is the Unit Separator (U+001F) which cannot appear in
   * Brazilian WhatsApp text, so split on `''` round-trips losslessly.
   */
  topLlmCategories(sinceIso: string, limit = 50): LlmCategoryRollup[] {
    const rows = this.db
      .prepare(
        `SELECT category, COUNT(*) AS n, GROUP_CONCAT(response_text, char(31)) AS texts
           FROM sdr_classifier_log
          WHERE source = 'llm'
            AND classified_at >= ?
          GROUP BY category
          ORDER BY n DESC
          LIMIT ?`,
      )
      .all(sinceIso, limit) as Array<{ category: string; n: number; texts: string | null }>

    return rows.map((r) => ({
      category: r.category,
      count: r.n,
      sample_texts: r.texts ? r.texts.split('').slice(0, 5) : [],
    }))
  }
}
