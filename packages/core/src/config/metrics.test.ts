import { describe, it, expect, beforeEach } from 'vitest'
import {
  metricsRegistry,
  messagesSentTotal,
  messagesFailedTotal,
  messagesQueuedTotal,
  quarantineEventsTotal,
  sendDurationSeconds,
  interMessageDelaySeconds,
  queueDepth,
  senderDailyCount,
  devicesOnline,
  senderQuarantined,
  getMetricsText,
  resetMetrics,
} from './metrics.js'

describe('Prometheus Metrics', () => {
  beforeEach(() => {
    resetMetrics()
  })

  describe('registry', () => {
    it('registers all expected metrics', async () => {
      const text = await getMetricsText()
      const expectedNames = [
        'dispatch_messages_sent_total',
        'dispatch_messages_failed_total',
        'dispatch_messages_queued_total',
        'dispatch_quarantine_events_total',
        'dispatch_send_duration_seconds',
        'dispatch_inter_message_delay_seconds',
        'dispatch_queue_depth',
        'dispatch_sender_daily_count',
        'dispatch_devices_online',
        'dispatch_sender_quarantined',
      ]
      for (const name of expectedNames) {
        expect(text).toContain(name)
      }
    })

    it('uses a custom registry (not default)', () => {
      // metricsRegistry should be an isolated Registry instance
      expect(metricsRegistry).toBeDefined()
      // Verify it has a metrics() method
      expect(typeof metricsRegistry.metrics).toBe('function')
    })
  })

  describe('counters', () => {
    it('incrementing messagesSentTotal increases its value', async () => {
      messagesSentTotal.inc({ sender: 'device1', method: 'intent', app_package: 'com.whatsapp' })
      messagesSentTotal.inc({ sender: 'device1', method: 'intent', app_package: 'com.whatsapp' })

      const text = await getMetricsText()
      // Should have value 2 for this label combination
      expect(text).toContain('dispatch_messages_sent_total{sender="device1",method="intent",app_package="com.whatsapp"} 2')
    })

    it('incrementing messagesFailedTotal tracks failures', async () => {
      messagesFailedTotal.inc({ sender: 'device2', error_type: 'timeout' })

      const text = await getMetricsText()
      expect(text).toContain('dispatch_messages_failed_total{sender="device2",error_type="timeout"} 1')
    })

    it('incrementing messagesQueuedTotal tracks enqueues', async () => {
      messagesQueuedTotal.inc({ plugin: 'oralsin' })
      messagesQueuedTotal.inc({ plugin: 'oralsin' })
      messagesQueuedTotal.inc({ plugin: 'direct' })

      const text = await getMetricsText()
      expect(text).toContain('dispatch_messages_queued_total{plugin="oralsin"} 2')
      expect(text).toContain('dispatch_messages_queued_total{plugin="direct"} 1')
    })

    it('incrementing quarantineEventsTotal tracks quarantine events', async () => {
      quarantineEventsTotal.inc({ sender: 'device3' })

      const text = await getMetricsText()
      expect(text).toContain('dispatch_quarantine_events_total{sender="device3"} 1')
    })
  })

  describe('histograms', () => {
    it('observing sendDurationSeconds records the value', async () => {
      sendDurationSeconds.observe({ method: 'intent' }, 12.5)

      const text = await getMetricsText()
      // Histogram creates _bucket, _sum, and _count entries
      expect(text).toContain('dispatch_send_duration_seconds_count{method="intent"} 1')
      expect(text).toContain('dispatch_send_duration_seconds_sum{method="intent"} 12.5')
    })

    it('observing interMessageDelaySeconds records the value', async () => {
      interMessageDelaySeconds.observe({ is_first_contact: 'true' }, 45)
      interMessageDelaySeconds.observe({ is_first_contact: 'true' }, 60)

      const text = await getMetricsText()
      expect(text).toContain('dispatch_inter_message_delay_seconds_count{is_first_contact="true"} 2')
    })

    it('sendDurationSeconds has expected buckets', async () => {
      sendDurationSeconds.observe({ method: 'test' }, 1)

      const text = await getMetricsText()
      // Verify some of the configured buckets appear
      expect(text).toContain('dispatch_send_duration_seconds_bucket{le="5",method="test"}')
      expect(text).toContain('dispatch_send_duration_seconds_bucket{le="30",method="test"}')
      expect(text).toContain('dispatch_send_duration_seconds_bucket{le="60",method="test"}')
      expect(text).toContain('dispatch_send_duration_seconds_bucket{le="+Inf",method="test"}')
    })
  })

  describe('gauges', () => {
    it('setting queueDepth updates its value', async () => {
      queueDepth.set(42)

      const text = await getMetricsText()
      expect(text).toContain('dispatch_queue_depth 42')
    })

    it('setting senderDailyCount updates per-sender value', async () => {
      senderDailyCount.set({ sender: 'device1' }, 15)
      senderDailyCount.set({ sender: 'device2' }, 7)

      const text = await getMetricsText()
      expect(text).toContain('dispatch_sender_daily_count{sender="device1"} 15')
      expect(text).toContain('dispatch_sender_daily_count{sender="device2"} 7')
    })

    it('setting devicesOnline updates the count', async () => {
      devicesOnline.set(3)

      const text = await getMetricsText()
      expect(text).toContain('dispatch_devices_online 3')
    })

    it('setting senderQuarantined updates quarantine status', async () => {
      senderQuarantined.set({ sender: 'device1' }, 1)
      senderQuarantined.set({ sender: 'device2' }, 0)

      const text = await getMetricsText()
      expect(text).toContain('dispatch_sender_quarantined{sender="device1"} 1')
      expect(text).toContain('dispatch_sender_quarantined{sender="device2"} 0')
    })
  })

  describe('getMetricsText', () => {
    it('returns valid Prometheus exposition format', async () => {
      messagesSentTotal.inc({ sender: 'dev1', method: 'intent', app_package: 'com.whatsapp' })
      queueDepth.set(5)

      const text = await getMetricsText()
      // Prometheus format: lines starting with # are comments (HELP/TYPE)
      expect(text).toContain('# HELP dispatch_messages_sent_total')
      expect(text).toContain('# TYPE dispatch_messages_sent_total counter')
      expect(text).toContain('# HELP dispatch_queue_depth')
      expect(text).toContain('# TYPE dispatch_queue_depth gauge')
    })
  })

  describe('resetMetrics', () => {
    it('clears all counter values', async () => {
      messagesSentTotal.inc({ sender: 'dev1', method: 'intent', app_package: 'com.whatsapp' })
      messagesFailedTotal.inc({ sender: 'dev1', error_type: 'crash' })

      resetMetrics()

      const text = await getMetricsText()
      // After reset, counters should not have any labeled values
      // (prom-client removes label series on reset)
      expect(text).not.toContain('dispatch_messages_sent_total{')
      expect(text).not.toContain('dispatch_messages_failed_total{')
    })

    it('clears all gauge values', async () => {
      queueDepth.set(100)
      devicesOnline.set(5)

      resetMetrics()

      const text = await getMetricsText()
      // After reset, gauges go to 0 (unlabeled) or disappear (labeled)
      expect(text).toContain('dispatch_queue_depth 0')
      expect(text).toContain('dispatch_devices_online 0')
    })

    it('clears histogram observations', async () => {
      sendDurationSeconds.observe({ method: 'intent' }, 10)
      sendDurationSeconds.observe({ method: 'intent' }, 20)

      resetMetrics()

      const text = await getMetricsText()
      expect(text).not.toContain('dispatch_send_duration_seconds_count{method="intent"}')
    })
  })
})
