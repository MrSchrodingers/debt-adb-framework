import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

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
 *
 * Creates the parent directory of the rotation file when needed — pino-roll
 * crashes with ENOENT on first rotate if the dir is missing (see issue #N
 * we hit on the physical server cold-start).
 */
export function buildLoggerConfig(
  nodeEnv: string | undefined,
  logFile?: string,
): LoggerTransportConfig {
  if (nodeEnv === 'production') {
    const file = logFile ?? DEFAULT_LOG_FILE
    try {
      mkdirSync(dirname(file), { recursive: true })
    } catch {
      // best-effort: if we can't create the dir, pino will surface a clearer error
    }
    return {
      transport: {
        target: 'pino-roll',
        options: {
          file,
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
