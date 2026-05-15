/**
 * debt-sdr Phase E (Task 40) — Prometheus metrics facade.
 *
 * The Prom-client instances themselves live in @dispatch/core's
 * `config/metrics.ts` so a single registry feeds the existing
 * `/metrics` endpoint. This module re-exports them under the names
 * the plugin uses internally and provides small helpers (cost model,
 * sequencer gauge refresh) so the wiring sites stay readable.
 *
 * Why a facade and not direct imports? Two reasons:
 *   1. The LLM-cost model is plugin-local — pricing changes per
 *      provider/model and core has no opinion about it.
 *   2. The sequencer gauge needs aggregation logic (count by status)
 *      that's plugin-specific.
 */

import type Database from 'better-sqlite3'
import {
  sdrInvariantViolations,
  sdrQueueBlockedByTenant,
  sdrResponseDroppedMismatch,
  sdrClassifierCalls,
  sdrClassifierLatency,
  sdrSequenceLeads,
  sdrLlmCostUsdTotal,
} from '@dispatch/core'
import type { Classification } from './classifier/classifier.js'

export {
  sdrInvariantViolations,
  sdrQueueBlockedByTenant,
  sdrResponseDroppedMismatch,
  sdrClassifierCalls,
  sdrClassifierLatency,
  sdrSequenceLeads,
  sdrLlmCostUsdTotal,
}

export function recordClassification(tenant: string, provider: string, classification: Classification): void {
  sdrClassifierCalls.inc({
    source: classification.source,
    category: classification.category,
    tenant,
  })
  sdrClassifierLatency.observe({ source: classification.source }, classification.latency_ms)

  // Forward provider-reported cost when present (LLM client annotates
  // its return). `regex` and `phase_gate` rows never bill.
  if (typeof classification.cost_usd === 'number' && classification.cost_usd > 0) {
    sdrLlmCostUsdTotal.inc({ tenant, provider }, classification.cost_usd)
  }
}

/**
 * Refresh `sdr_sequence_leads{tenant,status}` gauge from the database.
 * Called from Sequencer.tick after each tenant pass — keeps the gauge
 * eventually-consistent without blocking the dispatch loop.
 */
export function refreshSequenceGauge(db: Database.Database, tenant: string): void {
  const rows = db
    .prepare(
      `SELECT s.status AS status, COUNT(*) AS n
         FROM sdr_sequence_state s
         JOIN sdr_lead_queue l ON l.id = s.lead_id
        WHERE l.tenant = ?
        GROUP BY s.status`,
    )
    .all(tenant) as Array<{ status: string; n: number }>

  // Reset prior labels for this tenant first, then set fresh counts.
  // prom-client's Gauge doesn't expose per-label-prefix reset, so we
  // overwrite known statuses (status set is finite per sequencer FSM).
  const knownStatuses = [
    'pending_identity',
    'active',
    'qualified',
    'disqualified',
    'opted_out',
    'wrong_number',
    'no_response',
    'aborted',
  ]
  const counts = new Map<string, number>()
  for (const r of rows) counts.set(r.status, r.n)
  for (const status of knownStatuses) {
    sdrSequenceLeads.set({ tenant, status }, counts.get(status) ?? 0)
  }
}
