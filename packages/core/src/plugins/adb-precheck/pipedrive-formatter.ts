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
 */

const FALLBACK_PHONE = '(número desconhecido)'

/**
 * Build a Pipedrive deal URL from the configured PIPEDRIVE_COMPANY_DOMAIN.
 * Returns null when the domain is not configured (or empty), so callers can
 * gracefully omit the link from their Markdown layout.
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

// ── Scenario A — per-phone fail Activity ────────────────────────────────

export function buildPhoneFailActivity(
  intent: PipedrivePhoneFailIntent,
  companyDomain?: string | null,
): PipedriveActivityIntent {
  const pretty = formatBrPhonePretty(intent.phone)
  const dealUrl = buildDealUrl(intent.deal_id, companyDomain)
  const lines: string[] = []
  if (dealUrl) {
    lines.push(`**Deal**: [#${intent.deal_id}](${dealUrl})`, '')
  }
  lines.push(
    `**Verificação adb-precheck — ${intent.occurred_at}**`,
    '',
    '| Campo | Valor |',
    '|---|---|',
    `| Telefone | \`${pretty}\` |`,
    `| Coluna em prov_consultas | \`${intent.column}\` |`,
    `| Resultado | ❌ NÃO localizado no WhatsApp |`,
    `| Validado via | ${strategyLabel(intent.strategy)} |`,
    `| Job ID | \`${intent.job_id}\` |`,
  )
  if (intent.cache_ttl_days) {
    lines.push('', `_Validation cache TTL: ${intent.cache_ttl_days} dias_`)
  }
  const note = lines.join('\n')

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

// ── Scenario B — deal-level all-fail Activity ───────────────────────────

export function buildDealAllFailActivity(
  intent: PipedriveDealAllFailIntent,
  companyDomain?: string | null,
): PipedriveActivityIntent {
  const dealUrl = buildDealUrl(intent.deal_id, companyDomain)
  const rows = intent.phones
    .map(
      (p) =>
        `| \`${p.column}\` | \`${formatBrPhonePretty(p.phone)}\` | ${
          p.outcome === 'invalid'
            ? '❌ Não existe'
            : p.outcome === 'error'
              ? '⚠️ Erro de validação'
              : '✅ OK'
        } |`,
    )
    .join('\n')
  const noteLines: string[] = []
  if (dealUrl) {
    noteLines.push(`**Deal**: [#${intent.deal_id}](${dealUrl})`, '')
  }
  noteLines.push(
    '## ATENÇÃO — Deal arquivado em `prov_consultas_snapshot`',
    '',
    `**Verificação completa — ${intent.occurred_at}**`,
    '',
    '| Coluna | Telefone | Resultado |',
    '|---|---|---|',
    rows,
    '',
    `**Motivo arquival**: \`${intent.motivo}\``,
    `**Job ID**: \`${intent.job_id}\``,
    '',
    '### Próximos passos sugeridos',
    '- Contato manual via canais alternativos (e-mail, SMS, telefone fixo)',
    '- Skip tracing externo',
    '- Verificar dados cadastrais com a contraparte',
  )
  const note = noteLines.join('\n')

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

// ── Scenario C — pasta sweep Note ───────────────────────────────────────

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
