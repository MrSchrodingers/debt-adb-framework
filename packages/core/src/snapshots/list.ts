import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface SnapshotFileEntry {
  path: string
  day: string
  state: string
  phone_last4: string
  size: number
}

/**
 * Lists files persisted by `ProbeSnapshotWriter` under `<baseDir>/<YYYY-MM-DD>/`.
 * Filters by `since` (YYYY-MM-DD lexicographic compare against the day folder)
 * and `state` (exact match against the state segment of the filename).
 *
 * Filename convention is `<HHMMSS>_<phone-last4>_<state>_<dump-length>.xml`.
 * Files that don't match the convention are skipped silently — letting the
 * function tolerate stray files in the dir without crashing.
 *
 * Sort order: most recent first (descending path, since path embeds date+time).
 */
export function listSnapshotFiles(
  baseDir: string,
  opts: { since?: string; state?: string } = {},
): SnapshotFileEntry[] {
  let days: string[]
  try {
    days = readdirSync(baseDir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
  } catch {
    return []
  }
  if (opts.since) days = days.filter((d) => d >= opts.since!)
  const out: SnapshotFileEntry[] = []
  for (const day of days) {
    const dayDir = join(baseDir, day)
    let files: string[]
    try {
      files = readdirSync(dayDir)
    } catch {
      continue
    }
    for (const f of files) {
      const m = /^\d{6}_(\d{4})_([a-z_]+)_\d+\.xml$/.exec(f)
      if (!m) continue
      if (opts.state && m[2] !== opts.state) continue
      const fullPath = join(dayDir, f)
      let size = 0
      try { size = statSync(fullPath).size } catch { /* file vanished */ continue }
      out.push({ path: fullPath, day, state: m[2], phone_last4: m[1], size })
    }
  }
  return out.sort((a, b) => b.path.localeCompare(a.path))
}
