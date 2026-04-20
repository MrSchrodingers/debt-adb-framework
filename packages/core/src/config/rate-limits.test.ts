import { describe, it, expect } from 'vitest'
import { RateLimitGuard } from './rate-limits.js'

describe('RateLimitGuard', () => {
  it('allows send when under daily cap', () => {
    const guard = new RateLimitGuard({ maxPerSenderPerDay: 150 })
    expect(guard.canSend(100)).toBe(true)
  })

  it('blocks send when at daily cap', () => {
    const guard = new RateLimitGuard({ maxPerSenderPerDay: 150 })
    expect(guard.canSend(150)).toBe(false)
  })

  it('returns reachout delay for first contact', () => {
    const guard = new RateLimitGuard({ firstContactDelayMs: 45_000 })
    expect(guard.getInterMessageDelay(true)).toBeGreaterThanOrEqual(45_000 * 0.7) // with jitter
  })

  it('returns normal delay for recurring contact', () => {
    const guard = new RateLimitGuard({ recurringContactDelayMs: 15_000 })
    const delay = guard.getInterMessageDelay(false)
    expect(delay).toBeGreaterThanOrEqual(5_000)
    expect(delay).toBeLessThanOrEqual(25_000)
  })

  it('reads from env vars', () => {
    const guard = RateLimitGuard.fromEnv({
      MAX_PER_SENDER_PER_DAY: '200',
      FIRST_CONTACT_DELAY_MS: '60000',
      RECURRING_CONTACT_DELAY_MS: '10000',
    })
    expect(guard.canSend(199)).toBe(true)
    expect(guard.canSend(200)).toBe(false)
  })
})
