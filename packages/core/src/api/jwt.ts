import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Minimal HS256 JWT sign/verify. Avoids pulling jsonwebtoken just to support
 * a single-user .env-credential login flow.
 *
 * Token format: base64url(header).base64url(payload).base64url(hmac)
 */

interface JwtPayload {
  sub: string
  iat: number
  exp: number
  [k: string]: unknown
}

const HEADER = base64UrlEncode(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}

function base64UrlDecode(str: string): Buffer {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4))
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64')
}

export function signJwt(payload: Omit<JwtPayload, 'iat' | 'exp'>, secret: string, ttlSeconds = 8 * 60 * 60): string {
  const now = Math.floor(Date.now() / 1000)
  const full = { ...payload, iat: now, exp: now + ttlSeconds } as JwtPayload
  const body = base64UrlEncode(Buffer.from(JSON.stringify(full)))
  const signingInput = `${HEADER}.${body}`
  const sig = base64UrlEncode(createHmac('sha256', secret).update(signingInput).digest())
  return `${signingInput}.${sig}`
}

export type VerifyResult =
  | { ok: true; payload: JwtPayload }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' }

export function verifyJwt(token: string, secret: string): VerifyResult {
  const parts = token.split('.')
  if (parts.length !== 3) return { ok: false, reason: 'malformed' }
  const [h, b, s] = parts

  const expectedSig = base64UrlEncode(createHmac('sha256', secret).update(`${h}.${b}`).digest())
  const got = Buffer.from(s)
  const want = Buffer.from(expectedSig)
  if (got.length !== want.length || !timingSafeEqual(got, want)) {
    return { ok: false, reason: 'bad_signature' }
  }

  let payload: JwtPayload
  try {
    payload = JSON.parse(base64UrlDecode(b).toString('utf8')) as JwtPayload
  } catch {
    return { ok: false, reason: 'malformed' }
  }

  const now = Math.floor(Date.now() / 1000)
  if (typeof payload.exp !== 'number' || payload.exp < now) {
    return { ok: false, reason: 'expired' }
  }
  return { ok: true, payload }
}
