import { describe, it, expect } from 'vitest'
import {
  buildActivityUrl,
  buildDealAllFailActivity,
  buildDealUrl,
  buildPastaSummaryNote,
  buildPhoneFailActivity,
  escapeHtml,
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

  it('emits HTML (not Markdown) — Pipedrive Activity note field renders HTML', () => {
    const a = buildPhoneFailActivity(baseIntent, 'debt-5188cf')
    // Must be HTML.
    expect(a.payload.note).toContain('<table>')
    expect(a.payload.note).toContain('<p>')
    expect(a.payload.note).toContain('<strong>')
    expect(a.payload.note).toContain('<a href="https://debt-5188cf.pipedrive.com/deal/12345">')
    // Must NOT contain Markdown markers.
    expect(a.payload.note).not.toMatch(/^## /m)
    expect(a.payload.note).not.toContain('|---|')
    expect(a.payload.note).not.toMatch(/\*\*[^*]+\*\*/)
    // Domain-specific data still present.
    expect(a.payload.note).toContain('(43) 99193-8235')
    expect(a.payload.note).toContain('telefone_1')
    expect(a.payload.note).toContain('ADB direto')
    expect(a.payload.note).toContain('job-abc')
    expect(a.payload.note).toContain('30 dias')
  })

  it('omits TTL line when cache_ttl_days is undefined', () => {
    const a = buildPhoneFailActivity({ ...baseIntent, cache_ttl_days: undefined })
    expect(a.payload.note).not.toContain('Cache TTL')
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

  it('renders one HTML row per phone', () => {
    const a = buildDealAllFailActivity(intent)
    expect(a.payload.note).toContain('<td>telefone_1</td>')
    expect(a.payload.note).toContain('<td>(43) 99193-8235</td>')
    expect(a.payload.note).toContain('<td>telefone_2</td>')
    expect(a.payload.note).toContain('<td>(11) 98888-0000</td>')
    expect(a.payload.note).toContain('❌ Não existe')
  })

  it('dedup key uses deal+job', () => {
    const a = buildDealAllFailActivity(intent)
    expect(a.dedup_key).toBe('deal_all_fail|999|job-zzz')
  })

  it('emits HTML (not Markdown)', () => {
    const a = buildDealAllFailActivity(intent, 'debt-5188cf')
    expect(a.payload.note).toContain('<table>')
    expect(a.payload.note).toContain('<thead>')
    expect(a.payload.note).toContain('<tbody>')
    expect(a.payload.note).toContain('<th>Coluna</th>')
    expect(a.payload.note).toContain('<a href="https://debt-5188cf.pipedrive.com/deal/999">')
    expect(a.payload.note).not.toMatch(/^## /m)
    expect(a.payload.note).not.toContain('|---|')
    expect(a.payload.note).not.toMatch(/\*\*[^*]+\*\*/)
  })

  it('includes archival reason and next steps', () => {
    const a = buildDealAllFailActivity(intent)
    expect(a.payload.note).toContain('todos_telefones_invalidos')
    expect(a.payload.note).toContain('Próximos passos sugeridos')
    // Bullets via &bull; entity (HTML safelist friendly).
    expect(a.payload.note).toContain('&bull;')
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

  it('includes strategy breakdown as HTML rows', () => {
    const n = buildPastaSummaryNote(intent)
    expect(n.payload.content).toContain('<td>ADB direto</td><td>120</td>')
    expect(n.payload.content).toContain('<td>WAHA fallback</td><td>30</td>')
    expect(n.payload.content).toContain('<td>Cache hit (recente)</td><td>50</td>')
  })

  it('emits HTML (not Markdown) — Pipedrive Notes endpoint also renders HTML, not raw Markdown', () => {
    const n = buildPastaSummaryNote(intent, 'debt-5188cf')
    // Must be HTML.
    expect(n.payload.content).toContain('<table>')
    expect(n.payload.content).toContain('<thead>')
    expect(n.payload.content).toContain('<tbody>')
    expect(n.payload.content).toContain('<th>Métrica</th>')
    expect(n.payload.content).toContain('<th>Valor</th>')
    expect(n.payload.content).toContain('<p>')
    expect(n.payload.content).toContain('<strong>')
    expect(n.payload.content).toContain('<em>')
    expect(n.payload.content).toContain('&middot;')
    // Must NOT contain Markdown markers.
    expect(n.payload.content).not.toMatch(/^# /m)
    expect(n.payload.content).not.toMatch(/^## /m)
    expect(n.payload.content).not.toContain('|---|')
    expect(n.payload.content).not.toContain('| Métrica | Valor |')
    expect(n.payload.content).not.toMatch(/\*\*[^*]+\*\*/)
    // Must NOT contain disallowed safelist tags.
    expect(n.payload.content).not.toContain('<h1>')
    expect(n.payload.content).not.toContain('<h2>')
    expect(n.payload.content).not.toContain('<code>')
    // Domain-specific data still present.
    expect(n.payload.content).toContain('PASTA-042')
    expect(n.payload.content).toContain('job-final')
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

  it('escapes pasta containing html-special chars (defense vs injection)', () => {
    const n = buildPastaSummaryNote({
      ...intent,
      pasta: 'Brown & <Co>',
      job_id: '<script>alert(1)</script>',
    })
    expect(n.payload.content).toContain('Brown &amp; &lt;Co&gt;')
    expect(n.payload.content).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(n.payload.content).not.toContain('Brown & <Co>')
    expect(n.payload.content).not.toContain('<script>alert(1)</script>')
  })
})

describe('buildDealUrl / buildActivityUrl', () => {
  it('builds a deal URL with the configured subdomain', () => {
    expect(buildDealUrl(143611, 'debt-5188cf')).toBe('https://debt-5188cf.pipedrive.com/deal/143611')
  })

  it('returns null when domain is empty/undefined/null', () => {
    expect(buildDealUrl(143611, null)).toBeNull()
    expect(buildDealUrl(143611, undefined)).toBeNull()
    expect(buildDealUrl(143611, '')).toBeNull()
    expect(buildDealUrl(143611, '   ')).toBeNull()
  })

  it('rejects domains with invalid characters (defense vs misconfig)', () => {
    expect(buildDealUrl(1, 'evil.com/deal/1?x=y')).toBeNull()
    expect(buildDealUrl(1, '../../etc/passwd')).toBeNull()
    expect(buildDealUrl(1, 'has space')).toBeNull()
  })

  it('rejects non-positive deal ids', () => {
    expect(buildDealUrl(0, 'debt-5188cf')).toBeNull()
    expect(buildDealUrl(-1, 'debt-5188cf')).toBeNull()
    expect(buildDealUrl(1.5, 'debt-5188cf')).toBeNull()
  })

  it('builds activity URL anchored to deal page', () => {
    expect(buildActivityUrl(143611, 999, 'debt-5188cf'))
      .toBe('https://debt-5188cf.pipedrive.com/deal/143611#activity-999')
  })

  it('returns null for missing activity or domain', () => {
    expect(buildActivityUrl(143611, null, 'debt-5188cf')).toBeNull()
    expect(buildActivityUrl(143611, 999, null)).toBeNull()
  })
})

describe('formatter — dealUrl interpolation', () => {
  const phoneIntent: PipedrivePhoneFailIntent = {
    scenario: 'phone_fail',
    deal_id: 143611,
    pasta: 'P-001',
    phone: '5543991938235',
    column: 'telefone_1',
    strategy: 'adb',
    confidence: 0.9,
    job_id: 'job-1',
    occurred_at: '2026-04-28T18:00:00Z',
  }

  it('phone fail (HTML) includes deal link as <a href> at top when domain is set', () => {
    const a = buildPhoneFailActivity(phoneIntent, 'debt-5188cf')
    expect(a.payload.note).toContain('<a href="https://debt-5188cf.pipedrive.com/deal/143611">#143611</a>')
    // Deal link must be in the very first <p> block.
    expect(a.payload.note.startsWith('<p>')).toBe(true)
  })

  it('phone fail omits deal link when domain is unset', () => {
    const a = buildPhoneFailActivity(phoneIntent)
    expect(a.payload.note).not.toContain('pipedrive.com/deal')
  })

  it('deal-all-fail (HTML) includes deal link as <a href>', () => {
    const a = buildDealAllFailActivity({
      scenario: 'deal_all_fail',
      deal_id: 143611,
      pasta: 'P-001',
      phones: [{ column: 'telefone_1', phone: '5543991938235', outcome: 'invalid', strategy: 'adb', confidence: 0.9 }],
      motivo: 'todos_telefones_invalidos',
      job_id: 'job-1',
      occurred_at: '2026-04-28T18:00:00Z',
    }, 'debt-5188cf')
    expect(a.payload.note).toContain('<a href="https://debt-5188cf.pipedrive.com/deal/143611">#143611</a>')
  })

  it('pasta summary (HTML) includes deal link as <a href> at top when domain is set', () => {
    const n = buildPastaSummaryNote({
      scenario: 'pasta_summary',
      pasta: 'P-001', first_deal_id: 143611, job_id: 'job-1',
      job_started: null, job_ended: null,
      total_deals: 1, ok_deals: 1, archived_deals: 0,
      total_phones_checked: 1, ok_phones: 1,
      strategy_counts: { adb: 1, waha: 0, cache: 0 },
    }, 'debt-5188cf')
    expect(n.payload.content).toContain('<a href="https://debt-5188cf.pipedrive.com/deal/143611">#143611</a>')
    // The deal link must appear before the header block (first <p>).
    expect(n.payload.content.startsWith('<p>')).toBe(true)
    // Must NOT contain Markdown link syntax.
    expect(n.payload.content).not.toContain('](https://debt-5188cf')
  })

  it('pasta summary omits deal link when domain is unset', () => {
    const n = buildPastaSummaryNote({
      scenario: 'pasta_summary',
      pasta: 'P-001', first_deal_id: 1, job_id: 'j',
      job_started: null, job_ended: null,
      total_deals: 1, ok_deals: 1, archived_deals: 0,
      total_phones_checked: 1, ok_phones: 1,
      strategy_counts: { adb: 1, waha: 0, cache: 0 },
    })
    expect(n.payload.content).not.toContain('pipedrive.com/deal')
    // Still HTML, even without domain.
    expect(n.payload.content).toContain('<table>')
    expect(n.payload.content).not.toContain('# 📋')
    expect(n.payload.content).not.toContain('| Métrica | Valor |')
  })
})

describe('escapeHtml', () => {
  it('escapes the five html-special characters', () => {
    expect(escapeHtml('Brown & <Co>')).toBe('Brown &amp; &lt;Co&gt;')
    expect(escapeHtml('a"b\'c')).toBe('a&quot;b&#39;c')
  })

  it('returns empty string for null/undefined', () => {
    expect(escapeHtml(null)).toBe('')
    expect(escapeHtml(undefined)).toBe('')
  })

  it('passes through plain ASCII unchanged', () => {
    expect(escapeHtml('hello world 42')).toBe('hello world 42')
  })

  it('preserves emojis (multi-byte UTF-8 not in escape set)', () => {
    expect(escapeHtml('OK ✅ ❌ 🚨')).toBe('OK ✅ ❌ 🚨')
  })
})

describe('HTML formatter — escapes user-provided values', () => {
  it('phone_fail escapes pasta containing < & >', () => {
    const a = buildPhoneFailActivity({
      scenario: 'phone_fail',
      deal_id: 1,
      pasta: 'Brown & <Co>',
      phone: '5543991938235',
      column: 'telefone_1',
      strategy: 'adb',
      confidence: 0.9,
      job_id: 'job-1',
      occurred_at: '2026-04-28T18:00:00Z',
    })
    expect(a.payload.note).toContain('Brown &amp; &lt;Co&gt;')
    expect(a.payload.note).not.toContain('Brown & <Co>')
  })

  it('deal_all_fail escapes motivo containing html-special chars', () => {
    const a = buildDealAllFailActivity({
      scenario: 'deal_all_fail',
      deal_id: 1,
      pasta: 'P',
      motivo: 'reason <script>alert(1)</script>',
      phones: [{ column: 'telefone_1', phone: '5543991938235', outcome: 'invalid', strategy: 'adb', confidence: 0.9 }],
      job_id: 'job-1',
      occurred_at: '2026-04-28T18:00:00Z',
    })
    expect(a.payload.note).toContain('reason &lt;script&gt;alert(1)&lt;/script&gt;')
    expect(a.payload.note).not.toContain('<script>alert(1)</script>')
  })
})
