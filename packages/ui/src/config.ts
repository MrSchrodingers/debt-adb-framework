declare global {
  interface Window {
    __DISPATCH_CORE_URL__?: string
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

const TOKEN_STORAGE_KEY = 'dispatch.auth.token'

export function readStoredToken(): string | null {
  try {
    return typeof window !== 'undefined'
      ? window.localStorage.getItem(TOKEN_STORAGE_KEY)
      : null
  } catch {
    return null
  }
}

/**
 * Returns headers object for authenticated API requests.
 *
 * Auth is JWT-only: the UI obtains a token via /api/v1/auth/login and stores
 * it under TOKEN_STORAGE_KEY in localStorage. No static API key is bundled
 * into the public artifact (T-3.3 — bearer-only mode).
 */
export function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...extra }
  const token = readStoredToken()
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
  return headers
}
