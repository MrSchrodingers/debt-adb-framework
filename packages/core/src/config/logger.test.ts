import { describe, it, expect } from 'vitest'
import { buildLoggerConfig } from './logger.js'

describe('buildLoggerConfig', () => {
  it('returns pino-pretty transport in development', () => {
    const config = buildLoggerConfig('development')
    expect(config.transport.target).toBe('pino-pretty')
    expect(config.transport.options.colorize).toBe(true)
  })

  it('returns pino-roll transport in production', () => {
    const config = buildLoggerConfig('production')
    expect(config.transport.target).toBe('pino-roll')
    expect(config.transport.options.file).toBeDefined()
    expect(config.transport.options.limit).toBeDefined()
  })

  it('uses 50MB max file size in production', () => {
    const config = buildLoggerConfig('production')
    expect(config.transport.options.limit.count).toBe(5)
  })

  it('uses custom log path when provided', () => {
    const config = buildLoggerConfig('production', '/tmp/dispatch.log')
    expect(config.transport.options.file).toBe('/tmp/dispatch.log')
  })

  it('defaults to development when NODE_ENV is unset', () => {
    const config = buildLoggerConfig(undefined)
    expect(config.transport.target).toBe('pino-pretty')
  })
})
