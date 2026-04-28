import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  sendSlackAlert,
  sendTelegramAlert,
  sendCriticalAlert,
  alertCircuitOpened,
  alertNumberInvalid,
  alertHighFailureRate,
  alertBanPredictionTriggered,
  alertConfigReloaded,
} from './notifier.js'

const ENV_KEYS = [
  'DISPATCH_ALERT_SLACK_WEBHOOK',
  'DISPATCH_ALERT_TELEGRAM_BOT_TOKEN',
  'DISPATCH_ALERT_TELEGRAM_CHAT_ID',
  'DISPATCH_ALERT_TELEGRAM_THREAD_ID',
] as const

describe('alerts/notifier', () => {
  let originalFetch: typeof fetch
  let savedEnv: Record<string, string | undefined>

  beforeEach(() => {
    originalFetch = global.fetch
    savedEnv = {}
    for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k] }
  })

  afterEach(() => {
    global.fetch = originalFetch
    for (const k of ENV_KEYS) {
      if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k]; else delete process.env[k]
    }
    vi.restoreAllMocks()
  })

  describe('sendSlackAlert', () => {
    it('is a no-op when DISPATCH_ALERT_SLACK_WEBHOOK is unset', async () => {
      const fetchSpy = vi.fn()
      global.fetch = fetchSpy as unknown as typeof fetch
      await sendSlackAlert('hello')
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('POSTs structured payload to the webhook URL', async () => {
      process.env.DISPATCH_ALERT_SLACK_WEBHOOK = 'https://hooks.slack.test/abc'
      const fetchSpy = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
      global.fetch = fetchSpy as unknown as typeof fetch

      await sendSlackAlert(alertCircuitOpened('serial-X', 'too many failures', 5, '2026-04-28T13:00:00Z'))

      expect(fetchSpy).toHaveBeenCalledTimes(1)
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
      expect(url).toBe('https://hooks.slack.test/abc')
      expect(init.method).toBe('POST')
      const body = JSON.parse(init.body as string) as { attachments: Array<{ color: string; title: string; fields: Array<{ title: string }> }> }
      expect(body.attachments[0].color).toBe('#dc2626')
      expect(body.attachments[0].title).toContain('Circuit breaker aberto')
      expect(body.attachments[0].fields.map(f => f.title)).toEqual(
        expect.arrayContaining(['Device serial', 'Falhas consecutivas', 'Motivo', 'Próximo probe']),
      )
    })

    it('passes legacy string payload as plain text', async () => {
      process.env.DISPATCH_ALERT_SLACK_WEBHOOK = 'https://hooks.slack.test/abc'
      const fetchSpy = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
      global.fetch = fetchSpy as unknown as typeof fetch
      await sendSlackAlert('plain string')
      const init = fetchSpy.mock.calls[0][1] as RequestInit
      expect(JSON.parse(init.body as string)).toEqual({ text: 'plain string' })
    })

    it('does not throw when fetch rejects', async () => {
      process.env.DISPATCH_ALERT_SLACK_WEBHOOK = 'https://hooks.slack.test/abc'
      global.fetch = vi.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      await expect(sendSlackAlert('x')).resolves.toBeUndefined()
    })
  })

  describe('sendTelegramAlert', () => {
    it('is a no-op when token/chat are unset', async () => {
      const fetchSpy = vi.fn()
      global.fetch = fetchSpy as unknown as typeof fetch
      await sendTelegramAlert('hello')
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('POSTs MarkdownV2 with escaped reserved characters', async () => {
      process.env.DISPATCH_ALERT_TELEGRAM_BOT_TOKEN = 'BOT'
      process.env.DISPATCH_ALERT_TELEGRAM_CHAT_ID = '-100123'
      const fetchSpy = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
      global.fetch = fetchSpy as unknown as typeof fetch

      await sendTelegramAlert(alertNumberInvalid('5543991938235', 'send_failure', 0.92))

      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
      expect(url).toBe('https://api.telegram.org/botBOT/sendMessage')
      const body = JSON.parse(init.body as string) as { chat_id: string; text: string; parse_mode: string }
      expect(body.chat_id).toBe('-100123')
      expect(body.parse_mode).toBe('MarkdownV2')
      expect(body.text).toContain('Número inválido detectado')
      expect(body.text).toContain('5543991938235')
      // Reserved char . is escaped per MarkdownV2 (e.g. inside the ISO timestamp)
      expect(body.text).toMatch(/\\\./)
    })

    it('includes message_thread_id when DISPATCH_ALERT_TELEGRAM_THREAD_ID is set', async () => {
      process.env.DISPATCH_ALERT_TELEGRAM_BOT_TOKEN = 'BOT'
      process.env.DISPATCH_ALERT_TELEGRAM_CHAT_ID = '-100123'
      process.env.DISPATCH_ALERT_TELEGRAM_THREAD_ID = '396'
      const fetchSpy = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
      global.fetch = fetchSpy as unknown as typeof fetch

      await sendTelegramAlert({ title: 'x', severity: 'info' })

      const init = fetchSpy.mock.calls[0][1] as RequestInit
      const body = JSON.parse(init.body as string) as { message_thread_id: number }
      expect(body.message_thread_id).toBe(396)
    })

    it('legacy string payload is sent as HTML', async () => {
      process.env.DISPATCH_ALERT_TELEGRAM_BOT_TOKEN = 'BOT'
      process.env.DISPATCH_ALERT_TELEGRAM_CHAT_ID = '-100123'
      const fetchSpy = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
      global.fetch = fetchSpy as unknown as typeof fetch
      await sendTelegramAlert('hello world')
      const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string) as {
        text: string; parse_mode: string
      }
      expect(body.parse_mode).toBe('HTML')
      expect(body.text).toBe('hello world')
    })

    it('does not throw on HTTP error', async () => {
      process.env.DISPATCH_ALERT_TELEGRAM_BOT_TOKEN = 'BOT'
      process.env.DISPATCH_ALERT_TELEGRAM_CHAT_ID = '-100123'
      global.fetch = vi.fn().mockResolvedValue(new Response('bad', { status: 500 })) as unknown as typeof fetch
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      await expect(sendTelegramAlert('x')).resolves.toBeUndefined()
    })
  })

  describe('sendCriticalAlert', () => {
    it('fires both channels concurrently when both configured', async () => {
      process.env.DISPATCH_ALERT_SLACK_WEBHOOK = 'https://hooks.slack.test/abc'
      process.env.DISPATCH_ALERT_TELEGRAM_BOT_TOKEN = 'BOT'
      process.env.DISPATCH_ALERT_TELEGRAM_CHAT_ID = '-100123'
      const fetchSpy = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
      global.fetch = fetchSpy as unknown as typeof fetch
      await sendCriticalAlert({ title: 'test', severity: 'critical', summary: 'x' })
      expect(fetchSpy).toHaveBeenCalledTimes(2)
    })
  })

  describe('alert factories', () => {
    it('alertCircuitOpened produces critical severity with serial+reason fields', () => {
      const a = alertCircuitOpened('s1', 'why', 7, 'iso')
      expect(a.severity).toBe('critical')
      expect(a.fields).toMatchObject({ 'Device serial': 's1', 'Motivo': 'why', 'Falhas consecutivas': 7 })
    })

    it('alertHighFailureRate computes percentage correctly', () => {
      const a = alertHighFailureRate(50, 100, 200)
      expect(a.fields?.['Taxa']).toBe('25.0%')
    })

    it('alertBanPredictionTriggered reports suspect count and window', () => {
      const a = alertBanPredictionTriggered('s1', 5, 60000)
      expect(a.severity).toBe('critical')
      expect(a.fields).toMatchObject({ 'Sinais suspeitos': 5, 'Janela (ms)': 60000 })
    })

    it('alertConfigReloaded uses success severity when no failures', () => {
      const ok = alertConfigReloaded(4, 0)
      expect(ok.severity).toBe('success')
      const partial = alertConfigReloaded(2, 1)
      expect(partial.severity).toBe('warning')
    })
  })
})
