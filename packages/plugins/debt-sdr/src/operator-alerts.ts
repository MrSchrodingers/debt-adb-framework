import type Database from 'better-sqlite3'
import { ulid } from 'ulid'

export interface OperatorAlertRow {
  id: string
  tenant: string
  lead_id: string
  message_id: string
  response_text: string
  reason: string
  llm_reason: string | null
  raised_at: string
  resolved_at: string | null
  resolution: string | null
}

export interface RaiseInput {
  tenant: string
  leadId: string
  messageId: string
  responseText: string
  reason: string
  llmReason?: string
}

/**
 * Operator alert queue. Persisted under sdr_operator_alerts; consumed
 * by the admin route in Task 39 and by the Prometheus exporter in
 * Task 40. Idempotent per (lead, message, reason) — repeated classifier
 * calls on the same response don't spam the queue, but a different
 * `reason` for the same message (e.g. classifier_ambiguous followed by
 * llm_cost_exceeded) raises a fresh alert.
 *
 * raise() never throws on duplicate — the unique index swallows the
 * conflict via INSERT OR IGNORE so callers don't have to special-case
 * already-raised state.
 */
export class OperatorAlerts {
  constructor(private readonly db: Database.Database) {}

  raise(input: RaiseInput): string {
    const id = ulid()
    this.db
      .prepare(
        `INSERT OR IGNORE INTO sdr_operator_alerts
           (id, tenant, lead_id, message_id, response_text, reason, llm_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.tenant,
        input.leadId,
        input.messageId,
        input.responseText,
        input.reason,
        input.llmReason ?? null,
      )
    // Return the canonical id for whichever row owns this (lead, message, reason).
    const row = this.db
      .prepare(
        `SELECT id FROM sdr_operator_alerts
          WHERE lead_id = ? AND message_id = ? AND reason = ?`,
      )
      .get(input.leadId, input.messageId, input.reason) as { id: string } | undefined
    return row?.id ?? id
  }

  resolve(alertId: string, resolution: string): boolean {
    const r = this.db
      .prepare(
        `UPDATE sdr_operator_alerts
            SET resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                resolution = ?
          WHERE id = ? AND resolved_at IS NULL`,
      )
      .run(resolution, alertId)
    return r.changes > 0
  }

  listUnresolved(limit = 100): OperatorAlertRow[] {
    return this.db
      .prepare(
        `SELECT * FROM sdr_operator_alerts
          WHERE resolved_at IS NULL
          ORDER BY raised_at ASC
          LIMIT ?`,
      )
      .all(limit) as OperatorAlertRow[]
  }

  countUnresolved(): number {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n FROM sdr_operator_alerts WHERE resolved_at IS NULL")
      .get() as { n: number }
    return r.n
  }
}
