import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { CORE_URL } from '../config'

/**
 * Auth state for the UI.
 *
 * - `loading`: bootstrapping (reading localStorage, probing /healthz)
 * - `mode`:
 *     - 'open'   → server has no auth gate → app renders without login
 *     - 'closed' → server requires login; token may or may not be present
 * - `token`: present when authenticated; null otherwise
 *
 * The mode is detected by probing POST /api/v1/auth/login with empty body —
 * 400 means the route exists (gate enabled), anything else (404, network) =>
 * open mode. We probe once on mount.
 *
 * Task 3.4 — refresh tokens:
 *   - Login response now also returns `refresh_token` + `refresh_expires_at`.
 *   - Access TTL dropped from 8h to 15min; refresh TTL is 24h.
 *   - We pre-emptively call /api/v1/auth/refresh ~60s before access expiry.
 *   - On any 401 from a protected endpoint, we try a single refresh round-trip
 *     before logging the user out. If refresh itself 401s, we hard-logout.
 */

interface LoginResponse {
  token: string
  expires_at: string
  sub: string
  refresh_token?: string
  refresh_expires_at?: string
}

interface AuthState {
  loading: boolean
  mode: 'open' | 'closed'
  token: string | null
  expiresAt: string | null
  username: string | null
  error: string | null
  login: (username: string, password: string) => Promise<void>
  logout: () => void
}

const TOKEN_KEY = 'dispatch.auth.token'
const EXPIRES_KEY = 'dispatch.auth.expires_at'
const SUB_KEY = 'dispatch.auth.sub'
const REFRESH_KEY = 'dispatch.auth.refresh_token'
const REFRESH_EXPIRES_KEY = 'dispatch.auth.refresh_expires_at'

// Trigger refresh this many ms before access expiry.
const REFRESH_LEAD_MS = 60_000

const AuthContext = createContext<AuthState | null>(null)

function clearStorage(): void {
  try {
    window.localStorage.removeItem(TOKEN_KEY)
    window.localStorage.removeItem(EXPIRES_KEY)
    window.localStorage.removeItem(SUB_KEY)
    window.localStorage.removeItem(REFRESH_KEY)
    window.localStorage.removeItem(REFRESH_EXPIRES_KEY)
  } catch {
    /* localStorage unavailable */
  }
}

function readPersisted(): {
  token: string | null
  expiresAt: string | null
  sub: string | null
  refreshToken: string | null
  refreshExpiresAt: string | null
} {
  if (typeof window === 'undefined') {
    return { token: null, expiresAt: null, sub: null, refreshToken: null, refreshExpiresAt: null }
  }
  try {
    const token = window.localStorage.getItem(TOKEN_KEY)
    const expiresAt = window.localStorage.getItem(EXPIRES_KEY)
    const sub = window.localStorage.getItem(SUB_KEY)
    const refreshToken = window.localStorage.getItem(REFRESH_KEY)
    const refreshExpiresAt = window.localStorage.getItem(REFRESH_EXPIRES_KEY)

    // If the access token has already expired, fall back to the refresh
    // token (if still valid). Hand back the access metadata regardless and
    // let the in-flight refresh effect rotate it. Without this, page reloads
    // after >15min would force a re-login even when the 24h refresh is fine.
    const accessExpired = expiresAt ? new Date(expiresAt).getTime() <= Date.now() : true
    const refreshExpired = refreshExpiresAt ? new Date(refreshExpiresAt).getTime() <= Date.now() : true

    if (refreshExpired && accessExpired) {
      clearStorage()
      return { token: null, expiresAt: null, sub: null, refreshToken: null, refreshExpiresAt: null }
    }
    return { token, expiresAt, sub, refreshToken, refreshExpiresAt }
  } catch {
    return { token: null, expiresAt: null, sub: null, refreshToken: null, refreshExpiresAt: null }
  }
}

interface RefreshOutcome {
  ok: boolean
  data?: LoginResponse
}

async function callRefresh(refreshToken: string): Promise<RefreshOutcome> {
  try {
    const res = await fetch(`${CORE_URL}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    })
    if (!res.ok) return { ok: false }
    const data = (await res.json()) as LoginResponse
    return { ok: true, data }
  } catch {
    return { ok: false }
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const persisted = readPersisted()
  const [token, setToken] = useState<string | null>(persisted.token)
  const [expiresAt, setExpiresAt] = useState<string | null>(persisted.expiresAt)
  const [username, setUsername] = useState<string | null>(persisted.sub)
  const [refreshToken, setRefreshToken] = useState<string | null>(persisted.refreshToken)
  const [refreshExpiresAt, setRefreshExpiresAt] = useState<string | null>(persisted.refreshExpiresAt)
  const [mode, setMode] = useState<'open' | 'closed'>('closed')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Single in-flight refresh promise — coalesces concurrent calls (e.g. an
  // expiring access token + a 401 reaction firing at the same time should
  // both reuse the one /refresh round-trip).
  const inFlightRefresh = useRef<Promise<boolean> | null>(null)

  const persistSession = useCallback((data: LoginResponse) => {
    setToken(data.token)
    setExpiresAt(data.expires_at)
    setUsername(data.sub)
    if (data.refresh_token) setRefreshToken(data.refresh_token)
    if (data.refresh_expires_at) setRefreshExpiresAt(data.refresh_expires_at)
    try {
      window.localStorage.setItem(TOKEN_KEY, data.token)
      window.localStorage.setItem(EXPIRES_KEY, data.expires_at)
      window.localStorage.setItem(SUB_KEY, data.sub)
      if (data.refresh_token) window.localStorage.setItem(REFRESH_KEY, data.refresh_token)
      if (data.refresh_expires_at) window.localStorage.setItem(REFRESH_EXPIRES_KEY, data.refresh_expires_at)
    } catch {
      /* localStorage disabled — session-only */
    }
  }, [])

  const performLogout = useCallback(() => {
    setToken(null)
    setExpiresAt(null)
    setUsername(null)
    setRefreshToken(null)
    setRefreshExpiresAt(null)
    clearStorage()
  }, [])

  // Coalesced refresh — returns true on success, false on hard failure.
  const tryRefresh = useCallback(async (): Promise<boolean> => {
    const stored = window.localStorage.getItem(REFRESH_KEY)
    if (!stored) return false
    if (inFlightRefresh.current) return inFlightRefresh.current
    const promise = (async () => {
      const outcome = await callRefresh(stored)
      if (outcome.ok && outcome.data) {
        persistSession(outcome.data)
        return true
      }
      // Hard failure (401, network) — log out so the user lands on /login.
      performLogout()
      return false
    })()
    inFlightRefresh.current = promise
    try {
      return await promise
    } finally {
      inFlightRefresh.current = null
    }
  }, [persistSession, performLogout])

  // Probe whether the server has the auth gate enabled.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`${CORE_URL}/api/v1/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        })
        if (cancelled) return
        // Login route present → 400 (validation) means gate is on. 404 means open.
        // 401 also means present (someone sent empty creds).
        if (res.status === 404) {
          setMode('open')
        } else {
          setMode('closed')
        }
      } catch {
        if (!cancelled) setMode('open')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Pre-emptive refresh: schedule a refresh REFRESH_LEAD_MS before expiry.
  // Re-runs whenever expiresAt changes (i.e. after each successful refresh).
  useEffect(() => {
    if (mode !== 'closed' || !token || !expiresAt || !refreshToken) return
    const expiresMs = new Date(expiresAt).getTime()
    const delay = Math.max(0, expiresMs - Date.now() - REFRESH_LEAD_MS)
    const handle = window.setTimeout(() => {
      void tryRefresh()
    }, delay)
    return () => {
      window.clearTimeout(handle)
    }
  }, [mode, token, expiresAt, refreshToken, tryRefresh])

  // Global 401 handler: any protected fetch that comes back 401 (e.g. token
  // expired) tries a single refresh first. If that succeeds, we replay the
  // request with the new bearer; if not, we log the user out.
  useEffect(() => {
    if (mode !== 'closed' || !token) return
    const originalFetch = window.fetch.bind(window)
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url ?? ''
      const isRefreshCall = url.includes('/api/v1/auth/refresh')
      const isLoginCall = url.includes('/api/v1/auth/login')

      const res = await originalFetch(input as RequestInfo, init)
      if (res.status !== 401 || isRefreshCall || isLoginCall) {
        return res
      }

      // Try one refresh, then replay. If refresh fails, tryRefresh logs out.
      const ok = await tryRefresh()
      if (!ok) return res

      // Replay with the freshly stored bearer. We can only safely retry
      // requests where init.headers carries an Authorization we can swap.
      // For Request-object inputs (rarer in this codebase) we just return
      // the original 401 — the calling code already knows to read the body.
      const newToken = window.localStorage.getItem(TOKEN_KEY)
      if (!newToken || typeof input !== 'string') return res
      const headers = new Headers(init?.headers ?? {})
      headers.set('Authorization', `Bearer ${newToken}`)
      return originalFetch(input, { ...init, headers })
    }
    return () => {
      window.fetch = originalFetch
    }
  }, [mode, token, tryRefresh])

  const login = useCallback(async (u: string, p: string) => {
    setError(null)
    const res = await fetch(`${CORE_URL}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: u, password: p }),
    })
    if (res.status === 401) {
      setError('Usuário ou senha inválidos')
      throw new Error('invalid_credentials')
    }
    if (res.status === 400) {
      setError('Preencha usuário e senha')
      throw new Error('invalid_payload')
    }
    if (!res.ok) {
      setError(`Falha no login (HTTP ${res.status})`)
      throw new Error(`http_${res.status}`)
    }
    const data = (await res.json()) as LoginResponse
    persistSession(data)
  }, [persistSession])

  const logout = useCallback(() => {
    performLogout()
  }, [performLogout])

  const value = useMemo<AuthState>(
    () => ({ loading, mode, token, expiresAt, username, error, login, logout }),
    [loading, mode, token, expiresAt, username, error, login, logout],
  )

  // refreshExpiresAt is intentionally tracked in state but not exposed on the
  // public AuthState (consumers don't need it; only internal effects do).
  void refreshExpiresAt

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}

/**
 * Read the current token directly from storage. Use this in module-level code
 * (e.g. config.ts) where the React context isn't available. The auth provider
 * keeps localStorage in sync.
 */
export function getStoredToken(): string | null {
  return readPersisted().token
}
