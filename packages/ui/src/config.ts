declare global {
  interface Window {
    __DISPATCH_CORE_URL__?: string
    __DISPATCH_API_KEY__?: string
  }
}

export const CORE_URL =
  window.__DISPATCH_CORE_URL__
  ?? import.meta.env.VITE_CORE_URL
  ?? 'http://localhost:7890'

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
