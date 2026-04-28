/**
 * Task 10.3 — Structured critical alert notifier.
 *
 * Sends rich, formatted alerts to Slack and/or Telegram.
 * Both channels are no-ops when their env vars are unset — never throws,
 * never crashes. Failure to deliver is logged at warn level only.
 *
 * Env vars (all optional):
 *   DISPATCH_ALERT_SLACK_WEBHOOK          — Slack Incoming Webhook URL
 *   DISPATCH_ALERT_TELEGRAM_BOT_TOKEN     — Telegram bot token
 *   DISPATCH_ALERT_TELEGRAM_CHAT_ID       — Target chat/channel ID (e.g. -1003942208119)
 *   DISPATCH_ALERT_TELEGRAM_THREAD_ID     — Optional supergroup topic id (e.g. 396)
 */

export type AlertSeverity = 'critical' | 'warning' | 'info' | 'success'

export interface StructuredAlert {
  /** Short event title (e.g. "Circuit breaker opened"). */
  title: string
  /** Severity controls header emoji and color. */
  severity: AlertSeverity
  /** Optional human-readable summary line. */
  summary?: string
  /** Optional structured key/value fields rendered as a table. */
  fields?: Record<string, string | number | boolean | null | undefined>
  /** Optional pre-formatted code block (e.g. stack trace, JSON). */
  code?: { lang?: string; content: string }
  /** Optional URL rendered as a clickable footer link. */
  link?: { label: string; url: string }
  /** Optional source/component for the footer (e.g. "dispatch-core"). */
  source?: string
}

const SEVERITY_EMOJI: Record<AlertSeverity, string> = {
  critical: '🚨',
  warning:  '⚠️',
  info:     'ℹ️',
  success:  '✅',
}

const SEVERITY_SLACK_COLOR: Record<AlertSeverity, string> = {
  critical: '#dc2626', // red-600
  warning:  '#f59e0b', // amber-500
  info:     '#3b82f6', // blue-500
  success:  '#10b981', // emerald-500
}

// ── Telegram ───────────────────────────────────────────────────────────────

/** Escape characters reserved by Telegram MarkdownV2. */
function mdv2Escape(s: string): string {
  return s.replace(/[_*[\]()~`>#+\-=|{}.!]/g, (m) => '\\' + m)
}

function renderTelegramMarkdownV2(alert: StructuredAlert): string {
  const lines: string[] = []
  const emoji = SEVERITY_EMOJI[alert.severity]
  const sev = alert.severity.toUpperCase()
  lines.push(`${emoji} *${mdv2Escape(alert.title)}*  \`${mdv2Escape(sev)}\``)
  if (alert.summary) {
    lines.push('')
    lines.push(mdv2Escape(alert.summary))
  }
  if (alert.fields && Object.keys(alert.fields).length > 0) {
    lines.push('')
    for (const [k, v] of Object.entries(alert.fields)) {
      if (v === undefined || v === null) continue
      lines.push(`• *${mdv2Escape(k)}*: \`${mdv2Escape(String(v))}\``)
    }
  }
  if (alert.code) {
    const lang = alert.code.lang ? mdv2Escape(alert.code.lang) : ''
    lines.push('')
    lines.push('```' + lang)
    // Inside fenced blocks Telegram only requires \ and ` to be escaped
    lines.push(alert.code.content.replace(/[`\\]/g, (m) => '\\' + m))
    lines.push('```')
  }
  const footer: string[] = []
  if (alert.source) footer.push(`_${mdv2Escape(alert.source)}_`)
  footer.push(`_${mdv2Escape(new Date().toISOString())}_`)
  if (alert.link) footer.push(`[${mdv2Escape(alert.link.label)}](${alert.link.url})`)
  lines.push('')
  lines.push(footer.join(' · '))
  return lines.join('\n')
}

export async function sendTelegramAlert(alert: StructuredAlert | string): Promise<void> {
  const botToken = process.env.DISPATCH_ALERT_TELEGRAM_BOT_TOKEN
  const chatId   = process.env.DISPATCH_ALERT_TELEGRAM_CHAT_ID
  const threadId = process.env.DISPATCH_ALERT_TELEGRAM_THREAD_ID
  if (!botToken || !chatId) return

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`
  const payload: Record<string, unknown> = { chat_id: chatId }
  if (threadId) payload.message_thread_id = parseInt(threadId, 10)

  if (typeof alert === 'string') {
    payload.text = alert
    payload.parse_mode = 'HTML'
  } else {
    payload.text = renderTelegramMarkdownV2(alert)
    payload.parse_mode = 'MarkdownV2'
    if (alert.link) payload.disable_web_page_preview = true
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      console.warn(`[notifier] Telegram HTTP ${res.status}: ${await res.text().catch(() => '')}`)
    }
  } catch (err) {
    console.warn('[notifier] Telegram failed:', err instanceof Error ? err.message : String(err))
  }
}

// ── Slack ──────────────────────────────────────────────────────────────────

function renderSlackPayload(alert: StructuredAlert): Record<string, unknown> {
  const fieldList = alert.fields
    ? Object.entries(alert.fields)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => ({ title: k, value: String(v), short: true }))
    : []
  const codeBlock = alert.code
    ? '```' + (alert.code.lang ?? '') + '\n' + alert.code.content + '\n```'
    : null
  const footerParts: string[] = []
  if (alert.source) footerParts.push(alert.source)
  footerParts.push(new Date().toISOString())
  return {
    attachments: [{
      color:       SEVERITY_SLACK_COLOR[alert.severity],
      title:       `${SEVERITY_EMOJI[alert.severity]}  ${alert.title}`,
      title_link:  alert.link?.url,
      text:        [alert.summary, codeBlock].filter(Boolean).join('\n\n') || undefined,
      fields:      fieldList,
      footer:      footerParts.join(' · '),
      ts:          Math.floor(Date.now() / 1000),
    }],
  }
}

export async function sendSlackAlert(alert: StructuredAlert | string): Promise<void> {
  const webhookUrl = process.env.DISPATCH_ALERT_SLACK_WEBHOOK
  if (!webhookUrl) return
  const body = typeof alert === 'string' ? { text: alert } : renderSlackPayload(alert)
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      console.warn(`[notifier] Slack HTTP ${res.status}: ${await res.text().catch(() => '')}`)
    }
  } catch (err) {
    console.warn('[notifier] Slack failed:', err instanceof Error ? err.message : String(err))
  }
}

// ── Convenience ────────────────────────────────────────────────────────────

/** Fire both channels concurrently. Accepts a string (legacy) or structured alert. */
export async function sendCriticalAlert(alert: StructuredAlert | string): Promise<void> {
  await Promise.all([sendSlackAlert(alert), sendTelegramAlert(alert)])
}

// ── Pre-built alert factories for common Dispatch events ───────────────────

export function alertCircuitOpened(serial: string, reason: string, consecutiveFailures: number, nextAttemptAt: string): StructuredAlert {
  return {
    title: 'Circuit breaker aberto',
    severity: 'critical',
    summary: `Device parou de receber sends por causa de falhas consecutivas. Próxima tentativa será em ${nextAttemptAt}.`,
    fields: {
      'Device serial': serial,
      'Falhas consecutivas': consecutiveFailures,
      'Motivo': reason,
      'Próximo probe': nextAttemptAt,
    },
    source: 'dispatch-core / circuit-breaker',
  }
}

export function alertNumberInvalid(phone: string, source: string, confidence: number | null): StructuredAlert {
  return {
    title: 'Número inválido detectado',
    severity: 'warning',
    summary: 'Recipient confirmado como não-WhatsApp via probe. Adicionado ao blacklist.',
    fields: {
      'Telefone': phone,
      'Fonte': source,
      'Confiança': confidence ?? 'n/a',
    },
    source: 'dispatch-core / ban-detector',
  }
}

export function alertHighFailureRate(failedLastHour: number, threshold: number, totalLastHour: number): StructuredAlert {
  const rate = totalLastHour > 0 ? ((failedLastHour / totalLastHour) * 100).toFixed(1) : '0'
  return {
    title: 'Taxa de falha alta',
    severity: 'warning',
    summary: `${failedLastHour} mensagens falharam na última hora (limite: ${threshold}). Taxa: ${rate}% de ${totalLastHour} envios totais.`,
    fields: {
      'Falhas/hora': failedLastHour,
      'Limite': threshold,
      'Taxa': `${rate}%`,
      'Total enviados': totalLastHour,
    },
    source: 'dispatch-core / queue-monitor',
  }
}

export function alertBanPredictionTriggered(serial: string, suspectCount: number, windowMs: number): StructuredAlert {
  return {
    title: 'Ban prediction acionado',
    severity: 'critical',
    summary: 'Frida hooks detectaram padrão de pré-ban. Circuit breaker aberto preventivamente.',
    fields: {
      'Device serial': serial,
      'Sinais suspeitos': suspectCount,
      'Janela (ms)': windowMs,
    },
    source: 'dispatch-core / ban-prediction',
  }
}

export function alertDispatchPaused(scope: string, key: string, reason: string, by: string): StructuredAlert {
  return {
    title: '🛑 Dispatch pausado',
    severity: 'critical',
    summary: `Pause manual ativado em ${scope}=${key}. Mensagens nesse escopo NÃO sairão até resume.`,
    fields: {
      'Escopo': scope,
      'Chave': key,
      'Motivo': reason,
      'Por': by,
    },
    source: 'dispatch-core / pause-state',
  }
}

export function alertDispatchResumed(scope: string, key: string, by: string): StructuredAlert {
  return {
    title: '▶️ Dispatch retomado',
    severity: 'success',
    summary: `Pause em ${scope}=${key} foi removido. Mensagens voltam a fluir.`,
    fields: {
      'Escopo': scope,
      'Chave': key,
      'Por': by,
    },
    source: 'dispatch-core / pause-state',
  }
}

export function alertConfigReloaded(components: number, failed: number): StructuredAlert {
  return {
    title: 'Configuração recarregada',
    severity: failed > 0 ? 'warning' : 'success',
    summary: failed > 0
      ? `Reload parcial: ${components} ok, ${failed} falharam.`
      : `Reload completo: ${components} componentes atualizados.`,
    fields: {
      'OK': components,
      'Falhas': failed,
    },
    source: 'dispatch-core / hot-reload',
  }
}
