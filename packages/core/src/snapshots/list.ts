import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface SnapshotFileEntry {
  path: string
  day: string
  state: string
  phone_last4: string
  size: number
  /** Tenant namespace the snapshot belongs to (e.g. `'adb'`, `'sicoob'`). */
  tenant: string
}

/** Regex that matches ProbeSnapshotWriter filename convention. */
const FILENAME_RE = /^\d{6}_(\d{4})_([a-z_]+)_\d+\.xml$/

/**
 * Lists files persisted by `ProbeSnapshotWriter` under
 * `<baseDir>/<tenant>/<YYYY-MM-DD>/`.
 *
 * Filters:
 * - `since`  — YYYY-MM-DD lexicographic compare against the day folder.
 * - `state`  — exact match against the state segment of the filename.
 * - `tenant` — when provided, only files under `<baseDir>/<tenant>/…` are
 *              returned. When omitted, all tenant sub-directories are traversed
 *              and each returned entry is tagged with its `tenant`.
 *
 * Filename convention is `<HHMMSS>_<phone-last4>_<state>_<dump-length>.xml`.
 * Files that don't match the convention are skipped silently — letting the
 * function tolerate stray files in the dir without crashing.
 *
 * Sort order: most recent first (descending path, since path embeds date+time).
 */
export function listSnapshotFiles(
  baseDir: string,
  opts: { since?: string; state?: string; tenant?: string } = {},
): SnapshotFileEntry[] {
  // Resolve which tenant directories to traverse.
  let tenants: string[]
  if (opts.tenant) {
    tenants = [opts.tenant]
  } else {
    try {
      tenants = readdirSync(baseDir).filter((entry) => {
        try { return statSync(join(baseDir, entry)).isDirectory() } catch { return false }
      })
    } catch {
      return []
    }
    if (tenants.length === 0) return []
  }

  const out: SnapshotFileEntry[] = []

  for (const tenant of tenants) {
    const tenantDir = join(baseDir, tenant)
    let days: string[]
    try {
      days = readdirSync(tenantDir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    } catch {
      continue
    }
    if (opts.since) days = days.filter((d) => d >= opts.since!)

    for (const day of days) {
      const dayDir = join(tenantDir, day)
      let files: string[]
      try {
        files = readdirSync(dayDir)
      } catch {
        continue
      }
      for (const f of files) {
        const m = FILENAME_RE.exec(f)
        if (!m) continue
        if (opts.state && m[2] !== opts.state) continue
        const fullPath = join(dayDir, f)
        let size = 0
        try { size = statSync(fullPath).size } catch { /* file vanished */ continue }
        out.push({ path: fullPath, day, state: m[2], phone_last4: m[1], size, tenant })
      }
    }
  }

  return out.sort((a, b) => b.path.localeCompare(a.path))
}
