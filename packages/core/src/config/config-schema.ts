import { z } from 'zod'

/**
 * Raw env schema — maps SCREAMING_SNAKE env vars to Zod validations.
 * DISPATCH_API_KEY is required in production/development, optional in test.
 */
const envSchema = z
  .object({
    // Core
    DISPATCH_API_KEY: z.string().default(''),
    PORT: z.coerce.number().default(7890),
    DB_PATH: z.string().default('dispatch.db'),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    LOG_FILE: z.string().optional(),
    DISPATCH_ALLOWED_ORIGINS: z.string().optional(),

    // WAHA
    WAHA_API_URL: z.string().url().optional(),
    WAHA_API_KEY: z.string().optional(),
    WAHA_WEBHOOK_HMAC_SECRET: z.string().optional(),
    DISPATCH_WEBHOOK_URL: z.string().url().optional(),

    // Chatwoot
    CHATWOOT_API_URL: z.string().url().optional(),
    CHATWOOT_API_TOKEN: z.string().optional(),
    CHATWOOT_ACCOUNT_ID: z.coerce.number().default(1),

    // Rate Limiting
    MAX_PER_SENDER_PER_DAY: z.coerce.number().default(150),
    FIRST_CONTACT_DELAY_MS: z.coerce.number().default(45_000),
    RECURRING_CONTACT_DELAY_MS: z.coerce.number().default(15_000),
    RATE_LIMIT_JITTER: z.coerce.number().default(0.3),

    // Strategy Weights
    SEND_STRATEGY_PREFILL_WEIGHT: z.coerce.number().default(50),
    SEND_STRATEGY_SEARCH_WEIGHT: z.coerce.number().default(30),
    SEND_STRATEGY_TYPING_WEIGHT: z.coerce.number().default(20),

    // Quarantine
    QUARANTINE_AFTER_FAILURES: z.coerce.number().default(3),
    QUARANTINE_DURATION_MS: z.coerce.number().default(3_600_000),

    // Send Window (Phase 3 — future)
    SEND_WINDOW_START: z.coerce.number().default(7),
    SEND_WINDOW_END: z.coerce.number().default(21),
    SEND_WINDOW_DAYS: z.string().default('1,2,3,4,5'),
    SEND_WINDOW_OFFSET_HOURS: z.coerce.number().default(-3),

    // Screenshots (Phase 5 — future)
    SCREENSHOT_MODE: z.enum(['all', 'sample', 'none']).default('all'),
    SCREENSHOT_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.1),
    SCREENSHOT_FORMAT: z.enum(['png', 'jpeg']).default('png'),
    SCREENSHOT_JPEG_QUALITY: z.coerce.number().min(1).max(100).default(60),
    SCREENSHOT_RETENTION_DAYS: z.coerce.number().default(7),

    // Plugins
    DISPATCH_PLUGINS: z.string().default(''),
    PLUGIN_ORALSIN_WEBHOOK_URL: z.string().optional(),

    // Retention
    MESSAGE_HISTORY_RETENTION_DAYS: z.coerce.number().default(90),
  })
  .superRefine((data, ctx) => {
    // DISPATCH_API_KEY is required in non-test environments
    if (data.NODE_ENV !== 'test' && (!data.DISPATCH_API_KEY || data.DISPATCH_API_KEY.trim() === '')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'DISPATCH_API_KEY is required in production and development environments',
        path: ['DISPATCH_API_KEY'],
      })
    }
  })

export interface DispatchConfig {
  port: number
  dbPath: string
  nodeEnv: 'development' | 'production' | 'test'
  logFile?: string
  dispatchApiKey: string
  dispatchAllowedOrigins?: string
  waha: {
    apiUrl?: string
    apiKey?: string
    hmacSecret?: string
    webhookUrl?: string
  }
  chatwoot: {
    apiUrl?: string
    apiToken?: string
    accountId: number
  }
  rateLimit: {
    maxPerSenderPerDay: number
    firstContactDelayMs: number
    recurringContactDelayMs: number
    jitterRange: number
  }
  strategy: {
    prefillWeight: number
    searchWeight: number
    typingWeight: number
  }
  quarantine: {
    afterFailures: number
    durationMs: number
  }
  sendWindow: {
    start: number
    end: number
    days: string
    offsetHours: number
  }
  screenshot: {
    mode: 'all' | 'sample' | 'none'
    sampleRate: number
    format: 'png' | 'jpeg'
    jpegQuality: number
    retentionDays: number
  }
  plugins: string[]
  pluginOralsinWebhookUrl?: string
  messageHistoryRetentionDays: number
}

/**
 * Parse and validate environment variables into a typed DispatchConfig.
 * Throws ZodError on invalid config — server should crash fast.
 */
export function parseConfig(env: Record<string, string | undefined>): DispatchConfig {
  const parsed = envSchema.parse(env)

  return {
    port: parsed.PORT,
    dbPath: parsed.DB_PATH,
    nodeEnv: parsed.NODE_ENV,
    logFile: parsed.LOG_FILE,
    dispatchApiKey: parsed.DISPATCH_API_KEY,
    dispatchAllowedOrigins: parsed.DISPATCH_ALLOWED_ORIGINS,
    waha: {
      apiUrl: parsed.WAHA_API_URL,
      apiKey: parsed.WAHA_API_KEY,
      hmacSecret: parsed.WAHA_WEBHOOK_HMAC_SECRET,
      webhookUrl: parsed.DISPATCH_WEBHOOK_URL,
    },
    chatwoot: {
      apiUrl: parsed.CHATWOOT_API_URL,
      apiToken: parsed.CHATWOOT_API_TOKEN,
      accountId: parsed.CHATWOOT_ACCOUNT_ID,
    },
    rateLimit: {
      maxPerSenderPerDay: parsed.MAX_PER_SENDER_PER_DAY,
      firstContactDelayMs: parsed.FIRST_CONTACT_DELAY_MS,
      recurringContactDelayMs: parsed.RECURRING_CONTACT_DELAY_MS,
      jitterRange: parsed.RATE_LIMIT_JITTER,
    },
    strategy: {
      prefillWeight: parsed.SEND_STRATEGY_PREFILL_WEIGHT,
      searchWeight: parsed.SEND_STRATEGY_SEARCH_WEIGHT,
      typingWeight: parsed.SEND_STRATEGY_TYPING_WEIGHT,
    },
    quarantine: {
      afterFailures: parsed.QUARANTINE_AFTER_FAILURES,
      durationMs: parsed.QUARANTINE_DURATION_MS,
    },
    sendWindow: {
      start: parsed.SEND_WINDOW_START,
      end: parsed.SEND_WINDOW_END,
      days: parsed.SEND_WINDOW_DAYS,
      offsetHours: parsed.SEND_WINDOW_OFFSET_HOURS,
    },
    screenshot: {
      mode: parsed.SCREENSHOT_MODE,
      sampleRate: parsed.SCREENSHOT_SAMPLE_RATE,
      format: parsed.SCREENSHOT_FORMAT,
      jpegQuality: parsed.SCREENSHOT_JPEG_QUALITY,
      retentionDays: parsed.SCREENSHOT_RETENTION_DAYS,
    },
    plugins: parsed.DISPATCH_PLUGINS
      ? parsed.DISPATCH_PLUGINS.split(',').map((s) => s.trim()).filter(Boolean)
      : [],
    pluginOralsinWebhookUrl: parsed.PLUGIN_ORALSIN_WEBHOOK_URL,
    messageHistoryRetentionDays: parsed.MESSAGE_HISTORY_RETENTION_DAYS,
  }
}
