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

export async function getMetricsText(): Promise<string> {
  return metricsRegistry.metrics()
}

export function resetMetrics(): void {
  metricsRegistry.resetMetrics()
}
