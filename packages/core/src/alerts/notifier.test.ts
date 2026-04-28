import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { sendSlackAlert, sendTelegramAlert, sendCriticalAlert } from './notifier.js'

// Capture fetch calls
type FetchCall = { url: string; init: RequestInit }
let calls: FetchCall[] = []
let mockStatus = 200
let mockResponseText = 'ok'

const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
  calls.push({ url, init: init ?? {} })
  return {
    ok: mockStatus >= 200 && mockStatus < 300,
    status: mockStatus,
    text: () => Promise.resolve(mockResponseText),
  } as Response
})

beforeEach(() => {
  calls = []
  mockStatus = 200
  mockResponseText = 'ok'
  vi.stubGlobal('fetch', mockFetch)
})

afterEach(() => {
  vi.unstubAllGlobals()
  // Clean env vars
  delete process.env.DISPATCH_ALERT_SLACK_WEBHOOK
  delete process.env.DISPATCH_ALERT_TELEGRAM_BOT_TOKEN
  delete process.env.DISPATCH_ALERT_TELEGRAM_CHAT_ID
})

// ── Slack ────────────────────────────────────────────────────────────────────

describe('sendSlackAlert', () => {
  it('is a no-op when DISPATCH_ALERT_SLACK_WEBHOOK is unset', async () => {
    await sendSlackAlert('test')
    expect(calls).toHaveLength(0)
  })

  it('POSTs to the webhook URL when env var is set', async () => {
    process.env.DISPATCH_ALERT_SLACK_WEBHOOK = 'https://hooks.slack.com/test'
    await sendSlackAlert('hello slack')

    expect(calls).toHaveLength(1)
    const { url, init } = calls[0]
    expect(url).toBe('https://hooks.slack.com/test')
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body as string) as { text: string }
    expect(body.text).toBe('hello slack')
  })

  it('sends correct Content-Type header', async () => {
    process.env.DISPATCH_ALERT_SLACK_WEBHOOK = 'https://hooks.slack.com/test'
    await sendSlackAlert('header check')

    const { init } = calls[0]
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
  })

  it('does not throw on non-2xx response', async () => {
    process.env.DISPATCH_ALERT_SLACK_WEBHOOK = 'https://hooks.slack.com/test'
    mockStatus = 500
    await expect(sendSlackAlert('bad response')).resolves.toBeUndefined()
  })

  it('does not throw when fetch rejects', async () => {
    process.env.DISPATCH_ALERT_SLACK_WEBHOOK = 'https://hooks.slack.com/test'
    mockFetch.mockRejectedValueOnce(new Error('network error'))
    await expect(sendSlackAlert('network fail')).resolves.toBeUndefined()
  })
})

// ── Telegram ─────────────────────────────────────────────────────────────────

describe('sendTelegramAlert', () => {
  it('is a no-op when TELEGRAM env vars are unset', async () => {
    await sendTelegramAlert('test')
    expect(calls).toHaveLength(0)
  })

  it('is a no-op when only token is set (missing chat_id)', async () => {
    process.env.DISPATCH_ALERT_TELEGRAM_BOT_TOKEN = 'tok'
    await sendTelegramAlert('test')
    expect(calls).toHaveLength(0)
  })

  it('is a no-op when only chat_id is set (missing token)', async () => {
    process.env.DISPATCH_ALERT_TELEGRAM_CHAT_ID = '123456'
    await sendTelegramAlert('test')
    expect(calls).toHaveLength(0)
  })

  it('POSTs to Telegram sendMessage with correct payload', async () => {
    process.env.DISPATCH_ALERT_TELEGRAM_BOT_TOKEN = 'mytoken'
    process.env.DISPATCH_ALERT_TELEGRAM_CHAT_ID = '-100123456789'
    await sendTelegramAlert('hello telegram')

    expect(calls).toHaveLength(1)
    const { url, init } = calls[0]
    expect(url).toBe('https://api.telegram.org/botmytoken/sendMessage')
    expect(init.method).toBe('POST')

    const body = JSON.parse(init.body as string) as {
      chat_id: string
      text: string
      parse_mode: string
    }
    expect(body.chat_id).toBe('-100123456789')
    expect(body.text).toBe('hello telegram')
    expect(body.parse_mode).toBe('HTML')
  })

  it('does not throw on non-2xx response', async () => {
    process.env.DISPATCH_ALERT_TELEGRAM_BOT_TOKEN = 'tok'
    process.env.DISPATCH_ALERT_TELEGRAM_CHAT_ID = '1'
    mockStatus = 400
    await expect(sendTelegramAlert('bad')).resolves.toBeUndefined()
  })

  it('does not throw when fetch rejects', async () => {
    process.env.DISPATCH_ALERT_TELEGRAM_BOT_TOKEN = 'tok'
    process.env.DISPATCH_ALERT_TELEGRAM_CHAT_ID = '1'
    mockFetch.mockRejectedValueOnce(new Error('timeout'))
    await expect(sendTelegramAlert('fail')).resolves.toBeUndefined()
  })
})

// ── sendCriticalAlert ─────────────────────────────────────────────────────────

describe('sendCriticalAlert', () => {
  it('fires both Slack and Telegram concurrently when both are configured', async () => {
    process.env.DISPATCH_ALERT_SLACK_WEBHOOK = 'https://hooks.slack.com/test'
    process.env.DISPATCH_ALERT_TELEGRAM_BOT_TOKEN = 'tok'
    process.env.DISPATCH_ALERT_TELEGRAM_CHAT_ID = '1'
    await sendCriticalAlert('critical event')

    expect(calls).toHaveLength(2)
    const urls = calls.map(c => c.url)
    expect(urls).toContain('https://hooks.slack.com/test')
    expect(urls.some(u => u.includes('api.telegram.org'))).toBe(true)
  })

  it('is a no-op when neither channel is configured', async () => {
    await sendCriticalAlert('silent')
    expect(calls).toHaveLength(0)
  })
})
