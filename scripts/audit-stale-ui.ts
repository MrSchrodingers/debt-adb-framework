#!/usr/bin/env -S node --import tsx
/**
 * Stale-UI audit + bulk re-probe trigger.
 *
 * Identifies adb_precheck_deals.phones_json entries whose most-recent
 * wa_contact_checks row was potentially affected by the stale-UI bug
 * (fixed in commit fed94e19). Optionally marks suspect entries as
 * `outcome='error'` so the existing sweep re-probes them with the
 * fixed code.
 *
 * Usage:
 *   tsx scripts/audit-stale-ui.ts                      # dry-run report (no DB writes)
 *   tsx scripts/audit-stale-ui.ts --mark-suspect       # mark only confirmed-wrong rows
 *   tsx scripts/audit-stale-ui.ts --mark-all-affected  # also mark unverifiable rows
 *
 * Env:
 *   DB_PATH     — path to dispatch.db (default: dispatch.db)
 *   AUDIT_LIMIT — max deals to consider (default: no limit)
 */
import Database from 'better-sqlite3'
import { xmlContainsVariantDigits } from '../packages/core/src/check-strategies/probe-sanity.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PhoneOutcome = 'valid' | 'invalid' | 'error'

interface PhoneResult {
  column: string
  raw: string
  normalized: string
  outcome: PhoneOutcome
  source: string
  confidence: number | null
  variant_tried: string | null
  error: string | null
}

type Verdict =
  | 'verified'
  | 'suspect_mismatch'
  | 'unverifiable'
  | 'no_check'
  | 'error_already'

interface VerdictDetail {
  verdict: Verdict
  matched_rule: string | null
  matched_text_digits_match: boolean | null
  reason: string
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DB_PATH = process.env.DB_PATH ?? 'dispatch.db'
const LIMIT = process.env.AUDIT_LIMIT ? Number(process.env.AUDIT_LIMIT) : null

const flags = new Set(process.argv.slice(2))
const MARK_SUSPECT = flags.has('--mark-suspect') || flags.has('--mark-all-affected')
const MARK_UNVERIFIABLE = flags.has('--mark-all-affected')
const DRY_RUN = !MARK_SUSPECT

if (DRY_RUN) {
  console.log('Mode: DRY-RUN (no DB writes). Pass --mark-suspect or --mark-all-affected to apply.')
} else if (MARK_UNVERIFIABLE) {
  console.log('Mode: MARK-ALL-AFFECTED — both suspect_mismatch AND unverifiable will be flagged as error.')
} else {
  console.log('Mode: MARK-SUSPECT — only confirmed-wrong rows (matched_text mismatch) will be flagged as error.')
}

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

const db = new Database(DB_PATH, { readonly: false })
db.pragma('journal_mode = WAL')

// ---------------------------------------------------------------------------
// Pre-fetch: most-recent decisive check per phone_normalized
// ---------------------------------------------------------------------------

interface LatestCheck {
  phone_normalized: string
  result: string
  matched_rule: string | null
  matched_text: string | null
}

const latestChecks = new Map<string, LatestCheck>()
{
  const rows = db
    .prepare(`
      SELECT phone_normalized, result, evidence, checked_at
      FROM wa_contact_checks
      WHERE source = 'adb_probe' AND result IN ('exists', 'not_exists')
      ORDER BY checked_at DESC
    `)
    .all() as Array<{ phone_normalized: string; result: string; evidence: string | null; checked_at: string }>

  for (const r of rows) {
    if (latestChecks.has(r.phone_normalized)) continue  // already have a more recent one

    let matchedRule: string | null = null
    let matchedText: string | null = null
    if (r.evidence) {
      try {
        const ev = JSON.parse(r.evidence) as { matched_rule?: string; matched_text?: string }
        matchedRule = ev.matched_rule ?? null
        matchedText = ev.matched_text ?? null
      } catch {
        // ignore malformed evidence blobs
      }
    }
    latestChecks.set(r.phone_normalized, {
      phone_normalized: r.phone_normalized,
      result: r.result,
      matched_rule: matchedRule,
      matched_text: matchedText,
    })
  }
}

console.log(`Loaded ${latestChecks.size} decisive checks from wa_contact_checks.`)

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

// Rules where matched_text reliably contains the probed phone number.
// These are the "not on WhatsApp" messages that include the number in the UI.
const VERIFIABLE_RULES = new Set([
  'not_on_whatsapp_pt',
  'not_on_whatsapp_en',
  'not_on_whatsapp_es',
])

function classifyPhone(phone: PhoneResult): VerdictDetail {
  if (phone.outcome === 'error') {
    return {
      verdict: 'error_already',
      matched_rule: null,
      matched_text_digits_match: null,
      reason: 'phone is already flagged as error',
    }
  }

  // Both 'valid' and 'invalid' are decisive outcomes. Only those can be
  // misclassified by the stale-UI bug — re-probe them.
  if (phone.outcome !== 'valid' && phone.outcome !== 'invalid') {
    // Should not happen given PhoneOutcome = 'valid'|'invalid'|'error',
    // but guard against future schema drift.
    return {
      verdict: 'unverifiable',
      matched_rule: null,
      matched_text_digits_match: null,
      reason: `unexpected outcome='${String(phone.outcome)}'`,
    }
  }

  const check = latestChecks.get(phone.normalized)
  if (!check) {
    return {
      verdict: 'no_check',
      matched_rule: null,
      matched_text_digits_match: null,
      reason: 'no decisive wa_contact_checks row found for this phone',
    }
  }

  // Pre-classifier era: evidence had no matched_rule field — can't verify.
  if (!check.matched_rule) {
    return {
      verdict: 'unverifiable',
      matched_rule: null,
      matched_text_digits_match: null,
      reason: 'pre-classifier check (no matched_rule on evidence)',
    }
  }

  if (!VERIFIABLE_RULES.has(check.matched_rule)) {
    // Rules without a phone number in matched_text:
    //   whatsapp_input_field     → chat open, no number visible
    //   whatsapp_invite_cta_id   → legacy resource-id, no display text
    //   invite_button_localized  → button label only
    //   whatsapp_progress_bar    → transient "Searching..." state
    //   searching_text           → transient state
    return {
      verdict: 'unverifiable',
      matched_rule: check.matched_rule,
      matched_text_digits_match: null,
      reason: `matched_rule='${check.matched_rule}' does not carry a phone number in matched_text`,
    }
  }

  // not_on_whatsapp_{pt,en,es} — matched_text contains the phone number shown
  // in the WhatsApp "This number is not on WhatsApp" dialog. Verify it.
  if (!check.matched_text) {
    return {
      verdict: 'unverifiable',
      matched_rule: check.matched_rule,
      matched_text_digits_match: null,
      reason: 'matched_rule carries phone but matched_text was not stored (older row)',
    }
  }

  const digitsMatch = xmlContainsVariantDigits(check.matched_text, phone.normalized)
  return {
    verdict: digitsMatch ? 'verified' : 'suspect_mismatch',
    matched_rule: check.matched_rule,
    matched_text_digits_match: digitsMatch,
    reason: digitsMatch
      ? 'matched_text digits match probed phone'
      : `matched_text shows DIFFERENT number: "${check.matched_text.slice(0, 120)}"`,
  }
}

// ---------------------------------------------------------------------------
// Iterate deals
// ---------------------------------------------------------------------------

interface DealRow {
  pasta: string
  deal_id: number
  contato_tipo: string
  contato_id: number
  phones_json: string
}

const dealRowsQuery = LIMIT
  ? db.prepare(`SELECT pasta, deal_id, contato_tipo, contato_id, phones_json FROM adb_precheck_deals LIMIT ${LIMIT}`)
  : db.prepare(`SELECT pasta, deal_id, contato_tipo, contato_id, phones_json FROM adb_precheck_deals`)

const dealRows = dealRowsQuery.all() as DealRow[]
console.log(`Scanning ${dealRows.length} deals…`)

const counts: Record<Verdict, number> = {
  verified: 0,
  suspect_mismatch: 0,
  unverifiable: 0,
  no_check: 0,
  error_already: 0,
}

const MAX_SAMPLES = 5
const samples: Record<Verdict, Array<{ pasta: string; deal_id: number; phone: string; reason: string }>> = {
  verified: [],
  suspect_mismatch: [],
  unverifiable: [],
  no_check: [],
  error_already: [],
}

// Collect deals that need their phones_json rewritten.
const updatesByDeal = new Map<string, { row: DealRow; phones: PhoneResult[] }>()

for (const deal of dealRows) {
  let phones: PhoneResult[]
  try {
    phones = JSON.parse(deal.phones_json) as PhoneResult[]
  } catch {
    continue
  }

  let dealMutated = false

  for (const phone of phones) {
    const detail = classifyPhone(phone)
    counts[detail.verdict] += 1

    if (samples[detail.verdict].length < MAX_SAMPLES) {
      samples[detail.verdict].push({
        pasta: deal.pasta,
        deal_id: deal.deal_id,
        phone: phone.normalized,
        reason: detail.reason,
      })
    }

    const shouldMark =
      detail.verdict === 'suspect_mismatch' ||
      (detail.verdict === 'unverifiable' && MARK_UNVERIFIABLE)

    if (shouldMark) {
      phone.outcome = 'error'
      phone.error = phone.error
        ? `${phone.error}; stale-ui audit re-mark (${detail.verdict})`
        : `stale-ui audit re-mark (${detail.verdict})`
      dealMutated = true
    }
  }

  if (dealMutated) {
    const key = `${deal.pasta}|${deal.deal_id}|${deal.contato_tipo}|${deal.contato_id}`
    updatesByDeal.set(key, { row: deal, phones })
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

console.log('\n=== Audit summary ===')
const total = Object.values(counts).reduce((a, b) => a + b, 0)
const orderedKeys: Verdict[] = ['verified', 'suspect_mismatch', 'unverifiable', 'no_check', 'error_already']
for (const k of orderedKeys) {
  const pct = total > 0 ? ((counts[k] / total) * 100).toFixed(1) : '0.0'
  console.log(`  ${k.padEnd(22)}: ${String(counts[k]).padStart(5)} (${pct}%)`)
}
console.log(`  ${'TOTAL'.padEnd(22)}: ${String(total).padStart(5)}`)

console.log('\n=== Samples ===')
for (const k of ['suspect_mismatch', 'unverifiable', 'no_check'] as const) {
  if (samples[k].length === 0) continue
  console.log(`\n${k}:`)
  for (const s of samples[k]) {
    console.log(`  pasta=${s.pasta} deal=${s.deal_id} phone=${s.phone}`)
    console.log(`    → ${s.reason}`)
  }
}

// ---------------------------------------------------------------------------
// Writeback (only when a marking flag is set)
// ---------------------------------------------------------------------------

if (DRY_RUN) {
  console.log('\nDry-run only — nothing written.')
  const toMark =
    counts.suspect_mismatch + (MARK_UNVERIFIABLE ? counts.unverifiable : 0)
  console.log(
    `Would mark: ${counts.suspect_mismatch} suspect_mismatch` +
    (MARK_UNVERIFIABLE ? ` + ${counts.unverifiable} unverifiable` : '') +
    ` = ${toMark} phone entries across up to ${updatesByDeal.size} deals.`,
  )
} else if (updatesByDeal.size === 0) {
  console.log('\nNo deals to update.')
} else {
  console.log(`\nWriting back ${updatesByDeal.size} mutated deals…`)

  const upsert = db.prepare(`
    UPDATE adb_precheck_deals
       SET phones_json        = ?,
           valid_count        = ?,
           invalid_count      = ?,
           primary_valid_phone = ?
     WHERE pasta = ? AND deal_id = ? AND contato_tipo = ? AND contato_id = ?
  `)

  const txn = db.transaction(() => {
    for (const { row, phones } of updatesByDeal.values()) {
      const validCount = phones.filter((p) => p.outcome === 'valid').length
      const invalidCount = phones.filter((p) => p.outcome === 'invalid').length
      const primaryValid = phones.find((p) => p.outcome === 'valid')?.normalized ?? null
      upsert.run(
        JSON.stringify(phones),
        validCount,
        invalidCount,
        primaryValid,
        row.pasta,
        row.deal_id,
        row.contato_tipo,
        row.contato_id,
      )
    }
  })
  txn()

  console.log(`✓ Updated ${updatesByDeal.size} deals.`)
  console.log('\nNow trigger the sweep to re-probe the flagged phones:')
  console.log('  curl -X POST http://127.0.0.1:7890/api/v1/plugins/adb-precheck/retry-errors \\')
  console.log('    -H "Authorization: Bearer $TOKEN" \\')
  console.log('    -H "content-type: application/json" \\')
  console.log('    -d \'{"max_deals": 1000}\'')
}

db.close()
