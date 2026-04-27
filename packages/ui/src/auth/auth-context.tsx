import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
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
 */

interface LoginResponse {
  token: string
  expires_at: string
  sub: string
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

const AuthContext = createContext<AuthState | null>(null)

function readPersisted(): { token: string | null; expiresAt: string | null; sub: string | null } {
  if (typeof window === 'undefined') return { token: null, expiresAt: null, sub: null }
  try {
    const token = window.localStorage.getItem(TOKEN_KEY)
    const expiresAt = window.localStorage.getItem(EXPIRES_KEY)
    const sub = window.localStorage.getItem(SUB_KEY)
    if (token && expiresAt && new Date(expiresAt).getTime() <= Date.now()) {
      // Expired — clean up
      window.localStorage.removeItem(TOKEN_KEY)
      window.localStorage.removeItem(EXPIRES_KEY)
      window.localStorage.removeItem(SUB_KEY)
      return { token: null, expiresAt: null, sub: null }
    }
    return { token, expiresAt, sub }
  } catch {
    return { token: null, expiresAt: null, sub: null }
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const persisted = readPersisted()
  const [token, setToken] = useState<string | null>(persisted.token)
  const [expiresAt, setExpiresAt] = useState<string | null>(persisted.expiresAt)
  const [username, setUsername] = useState<string | null>(persisted.sub)
  const [mode, setMode] = useState<'open' | 'closed'>('closed')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

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

  // Global 401 handler: any protected fetch that comes back 401 (e.g. token
  // expired) auto-logs-out. Skip the login endpoint itself (its 401 is the
  // "wrong creds" path, handled inline by login()).
  useEffect(() => {
    if (mode !== 'closed' || !token) return
    const originalFetch = window.fetch.bind(window)
    window.fetch = async (input, init) => {
      const res = await originalFetch(input as RequestInfo, init)
      if (res.status === 401) {
        const url = typeof input === 'string' ? input : (input as Request).url ?? ''
        if (!url.includes('/api/v1/auth/login')) {
          setToken(null)
          setExpiresAt(null)
          setUsername(null)
          try {
            window.localStorage.removeItem(TOKEN_KEY)
            window.localStorage.removeItem(EXPIRES_KEY)
            window.localStorage.removeItem(SUB_KEY)
          } catch {
            /* noop */
          }
        }
      }
      return res
    }
    return () => {
      window.fetch = originalFetch
    }
  }, [mode, token])

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
    setToken(data.token)
    setExpiresAt(data.expires_at)
    setUsername(data.sub)
    try {
      window.localStorage.setItem(TOKEN_KEY, data.token)
      window.localStorage.setItem(EXPIRES_KEY, data.expires_at)
      window.localStorage.setItem(SUB_KEY, data.sub)
    } catch {
      /* localStorage disabled — session-only */
    }
  }, [])

  const logout = useCallback(() => {
    setToken(null)
    setExpiresAt(null)
    setUsername(null)
    try {
      window.localStorage.removeItem(TOKEN_KEY)
      window.localStorage.removeItem(EXPIRES_KEY)
      window.localStorage.removeItem(SUB_KEY)
    } catch {
      /* noop */
    }
  }, [])

  const value = useMemo<AuthState>(
    () => ({ loading, mode, token, expiresAt, username, error, login, logout }),
    [loading, mode, token, expiresAt, username, error, login, logout],
  )

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
