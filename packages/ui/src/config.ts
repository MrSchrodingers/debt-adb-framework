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

/**
 * Returns headers object including X-API-Key when configured.
 * Merge this with any additional headers for fetch calls.
 */
export function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...extra }
  if (API_KEY) {
    headers['X-API-Key'] = API_KEY
  }
  return headers
}
