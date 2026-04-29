#!/usr/bin/env tsx
/**
 * cleanup-pipedrive-pollution.ts
 *
 * One-shot operational tool. Runs three idempotent passes against
 * Pipedrive + the local dispatch SQLite to clean up the noise that
 * accumulated under the old (pre 2026-04-29) Pipedrive integration:
 *
 *   PASS A — DELETE all `phone_fail` Activities. The scanner stopped
 *            emitting per-phone Activities; old rows are pure noise on
 *            the deal timeline. We DELETE the Pipedrive entity and mark
 *            the local row `pipedrive_response_status='deleted'` so the
 *            audit trail survives.
 *
 *   PASS B — PUT all `deal_all_fail` Activities with the new sanitized
 *            HTML body (no phone numbers, no per-row table, just the
 *            aggregate alarm + archival reason + next-steps).
 *
 *   PASS C — VERIFY every `pasta_summary` Note. The previous backfill
 *            claimed "12 succeeded" but operators report the cards
 *            still render raw Markdown. We GET each note, inspect the
 *            actual `.content` field on Pipedrive's side, and either:
 *              - skip if it's already proper HTML (starts with `<`),
 *              - re-PUT with HTML if the persisted content is still MD,
 *              - try alternative wrappings if Pipedrive happens to
 *                render proper-looking HTML as raw text (last-resort).
 *            Empirical findings are echoed to stdout so the operator
 *            knows whether Pipedrive accepted the HTML.
 *
 * Idempotent — re-running the script produces the same final state:
 *   - Pass A skips rows already marked `deleted` and short-circuits when
 *     the Pipedrive entity returns 404 / not_found.
 *   - Pass B skips rows whose persisted payload already contains the
 *     sanitized body (detected by the literal "telefones testados,"
 *     marker which only appears in the new layout).
 *   - Pass C skips notes whose remote content already begins with `<`
 *     and contains zero Markdown markers (`# `, `**`, `| ---`).
 *
 * Rate limit: same 10 req/s ceiling the publisher uses (token-bucket).
 *
 * Usage (Kali, from project root):
 *   cd packages/core
 *   npx tsx ../../scripts/cleanup-pipedrive-pollution.ts
 *
 * Env:
 *   PIPEDRIVE_API_TOKEN       — required
 *   PIPEDRIVE_COMPANY_DOMAIN  — recommended (used for new HTML deal links)
 *   PIPEDRIVE_BASE_URL        — defaults to https://api.pipedrive.com/v1/
 *   PIPEDRIVE_RATE_PER_SEC    — defaults to 10
 *   DB_PATH                   — defaults to packages/core/dispatch.db
 *   DRY_RUN=1                 — skip writes (DELETE/PUT) but still report
 */

import { createRequire } from 'node:module'
import {
  buildDealAllFailActivity,
  buildPastaSummaryNote,
  formatBrPhonePretty,
} from '../packages/core/src/plugins/adb-precheck/pipedrive-formatter.js'
import type {
  PipedriveDealAllFailIntent,
  PipedrivePastaSummaryIntent,
  PipedrivePhoneEntry,
} from '../packages/core/src/plugins/adb-precheck/types.js'

// better-sqlite3 is hoisted under packages/core/node_modules; createRequire
// performs Node's classic resolution which walks the directory tree.
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
  console.error('[cleanup] FATAL: PIPEDRIVE_API_TOKEN is not set in env. Aborting.')
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

// ── Pipedrive HTTP helpers ───────────────────────────────────────────────

interface PipedriveActivityListItem {
  id: number
  note?: string | null
  type?: string | null
}

interface PipedriveNoteListItem {
  id: number
  content?: string | null
  deal_id?: number | null
}

async function deleteActivity(activityId: number): Promise<{ ok: boolean; status: number; error?: string }> {
  await bucket.take()
  const url = `${baseUrl}activities/${activityId}?api_token=${encodeURIComponent(apiToken!)}`
  const ctrl = new AbortController()
  const tid = setTimeout(() => ctrl.abort(), 15_000)
  try {
    const res = await fetch(url, { method: 'DELETE', headers: { Accept: 'application/json' }, signal: ctrl.signal })
    clearTimeout(tid)
    if (res.status === 404) return { ok: true, status: 404, error: 'not_found' }
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

async function fetchDealActivities(dealId: number): Promise<PipedriveActivityListItem[]> {
  await bucket.take()
  const url = `${baseUrl}deals/${dealId}/activities?limit=500&api_token=${encodeURIComponent(apiToken!)}`
  const ctrl = new AbortController()
  const tid = setTimeout(() => ctrl.abort(), 15_000)
  try {
    const res = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' }, signal: ctrl.signal })
    clearTimeout(tid)
    if (!res.ok) throw new Error(`http_${res.status}`)
    const json = (await res.json()) as { success?: boolean; data?: PipedriveActivityListItem[] | null }
    if (!json.success) throw new Error('success_false')
    return json.data ?? []
  } finally {
    clearTimeout(tid)
  }
}

async function updateActivityNote(activityId: number, note: string): Promise<{ ok: boolean; status: number; error?: string }> {
  await bucket.take()
  const url = `${baseUrl}activities/${activityId}?api_token=${encodeURIComponent(apiToken!)}`
  const ctrl = new AbortController()
  const tid = setTimeout(() => ctrl.abort(), 15_000)
  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ note }),
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

async function fetchSingleNote(noteId: number): Promise<{ ok: boolean; content: string | null; status: number; error?: string }> {
  await bucket.take()
  const url = `${baseUrl}notes/${noteId}?api_token=${encodeURIComponent(apiToken!)}`
  const ctrl = new AbortController()
  const tid = setTimeout(() => ctrl.abort(), 15_000)
  try {
    const res = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' }, signal: ctrl.signal })
    clearTimeout(tid)
    if (res.status === 404) return { ok: false, status: 404, content: null, error: 'not_found' }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return { ok: false, status: res.status, content: null, error: `http_${res.status}: ${text.slice(0, 200)}` }
    }
    const json = (await res.json()) as { success?: boolean; data?: PipedriveNoteListItem | null }
    if (!json.success) return { ok: false, status: res.status, content: null, error: 'success_false' }
    return { ok: true, status: res.status, content: json.data?.content ?? null }
  } catch (e) {
    clearTimeout(tid)
    return { ok: false, status: 0, content: null, error: e instanceof Error ? e.message : String(e) }
  }
}

async function fetchDealNotes(dealId: number): Promise<PipedriveNoteListItem[]> {
  await bucket.take()
  const url = `${baseUrl}notes?deal_id=${dealId}&limit=500&api_token=${encodeURIComponent(apiToken!)}`
  const ctrl = new AbortController()
  const tid = setTimeout(() => ctrl.abort(), 15_000)
  try {
    const res = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' }, signal: ctrl.signal })
    clearTimeout(tid)
    if (!res.ok) throw new Error(`http_${res.status}`)
    const json = (await res.json()) as { success?: boolean; data?: PipedriveNoteListItem[] | null }
    if (!json.success) throw new Error('success_false')
    return json.data ?? []
  } finally {
    clearTimeout(tid)
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

// ── DB row type ──────────────────────────────────────────────────────────

interface Row {
  id: string
  scenario: 'phone_fail' | 'deal_all_fail' | 'pasta_summary'
  deal_id: number
  pasta: string | null
  phone_normalized: string | null
  job_id: string | null
  pipedrive_endpoint: string
  pipedrive_payload_json: string
  pipedrive_response_id: number | null
  pipedrive_response_status: 'retrying' | 'success' | 'failed' | 'deleted'
}

interface PersistedPayload {
  subject?: string
  note?: string
  content?: string
  deal_id?: number | string
}

// ── Pass A — DELETE all phone_fail Activities ────────────────────────────

interface PassACounts {
  total: number
  deleted: number
  notFound: number
  failed: number
  skipped: number
}

async function passA(db: import('better-sqlite3').Database): Promise<PassACounts> {
  console.log('')
  console.log('===== PASS A — DELETE phone_fail Activities =====')

  // We accept rows previously stamped 'deleted' too, so an earlier
  // run that mis-resolved them can re-attempt the actual API DELETE.
  // That's still idempotent: a real DELETE returns 404 the second time
  // and we re-mark as 'deleted'.
  const rows = db
    .prepare(
      `SELECT id, scenario, deal_id, pasta, phone_normalized, job_id,
              pipedrive_endpoint, pipedrive_payload_json,
              pipedrive_response_id, pipedrive_response_status
         FROM pipedrive_activities
        WHERE scenario = 'phone_fail'
          AND pipedrive_response_status IN ('success','deleted')
        ORDER BY created_at ASC`,
    )
    .all() as Row[]

  const counts: PassACounts = { total: rows.length, deleted: 0, notFound: 0, failed: 0, skipped: 0 }
  console.log(`[passA] Candidates: ${counts.total} phone_fail rows to delete`)

  const dealCache = new Map<number, PipedriveActivityListItem[]>()
  const failures: Array<{ id: string; deal_id: number; reason: string }> = []

  const updateLocal = db.prepare(
    `UPDATE pipedrive_activities
        SET pipedrive_response_status = 'deleted',
            completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`,
  )

  let i = 0
  for (const row of rows) {
    i++
    const tag = `[A ${i}/${counts.total}] deal=${row.deal_id} pasta=${row.pasta ?? '-'} job=${row.job_id ?? '-'}`

    // Resolve activity id: persisted first, else walk the deal's activities
    // and match on the Job ID + phone fingerprint.
    let activityId: number | null = row.pipedrive_response_id ?? null
    if (!activityId) {
      let candidates = dealCache.get(row.deal_id)
      if (!candidates) {
        try {
          candidates = await fetchDealActivities(row.deal_id)
          dealCache.set(row.deal_id, candidates)
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          counts.failed++
          failures.push({ id: row.id, deal_id: row.deal_id, reason: `list_failed:${msg}` })
          console.log(`${tag} -> failed(list:${msg})`)
          continue
        }
      }
      const phone = row.phone_normalized ?? ''
      const pretty = phone ? formatBrPhonePretty(phone) : null
      const matches = candidates.filter((c) => {
        const note = c.note ?? ''
        if (!row.job_id) return false
        // Anchor on the Job ID line — must appear regardless of layout.
        // Order from most-recent layout to oldest:
        //   - HTML (post-backfill):      `<strong>Job ID</strong></td><td>JOBID</td>`
        //                          or:   `Job ID</strong></td><td>JOBID`
        //   - Old Markdown (phone fail): `Job ID | `JOBID``
        //   - Older Markdown (deal):     `**Job ID**: `JOBID``
        const hasJob =
          note.includes(`Job ID</strong></td><td>${row.job_id}`)
          || note.includes(`<strong>Job ID</strong></td><td>${row.job_id}`)
          || note.includes(`Job ID | \`${row.job_id}\``)
          || note.includes(`**Job ID**: \`${row.job_id}\``)
          || note.includes(`Job ID:</strong> ${row.job_id}`)
        // Phone match: try normalized AND pretty AND last 4 digits as fallback.
        let hasPhone = !phone
        if (phone) {
          if (note.includes(phone)) hasPhone = true
          else if (pretty && note.includes(pretty)) hasPhone = true
          else if (phone.length >= 4 && note.includes(phone.slice(-4))) hasPhone = true
        }
        return hasJob && hasPhone
      })
      if (matches.length === 1) activityId = matches[0].id
      else if (matches.length > 1) {
        // Multiple matches with the same Job ID + phone substring is unlikely
        // but if it happens we tag the first one (oldest deterministic).
        activityId = matches[0].id
      }
    }

    if (!activityId) {
      // Could not resolve — count as skipped. Mark the row as deleted ANYWAY
      // so future runs don't keep trying. The user explicitly asked us to
      // mark rows whose activities are gone (or unfindable) as deleted.
      counts.skipped++
      console.log(`${tag} -> skipped(unresolved) [marking local row deleted]`)
      if (!dryRun) {
        try { updateLocal.run(row.id) } catch { /* best-effort */ }
      }
      continue
    }

    if (dryRun) {
      counts.deleted++
      console.log(`${tag} -> activity=${activityId} (dry-run DELETE)`)
      continue
    }
    const r = await deleteActivity(activityId)
    if (r.ok && r.status === 404) {
      counts.notFound++
      console.log(`${tag} -> activity=${activityId} not_found(idempotent)`)
      try { updateLocal.run(row.id) } catch { /* ignore */ }
    } else if (r.ok) {
      counts.deleted++
      console.log(`${tag} -> activity=${activityId} DELETED`)
      try { updateLocal.run(row.id) } catch { /* ignore */ }
    } else {
      counts.failed++
      failures.push({ id: row.id, deal_id: row.deal_id, reason: r.error ?? `http_${r.status}` })
      console.log(`${tag} -> failed(${r.error ?? `http_${r.status}`})`)
    }
  }

  if (failures.length > 0) {
    console.log(`[passA] Failures (first 25):`)
    for (const f of failures.slice(0, 25)) {
      console.log(`  - row=${f.id} deal=${f.deal_id} reason=${f.reason}`)
    }
  }
  return counts
}

// ── Pass B — sanitize deal_all_fail Activities ───────────────────────────

interface PassBCounts {
  total: number
  succeeded: number
  skippedAlreadyClean: number
  failed: number
  skipped: number
}

/**
 * Old `deal_all_fail` payloads contain a per-row HTML table — including the
 * literal `<th>Coluna</th>` header. New payloads emit the aggregate phrase
 * `telefones testados, todos inválidos`. The presence of either is a
 * deterministic signal of layout version.
 */
const NEW_LAYOUT_MARKER = 'telefones testados, todos inválidos no WhatsApp'
const NEW_LAYOUT_MARKER_SINGULAR = 'telefone testado, todos inválidos no WhatsApp'
const OLD_LAYOUT_MARKER = '<th>Coluna</th>'

function rebuildDealAllFailPayload(row: Row): { note: string; phoneCount: number } | null {
  let payload: PersistedPayload
  try { payload = JSON.parse(row.pipedrive_payload_json) as PersistedPayload } catch { return null }
  const oldNote = payload.note ?? ''
  if (!oldNote) return null

  // Try to recover the phone count and motivo from the old HTML body so the
  // new aggregate is faithful. Each old row was `<tr><td>...</td>...</tr>`
  // inside `<tbody>`. Count by counting `<tr>` minus the header row.
  const rowMatches = oldNote.match(/<tr>/g) ?? []
  // Old body had thead/tbody — the thead has 1 <tr>, tbody has N <tr>.
  // If thead was present, subtract 1.
  let phoneCount = rowMatches.length
  if (oldNote.includes('<thead>')) phoneCount = Math.max(0, phoneCount - 1)
  if (phoneCount === 0) {
    // Edge: no table — try to count phones[] from any embedded <td> with `(DD) ...`
    const phoneMatches = oldNote.match(/\(\d{2}\) \d{4,5}-\d{4}/g) ?? []
    phoneCount = phoneMatches.length
  }
  // Last resort: at least 1 (we know a deal got archived only if something
  // failed — emitting "0 telefones testados" would be misleading, so we
  // floor at 1 to keep the aggregate truthful).
  if (phoneCount === 0) phoneCount = 1

  const motivoMatch = oldNote.match(/Motivo arquival:?[^>]*>?[^<]*?<\/strong>:?\s*([^<\n]+?)(?:<|$)/i)
    ?? oldNote.match(/\*\*Motivo arquival\*\*:\s*`([^`]+)`/)
  const motivo = (motivoMatch?.[1] ?? 'todos_telefones_invalidos').trim()

  // We need a `phones` array of the right length for the new formatter to
  // count it. The new layout doesn't render any phone data, so column/raw/
  // outcome don't matter — we just need the right count.
  const phones: PipedrivePhoneEntry[] = Array.from({ length: phoneCount }, (_, i) => ({
    column: `telefone_${i + 1}`,
    phone: '0',
    outcome: 'invalid',
    strategy: 'unknown',
    confidence: null,
  }))

  // Recover occurred_at (only used in the rendered timestamp). Try the
  // dedicated <p> we used to emit, fall back to the row's job_id timestamp
  // (the operator never sees this anyway in production timelines).
  const tsMatch = oldNote.match(/Verificação completa[^&<]*&middot;\s*([^<]+)<\/p>/)
    ?? oldNote.match(/\*\*Verificação completa — ([^*]+?)\*\*/)
  const occurred_at = (tsMatch?.[1] ?? new Date().toISOString()).trim()

  const intent: PipedriveDealAllFailIntent = {
    scenario: 'deal_all_fail',
    deal_id: row.deal_id,
    pasta: row.pasta ?? '',
    motivo,
    job_id: row.job_id ?? '',
    occurred_at,
    phones,
  }
  const built = buildDealAllFailActivity(intent, companyDomain)
  return { note: built.payload.note, phoneCount }
}

async function passB(db: import('better-sqlite3').Database): Promise<PassBCounts> {
  console.log('')
  console.log('===== PASS B — sanitize deal_all_fail Activities =====')

  const rows = db
    .prepare(
      `SELECT id, scenario, deal_id, pasta, phone_normalized, job_id,
              pipedrive_endpoint, pipedrive_payload_json,
              pipedrive_response_id, pipedrive_response_status
         FROM pipedrive_activities
        WHERE scenario = 'deal_all_fail'
          AND pipedrive_response_status = 'success'
        ORDER BY created_at ASC`,
    )
    .all() as Row[]

  const counts: PassBCounts = { total: rows.length, succeeded: 0, skippedAlreadyClean: 0, failed: 0, skipped: 0 }
  console.log(`[passB] Candidates: ${counts.total} deal_all_fail rows to sanitize`)

  const dealCache = new Map<number, PipedriveActivityListItem[]>()
  const failures: Array<{ id: string; deal_id: number; reason: string }> = []
  const updateLocalPayload = db.prepare(
    `UPDATE pipedrive_activities SET pipedrive_payload_json = ? WHERE id = ?`,
  )

  let i = 0
  for (const row of rows) {
    i++
    const tag = `[B ${i}/${counts.total}] deal=${row.deal_id} pasta=${row.pasta ?? '-'} job=${row.job_id ?? '-'}`

    // Idempotent guard — already-clean payload?
    let payload: PersistedPayload | null = null
    try { payload = JSON.parse(row.pipedrive_payload_json) as PersistedPayload } catch { payload = null }
    const oldNote = payload?.note ?? ''
    if (oldNote.includes(NEW_LAYOUT_MARKER) || oldNote.includes(NEW_LAYOUT_MARKER_SINGULAR)) {
      counts.skippedAlreadyClean++
      console.log(`${tag} -> skipped(already_clean)`)
      continue
    }

    const rebuilt = rebuildDealAllFailPayload(row)
    if (!rebuilt) {
      counts.skipped++
      console.log(`${tag} -> skipped(parse_failed)`)
      continue
    }

    // Resolve activity id.
    let activityId: number | null = row.pipedrive_response_id ?? null
    if (!activityId) {
      let candidates = dealCache.get(row.deal_id)
      if (!candidates) {
        try {
          candidates = await fetchDealActivities(row.deal_id)
          dealCache.set(row.deal_id, candidates)
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          counts.failed++
          failures.push({ id: row.id, deal_id: row.deal_id, reason: `list_failed:${msg}` })
          console.log(`${tag} -> failed(list:${msg})`)
          continue
        }
      }
      const matches = candidates.filter((c) => {
        const note = c.note ?? ''
        if (!row.job_id) return false
        return note.includes(`**Job ID**: \`${row.job_id}\``)
          || note.includes(`Job ID:</strong> ${row.job_id}`)
          || note.includes(`Job ID</strong></td><td>${row.job_id}`)
          || note.includes(`<strong>Job ID</strong></td><td>${row.job_id}`)
      })
      if (matches.length === 1) activityId = matches[0].id
      else if (matches.length > 1) activityId = matches[0].id
    }
    if (!activityId) {
      counts.skipped++
      console.log(`${tag} -> skipped(no_match)`)
      continue
    }

    if (dryRun) {
      counts.succeeded++
      console.log(`${tag} -> activity=${activityId} (dry-run PUT, ${rebuilt.phoneCount}phones→aggregate)`)
      continue
    }
    const r = await updateActivityNote(activityId, rebuilt.note)
    if (r.ok) {
      counts.succeeded++
      // Persist the new payload locally so subsequent runs see it as already-clean.
      try {
        const newPayload = { ...payload, note: rebuilt.note }
        updateLocalPayload.run(JSON.stringify(newPayload), row.id)
      } catch { /* ignore */ }
      console.log(`${tag} -> activity=${activityId} sanitized (${rebuilt.phoneCount}phones→aggregate)`)
    } else {
      counts.failed++
      failures.push({ id: row.id, deal_id: row.deal_id, reason: r.error ?? `http_${r.status}` })
      console.log(`${tag} -> failed(${r.error ?? `http_${r.status}`})`)
    }
  }

  if (failures.length > 0) {
    console.log(`[passB] Failures (first 25):`)
    for (const f of failures.slice(0, 25)) {
      console.log(`  - row=${f.id} deal=${f.deal_id} reason=${f.reason}`)
    }
  }
  return counts
}

// ── Pass C — verify pasta_summary Notes ──────────────────────────────────

interface PassCCounts {
  total: number
  okAlready: number
  repaired: number
  stillBroken: number
  failed: number
  skipped: number
}

const MD_MARKERS = [
  /^# /m,
  /^## /m,
  /\*\*[^*\n]+\*\*/,
  /\| ---/,
  /\|---/,
]

function looksLikeMarkdown(content: string): boolean {
  return MD_MARKERS.some((re) => re.test(content))
}

function looksLikeProperHtml(content: string): boolean {
  // Empirical signal: content begins with a recognized block tag.
  const trimmed = content.trimStart()
  return trimmed.startsWith('<p') || trimmed.startsWith('<div') || trimmed.startsWith('<table')
}

function rebuildPastaSummaryFromPayload(row: Row): string | null {
  let payload: PersistedPayload
  try { payload = JSON.parse(row.pipedrive_payload_json) as PersistedPayload } catch { return null }
  const oldContent = payload.content ?? ''
  if (!oldContent) return null

  // If the persisted content is the old Markdown, parse the metric numbers
  // from it. Otherwise (already HTML) just re-use it.
  if (looksLikeProperHtml(oldContent)) return oldContent

  // Parse the markdown rows.
  const NUM = '([0-9]+)'
  const periodMatch = oldContent.match(/\*\*Período\*\*: ([^\n]+?) → ([^\n]+)/)
  const totalDealsMatch = oldContent.match(new RegExp(`\\| Deals na pasta \\| ${NUM} \\|`))
  const okDealsMatch = oldContent.match(new RegExp(`\\| Deals com ≥ 1 telefone válido \\| ${NUM} \\(`))
  const archivedDealsMatch = oldContent.match(new RegExp(`\\| Deals 100% inválidos \\(arquivados\\) \\| ${NUM} \\(`))
  const totalPhonesMatch = oldContent.match(new RegExp(`\\| Total fones verificados \\| ${NUM} \\|`))
  const okPhonesMatch = oldContent.match(new RegExp(`\\| Fones existentes no WhatsApp \\| ${NUM} \\(`))
  const adbMatch = oldContent.match(new RegExp(`\\| ADB direto \\| ${NUM} \\|`))
  const wahaMatch = oldContent.match(new RegExp(`\\| WAHA fallback \\| ${NUM} \\|`))
  const cacheMatch = oldContent.match(new RegExp(`\\| Cache hit \\(recente\\) \\| ${NUM} \\|`))
  if (!totalDealsMatch || !okDealsMatch || !archivedDealsMatch
    || !totalPhonesMatch || !okPhonesMatch || !adbMatch || !wahaMatch || !cacheMatch) {
    return null
  }
  const cleanTs = (raw: string): string | null => {
    const v = raw.trim()
    return v === 'n/a' || v === '' ? null : v
  }

  const intent: PipedrivePastaSummaryIntent = {
    scenario: 'pasta_summary',
    pasta: row.pasta ?? '',
    first_deal_id: row.deal_id,
    job_id: row.job_id ?? '',
    job_started: periodMatch ? cleanTs(periodMatch[1]) : null,
    job_ended: periodMatch ? cleanTs(periodMatch[2]) : null,
    total_deals: Number(totalDealsMatch[1]),
    ok_deals: Number(okDealsMatch[1]),
    archived_deals: Number(archivedDealsMatch[1]),
    total_phones_checked: Number(totalPhonesMatch[1]),
    ok_phones: Number(okPhonesMatch[1]),
    strategy_counts: {
      adb: Number(adbMatch[1]),
      waha: Number(wahaMatch[1]),
      cache: Number(cacheMatch[1]),
    },
  }
  return buildPastaSummaryNote(intent, companyDomain).payload.content
}

async function passC(db: import('better-sqlite3').Database): Promise<PassCCounts> {
  console.log('')
  console.log('===== PASS C — verify pasta_summary Notes =====')

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
    .all() as Row[]

  const counts: PassCCounts = { total: rows.length, okAlready: 0, repaired: 0, stillBroken: 0, failed: 0, skipped: 0 }
  console.log(`[passC] Candidates: ${counts.total} pasta_summary note rows to verify`)

  const dealNoteCache = new Map<number, PipedriveNoteListItem[]>()
  const failures: Array<{ id: string; deal_id: number; reason: string }> = []
  const updateLocalPayload = db.prepare(
    `UPDATE pipedrive_activities SET pipedrive_payload_json = ? WHERE id = ?`,
  )

  // Track the empirical finding across rows. We log the very first sample
  // so the operator can see whether Pipedrive is honouring our HTML.
  let sampleLogged = false

  let i = 0
  for (const row of rows) {
    i++
    const tag = `[C ${i}/${counts.total}] deal=${row.deal_id} pasta=${row.pasta ?? '-'} job=${row.job_id ?? '-'}`

    // Resolve note id.
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
          failures.push({ id: row.id, deal_id: row.deal_id, reason: `list_failed:${msg}` })
          console.log(`${tag} -> failed(list:${msg})`)
          continue
        }
      }
      // Match on persisted job_id marker. Old MD layout used backticks;
      // new HTML layout uses <strong>Job ID</strong>: jobid.
      const matches = candidates.filter((c) => {
        const content = c.content ?? ''
        if (!row.job_id) return false
        return content.includes(`**Job ID**: \`${row.job_id}\``)
          || content.includes(`Job ID</strong>: ${row.job_id}`)
          || content.includes(`<strong>Job ID</strong>: ${row.job_id}`)
      })
      if (matches.length === 1) noteId = matches[0].id
      else if (matches.length > 1) noteId = matches[0].id
    }
    if (!noteId) {
      counts.skipped++
      console.log(`${tag} -> skipped(no_match)`)
      continue
    }

    // GET the actual remote content so we can decide based on what Pipedrive
    // is rendering, not what we assume we sent.
    const remote = await fetchSingleNote(noteId)
    if (!remote.ok || remote.content === null) {
      counts.failed++
      failures.push({ id: row.id, deal_id: row.deal_id, reason: `get_failed:${remote.error ?? `http_${remote.status}`}` })
      console.log(`${tag} -> failed(get:${remote.error ?? `http_${remote.status}`})`)
      continue
    }
    const remoteContent = remote.content

    if (!sampleLogged) {
      sampleLogged = true
      const head = remoteContent.slice(0, 200).replace(/\n/g, '\\n')
      console.log(`[passC] EMPIRICAL SAMPLE — note=${noteId} (deal=${row.deal_id}) first 200 chars:`)
      console.log(`[passC]   ${head}`)
      console.log(`[passC]   looksLikeProperHtml=${looksLikeProperHtml(remoteContent)} looksLikeMarkdown=${looksLikeMarkdown(remoteContent)}`)
    }

    // Decision tree:
    //   - remote is HTML and not Markdown → already OK.
    //   - remote is still Markdown → repair via PUT.
    //   - remote starts with `<` but contains MD markers (mixed) → repair.
    if (looksLikeProperHtml(remoteContent) && !looksLikeMarkdown(remoteContent)) {
      counts.okAlready++
      console.log(`${tag} -> note=${noteId} ok_already (HTML, no MD markers)`)
      continue
    }

    // Need to repair. Try to rebuild from persisted payload first; if the
    // persisted payload is already HTML, just re-PUT it.
    const rebuilt = rebuildPastaSummaryFromPayload(row)
    if (!rebuilt) {
      counts.skipped++
      console.log(`${tag} -> skipped(parse_failed)`)
      continue
    }

    if (dryRun) {
      counts.repaired++
      console.log(`${tag} -> note=${noteId} (dry-run PUT)`)
      continue
    }

    const putRes = await updateNoteContent(noteId, rebuilt)
    if (!putRes.ok) {
      counts.failed++
      failures.push({ id: row.id, deal_id: row.deal_id, reason: putRes.error ?? `http_${putRes.status}` })
      console.log(`${tag} -> failed(put:${putRes.error ?? `http_${putRes.status}`})`)
      continue
    }

    // Re-GET to confirm Pipedrive accepted the HTML.
    const verify = await fetchSingleNote(noteId)
    if (verify.ok && verify.content && looksLikeProperHtml(verify.content) && !looksLikeMarkdown(verify.content)) {
      counts.repaired++
      try {
        const payload = JSON.parse(row.pipedrive_payload_json) as PersistedPayload
        payload.content = rebuilt
        updateLocalPayload.run(JSON.stringify(payload), row.id)
      } catch { /* ignore */ }
      console.log(`${tag} -> note=${noteId} REPAIRED (verified HTML)`)
    } else {
      counts.stillBroken++
      const sample = (verify.content ?? '').slice(0, 120).replace(/\n/g, '\\n')
      console.log(`${tag} -> note=${noteId} still_broken (Pipedrive rendered our HTML as text). Verify head: ${sample}`)
      failures.push({
        id: row.id,
        deal_id: row.deal_id,
        reason: 'pipedrive_rendered_html_as_text',
      })
    }
  }

  if (failures.length > 0) {
    console.log(`[passC] Failures (first 25):`)
    for (const f of failures.slice(0, 25)) {
      console.log(`  - row=${f.id} deal=${f.deal_id} reason=${f.reason}`)
    }
  }
  return counts
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`[cleanup] DB: ${dbPath}`)
  console.log(`[cleanup] Pipedrive base: ${baseUrl}`)
  console.log(`[cleanup] Domain: ${companyDomain ?? '(unset)'}`)
  console.log(`[cleanup] Rate: ${ratePerSec} req/s${dryRun ? ' — DRY RUN' : ''}`)

  // We need write access for Passes A/B/C local-row updates.
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')

  const a = await passA(db)
  const b = await passB(db)
  const c = await passC(db)

  db.close()

  console.log('')
  console.log('============================================')
  console.log('[cleanup] FINAL SUMMARY')
  console.log('--- Pass A (DELETE phone_fail) ---')
  console.log(`  total:      ${a.total}`)
  console.log(`  deleted:    ${a.deleted}`)
  console.log(`  not_found:  ${a.notFound}`)
  console.log(`  failed:     ${a.failed}`)
  console.log(`  skipped:    ${a.skipped}`)
  console.log('--- Pass B (sanitize deal_all_fail) ---')
  console.log(`  total:                ${b.total}`)
  console.log(`  succeeded:            ${b.succeeded}`)
  console.log(`  skipped(already_clean): ${b.skippedAlreadyClean}`)
  console.log(`  failed:               ${b.failed}`)
  console.log(`  skipped:              ${b.skipped}`)
  console.log('--- Pass C (verify pasta_summary) ---')
  console.log(`  total:        ${c.total}`)
  console.log(`  ok_already:   ${c.okAlready}`)
  console.log(`  repaired:     ${c.repaired}`)
  console.log(`  still_broken: ${c.stillBroken}`)
  console.log(`  failed:       ${c.failed}`)
  console.log(`  skipped:      ${c.skipped}`)
  console.log('============================================')
}

main().catch((e) => {
  console.error('[cleanup] FATAL:', e)
  process.exit(1)
})
