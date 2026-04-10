import { Registry, Counter, Histogram, Gauge } from 'prom-client'

// Create a custom registry (don't pollute the default)
export const metricsRegistry = new Registry()

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
