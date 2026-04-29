#!/usr/bin/env tsx
/**
 * backfill-pipedrive-activities.ts
 *
 * **OBSOLETE (2026-04-29).** This script was a one-time Markdown→HTML
 * migration for Activities. The new noise-reduction work supersedes it:
 *   - `phone_fail` Activities are no longer emitted (and the cleanup
 *     script DELETES historical ones).
 *   - `deal_all_fail` Activities now use a sanitized HTML body.
 * Use `scripts/cleanup-pipedrive-pollution.ts` instead. This file is kept
 * for reference/audit only.
 *
 * Original purpose:
 * One-shot operational tool. Repairs every Pipedrive Activity that was
 * created with the old Markdown formatter (which Pipedrive does not render —
 * shows raw MD source on a single line). Replaces each activity's `note`
 * with the new HTML payload produced by the fixed formatter.
 *
 * Why this exists:
 *   - Pipedrive Activity `note` accepts a tiny HTML safelist; Markdown is
 *     rendered as raw text. We previously emitted Markdown for activities,
 *     which produced visually broken cards on the deal page.
 *   - Notes (pasta_summary scenario) DO render Markdown — they are unchanged
 *     and skipped here.
 *
 * Why we re-discover the Pipedrive activity id:
 *   - The original publisher persisted the *outgoing* payload but not the
 *     Pipedrive `data.id` from the response, so we have no direct foreign key.
 *   - We resolve it by querying `GET /v1/deals/{deal_id}/activities` and
 *     matching by deterministic markers in the existing `note`:
 *       phone_fail   → matches on the persisted Job ID line AND the phone
 *       deal_all_fail→ matches on the persisted Job ID line
 *
 * Idempotency:
 *   - Running twice is a no-op for the second run because the new HTML body
 *     no longer contains the old Markdown markers, so the resolver simply
 *     finds zero candidates and we count it as `skipped(no_match)`. This is
 *     safe — failed/skipped rows are logged and the script completes.
 *
 * Rate limit: same 10 req/s ceiling the publisher uses.
 *
 * Usage (Kali, from project root):
 *   pnpm --filter @dispatch/core exec tsx ../../scripts/backfill-pipedrive-activities.ts
 *   # or with dotenv:
 *   node --env-file=packages/core/.env --import tsx scripts/backfill-pipedrive-activities.ts
 */

import { createRequire } from 'node:module'
import {
  buildDealAllFailActivity,
  buildPhoneFailActivity,
  formatBrPhonePretty,
} from '../packages/core/src/plugins/adb-precheck/pipedrive-formatter.js'
import type {
  PipedriveDealAllFailIntent,
  PipedrivePhoneFailIntent,
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
  console.error('[backfill] FATAL: PIPEDRIVE_API_TOKEN is not set in env. Aborting.')
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
// We persisted only the outgoing *payload* (subject/note), not the original
// intent. The note's Markdown is deterministic, so we parse it back into the
// fields the new formatter needs. This is fragile by design — the old format
// is fixed and was emitted by exactly one code path.

interface PersistedPayload {
  subject?: string
  note?: string
  deal_id?: number | string
}

interface PhoneFailFields {
  occurred_at: string
  column: string
  strategy: string
  cache_ttl_days: number | undefined
  phone: string
}

function parsePhoneFailNote(md: string, persistedPhone: string): PhoneFailFields | null {
  const tsMatch = md.match(/\*\*Verificação adb-precheck — ([^*]+?)\*\*/)
  const colMatch = md.match(/\| Coluna em prov_consultas \| `([^`]+)` \|/)
  const stratMatch = md.match(/\| Validado via \| ([^|]+?)\s*\|/)
  const ttlMatch = md.match(/_Validation cache TTL: (\d+) dias_/)

  if (!tsMatch || !colMatch || !stratMatch) return null
  return {
    occurred_at: tsMatch[1].trim(),
    column: colMatch[1].trim(),
    strategy: humanStrategyToCode(stratMatch[1].trim()),
    cache_ttl_days: ttlMatch ? Number(ttlMatch[1]) : undefined,
    phone: persistedPhone,
  }
}

interface DealAllFailFields {
  occurred_at: string
  motivo: string
  phones: PipedrivePhoneEntry[]
}

function parseDealAllFailNote(md: string): DealAllFailFields | null {
  const tsMatch = md.match(/\*\*Verificação completa — ([^*]+?)\*\*/)
  const motivoMatch = md.match(/\*\*Motivo arquival\*\*: `([^`]+)`/)
  const rowRe = /\| `([^`]+)` \| `([^`]+)` \| (❌ Não existe|⚠️ Erro de validação|✅ OK) \|/g
  const phones: PipedrivePhoneEntry[] = []
  let m: RegExpExecArray | null
  while ((m = rowRe.exec(md)) !== null) {
    const outcome: PipedrivePhoneEntry['outcome'] = m[3].startsWith('❌')
      ? 'invalid'
      : m[3].startsWith('⚠️')
        ? 'error'
        : 'valid'
    phones.push({
      column: m[1],
      phone: m[2],
      outcome,
      strategy: 'unknown',
      confidence: null,
    })
  }

  if (!tsMatch || !motivoMatch || phones.length === 0) return null
  return {
    occurred_at: tsMatch[1].trim(),
    motivo: motivoMatch[1].trim(),
    phones,
  }
}

function humanStrategyToCode(label: string): string {
  if (label === 'Cache (recente)') return 'cache'
  if (label === 'ADB direto') return 'adb'
  if (label === 'WAHA fallback') return 'waha'
  return label
}

// ── Pipedrive HTTP helpers ───────────────────────────────────────────────

interface PipedriveActivityListItem {
  id: number
  note?: string | null
  type?: string | null
}

async function fetchDealActivities(dealId: number): Promise<PipedriveActivityListItem[]> {
  await bucket.take()
  const url = `${baseUrl}deals/${dealId}/activities?limit=500&api_token=${encodeURIComponent(apiToken!)}`
  const ctrl = new AbortController()
  const tid = setTimeout(() => ctrl.abort(), 15_000)
  try {
    const res = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' }, signal: ctrl.signal })
    clearTimeout(tid)
    if (!res.ok) {
      throw new Error(`http_${res.status}`)
    }
    const json = (await res.json()) as { success?: boolean; data?: PipedriveActivityListItem[] | null }
    if (!json.success) throw new Error('success_false')
    return json.data ?? []
  } finally {
    clearTimeout(tid)
  }
}

async function updateActivityNote(activityId: number, note: string): Promise<{ status: number; error?: string }> {
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
      return { status: res.status, error: `http_${res.status}: ${text.slice(0, 200)}` }
    }
    return { status: res.status }
  } catch (e) {
    clearTimeout(tid)
    return { status: 0, error: e instanceof Error ? e.message : String(e) }
  }
}

// ── Activity match (resolver) ────────────────────────────────────────────

function findMatchingActivityId(
  candidates: PipedriveActivityListItem[],
  row: Row,
): number | null {
  if (!row.job_id) return null
  const filtered = candidates.filter((c) => typeof c.note === 'string' && c.note.length > 0)

  if (row.scenario === 'phone_fail') {
    const phone = row.phone_normalized
    const pretty = phone ? formatBrPhonePretty(phone) : null
    const matches = filtered.filter((c) => {
      const note = c.note!
      if (!note.includes(`Job ID | \`${row.job_id}\``)) return false
      if (phone && note.includes(phone)) return true
      if (pretty && note.includes(pretty)) return true
      return false
    })
    return matches.length === 1 ? matches[0].id : null
  }
  if (row.scenario === 'deal_all_fail') {
    const matches = filtered.filter((c) => {
      const note = c.note!
      return note.includes(`**Job ID**: \`${row.job_id}\``)
    })
    return matches.length === 1 ? matches[0].id : null
  }
  return null
}

// ── Body regenerator ─────────────────────────────────────────────────────

function regenerateNote(row: Row): string | null {
  let payload: PersistedPayload
  try {
    payload = JSON.parse(row.pipedrive_payload_json) as PersistedPayload
  } catch {
    return null
  }
  const oldNote = payload.note ?? ''
  if (!oldNote) return null

  if (row.scenario === 'phone_fail') {
    const fields = parsePhoneFailNote(oldNote, row.phone_normalized ?? '')
    if (!fields) return null
    const intent: PipedrivePhoneFailIntent = {
      scenario: 'phone_fail',
      deal_id: row.deal_id,
      pasta: row.pasta ?? '',
      phone: fields.phone,
      column: fields.column,
      strategy: fields.strategy,
      confidence: null,
      job_id: row.job_id ?? '',
      occurred_at: fields.occurred_at,
      cache_ttl_days: fields.cache_ttl_days,
    }
    return buildPhoneFailActivity(intent, companyDomain).payload.note
  }
  if (row.scenario === 'deal_all_fail') {
    const fields = parseDealAllFailNote(oldNote)
    if (!fields) return null
    const intent: PipedriveDealAllFailIntent = {
      scenario: 'deal_all_fail',
      deal_id: row.deal_id,
      pasta: row.pasta ?? '',
      motivo: fields.motivo,
      job_id: row.job_id ?? '',
      occurred_at: fields.occurred_at,
      phones: fields.phones,
    }
    return buildDealAllFailActivity(intent, companyDomain).payload.note
  }
  return null
}

// ── Main ─────────────────────────────────────────────────────────────────

interface Counts {
  total: number
  succeeded: number
  failed: number
  skipped: number
}

async function main(): Promise<void> {
  console.log(`[backfill] DB: ${dbPath}`)
  console.log(`[backfill] Pipedrive base: ${baseUrl}`)
  console.log(`[backfill] Domain: ${companyDomain ?? '(unset)'}`)
  console.log(`[backfill] Rate: ${ratePerSec} req/s${dryRun ? ' — DRY RUN' : ''}`)
  const db = new Database(dbPath, { readonly: true })

  const rows = db
    .prepare(
      `SELECT id, scenario, deal_id, pasta, phone_normalized, job_id,
              pipedrive_endpoint, pipedrive_payload_json,
              pipedrive_response_id, pipedrive_response_status
         FROM pipedrive_activities
        WHERE pipedrive_response_status = 'success'
          AND pipedrive_endpoint = '/activities'
        ORDER BY created_at ASC`,
    )
    .all() as Row[]

  const counts: Counts = { total: rows.length, succeeded: 0, failed: 0, skipped: 0 }
  console.log(`[backfill] Candidates: ${counts.total} activity rows to repair`)

  const dealCache = new Map<number, PipedriveActivityListItem[]>()
  const failures: Array<{ id: string; deal_id: number; reason: string }> = []

  let i = 0
  for (const row of rows) {
    i++
    const tag = `[${i}/${counts.total}] deal=${row.deal_id} scenario=${row.scenario} job=${row.job_id ?? '-'}`

    const newNote = regenerateNote(row)
    if (!newNote) {
      counts.skipped++
      console.log(`${tag} -> skipped(parse_failed)`)
      continue
    }

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
    const activityId = findMatchingActivityId(candidates, row)
    if (!activityId) {
      counts.skipped++
      console.log(`${tag} -> skipped(no_match)`)
      continue
    }

    if (dryRun) {
      counts.succeeded++
      console.log(`${tag} -> activity=${activityId} (dry-run)`)
      continue
    }
    const result = await updateActivityNote(activityId, newNote)
    if (result.status >= 200 && result.status < 300) {
      counts.succeeded++
      console.log(`${tag} -> activity=${activityId} updated`)
    } else {
      counts.failed++
      failures.push({ id: row.id, deal_id: row.deal_id, reason: result.error ?? `http_${result.status}` })
      console.log(`${tag} -> failed(${result.error ?? `http_${result.status}`})`)
    }
  }

  db.close()

  console.log('')
  console.log('============================================')
  console.log('[backfill] FINAL SUMMARY')
  console.log(`  total:     ${counts.total}`)
  console.log(`  succeeded: ${counts.succeeded}`)
  console.log(`  failed:    ${counts.failed}`)
  console.log(`  skipped:   ${counts.skipped}`)
  console.log('============================================')
  if (failures.length > 0) {
    console.log('[backfill] Failures (first 25):')
    for (const f of failures.slice(0, 25)) {
      console.log(`  - row=${f.id} deal=${f.deal_id} reason=${f.reason}`)
    }
  }
}

main().catch((e) => {
  console.error('[backfill] FATAL:', e)
  process.exit(1)
})
