import { describe, it, expect } from 'vitest'
import { SenderHealth } from './sender-health.js'

describe('SenderHealth', () => {
  it('quarantines sender after N consecutive failures', () => {
    const health = new SenderHealth({ quarantineAfterFailures: 3 })
    health.recordFailure('+5543996835100')
    health.recordFailure('+5543996835100')
    expect(health.isQuarantined('+5543996835100')).toBe(false)
    health.recordFailure('+5543996835100')
    expect(health.isQuarantined('+5543996835100')).toBe(true)
  })

  it('resets failure count on success', () => {
    const health = new SenderHealth({ quarantineAfterFailures: 3 })
    health.recordFailure('+5543996835100')
    health.recordFailure('+5543996835100')
    health.recordSuccess('+5543996835100')
    health.recordFailure('+5543996835100')
    expect(health.isQuarantined('+5543996835100')).toBe(false)
  })

  it('auto-releases quarantine after cooldown', () => {
    const health = new SenderHealth({ quarantineAfterFailures: 1, quarantineDurationMs: 100 })
    health.recordFailure('+5543996835100')
    expect(health.isQuarantined('+5543996835100')).toBe(true)
    return new Promise<void>(resolve => {
      setTimeout(() => {
        expect(health.isQuarantined('+5543996835100')).toBe(false)
        resolve()
      }, 150)
    })
  })

  it('does not quarantine below the threshold', () => {
    const health = new SenderHealth({ quarantineAfterFailures: 3 })
    health.recordFailure('+5543996835100')
    health.recordFailure('+5543996835100')
    expect(health.isQuarantined('+5543996835100')).toBe(false)
  })

  it('tracks independent senders separately', () => {
    const health = new SenderHealth({ quarantineAfterFailures: 2 })
    health.recordFailure('senderA')
    health.recordFailure('senderA')
    health.recordFailure('senderB')
    expect(health.isQuarantined('senderA')).toBe(true)
    expect(health.isQuarantined('senderB')).toBe(false)
  })

  it('uses default config when none provided', () => {
    const health = new SenderHealth()
    // Default is 3 failures before quarantine
    health.recordFailure('x')
    health.recordFailure('x')
    expect(health.isQuarantined('x')).toBe(false)
    health.recordFailure('x')
    expect(health.isQuarantined('x')).toBe(true)
  })

  it('does not quarantine unknown sender', () => {
    const health = new SenderHealth()
    expect(health.isQuarantined('never-failed')).toBe(false)
  })
})
