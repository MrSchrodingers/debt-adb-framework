const DEFAULT_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:7890',
]

/**
 * Build the list of allowed CORS origins.
 * Always includes dev defaults (localhost:5173 for Vite, localhost:7890 for Electron/self).
 * Extra origins can be provided via comma-separated string (from DISPATCH_ALLOWED_ORIGINS env var).
 */
export function buildCorsOrigins(extraOrigins?: string): string[] {
  const origins = [...DEFAULT_ORIGINS]
  if (extraOrigins) {
    const extras = extraOrigins
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    origins.push(...extras)
  }
  return origins
}
