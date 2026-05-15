import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { ClassifierLog } from './classifier-log.js'
import { initSdrSchema } from '../db/migrations.js'
import type { Classification } from './classifier.js'

describe('ClassifierLog', () => {
  let db: Database.Database
  let log: ClassifierLog

  beforeEach(() => {
    db = new Database(':memory:')
    initSdrSchema(db)
    log = new ClassifierLog(db)
  })

  afterEach(() => {
    db.close()
  })

  it('persists a classification row', () => {
    const c: Classification = {
      category: 'identity_confirm',
      confidence: 1.0,
      source: 'regex',
      latency_ms: 2.5,
      raw: { matched_pattern: '^\\s*sim\\s*$' },
    }
    log.record({
      lead_id: 'lead-1',
      message_id: 'msg-1',
      response_text: 'Sim',
      classification: c,
    })

    const row = db.prepare('SELECT * FROM sdr_classifier_log').get() as {
      lead_id: string
      message_id: string
      response_text: string
      category: string
      confidence: number
      source: string
      llm_reason: string | null
      latency_ms: number
    }
    expect(row.lead_id).toBe('lead-1')
    expect(row.message_id).toBe('msg-1')
    expect(row.response_text).toBe('Sim')
    expect(row.category).toBe('identity_confirm')
    expect(row.confidence).toBe(1.0)
    expect(row.source).toBe('regex')
    expect(row.llm_reason).toBeNull()
    expect(row.latency_ms).toBe(3)
  })

  it('persists LLM reason and rounds latency_ms to integer', () => {
    log.record({
      lead_id: 'lead-2',
      message_id: 'msg-2',
      response_text: 'me explica direito',
      classification: {
        category: 'interested',
        confidence: 0.87,
        source: 'llm',
        latency_ms: 712.4,
        reason: 'user_asked_for_details',
      },
    })
    const row = db
      .prepare("SELECT llm_reason, latency_ms FROM sdr_classifier_log WHERE message_id = 'msg-2'")
      .get() as { llm_reason: string; latency_ms: number }
    expect(row.llm_reason).toBe('user_asked_for_details')
    expect(row.latency_ms).toBe(712)
    expect(Number.isInteger(row.latency_ms)).toBe(true)
  })

  it('topLlmCategories returns count + bounded sample texts', () => {
    const now = new Date().toISOString()
    for (let i = 0; i < 6; i++) {
      log.record({
        lead_id: `lead-${i}`,
        message_id: `msg-${i}`,
        response_text: `pode me ligar mais tarde ${i}`,
        classification: {
          category: 'question',
          confidence: 0.8,
          source: 'llm',
          latency_ms: 400,
          reason: 'r',
        },
      })
    }
    log.record({
      lead_id: 'lead-99',
      message_id: 'msg-99',
      response_text: 'irrelevant',
      classification: {
        category: 'interested',
        confidence: 0.8,
        source: 'llm',
        latency_ms: 400,
      },
    })

    const rollup = log.topLlmCategories(new Date(Date.parse(now) - 60_000).toISOString())
    expect(rollup[0].category).toBe('question')
    expect(rollup[0].count).toBe(6)
    expect(rollup[0].sample_texts.length).toBeLessThanOrEqual(5)
    expect(rollup[0].sample_texts[0]).toContain('pode me ligar mais tarde')
  })

  it('topLlmCategories ignores rows older than the since cutoff', () => {
    // Manually insert a row with an old classified_at.
    db.prepare(
      `INSERT INTO sdr_classifier_log
         (id, lead_id, message_id, response_text, category, confidence, source, latency_ms, classified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'old-1',
      'l-old',
      'm-old',
      'antigo',
      'interested',
      0.9,
      'llm',
      300,
      '2024-01-01T00:00:00Z',
    )
    const r = log.topLlmCategories(new Date().toISOString())
    expect(r).toHaveLength(0)
  })

  it('topLlmCategories ignores rows where source is not llm (regex / phase_gate / llm_error)', () => {
    log.record({
      lead_id: 'l1',
      message_id: 'm1',
      response_text: 'Sim',
      classification: { category: 'identity_confirm', confidence: 1, source: 'regex', latency_ms: 1 },
    })
    log.record({
      lead_id: 'l2',
      message_id: 'm2',
      response_text: 'foo',
      classification: { category: 'ambiguous', confidence: 0, source: 'llm_error', latency_ms: 1 },
    })
    const r = log.topLlmCategories(new Date(Date.now() - 60_000).toISOString())
    expect(r).toHaveLength(0)
  })
})
