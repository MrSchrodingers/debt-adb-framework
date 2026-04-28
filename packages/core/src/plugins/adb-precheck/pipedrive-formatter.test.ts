import { describe, it, expect } from 'vitest'
import {
  buildDealAllFailActivity,
  buildPastaSummaryNote,
  buildPhoneFailActivity,
  formatBrPhonePretty,
  strategyLabel,
} from './pipedrive-formatter.js'
import type {
  PipedriveDealAllFailIntent,
  PipedrivePastaSummaryIntent,
  PipedrivePhoneFailIntent,
} from './types.js'

describe('formatBrPhonePretty', () => {
  it('formats a 13-digit BR mobile', () => {
    expect(formatBrPhonePretty('5543991938235')).toBe('(43) 99193-8235')
  })

  it('formats an 11-digit input by prefixing zone parsing', () => {
    expect(formatBrPhonePretty('43991938235')).toBe('(43) 99193-8235')
  })

  it('formats an 8-digit landline DDD', () => {
    expect(formatBrPhonePretty('5511 4002-8922')).toBe('(11) 4002-8922')
  })

  it('returns fallback marker when null', () => {
    expect(formatBrPhonePretty(null)).toBe('(número desconhecido)')
  })

  it('returns input as-is on bad length', () => {
    expect(formatBrPhonePretty('123')).toBe('123')
  })
})

describe('strategyLabel', () => {
  it.each([
    ['cache', 'Cache (recente)'],
    ['L1', 'Cache (recente)'],
    ['adb', 'ADB direto'],
    ['adb_probe', 'ADB direto'],
    ['waha', 'WAHA fallback'],
    ['custom_thing', 'custom_thing'],
  ])('maps %s → %s', (src, label) => {
    expect(strategyLabel(src)).toBe(label)
  })
})

describe('buildPhoneFailActivity', () => {
  const baseIntent: PipedrivePhoneFailIntent = {
    scenario: 'phone_fail',
    deal_id: 12345,
    pasta: 'PASTA-001',
    phone: '5543991938235',
    column: 'telefone_1',
    strategy: 'adb',
    confidence: 0.93,
    job_id: 'job-abc',
    occurred_at: '2026-04-28T18:00:00Z',
    cache_ttl_days: 30,
  }

  it('produces activity with closed flag and call type', () => {
    const a = buildPhoneFailActivity(baseIntent)
    expect(a.kind).toBe('activity')
    expect(a.payload.type).toBe('call')
    expect(a.payload.done).toBe(1)
    expect(a.payload.deal_id).toBe(12345)
    expect(a.payload.subject).toContain('(43) 99193-8235')
    expect(a.payload.subject).toContain('❌')
  })

  it('renders dedup key as phone_fail|deal|phone|job', () => {
    const a = buildPhoneFailActivity(baseIntent)
    expect(a.dedup_key).toBe('phone_fail|12345|5543991938235|job-abc')
  })

  it('snapshot — exact markdown layout', () => {
    const a = buildPhoneFailActivity(baseIntent)
    expect(a.payload.note).toMatchInlineSnapshot(`
      "**Verificação adb-precheck — 2026-04-28T18:00:00Z**

      | Campo | Valor |
      |---|---|
      | Telefone | \`(43) 99193-8235\` |
      | Coluna em prov_consultas | \`telefone_1\` |
      | Resultado | ❌ NÃO localizado no WhatsApp |
      | Validado via | ADB direto |
      | Job ID | \`job-abc\` |

      _Validation cache TTL: 30 dias_"
    `)
  })

  it('omits TTL line when cache_ttl_days is undefined', () => {
    const a = buildPhoneFailActivity({ ...baseIntent, cache_ttl_days: undefined })
    expect(a.payload.note).not.toContain('Validation cache TTL')
  })
})

describe('buildDealAllFailActivity', () => {
  const intent: PipedriveDealAllFailIntent = {
    scenario: 'deal_all_fail',
    deal_id: 999,
    pasta: 'PASTA-007',
    motivo: 'todos_telefones_invalidos',
    job_id: 'job-zzz',
    occurred_at: '2026-04-28T18:30:00Z',
    phones: [
      { column: 'telefone_1', phone: '5543991938235', outcome: 'invalid', strategy: 'adb', confidence: 0.93 },
      { column: 'telefone_2', phone: '5511988880000', outcome: 'invalid', strategy: 'waha', confidence: 0.71 },
    ],
  }

  it('uses task type with alarming subject', () => {
    const a = buildDealAllFailActivity(intent)
    expect(a.payload.type).toBe('task')
    expect(a.payload.done).toBe(1)
    expect(a.payload.subject).toContain('🚨')
    expect(a.payload.subject).toContain('nenhum telefone')
  })

  it('renders one row per phone', () => {
    const a = buildDealAllFailActivity(intent)
    expect(a.payload.note).toContain('| `telefone_1` | `(43) 99193-8235` | ❌ Não existe |')
    expect(a.payload.note).toContain('| `telefone_2` | `(11) 98888-0000` | ❌ Não existe |')
  })

  it('dedup key uses deal+job', () => {
    const a = buildDealAllFailActivity(intent)
    expect(a.dedup_key).toBe('deal_all_fail|999|job-zzz')
  })

  it('includes archival reason and next steps', () => {
    const a = buildDealAllFailActivity(intent)
    expect(a.payload.note).toContain('todos_telefones_invalidos')
    expect(a.payload.note).toContain('Próximos passos sugeridos')
  })
})

describe('buildPastaSummaryNote', () => {
  const intent: PipedrivePastaSummaryIntent = {
    scenario: 'pasta_summary',
    pasta: 'PASTA-042',
    first_deal_id: 100,
    job_id: 'job-final',
    job_started: '2026-04-28T17:00:00Z',
    job_ended: '2026-04-28T18:00:00Z',
    total_deals: 50,
    ok_deals: 35,
    archived_deals: 15,
    total_phones_checked: 200,
    ok_phones: 140,
    strategy_counts: { adb: 120, waha: 30, cache: 50 },
  }

  it('produces a note (not activity)', () => {
    const n = buildPastaSummaryNote(intent)
    expect(n.kind).toBe('note')
    expect(n.payload.deal_id).toBe(100)
  })

  it('dedup key uses pasta+job', () => {
    const n = buildPastaSummaryNote(intent)
    expect(n.dedup_key).toBe('pasta_summary|PASTA-042|job-final')
  })

  it('renders percentages with 1 decimal', () => {
    const n = buildPastaSummaryNote(intent)
    // 35/50 = 70.0%
    expect(n.payload.content).toContain('35 (70.0%)')
    // 15/50 = 30.0%
    expect(n.payload.content).toContain('15 (30.0%)')
    // 140/200 = 70.0%
    expect(n.payload.content).toContain('140 (70.0%)')
  })

  it('includes strategy breakdown', () => {
    const n = buildPastaSummaryNote(intent)
    expect(n.payload.content).toContain('| ADB direto | 120 |')
    expect(n.payload.content).toContain('| WAHA fallback | 30 |')
    expect(n.payload.content).toContain('| Cache hit (recente) | 50 |')
  })

  it('handles 0/0 gracefully (no NaN%)', () => {
    const n = buildPastaSummaryNote({
      ...intent,
      total_deals: 0,
      ok_deals: 0,
      archived_deals: 0,
      total_phones_checked: 0,
      ok_phones: 0,
    })
    expect(n.payload.content).not.toContain('NaN')
    expect(n.payload.content).toContain('0 (0.0%)')
  })
})
