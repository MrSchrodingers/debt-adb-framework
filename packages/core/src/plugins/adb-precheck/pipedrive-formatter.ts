import type {
  PipedriveActivityIntent,
  PipedriveDealAllFailIntent,
  PipedriveNoteIntent,
  PipedrivePastaDealRow,
  PipedrivePastaSummaryIntent,
  PipedrivePhoneFailIntent,
} from './types.js'

/**
 * Pure formatters for Pipedrive payloads.
 *
 * Two active scenarios after the 2026-04-29 noise reduction:
 *   - `deal_all_fail`  → HTML Activity `note` (one per archived deal,
 *                        no phone numbers in body — privacy + clutter).
 *   - `pasta_summary`  → HTML Note `content` (one per pasta at job-end).
 *
 * `phone_fail` is DEPRECATED. The formatter is kept exported for the
 * one-shot cleanup script that needs to repair / delete historical
 * activity rows of that scenario. NO ACTIVE CALLER MAY USE IT — see
 * pipedrive-publisher.ts which no longer exposes `enqueuePhoneFail()`.
 *
 * Deterministic — same input ⇒ same output ⇒ snapshot-friendly. NEVER
 * calls into IO. The publisher composes these into full intents (with
 * dedup keys) before handing them to the client.
 *
 * Pipedrive HTML safelist (per docs / observed behavior, identical for
 * Activity.note and Note.content):
 *   <p> <br> <strong> <em> <u> <ul> <ol> <li> <a> <table> <tr> <td> <th>
 *   <thead> <tbody>
 * Tags outside this list are stripped (notably <h1>..<h6>, <code>). We only
 * use safelist tags. Bullets are emitted as &bull; entities inside <p><br>.
 *
 * ─── Pasta summary HTML rendering quirk ─────────────────────────────────
 * Pipedrive's Notes API empirically renders content reliably as HTML when
 * the body STARTS with a recognized block tag (we use `<p>`). The previous
 * Markdown payloads were shown raw because they lacked any HTML. As long
 * as the first character is `<`, the renderer treats the whole body as
 * HTML and strips disallowed tags silently. The cleanup script verifies
 * this empirically by GET-ing each migrated note and checking `.content`.
 */

const FALLBACK_PHONE = '(número desconhecido)'

/**
 * Build a Pipedrive deal URL from the configured PIPEDRIVE_COMPANY_DOMAIN.
 * Returns null when the domain is not configured (or empty), so callers can
 * gracefully omit the link from their layout.
 *
 * Domain format: subdomain prefix only — e.g. `debt-5188cf` →
 * `https://debt-5188cf.pipedrive.com/deal/{id}`. We sanitize the input to a
 * conservative subdomain regex so a misconfigured env var cannot produce
 * arbitrary URLs.
 */
const COMPANY_DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i
export function buildDealUrl(dealId: number, companyDomain: string | null | undefined): string | null {
  if (!companyDomain) return null
  const trimmed = companyDomain.trim()
  if (!trimmed || !COMPANY_DOMAIN_RE.test(trimmed)) return null
  if (!Number.isInteger(dealId) || dealId <= 0) return null
  return `https://${trimmed}.pipedrive.com/deal/${dealId}`
}

/**
 * Build a deep-link URL to an activity within a Pipedrive deal page. Pipedrive
 * does not expose stable URLs for activity ids on the activity list endpoint,
 * but the canonical pattern is the deal page anchored to the activity:
 *   https://{domain}.pipedrive.com/deal/{deal_id}#activity-{activity_id}
 * Returns null when domain or activityId is missing/invalid.
 */
export function buildActivityUrl(
  dealId: number,
  activityId: number | null | undefined,
  companyDomain: string | null | undefined,
): string | null {
  const dealUrl = buildDealUrl(dealId, companyDomain)
  if (!dealUrl || !activityId || !Number.isInteger(activityId) || activityId <= 0) return null
  return `${dealUrl}#activity-${activityId}`
}

/** "55 43 99193-8235" → "(43) 99193-8235". Returns input as-is on parse failure. */
export function formatBrPhonePretty(phone: string | null | undefined): string {
  if (!phone) return FALLBACK_PHONE
  const digits = phone.replace(/\D/g, '')
  if (digits.length < 10 || digits.length > 13) return phone
  // Drop country code (55) when present.
  const local = digits.length >= 12 && digits.startsWith('55') ? digits.slice(2) : digits
  if (local.length !== 10 && local.length !== 11) return phone
  const ddd = local.slice(0, 2)
  const rest = local.slice(2)
  // 9-digit mobile: 99193-8235 / 8-digit landline: 9193-8235
  const mid = rest.length === 9 ? rest.slice(0, 5) : rest.slice(0, 4)
  const tail = rest.length === 9 ? rest.slice(5) : rest.slice(4)
  return `(${ddd}) ${mid}-${tail}`
}

/** Map our internal `source` ids onto a human-friendly strategy label. */
export function strategyLabel(source: string): string {
  const s = source.toLowerCase()
  if (s === 'cache' || s === 'cache_hit' || s === 'l1') return 'Cache (recente)'
  if (s === 'adb' || s === 'adb_probe' || s === 'l3') return 'ADB direto'
  if (s === 'waha' || s === 'waha_check' || s === 'l2') return 'WAHA fallback'
  return source
}

/**
 * HTML-escape any user-provided string before interpolating into an HTML
 * payload destined for Pipedrive. Returns empty string for nullish inputs so
 * concatenation cannot accidentally introduce the literal "null"/"undefined".
 *
 * Covers the 5 chars that can break HTML structure: & < > " '. Entities use
 * named refs where they exist (&amp; &lt; &gt; &quot;) and the numeric ref
 * for the apostrophe (&#39;) which is the most portable form (some legacy
 * sanitizers still drop &apos;).
 */
export function escapeHtml(value: string | null | undefined): string {
  if (value === null || value === undefined) return ''
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// ── Scenario A — per-phone fail Activity (HTML) — DEPRECATED ───────────
//
// Retained ONLY so the one-shot cleanup script can DELETE historical
// rows of this scenario. No active caller emits this anymore — the
// scanner skips `phone_fail` entirely as of 2026-04-29.

/** @deprecated 2026-04-29 — scenario removed; kept for cleanup script only. */
export function buildPhoneFailActivity(
  intent: PipedrivePhoneFailIntent,
  companyDomain?: string | null,
): PipedriveActivityIntent {
  const pretty = formatBrPhonePretty(intent.phone)
  const dealUrl = buildDealUrl(intent.deal_id, companyDomain)
  // All user-facing values get escaped before HTML interpolation.
  const prettyEsc = escapeHtml(pretty)
  const pastaEsc = escapeHtml(intent.pasta)
  const columnEsc = escapeHtml(intent.column)
  const strategyEsc = escapeHtml(strategyLabel(intent.strategy))
  const jobIdEsc = escapeHtml(intent.job_id)
  const occurredEsc = escapeHtml(intent.occurred_at)

  const parts: string[] = []
  if (dealUrl) {
    // dealUrl is built from sanitized inputs (dealId integer, domain regex), so
    // it does not require escaping — but we still escape for defense-in-depth.
    parts.push(
      `<p><strong>Deal:</strong> <a href="${escapeHtml(dealUrl)}">#${intent.deal_id}</a> &middot; <strong>Pasta:</strong> ${pastaEsc}</p>`,
    )
  } else {
    parts.push(`<p><strong>Pasta:</strong> ${pastaEsc}</p>`)
  }
  parts.push(`<p><strong>Verificação adb-precheck</strong> &middot; ${occurredEsc}</p>`)
  parts.push(
    '<table>'
      + `<tr><td><strong>Telefone</strong></td><td>${prettyEsc}</td></tr>`
      + `<tr><td><strong>Coluna</strong></td><td>${columnEsc}</td></tr>`
      + '<tr><td><strong>Resultado</strong></td><td>❌ NÃO localizado no WhatsApp</td></tr>'
      + `<tr><td><strong>Validado via</strong></td><td>${strategyEsc}</td></tr>`
      + `<tr><td><strong>Job ID</strong></td><td>${jobIdEsc}</td></tr>`
      + '</table>',
  )
  if (intent.cache_ttl_days) {
    parts.push(`<p><em>Cache TTL: ${intent.cache_ttl_days} dias</em></p>`)
  }
  const note = parts.join('')

  return {
    kind: 'activity',
    dedup_key: `phone_fail|${intent.deal_id}|${intent.phone}|${intent.job_id}`,
    payload: {
      subject: `❌ Telefone ${pretty} sem WhatsApp`,
      type: 'call',
      done: 1,
      deal_id: intent.deal_id,
      note,
    },
  }
}

// ── Scenario B — deal-level all-fail Activity (HTML, sanitized) ─────────
//
// Emits an aggregate-only summary: NO phone numbers, NO column refs, NO
// per-row results table. Operators still get the alarm + audit trail at
// the deal level (the deal was archived, why, by which job) without the
// timeline pollution and without leaking individual numbers.

export function buildDealAllFailActivity(
  intent: PipedriveDealAllFailIntent,
  companyDomain?: string | null,
): PipedriveActivityIntent {
  const dealUrl = buildDealUrl(intent.deal_id, companyDomain)
  const pastaEsc = escapeHtml(intent.pasta)
  const motivoEsc = escapeHtml(intent.motivo)
  const jobIdEsc = escapeHtml(intent.job_id)
  const occurredEsc = escapeHtml(intent.occurred_at)
  const phoneCount = intent.phones.length

  const parts: string[] = []
  if (dealUrl) {
    parts.push(
      `<p><strong>Deal:</strong> <a href="${escapeHtml(dealUrl)}">#${intent.deal_id}</a> &middot; <strong>Pasta:</strong> ${pastaEsc}</p>`,
    )
  } else {
    parts.push(`<p><strong>Pasta:</strong> ${pastaEsc}</p>`)
  }
  // No <code> tag — not in the safelist; use <strong> as visual emphasis instead.
  parts.push(`<p>🚨 <strong>ATENÇÃO</strong> — Deal arquivado em <strong>prov_consultas_snapshot</strong></p>`)
  parts.push(`<p><strong>Verificação completa</strong> &middot; ${occurredEsc}</p>`)
  parts.push(
    `<p><strong>${phoneCount} telefone${phoneCount === 1 ? '' : 's'} testado${phoneCount === 1 ? '' : 's'}, todos inválidos no WhatsApp.</strong></p>`,
  )
  parts.push(
    `<p><strong>Motivo arquival:</strong> ${motivoEsc}<br>`
      + `<strong>Job ID:</strong> ${jobIdEsc}</p>`,
  )
  parts.push('<p><strong>Próximos passos sugeridos:</strong></p>')
  parts.push(
    '<p>'
      + '&bull; Contato manual via canais alternativos (e-mail, SMS, telefone fixo)<br>'
      + '&bull; Skip tracing externo<br>'
      + '&bull; Verificar dados cadastrais com a contraparte'
      + '</p>',
  )
  const note = parts.join('')

  return {
    kind: 'activity',
    dedup_key: `deal_all_fail|${intent.deal_id}|${intent.job_id}`,
    payload: {
      subject: '🚨 ATENÇÃO — nenhum telefone do deal está no WhatsApp',
      type: 'task',
      done: 1,
      deal_id: intent.deal_id,
      note,
    },
  }
}

// ── Scenario C — pasta sweep Note (HTML) ────────────────────────────────
//
// Pipedrive's POST /v1/notes endpoint renders the same constrained HTML
// safelist as Activity.note when content is sent verbatim — Markdown shipped
// in `content` is shown as raw source on the deal timeline. Migrated to HTML
// on 2026-04-29 (mirroring the Activities migration done on the same day).

function pct(numerator: number, denominator: number): string {
  if (denominator <= 0) return '0.0'
  return ((numerator / denominator) * 100).toFixed(1)
}

/** Marker that identifies the v2 layout (per-deal detail) — used by
 *  the backfill script for cheap idempotency detection without parsing
 *  the rest of the body. The marker lives inside the per-deal intro line
 *  ("Detalhamento por deal:") emitted only when `deals[]` is non-empty.
 */
export const PASTA_SUMMARY_V2_MARKER = 'Detalhamento por deal'

/** Map a phone outcome to a friendly status cell (with emoji + label). */
function outcomeCell(outcome: 'valid' | 'invalid' | 'error'): string {
  if (outcome === 'valid') return '✅ Existe no WhatsApp'
  if (outcome === 'invalid') return '❌ Não localizado'
  return '⚠️ Erro de verificação'
}

/** Render the phone table for one deal — already-escaped values only. */
function renderDealPhonesTable(deal: PipedrivePastaDealRow): string {
  if (!deal.phones || deal.phones.length === 0) {
    return '<p><em>(nenhum telefone foi extraído deste deal)</em></p>'
  }
  const rows = deal.phones
    .map((p) => {
      const colEsc = escapeHtml(p.column)
      const pretty = formatBrPhonePretty(p.phone_normalized)
      const phoneEsc = escapeHtml(pretty)
      const statusEsc = escapeHtml(outcomeCell(p.outcome))
      const stratEsc = escapeHtml(strategyLabel(p.strategy))
      return `<tr><td>${colEsc}</td><td>${phoneEsc}</td><td>${statusEsc}</td><td>${stratEsc}</td></tr>`
    })
    .join('')
  return (
    '<table>'
    + '<thead><tr><th>Coluna</th><th>Número</th><th>Status</th><th>Validado via</th></tr></thead>'
    + `<tbody>${rows}</tbody>`
    + '</table>'
  )
}

export function buildPastaSummaryNote(
  intent: PipedrivePastaSummaryIntent,
  companyDomain?: string | null,
): PipedriveNoteIntent {
  const okPct = pct(intent.ok_deals, intent.total_deals)
  const archivedPct = pct(intent.archived_deals, intent.total_deals)
  const okPhonesPct = pct(intent.ok_phones, intent.total_phones_checked)
  const dealUrl = buildDealUrl(intent.first_deal_id, companyDomain)

  // All user-facing values get escaped before HTML interpolation.
  const pastaEsc = escapeHtml(intent.pasta)
  const jobIdEsc = escapeHtml(intent.job_id)
  const startedEsc = escapeHtml(intent.job_started ?? 'n/a')
  const endedEsc = escapeHtml(intent.job_ended ?? 'n/a')

  const parts: string[] = []

  // ── Header — pasta name as visual title + first-deal link inline ──────
  if (dealUrl) {
    parts.push(
      `<p><strong>📋 Resumo de varredura</strong> &middot; Pasta <strong>${pastaEsc}</strong> &middot; `
        + `<a href="${escapeHtml(dealUrl)}">deal #${intent.first_deal_id}</a></p>`,
    )
  } else {
    parts.push(
      `<p><strong>📋 Resumo de varredura</strong> &middot; Pasta <strong>${pastaEsc}</strong></p>`,
    )
  }

  // ── Period + Job ID block (compact) ───────────────────────────────────
  parts.push(
    '<p>'
      + `<em>Período</em>: ${startedEsc} &ndash; ${endedEsc}<br>`
      + `<em>Job ID</em>: ${jobIdEsc}`
      + '</p>',
  )

  // ── Aggregate metrics with emoji column ──────────────────────────────
  parts.push('<p><strong>Métricas</strong></p>')
  parts.push(
    '<table>'
      + '<thead><tr><th></th><th>Métrica</th><th>Valor</th></tr></thead>'
      + '<tbody>'
      + `<tr><td>📞</td><td>Deals na pasta</td><td><strong>${intent.total_deals}</strong></td></tr>`
      + `<tr><td>✅</td><td>Deals com ≥ 1 telefone válido</td><td><strong>${intent.ok_deals}</strong> (${okPct}%)</td></tr>`
      + `<tr><td>❌</td><td>Deals 100% inválidos (arquivados)</td><td><strong>${intent.archived_deals}</strong> (${archivedPct}%)</td></tr>`
      + `<tr><td>📞</td><td>Total fones verificados</td><td><strong>${intent.total_phones_checked}</strong></td></tr>`
      + `<tr><td>✅</td><td>Fones existentes no WhatsApp</td><td><strong>${intent.ok_phones}</strong> (${okPhonesPct}%)</td></tr>`
      + '</tbody>'
      + '</table>',
  )

  // ── NEW per-deal section ──────────────────────────────────────────────
  // Only rendered when the intent carries deal-level detail — keeps
  // backwards-compat with manual API callers that omit `deals`.
  const deals = intent.deals ?? []
  if (deals.length > 0) {
    parts.push(`<p><em>${PASTA_SUMMARY_V2_MARKER}:</em></p>`)
    // Deals are rendered in scan order — scanner inserts them as they are
    // processed, so the natural ordering reflects the keyset traversal.
    for (const deal of deals) {
      const dealUrlForRow = buildDealUrl(deal.deal_id, companyDomain)
      const header = dealUrlForRow
        ? `<p><strong>📌 Deal <a href="${escapeHtml(dealUrlForRow)}">#${deal.deal_id}</a></strong></p>`
        : `<p><strong>📌 Deal #${deal.deal_id}</strong></p>`
      parts.push(header)
      parts.push(renderDealPhonesTable(deal))
    }
  }

  // ── Strategy distribution (aggregated bottom block) ──────────────────
  parts.push('<p><strong>Distribuição por estratégia de validação</strong></p>')
  parts.push(
    '<table>'
      + '<thead><tr><th>Estratégia</th><th>Verificações</th></tr></thead>'
      + '<tbody>'
      + `<tr><td>ADB direto</td><td>${intent.strategy_counts.adb}</td></tr>`
      + `<tr><td>WAHA fallback</td><td>${intent.strategy_counts.waha}</td></tr>`
      + `<tr><td>Cache hit (recente)</td><td>${intent.strategy_counts.cache}</td></tr>`
      + '</tbody>'
      + '</table>',
  )
  parts.push('<p><em>Gerado automaticamente por <strong>dispatch-core</strong> &middot; adb-precheck plugin.</em></p>')
  const content = parts.join('')

  return {
    kind: 'note',
    dedup_key: `pasta_summary|${intent.pasta}|${intent.job_id}`,
    payload: {
      deal_id: intent.first_deal_id,
      content,
    },
  }
}
