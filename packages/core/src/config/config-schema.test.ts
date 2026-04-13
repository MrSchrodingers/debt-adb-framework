import { describe, it, expect } from 'vitest'
import { parseConfig } from './config-schema.js'

describe('parseConfig', () => {
  const minimalEnv = { DISPATCH_API_KEY: 'test-key-123' }

  it('parses minimal valid config (only DISPATCH_API_KEY) with all defaults', () => {
    const config = parseConfig(minimalEnv)

    expect(config.dispatchApiKey).toBe('test-key-123')
    expect(config.port).toBe(7890)
    expect(config.dbPath).toBe('dispatch.db')
    expect(config.nodeEnv).toBe('development')
    expect(config.logFile).toBeUndefined()
    expect(config.dispatchAllowedOrigins).toBeUndefined()

    // WAHA defaults
    expect(config.waha.apiUrl).toBeUndefined()
    expect(config.waha.apiKey).toBeUndefined()
    expect(config.waha.hmacSecret).toBeUndefined()
    expect(config.waha.webhookUrl).toBeUndefined()

    // Chatwoot defaults
    expect(config.chatwoot.apiUrl).toBeUndefined()
    expect(config.chatwoot.apiToken).toBeUndefined()
    expect(config.chatwoot.accountId).toBe(1)

    // Rate limit defaults
    expect(config.rateLimit.maxPerSenderPerDay).toBe(150)
    expect(config.rateLimit.firstContactDelayMs).toBe(45000)
    expect(config.rateLimit.recurringContactDelayMs).toBe(15000)
    expect(config.rateLimit.jitterRange).toBe(0.3)

    // Strategy defaults
    expect(config.strategy.prefillWeight).toBe(50)
    expect(config.strategy.searchWeight).toBe(30)
    expect(config.strategy.typingWeight).toBe(20)

    // Quarantine defaults
    expect(config.quarantine.afterFailures).toBe(3)
    expect(config.quarantine.durationMs).toBe(3600000)

    // Send window defaults
    expect(config.sendWindow.start).toBe(7)
    expect(config.sendWindow.end).toBe(21)
    expect(config.sendWindow.days).toBe('1,2,3,4,5')
    expect(config.sendWindow.offsetHours).toBe(-3)

    // Screenshot defaults
    expect(config.screenshot.mode).toBe('all')
    expect(config.screenshot.sampleRate).toBe(0.1)
    expect(config.screenshot.format).toBe('png')
    expect(config.screenshot.retentionDays).toBe(7)

    // Plugin defaults
    expect(config.plugins).toEqual([])
    expect(config.pluginOralsinWebhookUrl).toBeUndefined()

    // Retention defaults
    expect(config.messageHistoryRetentionDays).toBe(90)
  })

  it('throws if DISPATCH_API_KEY missing (non-test env)', () => {
    expect(() => parseConfig({ NODE_ENV: 'production' })).toThrow()
  })

  it('throws if DISPATCH_API_KEY is empty string (non-test env)', () => {
    expect(() => parseConfig({ DISPATCH_API_KEY: '', NODE_ENV: 'production' })).toThrow()
  })

  it('allows missing DISPATCH_API_KEY in test environment', () => {
    const config = parseConfig({ NODE_ENV: 'test' })
    expect(config.dispatchApiKey).toBe('')
    expect(config.nodeEnv).toBe('test')
  })

  it('coerces PORT string to number', () => {
    const config = parseConfig({ ...minimalEnv, PORT: '3000' })
    expect(config.port).toBe(3000)
  })

  it('validates WAHA_API_URL as URL when provided', () => {
    const config = parseConfig({
      ...minimalEnv,
      WAHA_API_URL: 'https://waha.example.com',
    })
    expect(config.waha.apiUrl).toBe('https://waha.example.com')
  })

  it('rejects invalid WAHA_API_URL', () => {
    expect(() =>
      parseConfig({ ...minimalEnv, WAHA_API_URL: 'not-a-url' }),
    ).toThrow()
  })

  it('parses send window config with custom values', () => {
    const config = parseConfig({
      ...minimalEnv,
      SEND_WINDOW_START: '8',
      SEND_WINDOW_END: '20',
      SEND_WINDOW_DAYS: '1,2,3,4,5,6',
      SEND_WINDOW_OFFSET_HOURS: '-5',
    })
    expect(config.sendWindow.start).toBe(8)
    expect(config.sendWindow.end).toBe(20)
    expect(config.sendWindow.days).toBe('1,2,3,4,5,6')
    expect(config.sendWindow.offsetHours).toBe(-5)
  })

  it('parses screenshot config with custom values', () => {
    const config = parseConfig({
      ...minimalEnv,
      SCREENSHOT_MODE: 'sample',
      SCREENSHOT_SAMPLE_RATE: '0.5',
      SCREENSHOT_FORMAT: 'jpeg',
      SCREENSHOT_RETENTION_DAYS: '30',
    })
    expect(config.screenshot.mode).toBe('sample')
    expect(config.screenshot.sampleRate).toBe(0.5)
    expect(config.screenshot.format).toBe('jpeg')
    expect(config.screenshot.retentionDays).toBe(30)
  })

  it('rejects invalid SCREENSHOT_MODE enum', () => {
    expect(() =>
      parseConfig({ ...minimalEnv, SCREENSHOT_MODE: 'invalid' }),
    ).toThrow()
  })

  it('rejects SCREENSHOT_SAMPLE_RATE above 1', () => {
    expect(() =>
      parseConfig({ ...minimalEnv, SCREENSHOT_SAMPLE_RATE: '1.5' }),
    ).toThrow()
  })

  it('splits DISPATCH_PLUGINS into array', () => {
    const config = parseConfig({
      ...minimalEnv,
      DISPATCH_PLUGINS: 'oralsin, custom-plugin',
      PLUGIN_ORALSIN_API_KEY: 'test-key',
      PLUGIN_ORALSIN_HMAC_SECRET: 'test-secret',
      PLUGIN_ORALSIN_WEBHOOK_URL: 'https://test.debt.com.br/webhook',
      DISPATCH_WEBHOOK_ALLOWED_DOMAINS: 'debt.com.br',
    })
    expect(config.plugins).toEqual(['oralsin', 'custom-plugin'])
  })

  it('returns empty plugins array for empty DISPATCH_PLUGINS', () => {
    const config = parseConfig({ ...minimalEnv, DISPATCH_PLUGINS: '' })
    expect(config.plugins).toEqual([])
  })
})
