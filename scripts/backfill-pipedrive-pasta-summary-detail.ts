#!/usr/bin/env tsx
/**
 * backfill-pipedrive-pasta-summary-detail.ts
 *
 * One-shot operational tool — retroactive Pipedrive Note repair.
 *
 * Operators reported the existing `pasta_summary` Notes were too anonymous:
 * they showed *how many* phones were checked but not *which* phones, grouped
 * by which deal, with which outcome, validated by which strategy. This
 * script re-renders every historical pasta_summary Note with the new v2
 * layout (per-deal phone breakdown + visual upgrades).
 *
 * Strategy:
 *   1. Read every `pipedrive_activities` row where:
 *        scenario = 'pasta_summary'
 *        AND pipedrive_endpoint = '/notes'
 *        AND pipedrive_response_status = 'success'
 *      — these are the deal-anchored Notes the publisher has already POSTed
 *      to Pipedrive at least once.
 *   2. For each row, resolve the Pipedrive `note_id`:
 *        - prefer `row.pipedrive_response_id` (post 2026-04-29 publisher fix)
 *        - else GET /v1/notes?deal_id={deal_id}&limit=500 and match by the
 *          job_id marker that lives in the body (MD or HTML form)
 *   3. Look up the per-deal phone breakdown from the LOCAL `adb_precheck_deals`
 *      table:
 *        SELECT pasta, deal_id, contato_tipo, contato_id,
 *               phones_json, valid_count, invalid_count
 *          FROM adb_precheck_deals
 *         WHERE last_job_id = ?
 *      Deals are grouped by `deal_id` (multiple contato_id rows merge into one
 *      deal entry, matching the runtime scanner's behavior).
 *   4. Re-derive aggregates from those rows so the pasta totals on the Note
 *      match what the scanner emitted at the time:
 *        total_deals = COUNT(distinct contato rows)
 *        ok_deals    = COUNT(rows with valid_count > 0)
 *        archived_deals = COUNT(rows with valid_count = 0 AND invalid_count > 0)
 *        total_phones_checked = SUM(phones_json[].length)
 *        ok_phones   = SUM(valid_count)
 *        strategy_counts = aggregated from each phones_json[].source
 *   5. Build the new `PipedrivePastaSummaryIntent` (now with `deals[]`) and
 *      run it through `buildPastaSummaryNote(intent, companyDomain)`.
 *   6. PUT /v1/notes/{note_id} with the new content.
 *
 * Idempotency:
 *   - Cheap pre-check: if persisted payload's `content` already contains the
 *     v2 marker (`PASTA_SUMMARY_V2_MARKER` = "Detalhamento por deal"), we skip
 *     without any HTTP call.
 *   - Defensive remote check: after resolving note_id, GET the remote note;
 *     if its content already contains the v2 marker, mark as skipped(idempotent)
 *     and update local payload to match (so future runs short-circuit on the
 *     cheap path).
 *
 * Rate limit: 10 req/s — same token-bucket the publisher uses.
 *
 * Usage (Kali, from project root):
 *   cd packages/core
 *   npx tsx ../../scripts/backfill-pipedrive-pasta-summary-detail.ts
 *
 * Env:
 *   PIPEDRIVE_API_TOKEN       — required
 *   PIPEDRIVE_COMPANY_DOMAIN  — recommended (used for in-Note deal links)
 *   PIPEDRIVE_BASE_URL        — defaults to https://api.pipedrive.com/v1/
 *   PIPEDRIVE_RATE_PER_SEC    — defaults to 10
 *   DB_PATH                   — defaults to packages/core/dispatch.db
 *   DRY_RUN=1                 — skip PUT but still report
 */

import { createRequire } from 'node:module'
import {
  buildPastaSummaryNote,
  PASTA_SUMMARY_V2_MARKER,
} from '../packages/core/src/plugins/adb-precheck/pipedrive-formatter.js'
import type {
  PipedrivePastaDealRow,
  PipedrivePastaSummaryIntent,
  PhoneOutcome,
} from '../packages/core/src/plugins/adb-precheck/types.js'

const require = createRequire(import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require('better-sqlite3') as typeof import('better-sqlite3').default

// ── CLI / env ────────────────────────────────────────────────────────────

const dbPath = process.env.DB_PATH ?? 'packages/core/dispatch.db'
const apiToken = process.env.PIPEDRIVE_API_TOKEN
const companyDomain = process.env.PIPEDRIVE_COMPANY_DOMAIN ?? null
const baseUrl = (process.env.PIPEDRIVE_BASE_URL ?? 'https://api.pipedrive.com/v1/').replace(/\/+$/, '/')
const ratePerSec = Number(process.env.PIPEDRIVE_RATE_PER_SEC ?? 10)
const dryRun = process.env.DRY_RUN === '1'

if (!apiToken) {
  console.error('[backfill-detail] FATAL: PIPEDRIVE_API_TOKEN is not set in env. Aborting.')
  process.exit(1)
}

// ── Token-bucket (mirrors PipedriveClient) ───────────────────────────────

class TokenBucket {
  private tokens: number
  private lastRefill = Date.now()
  constructor(private readonly rate: number, private readonly burst: number) {
    this.tokens = burst
  }
  async take(): Promise<void> {
    while (true) {
      const now = Date.now()
      const elapsed = (now - this.lastRefill) / 1000
      this.tokens = Math.min(this.burst, this.tokens + elapsed * this.rate)
      this.lastRefill = now
      if (this.tokens >= 1) {
        this.tokens -= 1
        return
      }
      const waitMs = Math.ceil(((1 - this.tokens) / this.rate) * 1000)
      await new Promise((r) => setTimeout(r, Math.max(waitMs, 5)))
    }
  }
}

const bucket = new TokenBucket(ratePerSec, 5)

// ── Local DB row types ───────────────────────────────────────────────────

interface ActivityRow {
  id: string
  scenario: 'phone_fail' | 'deal_all_fail' | 'pasta_summary'
  deal_id: number
  pasta: string | null
  phone_normalized: string | null
  job_id: string | null
  pipedrive_endpoint: string
  pipedrive_payload_json: string
  pipedrive_response_id: number | null
  pipedrive_response_status: 'retrying' | 'success' | 'failed'
}

interface DealCacheRow {
  pasta: string
  deal_id: number
  contato_tipo: string
  contato_id: number
  phones_json: string
  valid_count: number
  invalid_count: number
}

interface PersistedPayload {
  content?: string
  deal_id?: number | string
}

// Shape of phones_json stored by `PrecheckJobStore.upsertDeal` —
// `JSON.stringify(result.phones)` where each entry is a `PhoneResult`.
interface PhonesJsonEntry {
  column: string
  raw: string
  normalized: string
  outcome: PhoneOutcome
  source: string
  confidence: number | null
  variant_tried: string | null
  error: string | null
}

// ── Pipedrive HTTP helpers ───────────────────────────────────────────────

interface PipedriveNoteListItem {
  id: number
  content?: string | null
  deal_id?: number | null
}

async function fetchDealNotes(dealId: number): Promise<PipedriveNoteListItem[]> {
  await bucket.take()
  const url = `${baseUrl}notes?deal_id=${dealId}&limit=500&api_token=${encodeURIComponent(apiToken!)}`
  const ctrl = new AbortController()
  const tid = setTimeout(() => ctrl.abort(), 15_000)
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: ctrl.signal,
    })
    clearTimeout(tid)
    if (!res.ok) throw new Error(`http_${res.status}`)
    const json = (await res.json()) as { success?: boolean; data?: PipedriveNoteListItem[] | null }
    if (!json.success) throw new Error('success_false')
    return json.data ?? []
  } finally {
    clearTimeout(tid)
  }
}

async function fetchSingleNote(noteId: number): Promise<{ ok: boolean; content: string | null; status: number; error?: string }> {
  await bucket.take()
  const url = `${baseUrl}notes/${noteId}?api_token=${encodeURIComponent(apiToken!)}`
  const ctrl = new AbortController()
  const tid = setTimeout(() => ctrl.abort(), 15_000)
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: ctrl.signal,
    })
    clearTimeout(tid)
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return { ok: false, content: null, status: res.status, error: `http_${res.status}: ${text.slice(0, 160)}` }
    }
    const json = (await res.json()) as { success?: boolean; data?: { content?: string | null } | null }
    if (!json.success || !json.data) return { ok: false, content: null, status: res.status, error: 'success_false' }
    return { ok: true, content: json.data.content ?? '', status: res.status }
  } catch (e) {
    clearTimeout(tid)
    return { ok: false, content: null, status: 0, error: e instanceof Error ? e.message : String(e) }
  }
}

async function updateNoteContent(noteId: number, content: string): Promise<{ ok: boolean; status: number; error?: string }> {
  await bucket.take()
  const url = `${baseUrl}notes/${noteId}?api_token=${encodeURIComponent(apiToken!)}`
  const ctrl = new AbortController()
  const tid = setTimeout(() => ctrl.abort(), 15_000)
  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ content }),
      signal: ctrl.signal,
    })
    clearTimeout(tid)
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return { ok: false, status: res.status, error: `http_${res.status}: ${text.slice(0, 200)}` }
    }
    return { ok: true, status: res.status }
  } catch (e) {
    clearTimeout(tid)
    return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) }
  }
}

// ── Note resolver ────────────────────────────────────────────────────────
//
// Old MD layout: contains the literal `**Job ID**: \`{job_id}\`` line.
// New HTML layout (pre-v2): contains `<strong>Job ID</strong>: {job_id}`.
// New HTML layout (v2):     contains `<em>Job ID</em>: {job_id}`.
// We accept any of the three to maximize hit rate when the persisted
// pipedrive_response_id is missing.
function findMatchingNoteId(candidates: PipedriveNoteListItem[], row: ActivityRow): number | null {
  if (!row.job_id) return null
  const matches = candidates.filter((c) => {
    const content = typeof c.content === 'string' ? c.content : ''
    if (!content) return false
    return (
      content.includes(`**Job ID**: \`${row.job_id}\``)
      || content.includes(`Job ID</strong>: ${row.job_id}`)
      || content.includes(`Job ID</em>: ${row.job_id}`)
    )
  })
  if (matches.length === 0) return null
  // Take the most recently-created when ambiguous — Pipedrive returns notes
  // newest-first by default, so [0] is the freshest match for this job.
  return matches[0]!.id
}

// ── Source-data lookup ───────────────────────────────────────────────────
//
// Re-derives the v2 PipedrivePastaSummaryIntent from the local SQLite cache.
// Returns null when no rows match — happens for old jobs whose deal cache
// was archived/purged before this script ran.

function classifyStrategy(source: string): 'adb' | 'waha' | 'cache' {
  const s = (source ?? '').toLowerCase()
  if (s.includes('adb')) return 'adb'
  if (s.includes('waha')) return 'waha'
  return 'cache'
}

interface RebuildOutcome {
  intent: PipedrivePastaSummaryIntent | null
  /** Diagnostic — number of cache rows that fed the rebuild. */
  rowsFound: number
}

function rebuildIntentFromLocal(
  row: ActivityRow,
  pickRowsByJob: (jobId: string) => DealCacheRow[],
  pickRowsByPasta: (pasta: string) => DealCacheRow[],
  parsedJobBoundaries: { started: string | null; ended: string | null },
): RebuildOutcome {
  // Primary lookup: rows whose last_job_id matches.
  let cacheRows: DealCacheRow[] = []
  if (row.job_id) cacheRows = pickRowsByJob(row.job_id)
  // Fallback: when last_job_id was overwritten by a later job, look up by
  // pasta. We deduplicate by (deal_id, contato_tipo, contato_id) so re-scans
  // do not double-count.
  if (cacheRows.length === 0 && row.pasta) {
    cacheRows = pickRowsByPasta(row.pasta)
  }
  if (cacheRows.length === 0) return { intent: null, rowsFound: 0 }

  // Aggregate.
  let totalDeals = 0
  let okDeals = 0
  let archivedDeals = 0
  let totalPhonesChecked = 0
  let okPhones = 0
  const strategyCounts = { adb: 0, waha: 0, cache: 0 }
  // Group phones by deal_id (matches scanner.runJob behavior).
  const dealsMap = new Map<number, PipedrivePastaDealRow>()

  for (const cr of cacheRows) {
    totalDeals += 1
    if (cr.valid_count > 0) okDeals += 1
    else if (cr.invalid_count > 0) archivedDeals += 1

    let parsed: PhonesJsonEntry[]
    try {
      parsed = JSON.parse(cr.phones_json) as PhonesJsonEntry[]
    } catch {
      parsed = []
    }
    totalPhonesChecked += parsed.length
    for (const p of parsed) {
      if (p.outcome === 'valid') okPhones += 1
      strategyCounts[classifyStrategy(p.source)] += 1
    }

    let dealRow = dealsMap.get(cr.deal_id)
    if (!dealRow) {
      dealRow = { deal_id: cr.deal_id, phones: [] }
      dealsMap.set(cr.deal_id, dealRow)
    }
    for (const p of parsed) {
      dealRow.phones.push({
        column: p.column,
        phone_normalized: p.normalized || p.raw,
        outcome: p.outcome,
        strategy: classifyStrategy(p.source),
      })
    }
  }

  // Sort deals ascending by id (matches new scanner behavior).
  const dealsSorted = Array.from(dealsMap.values()).sort((a, b) => a.deal_id - b.deal_id)
  // Choose first_deal_id — prefer the row's persisted deal_id (the historical
  // anchor), but fall back to MIN(deal_id) from the cache when missing.
  const firstDealId = row.deal_id || dealsSorted[0]?.deal_id || 0
  if (firstDealId <= 0) return { intent: null, rowsFound: cacheRows.length }

  return {
    intent: {
      scenario: 'pasta_summary',
      pasta: row.pasta ?? cacheRows[0]!.pasta,
      first_deal_id: firstDealId,
      job_id: row.job_id ?? '',
      job_started: parsedJobBoundaries.started,
      job_ended: parsedJobBoundaries.ended,
      total_deals: totalDeals,
      ok_deals: okDeals,
      archived_deals: archivedDeals,
      total_phones_checked: totalPhonesChecked,
      ok_phones: okPhones,
      strategy_counts: strategyCounts,
      deals: dealsSorted,
    },
    rowsFound: cacheRows.length,
  }
}

// Best-effort recovery of `Período: <start> → <end>` from the persisted
// MD payload. Returns nulls when not present (e.g. v1 HTML doesn't preserve
// the literal arrow). Acceptable — the formatter accepts null and renders
// "n/a".
function parsePeriodFromPayload(rawPayload: string): { started: string | null; ended: string | null } {
  let payload: PersistedPayload
  try {
    payload = JSON.parse(rawPayload) as PersistedPayload
  } catch {
    return { started: null, ended: null }
  }
  const c = payload.content ?? ''
  // Old MD: **Período**: 2026-04-28T17:00:00Z → 2026-04-28T18:00:00Z
  const md = c.match(/\*\*Período\*\*: ([^\n]+?) → ([^\n]+)/)
  if (md) {
    const a = md[1]!.trim()
    const b = md[2]!.trim()
    return {
      started: a === 'n/a' ? null : a,
      ended: b === 'n/a' ? null : b,
    }
  }
  // v1 HTML: <strong>Período</strong>: <start> → <end><br>
  const html1 = c.match(/<strong>Período<\/strong>: ([^<]+?) → ([^<]+?)<br/)
  if (html1) {
    const a = html1[1]!.trim()
    const b = html1[2]!.trim()
    return {
      started: a === 'n/a' ? null : a,
      ended: b === 'n/a' ? null : b,
    }
  }
  return { started: null, ended: null }
}

// ── Main ─────────────────────────────────────────────────────────────────

interface Counts {
  total: number
  succeeded: number
  failed: number
  skipped: number
  skippedIdempotent: number
}

async function main(): Promise<void> {
  console.log(`[backfill-detail] DB: ${dbPath}`)
  console.log(`[backfill-detail] Pipedrive base: ${baseUrl}`)
  console.log(`[backfill-detail] Domain: ${companyDomain ?? '(unset)'}`)
  console.log(`[backfill-detail] Rate: ${ratePerSec} req/s${dryRun ? ' — DRY RUN' : ''}`)
  console.log(`[backfill-detail] V2 marker: "${PASTA_SUMMARY_V2_MARKER}"`)

  const db = new Database(dbPath)

  // Pull all candidates. We update the local payload after a successful PUT
  // so re-runs can short-circuit on the cheap path; that requires opening
  // the DB read-write.
  const rows = db
    .prepare(
      `SELECT id, scenario, deal_id, pasta, phone_normalized, job_id,
              pipedrive_endpoint, pipedrive_payload_json,
              pipedrive_response_id, pipedrive_response_status
         FROM pipedrive_activities
        WHERE scenario = 'pasta_summary'
          AND pipedrive_endpoint = '/notes'
          AND pipedrive_response_status = 'success'
        ORDER BY created_at ASC`,
    )
    .all() as ActivityRow[]

  const counts: Counts = { total: rows.length, succeeded: 0, failed: 0, skipped: 0, skippedIdempotent: 0 }
  console.log(`[backfill-detail] Candidates: ${counts.total} pasta_summary note rows`)

  // Pre-build per-job and per-pasta caches from adb_precheck_deals to avoid
  // O(N×M) hits. Each lookup is O(1) thanks to the Map.
  const allDeals = db
    .prepare(
      `SELECT pasta, deal_id, contato_tipo, contato_id,
              phones_json, valid_count, invalid_count, last_job_id
         FROM adb_precheck_deals`,
    )
    .all() as Array<DealCacheRow & { last_job_id: string }>
  const byJob = new Map<string, DealCacheRow[]>()
  const byPasta = new Map<string, DealCacheRow[]>()
  for (const d of allDeals) {
    const slim: DealCacheRow = {
      pasta: d.pasta,
      deal_id: d.deal_id,
      contato_tipo: d.contato_tipo,
      contato_id: d.contato_id,
      phones_json: d.phones_json,
      valid_count: d.valid_count,
      invalid_count: d.invalid_count,
    }
    {
      const arr = byJob.get(d.last_job_id) ?? []
      arr.push(slim)
      byJob.set(d.last_job_id, arr)
    }
    {
      const arr = byPasta.get(d.pasta) ?? []
      arr.push(slim)
      byPasta.set(d.pasta, arr)
    }
  }
  console.log(`[backfill-detail] Loaded local cache: ${allDeals.length} adb_precheck_deals rows (${byJob.size} jobs, ${byPasta.size} pastas)`)

  const updateLocalPayload = db.prepare(
    `UPDATE pipedrive_activities SET pipedrive_payload_json = ? WHERE id = ?`,
  )
  const dealNoteCache = new Map<number, PipedriveNoteListItem[]>()
  const failures: Array<{ id: string; deal_id: number; pasta: string | null; reason: string }> = []
  let firstSampleLogged = false

  let i = 0
  for (const row of rows) {
    i++
    const tag = `[${i}/${counts.total}] deal=${row.deal_id} pasta=${row.pasta ?? '-'} job=${row.job_id ?? '-'}`

    // Cheap idempotency check — persisted payload already v2.
    let payload: PersistedPayload | null = null
    try {
      payload = JSON.parse(row.pipedrive_payload_json) as PersistedPayload
    } catch {
      payload = null
    }
    if (payload?.content && payload.content.includes(PASTA_SUMMARY_V2_MARKER)) {
      counts.skippedIdempotent++
      console.log(`${tag} -> skipped(idempotent_local)`)
      continue
    }

    // Rebuild from local cache.
    const period = parsePeriodFromPayload(row.pipedrive_payload_json)
    const { intent, rowsFound } = rebuildIntentFromLocal(
      row,
      (jid) => byJob.get(jid) ?? [],
      (pasta) => byPasta.get(pasta) ?? [],
      period,
    )
    if (!intent) {
      counts.skipped++
      console.log(`${tag} -> skipped(no_local_data, rowsFound=${rowsFound})`)
      continue
    }

    const newContent = buildPastaSummaryNote(intent, companyDomain).payload.content

    // Resolve the Pipedrive note id.
    let noteId: number | null = row.pipedrive_response_id ?? null
    if (!noteId) {
      let candidates = dealNoteCache.get(row.deal_id)
      if (!candidates) {
        try {
          candidates = await fetchDealNotes(row.deal_id)
          dealNoteCache.set(row.deal_id, candidates)
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          counts.failed++
          failures.push({ id: row.id, deal_id: row.deal_id, pasta: row.pasta, reason: `list_failed:${msg}` })
          console.log(`${tag} -> failed(list:${msg})`)
          continue
        }
      }
      noteId = findMatchingNoteId(candidates, row)
    }
    if (!noteId) {
      counts.skipped++
      console.log(`${tag} -> skipped(no_match, rowsFound=${rowsFound})`)
      continue
    }

    // Defensive remote idempotency check — saves a redundant PUT when the
    // persisted payload was older than reality.
    const remote = await fetchSingleNote(noteId)
    if (remote.ok && remote.content && remote.content.includes(PASTA_SUMMARY_V2_MARKER)) {
      counts.skippedIdempotent++
      // Heal local state so future runs short-circuit cheaply.
      try {
        const synced = JSON.stringify({ ...(payload ?? {}), content: remote.content })
        updateLocalPayload.run(synced, row.id)
      } catch {
        // best-effort, never block the main path
      }
      console.log(`${tag} -> skipped(idempotent_remote, note=${noteId})`)
      continue
    }

    if (!firstSampleLogged) {
      firstSampleLogged = true
      const head = newContent.slice(0, 400).replace(/\n/g, '\\n')
      console.log(`[backfill-detail] FIRST RENDERED SAMPLE — note=${noteId} (deal=${row.deal_id})`)
      console.log(`[backfill-detail]   bytes=${newContent.length} dealsInBody=${intent.deals?.length ?? 0}`)
      console.log(`[backfill-detail]   head: ${head}`)
    }

    if (dryRun) {
      counts.succeeded++
      console.log(`${tag} -> note=${noteId} (dry-run, deals=${intent.deals?.length ?? 0})`)
      continue
    }

    const putRes = await updateNoteContent(noteId, newContent)
    if (putRes.ok) {
      counts.succeeded++
      try {
        const synced = JSON.stringify({ ...(payload ?? {}), deal_id: row.deal_id, content: newContent })
        updateLocalPayload.run(synced, row.id)
      } catch {
        // best-effort
      }
      console.log(`${tag} -> note=${noteId} updated (deals=${intent.deals?.length ?? 0})`)
    } else {
      counts.failed++
      failures.push({ id: row.id, deal_id: row.deal_id, pasta: row.pasta, reason: putRes.error ?? `http_${putRes.status}` })
      console.log(`${tag} -> failed(put:${putRes.error ?? `http_${putRes.status}`})`)
    }
  }

  db.close()

  console.log('')
  console.log('============================================')
  console.log('[backfill-detail] FINAL SUMMARY')
  console.log(`  total:               ${counts.total}`)
  console.log(`  succeeded:           ${counts.succeeded}`)
  console.log(`  failed:              ${counts.failed}`)
  console.log(`  skipped:             ${counts.skipped}`)
  console.log(`  skipped(idempotent): ${counts.skippedIdempotent}`)
  console.log('============================================')
  if (failures.length > 0) {
    console.log('[backfill-detail] Failures (first 25):')
    for (const f of failures.slice(0, 25)) {
      console.log(`  - row=${f.id} deal=${f.deal_id} pasta=${f.pasta ?? '-'} reason=${f.reason}`)
    }
  }
}

main().catch((e) => {
  console.error('[backfill-detail] FATAL:', e)
  process.exit(1)
})
