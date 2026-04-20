interface LoggerTransportConfig {
  transport: {
    target: string
    options: Record<string, unknown>
  }
}

const DEFAULT_LOG_FILE = './logs/dispatch.log'
const MAX_FILE_SIZE = '50m' // 50MB
const MAX_FILES = 5

/**
 * Build pino logger config based on environment.
 * - development: pino-pretty (colorized console output)
 * - production: pino-roll (file rotation, 50MB max, 5 backups)
 */
export function buildLoggerConfig(
  nodeEnv: string | undefined,
  logFile?: string,
): LoggerTransportConfig {
  if (nodeEnv === 'production') {
    return {
      transport: {
        target: 'pino-roll',
        options: {
          file: logFile ?? DEFAULT_LOG_FILE,
          size: MAX_FILE_SIZE,
          limit: {
            count: MAX_FILES,
          },
        },
      },
    }
  }

  return {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true },
    },
  }
}
