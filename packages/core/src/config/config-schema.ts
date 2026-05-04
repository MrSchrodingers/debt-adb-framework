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
    PLUGIN_ORALSIN_API_KEY: z.string().optional(),
    PLUGIN_ORALSIN_HMAC_SECRET: z.string().optional(),
    PLUGIN_ADB_PRECHECK_WEBHOOK_URL: z.string().optional(),
    PLUGIN_ADB_PRECHECK_API_KEY: z.string().optional(),
    PLUGIN_ADB_PRECHECK_HMAC_SECRET: z.string().optional(),
    PLUGIN_ADB_PRECHECK_PG_URL: z.string().optional(),
    PLUGIN_ADB_PRECHECK_PG_MAX: z.coerce.number().int().min(1).max(50).default(4),
    PLUGIN_ADB_PRECHECK_BACKEND: z.enum(['sql', 'rest']).default('sql'),
    PLUGIN_ADB_PRECHECK_REST_BASE_URL: z.string().optional(),
    PLUGIN_ADB_PRECHECK_REST_API_KEY: z.string().optional(),
    PLUGIN_ADB_PRECHECK_REST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).optional(),
    PLUGIN_ADB_PRECHECK_DEVICE_SERIAL: z.string().optional(),
    PLUGIN_ADB_PRECHECK_WAHA_SESSION: z.string().optional(),

    // Security
    DISPATCH_WEBHOOK_ALLOWED_DOMAINS: z.string().optional(),
    DISPATCH_HTTP_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(10000),

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

    // S3/R12/Decision #22: Conditional required fields when plugins enabled
    const plugins = data.DISPATCH_PLUGINS?.split(',').map(s => s.trim()).filter(Boolean) ?? []
    if (plugins.includes('oralsin')) {
      if (!data.PLUGIN_ORALSIN_API_KEY) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'PLUGIN_ORALSIN_API_KEY required when oralsin plugin enabled', path: ['PLUGIN_ORALSIN_API_KEY'] })
      }
      if (!data.PLUGIN_ORALSIN_HMAC_SECRET) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'PLUGIN_ORALSIN_HMAC_SECRET required when oralsin plugin enabled', path: ['PLUGIN_ORALSIN_HMAC_SECRET'] })
      }
      if (!data.PLUGIN_ORALSIN_WEBHOOK_URL) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'PLUGIN_ORALSIN_WEBHOOK_URL required when oralsin plugin enabled', path: ['PLUGIN_ORALSIN_WEBHOOK_URL'] })
      }
    }
    if (plugins.includes('adb-precheck')) {
      if (!data.PLUGIN_ADB_PRECHECK_API_KEY) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'PLUGIN_ADB_PRECHECK_API_KEY required when adb-precheck plugin enabled', path: ['PLUGIN_ADB_PRECHECK_API_KEY'] })
      }
      if (!data.PLUGIN_ADB_PRECHECK_HMAC_SECRET) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'PLUGIN_ADB_PRECHECK_HMAC_SECRET required when adb-precheck plugin enabled', path: ['PLUGIN_ADB_PRECHECK_HMAC_SECRET'] })
      }
      // Backend-conditional: sql needs PG_URL (SSH tunnel),
      // rest needs REST_BASE_URL + REST_API_KEY (Pipeboard router).
      if (data.PLUGIN_ADB_PRECHECK_BACKEND === 'sql') {
        if (!data.PLUGIN_ADB_PRECHECK_PG_URL) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'PLUGIN_ADB_PRECHECK_PG_URL required when adb-precheck BACKEND=sql (Pipeboard postgres URL via SSH tunnel)', path: ['PLUGIN_ADB_PRECHECK_PG_URL'] })
        }
      } else {
        if (!data.PLUGIN_ADB_PRECHECK_REST_BASE_URL) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'PLUGIN_ADB_PRECHECK_REST_BASE_URL required when adb-precheck BACKEND=rest', path: ['PLUGIN_ADB_PRECHECK_REST_BASE_URL'] })
        }
        if (!data.PLUGIN_ADB_PRECHECK_REST_API_KEY) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'PLUGIN_ADB_PRECHECK_REST_API_KEY required when adb-precheck BACKEND=rest', path: ['PLUGIN_ADB_PRECHECK_REST_API_KEY'] })
        }
      }
    }
    if (plugins.length > 0 && !data.DISPATCH_WEBHOOK_ALLOWED_DOMAINS) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'DISPATCH_WEBHOOK_ALLOWED_DOMAINS required when plugins enabled', path: ['DISPATCH_WEBHOOK_ALLOWED_DOMAINS'] })
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
  pluginOralsinApiKey?: string
  pluginOralsinHmacSecret?: string
  webhookAllowedDomains?: string
  httpTimeoutMs: number
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
    pluginOralsinApiKey: parsed.PLUGIN_ORALSIN_API_KEY,
    pluginOralsinHmacSecret: parsed.PLUGIN_ORALSIN_HMAC_SECRET,
    webhookAllowedDomains: parsed.DISPATCH_WEBHOOK_ALLOWED_DOMAINS,
    httpTimeoutMs: parsed.DISPATCH_HTTP_TIMEOUT_MS,
    messageHistoryRetentionDays: parsed.MESSAGE_HISTORY_RETENTION_DAYS,
  }
}
