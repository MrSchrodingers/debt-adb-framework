import { Registry, Counter, Histogram, Gauge } from 'prom-client'

// Create a custom registry (don't pollute the default)
export const metricsRegistry = new Registry()

// ── Phase 9: Contact Registry & Hygiene (per grill D5/D6/D10/D11) ──

export const contactRegistryLookupsTotal = new Counter({
  name: 'dispatch_contact_registry_lookups_total',
  help: 'Total lookups against the WhatsApp contact registry',
  labelNames: ['result'] as const, // hit_valid | hit_invalid | hit_expired | miss
  registers: [metricsRegistry],
})

export const contactRegistryRecordsTotal = new Counter({
  name: 'dispatch_contact_registry_records_total',
  help: 'Total records written to wa_contact_checks',
  labelNames: ['source', 'result'] as const,
  registers: [metricsRegistry],
})

export const contactCheckLatency = new Histogram({
  name: 'dispatch_contact_check_latency_seconds',
  help: 'Latency of each check strategy',
  labelNames: ['source'] as const,
  buckets: [0.05, 0.1, 0.5, 1, 2, 5, 10],
  registers: [metricsRegistry],
})

export const numberInvalidEmittedTotal = new Counter({
  name: 'dispatch_number_invalid_emitted_total',
  help: 'Number of number_invalid callbacks emitted',
  labelNames: ['source'] as const,
  registers: [metricsRegistry],
})

export const digit9CorrectionsTotal = new Counter({
  name: 'dispatch_digit9_corrections_total',
  help: 'BR digit-9 variant corrections resolved via WAHA tiebreaker',
  registers: [metricsRegistry],
})

export const hygieneJobsActive = new Gauge({
  name: 'dispatch_hygiene_jobs_active',
  help: 'Currently active hygiene jobs',
  labelNames: ['plugin'] as const,
  registers: [metricsRegistry],
})

export const hygieneItemsProcessedTotal = new Counter({
  name: 'dispatch_hygiene_items_processed_total',
  help: 'Hygiene job items processed',
  labelNames: ['plugin', 'status'] as const,
  registers: [metricsRegistry],
})

export const hygieneRateLimitedTotal = new Counter({
  name: 'dispatch_hygiene_rate_limited_total',
  help: 'Rate limiter throttles on hygiene checks',
  labelNames: ['source', 'session'] as const,
  registers: [metricsRegistry],
})

// ── Counters (monotonic) ──

export const messagesSentTotal = new Counter({
  name: 'dispatch_messages_sent_total',
  help: 'Total messages sent successfully',
  labelNames: ['sender', 'method', 'app_package'] as const,
  registers: [metricsRegistry],
})

export const messagesFailedTotal = new Counter({
  name: 'dispatch_messages_failed_total',
  help: 'Total messages that failed to send',
  labelNames: ['sender', 'error_type'] as const,
  registers: [metricsRegistry],
})

export const messagesQueuedTotal = new Counter({
  name: 'dispatch_messages_queued_total',
  help: 'Total messages enqueued',
  labelNames: ['plugin'] as const,
  registers: [metricsRegistry],
})

export const quarantineEventsTotal = new Counter({
  name: 'dispatch_quarantine_events_total',
  help: 'Total quarantine events',
  labelNames: ['sender'] as const,
  registers: [metricsRegistry],
})

// Decision #23: Plugin-level metrics
export const callbacksTotal = new Counter({
  name: 'dispatch_callbacks_total',
  help: 'Total callbacks sent',
  labelNames: ['plugin', 'type', 'status'] as const,
  registers: [metricsRegistry],
})

export const pluginErrorsTotal = new Counter({
  name: 'dispatch_plugin_errors_total',
  help: 'Plugin handler errors',
  labelNames: ['plugin', 'event'] as const,
  registers: [metricsRegistry],
})

export const wahaDedupmissTotal = new Counter({
  name: 'dispatch_waha_dedup_miss_total',
  help: 'WAHA dedup window misses',
  registers: [metricsRegistry],
})

// Phase 12 — WAHA ack-level events for ban-prediction calibration (ADR 0001)
export const wahaAckTotal = new Counter({
  name: 'dispatch_waha_ack_total',
  help: 'WAHA ack events received per ack level',
  labelNames: ['ack_level_name'] as const,
  registers: [metricsRegistry],
})

export const wahaAckPersistFailedTotal = new Counter({
  name: 'dispatch_waha_ack_persist_failed_total',
  help: 'WAHA ack events that failed to persist',
  registers: [metricsRegistry],
})

// ── Histograms (distribution) ──

export const sendDurationSeconds = new Histogram({
  name: 'dispatch_send_duration_seconds',
  help: 'Duration of send operations in seconds',
  labelNames: ['method'] as const,
  buckets: [5, 10, 15, 20, 30, 45, 60],
  registers: [metricsRegistry],
})

export const interMessageDelaySeconds = new Histogram({
  name: 'dispatch_inter_message_delay_seconds',
  help: 'Delay between consecutive messages in seconds',
  labelNames: ['is_first_contact'] as const,
  buckets: [5, 10, 15, 30, 45, 60, 90, 120],
  registers: [metricsRegistry],
})

// ── Gauges (instantaneous) ──

export const queueDepth = new Gauge({
  name: 'dispatch_queue_depth',
  help: 'Current number of messages in queue (pending + processing)',
  registers: [metricsRegistry],
})

export const queueDepthByPlugin = new Gauge({
  name: 'dispatch_queue_depth_by_plugin',
  help: 'Queue depth per plugin',
  labelNames: ['plugin', 'status'] as const,
  registers: [metricsRegistry],
})

export const senderDailyCount = new Gauge({
  name: 'dispatch_sender_daily_count',
  help: 'Messages sent today per sender',
  labelNames: ['sender'] as const,
  registers: [metricsRegistry],
})

export const devicesOnline = new Gauge({
  name: 'dispatch_devices_online',
  help: 'Number of devices currently online',
  registers: [metricsRegistry],
})

export const senderQuarantined = new Gauge({
  name: 'dispatch_sender_quarantined',
  help: 'Whether a sender is currently quarantined (0 or 1)',
  labelNames: ['sender'] as const,
  registers: [metricsRegistry],
})

/**
 * adb-precheck → Pipeboard REST calls.
 *
 *   op:     invalidate | localize | deals | healthz
 *   status: HTTP status code (200, 401, 409, 429, 5xx, ...) or
 *           transport error class (network_error, timeout, enqueued).
 *
 * `enqueued` is emitted when the call failed with a retryable error
 * and the writeback was persisted to `pending_writebacks` for later
 * drain — important to differentiate from outright failure.
 */
export const precheckPipeboardRequestTotal = new Counter({
  name: 'dispatch_precheck_pipeboard_request_total',
  help: 'adb-precheck plugin requests to Pipeboard router, by op and status',
  labelNames: ['op', 'status'] as const,
  registers: [metricsRegistry],
})

/**
 * Snapshot of the local pending_writebacks SQLite buffer. A growing
 * value indicates Pipeboard is unreachable or rejecting with retryable
 * errors.
 */
export const precheckPipeboardPendingWritebacks = new Gauge({
  name: 'dispatch_precheck_pipeboard_pending_writebacks',
  help: 'Writebacks queued locally because Pipeboard returned a retryable error',
  registers: [metricsRegistry],
})

// ── debt-sdr Phase E (Task 40) ──────────────────────────────────────────
//
// SDR-specific metrics live on the SAME registry as core so a single
// /metrics scrape surfaces both. Names use the `sdr_*` prefix when the
// metric is plugin-owned (classifier, sequence FSM) and `dispatch_*`
// when the metric is owned by core but instrumented because of the
// plugin (queue tenant filter, response routing G5).

export const sdrInvariantViolations = new Counter({
  name: 'sdr_invariant_violation_total',
  help: 'Count of safety invariant violations (I1-I8); ANY increment pages on-call',
  labelNames: ['invariant'] as const,
  registers: [metricsRegistry],
})

export const sdrQueueBlockedByTenant = new Counter({
  name: 'dispatch_queue_blocked_by_tenant_filter_total',
  help: 'Messages skipped at dequeue due to tenant mismatch (G2 working as designed)',
  labelNames: ['tenant', 'device_serial'] as const,
  registers: [metricsRegistry],
})

export const sdrResponseDroppedMismatch = new Counter({
  name: 'dispatch_response_dropped_tenant_mismatch_total',
  help: 'Responses dropped at webhook handler due to tenant mismatch (G5 working as designed)',
  labelNames: ['sender_tenant', 'msg_tenant'] as const,
  registers: [metricsRegistry],
})

export const sdrClassifierCalls = new Counter({
  name: 'sdr_classifier_total',
  help: 'Classifier calls by source (regex/llm/llm_low_conf/llm_error) and outcome category',
  labelNames: ['source', 'category', 'tenant'] as const,
  registers: [metricsRegistry],
})

export const sdrClassifierLatency = new Histogram({
  name: 'sdr_classifier_latency_ms',
  help: 'Classifier latency in milliseconds',
  labelNames: ['source'] as const,
  buckets: [10, 50, 100, 500, 1000, 2000, 5000],
  registers: [metricsRegistry],
})

export const sdrSequenceLeads = new Gauge({
  name: 'sdr_sequence_leads',
  help: 'Count of leads in each sequence status (refreshed on sequencer tick)',
  labelNames: ['tenant', 'status'] as const,
  registers: [metricsRegistry],
})

export const sdrLlmCostUsdTotal = new Counter({
  name: 'sdr_classifier_llm_cost_usd_total',
  help: 'Cumulative LLM cost in USD (estimated per call)',
  labelNames: ['tenant', 'provider'] as const,
  registers: [metricsRegistry],
})

// ── Send post-tap validation (2026-05-15 incident) ──────────────────────
//
// Tracks how the ScreenshotValidator concludes after each tap on the send
// button. `result` labels:
//   - body_match    → body text confirmed in conversation (strongest)
//   - tick_visible  → tick/message_text indicator visible (medium)
//   - no_signal     → chat input present but neither body nor tick visible
//   - dialog_block  → error/permission dialog still on screen
//   - no_chat_input → chat input element missing entirely
//   - infra_fail    → UI dump itself failed; defaulted to soft-positive
export const sendValidationResultTotal = new Counter({
  name: 'dispatch_send_validation_result_total',
  help: 'Post-tap delivery validation outcomes',
  labelNames: ['result', 'app_package'] as const,
  registers: [metricsRegistry],
})

export const sendValidationLatencyMs = new Histogram({
  name: 'dispatch_send_validation_latency_ms',
  help: 'Latency of the post-tap UI dump + validation step',
  labelNames: ['app_package'] as const,
  buckets: [100, 250, 500, 1000, 2000, 5000, 10000],
  registers: [metricsRegistry],
})

export async function getMetricsText(): Promise<string> {
  return metricsRegistry.metrics()
}

export function resetMetrics(): void {
  metricsRegistry.resetMetrics()
}
