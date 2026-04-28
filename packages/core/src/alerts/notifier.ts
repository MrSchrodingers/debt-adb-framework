/**
 * Task 10.3 — Critical alert notifier.
 *
 * Sends alerts to Slack (webhook) and/or Telegram (bot API).
 * Both functions are no-ops when their respective env vars are unset —
 * no throws, no crashes. Failure to deliver an alert is logged but never
 * propagates to the caller.
 *
 * Env vars (all optional):
 *   DISPATCH_ALERT_SLACK_WEBHOOK          – Slack Incoming Webhook URL
 *   DISPATCH_ALERT_TELEGRAM_BOT_TOKEN     – Telegram bot token
 *   DISPATCH_ALERT_TELEGRAM_CHAT_ID       – Target chat/channel ID
 */

export async function sendSlackAlert(text: string): Promise<void> {
  const webhookUrl = process.env.DISPATCH_ALERT_SLACK_WEBHOOK
  if (!webhookUrl) return

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    if (!res.ok) {
      console.warn(`[notifier] Slack alert HTTP ${res.status}: ${await res.text().catch(() => '')}`)
    }
  } catch (err) {
    console.warn('[notifier] Slack alert failed:', err instanceof Error ? err.message : String(err))
  }
}

export async function sendTelegramAlert(text: string): Promise<void> {
  const botToken = process.env.DISPATCH_ALERT_TELEGRAM_BOT_TOKEN
  const chatId   = process.env.DISPATCH_ALERT_TELEGRAM_CHAT_ID
  if (!botToken || !chatId) return

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
      }),
    })
    if (!res.ok) {
      console.warn(`[notifier] Telegram alert HTTP ${res.status}: ${await res.text().catch(() => '')}`)
    }
  } catch (err) {
    console.warn('[notifier] Telegram alert failed:', err instanceof Error ? err.message : String(err))
  }
}

/** Convenience: fire both channels concurrently. */
export async function sendCriticalAlert(text: string): Promise<void> {
  await Promise.all([sendSlackAlert(text), sendTelegramAlert(text)])
}
