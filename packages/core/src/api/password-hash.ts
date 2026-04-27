import { compare, hash } from 'bcryptjs'
import { timingSafeEqual } from 'node:crypto'

/**
 * bcrypt cost factor. 12 rounds ≈ 250–400 ms on a modern x86_64. Matches the
 * default used by most Node frameworks and is the floor recommended by OWASP
 * 2024.
 */
const BCRYPT_ROUNDS = 12

/**
 * Detect bcrypt-format strings by their algorithm prefix:
 *   - `$2a$` — original spec (BSD), still emitted by some implementations
 *   - `$2b$` — current OpenBSD spec, default of bcryptjs/node-bcrypt today
 *   - `$2y$` — PHP variant, byte-compatible with `$2b$`
 *
 * Anything else (including legacy `$2$`, `$1$` md5-crypt, plaintext) returns
 * false and triggers the plaintext fallback in `verifyPassword`.
 */
const BCRYPT_RE = /^\$2[aby]\$/

export function isPasswordHashed(stored: string): boolean {
  return BCRYPT_RE.test(stored)
}

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, BCRYPT_ROUNDS)
}

/**
 * Verify a plaintext password against a stored credential.
 *
 *  - If `stored` is a bcrypt hash, run `bcrypt.compare` (constant-time per the
 *    bcryptjs implementation).
 *  - Otherwise, treat `stored` as plaintext (legacy / pre-migration `.env`)
 *    and use a constant-time byte compare. On length mismatch we still run a
 *    dummy `timingSafeEqual` so that the fast-fail path takes a similar amount
 *    of time as the same-length path, avoiding an obvious timing oracle.
 */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  if (isPasswordHashed(stored)) {
    return compare(plain, stored)
  }
  if (plain.length !== stored.length) {
    // Dummy compare so the early-out path still consumes some time. Using
    // 64-byte buffers because that is a reasonable upper bound for credentials
    // and keeps the compare cost stable.
    timingSafeEqual(Buffer.from('x'.repeat(64)), Buffer.from('y'.repeat(64)))
    return false
  }
  return timingSafeEqual(Buffer.from(plain), Buffer.from(stored))
}
