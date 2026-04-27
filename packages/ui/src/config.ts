declare global {
  interface Window {
    __DISPATCH_CORE_URL__?: string
    __DISPATCH_API_KEY__?: string
  }
}

// Resolution order:
//   1. Runtime override (set on window before app bundle loads)
//   2. Build-time override via VITE_CORE_URL
//   3. Same-origin as the current page — works for Vite dev (proxy) AND
//      production behind a reverse proxy (Caddy + Tailscale Funnel).
//   4. Last-resort fallback for unusual contexts (file://, tests)
export const CORE_URL =
  window.__DISPATCH_CORE_URL__
  ?? import.meta.env.VITE_CORE_URL
  ?? (typeof window !== 'undefined' && window.location?.origin && window.location.origin !== 'null'
        ? window.location.origin
        : 'http://localhost:7890')

export const API_KEY: string =
  window.__DISPATCH_API_KEY__
  ?? import.meta.env.VITE_API_KEY
  ?? ''

const TOKEN_STORAGE_KEY = 'dispatch.auth.token'

function readStoredToken(): string | null {
  try {
    return typeof window !== 'undefined'
      ? window.localStorage.getItem(TOKEN_STORAGE_KEY)
      : null
  } catch {
    return null
  }
}

/**
 * Returns headers object including X-API-Key when configured AND
 * Authorization: Bearer when a UI login JWT is present. Merge with any
 * additional headers for fetch calls.
 */
export function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...extra }
  if (API_KEY) {
    headers['X-API-Key'] = API_KEY
  }
  const token = readStoredToken()
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
  return headers
}

/**
 * Append the auth credential to a URL as `?key=` so it can be used in
 * contexts where request headers cannot be set (e.g. <img src>). Prefers
 * the UI JWT over the static API key.
 */
export function withAuthQuery(url: string): string {
  const key = readStoredToken() ?? (API_KEY || null)
  if (!key) return url
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}key=${encodeURIComponent(key)}`
}
