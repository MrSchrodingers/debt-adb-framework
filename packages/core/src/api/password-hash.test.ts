import { describe, it, expect } from 'vitest'
import { hashPassword, verifyPassword, isPasswordHashed } from './password-hash.js'

describe('isPasswordHashed', () => {
  it('returns true for $2a$ bcrypt strings', () => {
    expect(isPasswordHashed('$2a$12$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRST')).toBe(true)
  })

  it('returns true for $2b$ bcrypt strings', () => {
    expect(isPasswordHashed('$2b$12$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRST')).toBe(true)
  })

  it('returns true for $2y$ bcrypt strings', () => {
    expect(isPasswordHashed('$2y$12$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRST')).toBe(true)
  })

  it('returns false for plaintext password', () => {
    expect(isPasswordHashed('super-strong-pass')).toBe(false)
  })

  it('returns false for empty string', () => {
    expect(isPasswordHashed('')).toBe(false)
  })

  it('returns false for $2$ without algorithm letter (invalid)', () => {
    expect(isPasswordHashed('$2$12$abcdef')).toBe(false)
  })

  it('returns false for $1$ md5 crypt', () => {
    expect(isPasswordHashed('$1$salt$abcdef')).toBe(false)
  })
})

describe('hashPassword', () => {
  it('returns a string with a $2[aby]$ prefix', async () => {
    const h = await hashPassword('hello-world')
    expect(typeof h).toBe('string')
    expect(h).toMatch(/^\$2[aby]\$/)
  })

  it('returns a 60-char bcrypt string', async () => {
    const h = await hashPassword('hello-world')
    expect(h).toHaveLength(60)
  })

  it('produces different hashes for the same input (salt)', async () => {
    const a = await hashPassword('hello-world')
    const b = await hashPassword('hello-world')
    expect(a).not.toBe(b)
  })
}, 30_000)

describe('verifyPassword', () => {
  it('returns true when plain matches a freshly-generated hash', async () => {
    const h = await hashPassword('correct-horse-battery-staple')
    expect(await verifyPassword('correct-horse-battery-staple', h)).toBe(true)
  })

  it('returns false when plain does not match the hash', async () => {
    const h = await hashPassword('correct-horse-battery-staple')
    expect(await verifyPassword('wrong-pass', h)).toBe(false)
  })

  it('plaintext fallback: returns true on exact match', async () => {
    expect(await verifyPassword('plain-secret', 'plain-secret')).toBe(true)
  })

  it('plaintext fallback: returns false on mismatch (same length)', async () => {
    expect(await verifyPassword('plain-secret', 'plain-XXXXXX')).toBe(false)
  })

  it('plaintext fallback: returns false on length mismatch', async () => {
    expect(await verifyPassword('short', 'much-longer-string')).toBe(false)
  })

  it('plaintext fallback: length mismatch still returns a boolean (no throw)', async () => {
    // Even with a length mismatch, the implementation must not throw — it
    // should run a dummy timingSafeEqual to keep the response time roughly
    // similar across paths and avoid leaking which path was taken.
    await expect(verifyPassword('a', 'bb')).resolves.toBe(false)
    await expect(verifyPassword('', 'something')).resolves.toBe(false)
  })
}, 30_000)
