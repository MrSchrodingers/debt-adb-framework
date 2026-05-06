import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface SnapshotInput {
  xml: string
  state: string
  phone: string
  timestamp?: Date
}

export interface SnapshotWriterOpts {
  baseDir: string
  dailyQuota: number
  perMinuteCap: number
}

/**
 * Quota-bounded XML snapshot writer for `unknown` / `unknown_dialog` UI states.
 *
 * - Daily quota: max writes per UTC calendar day.
 * - Per-minute cap: max writes per UTC minute (storm protection — protects
 *   against runaway loops where every probe lands on the same unrecognized
 *   screen).
 *
 * Both quotas are tracked in-memory only — restart resets them. This is
 * intentional: the daily quota is meant to bound disk usage during a single
 * process lifetime, not across the lifetime of the deployment.
 *
 * Filename convention: `<HHMMSS>_<phone-last4>_<state>_<dump-length>.xml`
 * inside a per-day folder `<baseDir>/<YYYY-MM-DD>/`.
 */
export class ProbeSnapshotWriter {
  private readonly dailyCounts = new Map<string, number>()    // YYYY-MM-DD → count
  private readonly minuteCounts = new Map<string, number>()   // YYYY-MM-DDTHH:MM → count

  constructor(private readonly opts: SnapshotWriterOpts) {}

  write(input: SnapshotInput): string | null {
    const ts = input.timestamp ?? new Date()
    const day = ts.toISOString().slice(0, 10)
    const minute = ts.toISOString().slice(0, 16)

    const dailySoFar = this.dailyCounts.get(day) ?? 0
    if (dailySoFar >= this.opts.dailyQuota) return null

    const minuteSoFar = this.minuteCounts.get(minute) ?? 0
    if (minuteSoFar >= this.opts.perMinuteCap) return null

    const dir = join(this.opts.baseDir, day)
    mkdirSync(dir, { recursive: true })

    const hhmmss = ts.toISOString().slice(11, 19).replace(/:/g, '')
    const last4 = input.phone.slice(-4).padStart(4, '0')
    const file = `${hhmmss}_${last4}_${input.state}_${input.xml.length}.xml`
    const fullPath = join(dir, file)
    writeFileSync(fullPath, input.xml, 'utf8')

    this.dailyCounts.set(day, dailySoFar + 1)
    this.minuteCounts.set(minute, minuteSoFar + 1)
    return fullPath
  }
}
