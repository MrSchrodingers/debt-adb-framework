import type {
  PipedriveActivityIntent,
  PipedriveDealAllFailIntent,
  PipedriveNoteIntent,
  PipedrivePastaSummaryIntent,
  PipedrivePhoneFailIntent,
} from './types.js'

/**
 * Pure formatters for Pipedrive payloads.
 *
 * Three scenarios, three layouts. Deterministic — same input ⇒ same output ⇒
 * snapshot-friendly. NEVER calls into IO. The publisher composes these into
 * full intents (with dedup keys) before handing them to the client.
 *
 * IMPORTANT — output format split:
 *   - `phone_fail`     → HTML (Pipedrive Activity `note` field renders HTML
 *                        from a constrained safelist; Markdown is shown raw).
 *   - `deal_all_fail`  → HTML (same reason).
 *   - `pasta_summary`  → Markdown (Pipedrive Note `content` renders Markdown
 *                        beautifully — confirmed visually).
 *
 * Pipedrive Activity HTML safelist (per docs / observed behavior):
 *   <p> <br> <strong> <em> <u> <ul> <ol> <li> <a> <table> <tr> <td> <th>
 *   <thead> <tbody>
 * Tags outside this list are stripped (notably <h1>..<h6>, <code>). We only
 * use safelist tags. Bullets are emitted as &bull; entities inside <p><br>.
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

// ── Scenario A — per-phone fail Activity (HTML) ─────────────────────────

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

// ── Scenario B — deal-level all-fail Activity (HTML) ────────────────────

export function buildDealAllFailActivity(
  intent: PipedriveDealAllFailIntent,
  companyDomain?: string | null,
): PipedriveActivityIntent {
  const dealUrl = buildDealUrl(intent.deal_id, companyDomain)
  const pastaEsc = escapeHtml(intent.pasta)
  const motivoEsc = escapeHtml(intent.motivo)
  const jobIdEsc = escapeHtml(intent.job_id)
  const occurredEsc = escapeHtml(intent.occurred_at)

  const rows = intent.phones
    .map((p) => {
      const colEsc = escapeHtml(p.column)
      const phoneEsc = escapeHtml(formatBrPhonePretty(p.phone))
      const result =
        p.outcome === 'invalid'
          ? '❌ Não existe'
          : p.outcome === 'error'
            ? '⚠️ Erro de validação'
            : '✅ OK'
      return `<tr><td>${colEsc}</td><td>${phoneEsc}</td><td>${result}</td></tr>`
    })
    .join('')

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
    '<table>'
      + '<thead><tr><th>Coluna</th><th>Telefone</th><th>Resultado</th></tr></thead>'
      + `<tbody>${rows}</tbody>`
      + '</table>',
  )
  parts.push(`<p><strong>Motivo arquival:</strong> ${motivoEsc}</p>`)
  parts.push(`<p><strong>Job ID:</strong> ${jobIdEsc}</p>`)
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

// ── Scenario C — pasta sweep Note (Markdown — UNCHANGED) ────────────────
//
// Pipedrive Note `content` field renders Markdown correctly — headings, tables,
// lists all show as expected. Do NOT migrate this to HTML.

function pct(numerator: number, denominator: number): string {
  if (denominator <= 0) return '0.0'
  return ((numerator / denominator) * 100).toFixed(1)
}

export function buildPastaSummaryNote(
  intent: PipedrivePastaSummaryIntent,
  companyDomain?: string | null,
): PipedriveNoteIntent {
  const okPct = pct(intent.ok_deals, intent.total_deals)
  const archivedPct = pct(intent.archived_deals, intent.total_deals)
  const okPhonesPct = pct(intent.ok_phones, intent.total_phones_checked)
  const dealUrl = buildDealUrl(intent.first_deal_id, companyDomain)
  const lines: string[] = []
  if (dealUrl) {
    lines.push(`**Primeiro deal da pasta**: [#${intent.first_deal_id}](${dealUrl})`, '')
  }
  lines.push(
    `# 📋 Resumo de varredura — Pasta \`${intent.pasta}\``,
    '',
    `**Período**: ${intent.job_started ?? 'n/a'} → ${intent.job_ended ?? 'n/a'}`,
    `**Job ID**: \`${intent.job_id}\``,
    '',
    '## Métricas',
    '',
    '| Métrica | Valor |',
    '|---|---|',
    `| Deals na pasta | ${intent.total_deals} |`,
    `| Deals com ≥ 1 telefone válido | ${intent.ok_deals} (${okPct}%) |`,
    `| Deals 100% inválidos (arquivados) | ${intent.archived_deals} (${archivedPct}%) |`,
    `| Total fones verificados | ${intent.total_phones_checked} |`,
    `| Fones existentes no WhatsApp | ${intent.ok_phones} (${okPhonesPct}%) |`,
    '',
    '## Distribuição por estratégia de validação',
    '',
    '| Estratégia | Verificações |',
    '|---|---|',
    `| ADB direto | ${intent.strategy_counts.adb} |`,
    `| WAHA fallback | ${intent.strategy_counts.waha} |`,
    `| Cache hit (recente) | ${intent.strategy_counts.cache} |`,
    '',
    '_Gerado automaticamente por **dispatch-core** — `adb-precheck` plugin._',
  )
  const content = lines.join('\n')

  return {
    kind: 'note',
    dedup_key: `pasta_summary|${intent.pasta}|${intent.job_id}`,
    payload: {
      deal_id: intent.first_deal_id,
      content,
    },
  }
}
