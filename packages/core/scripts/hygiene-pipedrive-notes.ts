#!/usr/bin/env node
/**
 * One-shot hygiene script: removes the "📵 Telefones invalidados — N
 * números removidos do deal" Pipedrive activities/notes that the
 * Pipeboard Temporal worker has been emitting after every successful
 * `archive_if_empty=true` invalidate.
 *
 * Why this exists:
 *   - The note text says "removidos do deal" but the phones were
 *     removed from Pipeboard, NOT from Pipedrive — confuses the
 *     CRM operator who looks at the deal timeline.
 *   - The desired UX is: keep only the per-pasta `pasta_summary`
 *     (which Dispatch emits itself); drop the per-deal `📵`
 *     notification entirely.
 *   - Going forward, the Pipeboard team will disable the Temporal
 *     emission. This script cleans up the historical noise.
 *
 * Strategy:
 *   1. Enumerate every distinct deal_id Dispatch has scanned
 *      (adb_precheck_deals.deal_id).
 *   2. For each deal, fetch its activities via
 *      GET /v1/deals/{id}/activities?api_token=…&done=0,1
 *   3. Filter to activities whose `subject` OR `note` matches the
 *      "Telefones invalidados" / "📵" pattern AND whose `add_time`
 *      falls in the operator-supplied window (default: all-time).
 *   4. In `--dry-run` (default): print a table of candidates.
 *      In `--apply`: DELETE /v1/activities/{id} for each match,
 *      ratelimited via the same TokenBucket the publisher uses.
 *
 * Usage:
 *   pnpm tsx scripts/hygiene-pipedrive-notes.ts                  # dry-run
 *   pnpm tsx scripts/hygiene-pipedrive-notes.ts --apply          # actually delete
 *   pnpm tsx scripts/hygiene-pipedrive-notes.ts --since 2026-04-01
 *   pnpm tsx scripts/hygiene-pipedrive-notes.ts --pattern '📵|Telefones invalidados'
 *
 * Environment:
 *   PIPEDRIVE_API_TOKEN   required
 *   PIPEDRIVE_BASE_URL    optional, default https://api.pipedrive.com/v1/
 *   DB_PATH               optional, default ./dispatch.db
 */

import 'dotenv/config'
import Database from 'better-sqlite3'
import { argv, exit, env } from 'node:process'

interface Activity {
  id: number
  subject: string
  note: string | null
  add_time: string
  done: number
  type: string
  deal_id: number | null
}

interface Args {
  apply: boolean
  since: string | null
  pattern: RegExp
  dbPath: string
  baseUrl: string
  token: string
  ratePerSec: number
}

function parseArgs(): Args {
  const apply = argv.includes('--apply')
  const since = (() => {
    const i = argv.indexOf('--since')
    return i >= 0 && argv[i + 1] ? argv[i + 1] : null
  })()
  const patternStr = (() => {
    const i = argv.indexOf('--pattern')
    return i >= 0 && argv[i + 1] ? argv[i + 1] : '📵|Telefones invalidados|números removidos|numeros removidos'
  })()
  const dbPath = (() => {
    const i = argv.indexOf('--db')
    return i >= 0 && argv[i + 1] ? argv[i + 1] : env.DB_PATH ?? 'dispatch.db'
  })()
  const token = env.PIPEDRIVE_API_TOKEN ?? ''
  const baseUrl = (env.PIPEDRIVE_BASE_URL ?? 'https://api.pipedrive.com/v1/').replace(/\/+$/, '/')
  if (!token) {
    console.error('error: PIPEDRIVE_API_TOKEN env var is required')
    exit(2)
  }
  return {
    apply,
    since,
    pattern: new RegExp(patternStr, 'i'),
    dbPath,
    baseUrl,
    token,
    ratePerSec: 8, // safe under Pipedrive's 10/s burst
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

class RateLimiter {
  private last = 0
  constructor(private readonly minIntervalMs: number) {}
  async take(): Promise<void> {
    const now = Date.now()
    const wait = this.last + this.minIntervalMs - now
    if (wait > 0) await sleep(wait)
    this.last = Date.now()
  }
}

async function fetchDealActivities(
  args: Args,
  rate: RateLimiter,
  dealId: number,
): Promise<Activity[]> {
  await rate.take()
  const url = `${args.baseUrl}deals/${dealId}/activities?api_token=${encodeURIComponent(args.token)}&limit=500`
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) {
    if (res.status === 404) return []
    console.warn(`warn: deal ${dealId} list failed http ${res.status}`)
    return []
  }
  const json = (await res.json()) as { data: Activity[] | null }
  return json.data ?? []
}

async function deleteActivity(
  args: Args,
  rate: RateLimiter,
  activityId: number,
): Promise<boolean> {
  await rate.take()
  const url = `${args.baseUrl}activities/${activityId}?api_token=${encodeURIComponent(args.token)}`
  const res = await fetch(url, { method: 'DELETE' })
  if (!res.ok) {
    console.warn(`warn: delete activity ${activityId} failed http ${res.status}`)
    return false
  }
  return true
}

async function main(): Promise<number> {
  const args = parseArgs()
  console.log(`mode=${args.apply ? 'APPLY' : 'DRY-RUN'}`)
  console.log(`pattern=${args.pattern}`)
  console.log(`since=${args.since ?? '(all-time)'}`)
  console.log(`db=${args.dbPath}`)
  console.log(`baseUrl=${args.baseUrl}`)

  const db = new Database(args.dbPath, { readonly: true })
  const rows = db
    .prepare('SELECT DISTINCT deal_id FROM adb_precheck_deals ORDER BY deal_id')
    .all() as { deal_id: number }[]
  db.close()
  console.log(`distinct_deals_in_dispatch=${rows.length}`)

  const sinceMs = args.since ? new Date(args.since).getTime() : null
  const rate = new RateLimiter(Math.max(1, Math.floor(1000 / args.ratePerSec)))

  let scanned = 0
  let candidates = 0
  let deleted = 0
  let errors = 0
  const sampleSubjects = new Map<string, number>()

  for (const r of rows) {
    scanned++
    const list = await fetchDealActivities(args, rate, r.deal_id)
    for (const a of list) {
      const text = `${a.subject ?? ''}\n${a.note ?? ''}`
      if (!args.pattern.test(text)) continue
      if (sinceMs != null) {
        const t = new Date(a.add_time).getTime()
        if (Number.isFinite(t) && t < sinceMs) continue
      }
      candidates++
      sampleSubjects.set(a.subject, (sampleSubjects.get(a.subject) ?? 0) + 1)
      if (args.apply) {
        const ok = await deleteActivity(args, rate, a.id)
        if (ok) deleted++
        else errors++
      } else if (candidates <= 10) {
        console.log(
          `  candidate deal=${r.deal_id} activity=${a.id} add_time=${a.add_time} subject="${a.subject}"`,
        )
      }
    }
    if (scanned % 50 === 0) {
      console.log(`progress: scanned=${scanned}/${rows.length} candidates=${candidates} deleted=${deleted}`)
    }
  }

  console.log('---')
  console.log(`done. scanned=${scanned} candidates=${candidates} deleted=${deleted} errors=${errors}`)
  if (sampleSubjects.size > 0) {
    console.log('subject distribution (top 5):')
    const top = [...sampleSubjects.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
    for (const [subj, n] of top) console.log(`  ${n}× ${subj}`)
  }
  return 0
}

main().then((code) => exit(code)).catch((e) => {
  console.error(e)
  exit(3)
})
