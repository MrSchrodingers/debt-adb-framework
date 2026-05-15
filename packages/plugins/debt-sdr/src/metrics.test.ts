import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  sdrClassifierCalls,
  sdrClassifierLatency,
  sdrSequenceLeads,
  sdrLlmCostUsdTotal,
  sdrInvariantViolations,
  sdrQueueBlockedByTenant,
  sdrResponseDroppedMismatch,
  metricsRegistry,
} from '@dispatch/core'
import { recordClassification, refreshSequenceGauge } from './metrics.js'
import { initSdrSchema } from './db/migrations.js'

describe('debt-sdr metrics', () => {
  beforeEach(() => {
    sdrClassifierCalls.reset()
    sdrClassifierLatency.reset()
    sdrSequenceLeads.reset()
    sdrLlmCostUsdTotal.reset()
    sdrInvariantViolations.reset()
    sdrQueueBlockedByTenant.reset()
    sdrResponseDroppedMismatch.reset()
  })

  it('all 7 SDR metrics are registered on the same registry as core', async () => {
    const text = await metricsRegistry.metrics()
    expect(text).toContain('sdr_invariant_violation_total')
    expect(text).toContain('dispatch_queue_blocked_by_tenant_filter_total')
    expect(text).toContain('dispatch_response_dropped_tenant_mismatch_total')
    expect(text).toContain('sdr_classifier_total')
    expect(text).toContain('sdr_classifier_latency_ms')
    expect(text).toContain('sdr_sequence_leads')
    expect(text).toContain('sdr_classifier_llm_cost_usd_total')
  })

  it('recordClassification increments source/category/tenant counter + latency', async () => {
    recordClassification('oralsin-sdr', 'stub', {
      category: 'identity_confirm',
      confidence: 1,
      source: 'regex',
      latency_ms: 12,
    })
    recordClassification('oralsin-sdr', 'stub', {
      category: 'ambiguous',
      confidence: 0,
      source: 'llm_error',
      latency_ms: 1500,
      error: 'timeout',
    })

    const calls = await sdrClassifierCalls.get()
    const labelled = calls.values.filter((v) => v.labels.tenant === 'oralsin-sdr')
    expect(labelled).toHaveLength(2)
    expect(labelled.some((v) => v.labels.source === 'regex' && v.labels.category === 'identity_confirm')).toBe(true)
    expect(labelled.some((v) => v.labels.source === 'llm_error' && v.labels.category === 'ambiguous')).toBe(true)
  })

  it('recordClassification only bills cost when classification.cost_usd > 0', async () => {
    // regex: no cost
    recordClassification('t1', 'anthropic', {
      category: 'identity_confirm',
      confidence: 1,
      source: 'regex',
      latency_ms: 5,
    })
    // LLM with cost
    recordClassification('t1', 'anthropic', {
      category: 'interested',
      confidence: 0.92,
      source: 'llm',
      latency_ms: 1200,
      cost_usd: 0.0008,
    })

    const cost = await sdrLlmCostUsdTotal.get()
    const labelled = cost.values.filter((v) => v.labels.tenant === 't1' && v.labels.provider === 'anthropic')
    expect(labelled).toHaveLength(1)
    expect(labelled[0].value).toBeCloseTo(0.0008, 6)
  })

  it('refreshSequenceGauge sets per-status gauge values from sdr_sequence_state', async () => {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    initSdrSchema(db)
    const now = new Date().toISOString()
    const insertLead = db.prepare(
      `INSERT INTO sdr_lead_queue (id, tenant, pipedrive_deal_id, contact_phone, contact_name, pulled_at, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const insertState = db.prepare(
      `INSERT INTO sdr_sequence_state (lead_id, sequence_id, sender_phone, current_step, status, next_action_at)
       VALUES (?, 'oralsin-cold-v1', '554399000001', 0, ?, ?)`,
    )
    insertLead.run('L1', 'oralsin-sdr', 1, '5543991938235', 'A', now, 'gating', now, now)
    insertLead.run('L2', 'oralsin-sdr', 2, '5543991938235', 'B', now, 'sequencing', now, now)
    insertLead.run('L3', 'oralsin-sdr', 3, '5543991938235', 'C', now, 'sequencing', now, now)
    insertLead.run('L4', 'sicoob-sdr', 4, '5543991938235', 'D', now, 'completed', now, now)
    insertState.run('L1', 'pending_identity', now)
    insertState.run('L2', 'active', now)
    insertState.run('L3', 'active', now)
    insertState.run('L4', 'qualified', now)

    refreshSequenceGauge(db, 'oralsin-sdr')
    refreshSequenceGauge(db, 'sicoob-sdr')

    const gauge = await sdrSequenceLeads.get()
    const oralsinActive = gauge.values.find((v) => v.labels.tenant === 'oralsin-sdr' && v.labels.status === 'active')
    const oralsinPending = gauge.values.find((v) => v.labels.tenant === 'oralsin-sdr' && v.labels.status === 'pending_identity')
    const sicoobQualified = gauge.values.find((v) => v.labels.tenant === 'sicoob-sdr' && v.labels.status === 'qualified')

    expect(oralsinActive?.value).toBe(2)
    expect(oralsinPending?.value).toBe(1)
    expect(sicoobQualified?.value).toBe(1)

    db.close()
  })
})
