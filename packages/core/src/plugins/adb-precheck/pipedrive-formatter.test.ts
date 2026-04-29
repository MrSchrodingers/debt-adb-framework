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

// `buildPhoneFailActivity` is retained ONLY for the cleanup script; we keep
// a single sanity test to prove the helper still compiles and produces a
// payload with the historical dedup-key shape (which the cleanup script
// relies on when matching legacy rows). New code MUST NOT call it.
describe('buildPhoneFailActivity (deprecated, cleanup-only)', () => {
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

  it('still emits the historical dedup_key shape', () => {
    const a = buildPhoneFailActivity(baseIntent)
    expect(a.kind).toBe('activity')
    expect(a.dedup_key).toBe('phone_fail|12345|5543991938235|job-abc')
  })
})

describe('buildDealAllFailActivity (sanitized — no phone numbers in body)', () => {
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

  it('redacts phone numbers — body must not contain any digit string', () => {
    const a = buildDealAllFailActivity(intent)
    // No raw phone digits anywhere in body.
    expect(a.payload.note).not.toContain('5543991938235')
    expect(a.payload.note).not.toContain('5511988880000')
    // No pretty-formatted DDD/number pairs either.
    expect(a.payload.note).not.toMatch(/\(\d{2}\) \d{4,5}-\d{4}/)
  })

  it('omits per-row column references and results table', () => {
    const a = buildDealAllFailActivity(intent)
    // No column refs.
    expect(a.payload.note).not.toContain('telefone_1')
    expect(a.payload.note).not.toContain('telefone_2')
    // No table headers / status cells from the old layout.
    expect(a.payload.note).not.toContain('<th>Coluna</th>')
    expect(a.payload.note).not.toContain('<th>Telefone</th>')
    expect(a.payload.note).not.toContain('<th>Resultado</th>')
    expect(a.payload.note).not.toContain('❌ Não existe')
    expect(a.payload.note).not.toContain('<thead>')
    expect(a.payload.note).not.toContain('<tbody>')
  })

  it('exposes only an aggregate count of phones tested', () => {
    const a = buildDealAllFailActivity(intent)
    expect(a.payload.note).toContain('<strong>2 telefones testados, todos inválidos no WhatsApp.</strong>')
  })

  it('singularizes the count when only one phone was tested', () => {
    const a = buildDealAllFailActivity({ ...intent, phones: [intent.phones[0]] })
    expect(a.payload.note).toContain('<strong>1 telefone testado, todos inválidos no WhatsApp.</strong>')
  })

  it('dedup key uses deal+job', () => {
    const a = buildDealAllFailActivity(intent)
    expect(a.dedup_key).toBe('deal_all_fail|999|job-zzz')
  })

  it('emits HTML (not Markdown) with the deal link', () => {
    const a = buildDealAllFailActivity(intent, 'debt-5188cf')
    expect(a.payload.note).toContain('<p>')
    expect(a.payload.note).toContain('<strong>')
    expect(a.payload.note).toContain('<a href="https://debt-5188cf.pipedrive.com/deal/999">')
    expect(a.payload.note).not.toMatch(/^## /m)
    expect(a.payload.note).not.toContain('|---|')
    expect(a.payload.note).not.toMatch(/\*\*[^*]+\*\*/)
  })

  it('includes archival reason, job id, and next-steps bullets', () => {
    const a = buildDealAllFailActivity(intent)
    expect(a.payload.note).toContain('todos_telefones_invalidos')
    expect(a.payload.note).toContain('job-zzz')
    expect(a.payload.note).toContain('Próximos passos sugeridos')
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
    // 35/50 = 70.0% — value is now bolded to highlight the metric.
    expect(n.payload.content).toContain('<strong>35</strong> (70.0%)')
    // 15/50 = 30.0%
    expect(n.payload.content).toContain('<strong>15</strong> (30.0%)')
    // 140/200 = 70.0%
    expect(n.payload.content).toContain('<strong>140</strong> (70.0%)')
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
    expect(n.payload.content).toContain('<strong>0</strong> (0.0%)')
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

  // ── v2 layout — per-deal detail section ────────────────────────────────
  describe('v2 per-deal detail section', () => {
    const baseIntent: PipedrivePastaSummaryIntent = {
      scenario: 'pasta_summary',
      pasta: 'PASTA-X',
      first_deal_id: 100,
      job_id: 'job-v2',
      job_started: '2026-04-29T10:00:00Z',
      job_ended: '2026-04-29T10:05:00Z',
      total_deals: 2,
      ok_deals: 1,
      archived_deals: 1,
      total_phones_checked: 3,
      ok_phones: 1,
      strategy_counts: { adb: 2, waha: 1, cache: 0 },
      deals: [
        {
          deal_id: 100,
          phones: [
            { column: 'telefone_1', phone_normalized: '5543991938235', outcome: 'valid', strategy: 'adb' },
            { column: 'telefone_2', phone_normalized: '5511988887777', outcome: 'invalid', strategy: 'waha' },
          ],
        },
        {
          deal_id: 101,
          phones: [
            { column: 'whatsapp_hot', phone_normalized: '5511444444444', outcome: 'invalid', strategy: 'adb' },
          ],
        },
      ],
    }

    it('emits the "Detalhamento por deal" intro line', () => {
      const n = buildPastaSummaryNote(baseIntent)
      expect(n.payload.content).toContain('<p><em>Detalhamento por deal:</em></p>')
    })

    it('emits a 📌 sub-header per deal with the deal link when domain is set', () => {
      const n = buildPastaSummaryNote(baseIntent, 'debt-5188cf')
      expect(n.payload.content).toContain(
        '<p><strong>📌 Deal <a href="https://debt-5188cf.pipedrive.com/deal/100">#100</a></strong></p>',
      )
      expect(n.payload.content).toContain(
        '<p><strong>📌 Deal <a href="https://debt-5188cf.pipedrive.com/deal/101">#101</a></strong></p>',
      )
    })

    it('renders 📌 deal sub-header without link when domain is unset', () => {
      const n = buildPastaSummaryNote(baseIntent)
      expect(n.payload.content).toContain('<p><strong>📌 Deal #100</strong></p>')
      expect(n.payload.content).toContain('<p><strong>📌 Deal #101</strong></p>')
      expect(n.payload.content).not.toContain('pipedrive.com/deal/100')
    })

    it('emits a phones table per deal with 4 columns (Coluna, Número, Status, Validado via)', () => {
      const n = buildPastaSummaryNote(baseIntent)
      expect(n.payload.content).toContain(
        '<thead><tr><th>Coluna</th><th>Número</th><th>Status</th><th>Validado via</th></tr></thead>',
      )
    })

    it('renders ✅ for valid, ❌ for invalid, ⚠️ for error rows', () => {
      const n = buildPastaSummaryNote({
        ...baseIntent,
        deals: [
          {
            deal_id: 100,
            phones: [
              { column: 'telefone_1', phone_normalized: '5543991938235', outcome: 'valid', strategy: 'adb' },
              { column: 'telefone_2', phone_normalized: '5511988887777', outcome: 'invalid', strategy: 'waha' },
              { column: 'telefone_3', phone_normalized: '5511777777777', outcome: 'error', strategy: 'cache' },
            ],
          },
        ],
      })
      expect(n.payload.content).toContain('✅ Existe no WhatsApp')
      expect(n.payload.content).toContain('❌ Não localizado')
      expect(n.payload.content).toContain('⚠️ Erro de verificação')
    })

    it('uses pretty BR phone formatting in the per-deal table', () => {
      const n = buildPastaSummaryNote(baseIntent)
      // 5543991938235 → (43) 99193-8235
      expect(n.payload.content).toContain('(43) 99193-8235')
      // 5511988887777 → (11) 98888-7777
      expect(n.payload.content).toContain('(11) 98888-7777')
    })

    it('renders strategy labels (ADB direto / WAHA fallback / Cache (recente))', () => {
      const n = buildPastaSummaryNote(baseIntent)
      expect(n.payload.content).toContain('ADB direto')
      expect(n.payload.content).toContain('WAHA fallback')
    })

    it('escapes column, phone, and strategy in per-deal rows', () => {
      const n = buildPastaSummaryNote({
        ...baseIntent,
        deals: [
          {
            deal_id: 100,
            phones: [
              {
                column: 'tel<script>',
                phone_normalized: '<bad>',
                outcome: 'invalid',
                strategy: 'adb<x>',
              },
            ],
          },
        ],
      })
      expect(n.payload.content).toContain('tel&lt;script&gt;')
      expect(n.payload.content).not.toContain('<script>')
      expect(n.payload.content).toContain('&lt;bad&gt;')
      expect(n.payload.content).toContain('adb&lt;x&gt;')
    })

    it('renders gracefully when a deal has zero phones (all-archived corner case)', () => {
      const n = buildPastaSummaryNote({
        ...baseIntent,
        deals: [{ deal_id: 100, phones: [] }],
      })
      expect(n.payload.content).toContain('(nenhum telefone foi extraído deste deal)')
    })

    it('omits the per-deal section entirely when deals is empty/undefined (graceful degradation)', () => {
      const n1 = buildPastaSummaryNote({ ...baseIntent, deals: [] })
      const n2 = buildPastaSummaryNote({ ...baseIntent, deals: undefined })
      expect(n1.payload.content).not.toContain('Detalhamento por deal')
      expect(n1.payload.content).not.toContain('📌 Deal')
      expect(n2.payload.content).not.toContain('Detalhamento por deal')
      expect(n2.payload.content).not.toContain('📌 Deal')
      // Aggregate metrics block must still render.
      expect(n1.payload.content).toContain('<th>Métrica</th>')
    })

    it('aggregates the deal link into the title (single header line)', () => {
      const n = buildPastaSummaryNote(baseIntent, 'debt-5188cf')
      // Title carries the deal link inline — no separate "Primeiro deal" line.
      expect(n.payload.content).toContain('📋 Resumo de varredura')
      expect(n.payload.content).toContain('<a href="https://debt-5188cf.pipedrive.com/deal/100">deal #100</a>')
      expect(n.payload.content).not.toContain('Primeiro deal da pasta')
    })

    it('exposes the v2 marker so the backfill script can detect already-migrated notes', async () => {
      const m = await import('./pipedrive-formatter.js')
      expect(m.PASTA_SUMMARY_V2_MARKER).toBe('Detalhamento por deal')
      const n = buildPastaSummaryNote(baseIntent)
      expect(n.payload.content).toContain(m.PASTA_SUMMARY_V2_MARKER)
    })
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

  it('pasta summary (HTML) includes deal link as <a href> in title when domain is set', () => {
    const n = buildPastaSummaryNote({
      scenario: 'pasta_summary',
      pasta: 'P-001', first_deal_id: 143611, job_id: 'job-1',
      job_started: null, job_ended: null,
      total_deals: 1, ok_deals: 1, archived_deals: 0,
      total_phones_checked: 1, ok_phones: 1,
      strategy_counts: { adb: 1, waha: 0, cache: 0 },
    }, 'debt-5188cf')
    // v2 layout merges the deal link into the title — link text is "deal #N"
    // (not just "#N") so it reads naturally next to the pasta name.
    expect(n.payload.content).toContain('<a href="https://debt-5188cf.pipedrive.com/deal/143611">deal #143611</a>')
    // The body still starts with the title <p>.
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
  it('deal_all_fail escapes pasta containing < & >', () => {
    const a = buildDealAllFailActivity({
      scenario: 'deal_all_fail',
      deal_id: 1,
      pasta: 'Brown & <Co>',
      motivo: 'todos_telefones_invalidos',
      phones: [{ column: 'telefone_1', phone: '5543991938235', outcome: 'invalid', strategy: 'adb', confidence: 0.9 }],
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
