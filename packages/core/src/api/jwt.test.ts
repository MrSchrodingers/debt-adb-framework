import { describe, it, expect, vi, afterEach } from 'vitest'
import { signJwt, verifyJwt } from './jwt.js'

const SECRET = 'test-secret-do-not-use-in-prod'

describe('signJwt + verifyJwt', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('round-trips a payload and verifies', () => {
    const token = signJwt({ sub: 'admin' }, SECRET, 60)
    const r = verifyJwt(token, SECRET)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.payload.sub).toBe('admin')
      expect(r.payload.exp).toBeGreaterThan(r.payload.iat)
    }
  })

  it('rejects malformed token', () => {
    const r = verifyJwt('not-a-jwt', SECRET)
    expect(r).toEqual({ ok: false, reason: 'malformed' })
  })

  it('rejects bad signature (wrong secret)', () => {
    const token = signJwt({ sub: 'admin' }, SECRET, 60)
    const r = verifyJwt(token, 'different-secret')
    expect(r).toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('rejects expired token', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const token = signJwt({ sub: 'admin' }, SECRET, 60) // expires 60s later
    vi.setSystemTime(new Date('2026-01-01T00:02:00Z')) // 120s elapsed
    const r = verifyJwt(token, SECRET)
    expect(r).toEqual({ ok: false, reason: 'expired' })
  })

  it('rejects tampered payload', () => {
    const token = signJwt({ sub: 'admin' }, SECRET, 60)
    const [h, _b, s] = token.split('.')
    const tampered = `${h}.${Buffer.from('{"sub":"root","iat":1,"exp":9999999999}').toString('base64url')}.${s}`
    const r = verifyJwt(tampered, SECRET)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('bad_signature')
  })
})
