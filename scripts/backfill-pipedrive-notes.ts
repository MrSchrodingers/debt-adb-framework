#!/usr/bin/env tsx
/**
 * backfill-pipedrive-notes.ts
 *
 * One-shot operational tool. Repairs every Pipedrive Note created with the
 * old Markdown formatter for the `pasta_summary` scenario. Replaces each
 * note's `content` with the new HTML payload produced by the fixed
 * formatter.
 *
 * Why this exists:
 *   - Pipedrive's POST /v1/notes endpoint also renders content through a
 *     constrained HTML safelist; raw Markdown shows as collapsed source.
 *     We previously emitted Markdown for `pasta_summary` notes, which
 *     produced visually broken cards on the deal timeline.
 *   - This script is the Notes counterpart to backfill-pipedrive-activities
 *     (which repaired phone_fail / deal_all_fail Activities).
 *
 * Why we re-discover the Pipedrive note id:
 *   - The original publisher persisted the *outgoing* payload but not the
 *     Pipedrive `data.id` from the response, so we have no direct foreign
 *     key for older rows. Newer rows (post-2026-04-29 publisher fix) DO
 *     persist `pipedrive_response_id`, and we use it directly when present.
 *   - For older rows we resolve via `GET /v1/deals/{deal_id}/notes` and
 *     match on the persisted Job ID marker that appears in the body
 *     (`Job ID`: `{job_id}` for the old Markdown layout).
 *
 * Idempotency:
 *   - Running twice is a no-op for the second run because the new HTML body
 *     starts with `<p>` and the resolver/regenerator both detect that and
 *     short-circuit. The script counts these as `skipped(idempotent)`.
 *   - Concretely: if the persisted payload's `content` already starts with
 *     `<p>` we skip without touching Pipedrive.
 *
 * Rate limit: same 10 req/s ceiling the publisher uses.
 *
 * Usage (Kali, from project root):
 *   pnpm --filter @dispatch/core exec tsx ../../scripts/backfill-pipedrive-notes.ts
 *   # or with dotenv:
 *   node --env-file=packages/core/.env --import tsx scripts/backfill-pipedrive-notes.ts
 */

import { createRequire } from 'node:module'
import { buildPastaSummaryNote } from '../packages/core/src/plugins/adb-precheck/pipedrive-formatter.js'
import type { PipedrivePastaSummaryIntent } from '../packages/core/src/plugins/adb-precheck/types.js'

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
  console.error('[backfill-notes] FATAL: PIPEDRIVE_API_TOKEN is not set in env. Aborting.')
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
  pipedrive_response_status: 'retrying' | 'success' | 'failed'
}

// ── Markdown -> intent reverse parser ────────────────────────────────────
//
// We persisted only the outgoing *payload* (content), not the original
// intent. The note's Markdown is deterministic, so we parse it back into the
// fields the new formatter needs. This is fragile by design — the old format
// is fixed and was emitted by exactly one code path.

interface PersistedPayload {
  content?: string
  deal_id?: number | string
}

interface PastaSummaryFields {
  job_started: string | null
  job_ended: string | null
  total_deals: number
  ok_deals: number
  archived_deals: number
  total_phones_checked: number
  ok_phones: number
  strategy_counts: { adb: number; waha: number; cache: number }
}

const NUM = '([0-9]+)'

function parsePastaSummaryNote(md: string): PastaSummaryFields | null {
  // The old Markdown layout emitted by buildPastaSummaryNote() pre-2026-04-29.
  // Period is "**Período**: {start} → {end}" with literal "n/a" when null.
  const periodMatch = md.match(/\*\*Período\*\*: ([^\n]+?) → ([^\n]+)/)
  // Metric rows look like: `| Deals na pasta | 50 |`
  const totalDealsMatch = md.match(new RegExp(`\\| Deals na pasta \\| ${NUM} \\|`))
  const okDealsMatch = md.match(new RegExp(`\\| Deals com ≥ 1 telefone válido \\| ${NUM} \\(`))
  const archivedDealsMatch = md.match(new RegExp(`\\| Deals 100% inválidos \\(arquivados\\) \\| ${NUM} \\(`))
  const totalPhonesMatch = md.match(new RegExp(`\\| Total fones verificados \\| ${NUM} \\|`))
  const okPhonesMatch = md.match(new RegExp(`\\| Fones existentes no WhatsApp \\| ${NUM} \\(`))
  const adbMatch = md.match(new RegExp(`\\| ADB direto \\| ${NUM} \\|`))
  const wahaMatch = md.match(new RegExp(`\\| WAHA fallback \\| ${NUM} \\|`))
  const cacheMatch = md.match(new RegExp(`\\| Cache hit \\(recente\\) \\| ${NUM} \\|`))

  if (!totalDealsMatch || !okDealsMatch || !archivedDealsMatch
    || !totalPhonesMatch || !okPhonesMatch || !adbMatch || !wahaMatch || !cacheMatch) {
    return null
  }

  const cleanTs = (raw: string): string | null => {
    const v = raw.trim()
    return v === 'n/a' || v === '' ? null : v
  }

  return {
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
}

// ── Pipedrive HTTP helpers ───────────────────────────────────────────────

interface PipedriveNoteListItem {
  id: number
  content?: string | null
  deal_id?: number | null
}

async function fetchDealNotes(dealId: number): Promise<PipedriveNoteListItem[]> {
  await bucket.take()
  // `GET /v1/notes?deal_id={id}&limit=500` is the canonical filter; the
  // /deals/{id}/notes form is undocumented for v1 in some Pipedrive accounts.
  const url = `${baseUrl}notes?deal_id=${dealId}&limit=500&api_token=${encodeURIComponent(apiToken!)}`
  const ctrl = new AbortController()
  const tid = setTimeout(() => ctrl.abort(), 15_000)
  try {
    const res = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' }, signal: ctrl.signal })
    clearTimeout(tid)
    if (!res.ok) {
      throw new Error(`http_${res.status}`)
    }
    const json = (await res.json()) as { success?: boolean; data?: PipedriveNoteListItem[] | null }
    if (!json.success) throw new Error('success_false')
    return json.data ?? []
  } finally {
    clearTimeout(tid)
  }
}

async function updateNoteContent(noteId: number, content: string): Promise<{ status: number; error?: string }> {
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
      return { status: res.status, error: `http_${res.status}: ${text.slice(0, 200)}` }
    }
    return { status: res.status }
  } catch (e) {
    clearTimeout(tid)
    return { status: 0, error: e instanceof Error ? e.message : String(e) }
  }
}

// ── Note match (resolver) ────────────────────────────────────────────────
//
// The old Markdown layout always contained a literal `**Job ID**: \`{job_id}\``
// line; we use that as the deterministic anchor.

function findMatchingNoteId(
  candidates: PipedriveNoteListItem[],
  row: Row,
): number | null {
  if (!row.job_id) return null
  const filtered = candidates.filter((c) => typeof c.content === 'string' && c.content.length > 0)
  const matches = filtered.filter((c) => {
    const content = c.content!
    // Old Markdown marker — Pipedrive does not strip backticks even when
    // the rest of the body is shown raw, so this is a reliable fingerprint.
    return content.includes(`**Job ID**: \`${row.job_id}\``)
  })
  return matches.length === 1 ? matches[0].id : null
}

// ── Body regenerator ─────────────────────────────────────────────────────

function regenerateContent(row: Row): string | null {
  let payload: PersistedPayload
  try {
    payload = JSON.parse(row.pipedrive_payload_json) as PersistedPayload
  } catch {
    return null
  }
  const oldContent = payload.content ?? ''
  if (!oldContent) return null
  // Idempotent guard — we already migrated this row.
  if (oldContent.startsWith('<p>')) return null

  const fields = parsePastaSummaryNote(oldContent)
  if (!fields) return null
  const intent: PipedrivePastaSummaryIntent = {
    scenario: 'pasta_summary',
    pasta: row.pasta ?? '',
    first_deal_id: row.deal_id,
    job_id: row.job_id ?? '',
    job_started: fields.job_started,
    job_ended: fields.job_ended,
    total_deals: fields.total_deals,
    ok_deals: fields.ok_deals,
    archived_deals: fields.archived_deals,
    total_phones_checked: fields.total_phones_checked,
    ok_phones: fields.ok_phones,
    strategy_counts: fields.strategy_counts,
  }
  return buildPastaSummaryNote(intent, companyDomain).payload.content
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
  console.log(`[backfill-notes] DB: ${dbPath}`)
  console.log(`[backfill-notes] Pipedrive base: ${baseUrl}`)
  console.log(`[backfill-notes] Domain: ${companyDomain ?? '(unset)'}`)
  console.log(`[backfill-notes] Rate: ${ratePerSec} req/s${dryRun ? ' — DRY RUN' : ''}`)
  const db = new Database(dbPath, { readonly: true })

  const rows = db
    .prepare(
      `SELECT id, scenario, deal_id, pasta, phone_normalized, job_id,
              pipedrive_endpoint, pipedrive_payload_json,
              pipedrive_response_id, pipedrive_response_status
         FROM pipedrive_activities
        WHERE pipedrive_response_status = 'success'
          AND pipedrive_endpoint = '/notes'
          AND scenario = 'pasta_summary'
        ORDER BY created_at ASC`,
    )
    .all() as Row[]

  const counts: Counts = { total: rows.length, succeeded: 0, failed: 0, skipped: 0, skippedIdempotent: 0 }
  console.log(`[backfill-notes] Candidates: ${counts.total} pasta_summary note rows to repair`)

  const dealCache = new Map<number, PipedriveNoteListItem[]>()
  const failures: Array<{ id: string; deal_id: number; reason: string }> = []

  let i = 0
  for (const row of rows) {
    i++
    const tag = `[${i}/${counts.total}] deal=${row.deal_id} pasta=${row.pasta ?? '-'} job=${row.job_id ?? '-'}`

    // Cheap idempotency check before any HTTP call.
    let payload: PersistedPayload | null = null
    try {
      payload = JSON.parse(row.pipedrive_payload_json) as PersistedPayload
    } catch {
      // fall through — regenerateContent() will handle it
    }
    if (payload?.content && payload.content.startsWith('<p>')) {
      counts.skippedIdempotent++
      console.log(`${tag} -> skipped(idempotent)`)
      continue
    }

    const newContent = regenerateContent(row)
    if (!newContent) {
      counts.skipped++
      console.log(`${tag} -> skipped(parse_failed)`)
      continue
    }

    // Try to use the persisted Pipedrive id first (fast-path for new rows).
    let noteId: number | null = row.pipedrive_response_id ?? null
    if (!noteId) {
      let candidates = dealCache.get(row.deal_id)
      if (!candidates) {
        try {
          candidates = await fetchDealNotes(row.deal_id)
          dealCache.set(row.deal_id, candidates)
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          counts.failed++
          failures.push({ id: row.id, deal_id: row.deal_id, reason: `list_failed:${msg}` })
          console.log(`${tag} -> failed(list:${msg})`)
          continue
        }
      }
      noteId = findMatchingNoteId(candidates, row)
    }
    if (!noteId) {
      counts.skipped++
      console.log(`${tag} -> skipped(no_match)`)
      continue
    }

    if (dryRun) {
      counts.succeeded++
      console.log(`${tag} -> note=${noteId} (dry-run)`)
      continue
    }
    const result = await updateNoteContent(noteId, newContent)
    if (result.status >= 200 && result.status < 300) {
      counts.succeeded++
      console.log(`${tag} -> note=${noteId} updated`)
    } else {
      counts.failed++
      failures.push({ id: row.id, deal_id: row.deal_id, reason: result.error ?? `http_${result.status}` })
      console.log(`${tag} -> failed(${result.error ?? `http_${result.status}`})`)
    }
  }

  db.close()

  console.log('')
  console.log('============================================')
  console.log('[backfill-notes] FINAL SUMMARY')
  console.log(`  total:              ${counts.total}`)
  console.log(`  succeeded:          ${counts.succeeded}`)
  console.log(`  failed:             ${counts.failed}`)
  console.log(`  skipped:            ${counts.skipped}`)
  console.log(`  skipped(idempotent):${counts.skippedIdempotent}`)
  console.log('============================================')
  if (failures.length > 0) {
    console.log('[backfill-notes] Failures (first 25):')
    for (const f of failures.slice(0, 25)) {
      console.log(`  - row=${f.id} deal=${f.deal_id} reason=${f.reason}`)
    }
  }
}

main().catch((e) => {
  console.error('[backfill-notes] FATAL:', e)
  process.exit(1)
})
