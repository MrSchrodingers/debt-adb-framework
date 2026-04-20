#!/usr/bin/env node
// Extract full contact names from message bodies (pattern "Olá, <NAME>!")
// and backfill into the authoritative `contacts` table in dispatch.db.
// Also registers each on the correct Android profile (via --user) for WhatsApp pickup.
//
// Priority for the final display_name:
//   1. existing contacts.name in dispatch.db (highest — set by plugin)
//   2. extracted from messages.body
//   3. extracted from message_history.text
// Only writes if the candidate name has ≥ 2 words (audit requires full name).

import { execFileSync } from 'node:child_process'
import Database from '/var/www/adb_tools/node_modules/.pnpm/better-sqlite3@11.10.0/node_modules/better-sqlite3/lib/index.js'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEV = process.argv[2]
const PROFILE = process.argv[3] ?? 'auto'
const DRY_RUN = process.argv.includes('--dry-run')

if (!DEV) {
  console.error('Usage: node scripts/extract-names-from-messages.mjs <device_serial> [profile|auto] [--dry-run]')
  process.exit(1)
}

function adb(...args) { return execFileSync('adb', ['-s', DEV, ...args], { encoding: 'utf8' }) }
function shell(cmd) { return adb('shell', cmd) }

function resolveProfile() {
  if (PROFILE === 'auto') {
    const out = shell('am get-current-user').trim()
    return parseInt(out, 10) || 0
  }
  return parseInt(PROFILE, 10) || 0
}

function detectGoogleAccount() {
  const out = shell('dumpsys account')
  const m = out.match(/Account \{name=([^,}]+),\s*type=com\.google\}/)
  return m ? { type: 'com.google', name: m[1].trim() } : null
}

function pullWaFile(profile, name) {
  const tmpPath = `/tmp/wa-${DEV}-${profile}-${name}`
  shell(`su -c 'cp /data/user/${profile}/com.whatsapp/databases/${name} /sdcard/__wa.db && chmod 644 /sdcard/__wa.db'`)
  adb('pull', '/sdcard/__wa.db', tmpPath)
  return tmpPath
}

function extractGreetingName(body) {
  if (!body) return null
  // Match "Olá, NAME!" or "Ola, NAME!" or "Prezado(a), NAME!" etc.
  const patterns = [
    /Ol[áa],\s*([^!]+?)\s*!/,
    /Prezad[oa]\(?a?\)?,\s*([^!]+?)\s*!/,
    /Bo[mn]\s+(?:dia|tarde|noite),\s*([^!]+?)\s*!/i,
    /Caro\s+([^!,]+?)[!,]/i,
  ]
  for (const p of patterns) {
    const m = body.match(p)
    if (m) {
      const candidate = m[1].trim()
      // reject fragments like "Tudo bem?" or generic greetings
      if (!/^(tudo|bom|boa|ol[áa]|amig|cliente|senhor)/i.test(candidate)) {
        return candidate
      }
    }
  }
  return null
}

function isFullName(name) {
  if (!name || name.length < 3) return false
  // Reject placeholders: "Contato NNNN", digits only, etc
  if (/^contato\s+\d+$/i.test(name.trim())) return false
  if (/^\d+$/.test(name.trim())) return false
  const words = name.trim().split(/\s+/).filter((w) => w.length >= 2 && !/^[|~]/.test(w) && !/^\d+$/.test(w))
  return words.length >= 2
}

async function main() {
  const dbPath = path.resolve(__dirname, '..', 'packages', 'core', 'dispatch.db')
  const db = new Database(dbPath)
  const profile = resolveProfile()
  const google = detectGoogleAccount()
  const acctBinds = google
    ? `--bind account_type:s:${google.type} --bind account_name:s:${google.name}`
    : `--bind account_type:n: --bind account_name:n:`

  console.log(`=== extrair nomes de messages e registrar (device=${DEV} profile=${profile}) ===`)
  console.log(`Account destino: ${google ? `${google.name} (com.google)` : 'Local Phone Account'}`)
  if (DRY_RUN) console.log('*** DRY RUN — não altera nada ***\n')

  // Collect candidates: each phone → best known name (full)
  const candidates = new Map()

  // Priority 1: dispatch.db contacts (plugin-provided)
  for (const r of db.prepare('SELECT phone, name FROM contacts').all()) {
    if (isFullName(r.name)) candidates.set(r.phone, { name: r.name, source: 'contacts' })
  }

  // Priority 2: extract from messages.body
  for (const r of db.prepare('SELECT DISTINCT to_number, body FROM messages WHERE body IS NOT NULL').all()) {
    if (candidates.has(r.to_number)) continue
    const name = extractGreetingName(r.body)
    if (name && isFullName(name)) candidates.set(r.to_number, { name, source: 'messages.body' })
  }

  // Priority 3: extract from message_history.text
  for (const r of db.prepare(`SELECT DISTINCT to_number, text FROM message_history WHERE direction='outgoing' AND text IS NOT NULL`).all()) {
    if (candidates.has(r.to_number)) continue
    const name = extractGreetingName(r.text)
    if (name && isFullName(name)) candidates.set(r.to_number, { name, source: 'message_history.text' })
  }

  // Priority 4: extract from WhatsApp's own msgstore.db (profile-local)
  //   Joins jid_map (LID → phone JID) + message.text_data
  //   Great for chats that bypassed Dispatch entirely
  try {
    const msgstorePath = pullWaFile(profile, 'msgstore.db')
    const msgDb = new Database(msgstorePath, { readonly: true })
    const msgRows = msgDb.prepare(`
      SELECT DISTINCT j.raw_string AS jid, m.text_data AS body
      FROM message m
      JOIN chat c ON c._id = m.chat_row_id
      JOIN jid jlid ON jlid._id = c.jid_row_id
      JOIN jid_map jm ON jm.lid_row_id = jlid._id
      JOIN jid j ON j._id = jm.jid_row_id
      WHERE m.from_me = 1 AND m.text_data LIKE 'Ol%,%'
        AND j.raw_string LIKE '%@s.whatsapp.net'
    `).all()
    for (const r of msgRows) {
      const phone = r.jid.match(/^(\d{10,15})@/)?.[1]
      if (!phone || candidates.has(phone)) continue
      const name = extractGreetingName(r.body)
      if (name && isFullName(name)) candidates.set(phone, { name, source: 'msgstore.text_data' })
    }
    msgDb.close()
  } catch (e) {
    console.warn('  (could not harvest msgstore:', e.message + ')')
  }

  console.log(`${candidates.size} contatos com nome completo encontrados`)

  const userFlag = `--user ${profile}`
  const insertContact = db.prepare('INSERT OR IGNORE INTO contacts (phone, name) VALUES (?, ?)')
  const updateContact = db.prepare('UPDATE contacts SET name = ? WHERE phone = ? AND (name IS NULL OR length(name) < length(?))')

  let created = 0
  let skipped = 0
  let errors = 0

  for (const [phone, { name, source }] of candidates) {
    try {
      // sync dispatch.db contacts (cache central)
      if (!DRY_RUN) {
        insertContact.run(phone, name)
        updateContact.run(name, phone, name)
      }

      // check on device profile
      const existing = shell(`content query ${userFlag} --uri content://com.android.contacts/phone_lookup/${phone} --projection display_name`)
      const deviceHas = existing.includes('display_name=')
      const currentNameOnDevice = existing.match(/display_name=([^,\n]+)/)?.[1]?.trim()

      if (deviceHas && currentNameOnDevice && isFullName(currentNameOnDevice)) {
        skipped++
        continue // already has a full name on device
      }

      if (DRY_RUN) {
        console.log(`  [dry] ${phone} "${name}" (via ${source}) ${deviceHas ? 'updating' : 'creating'}`)
        created++
        continue
      }

      // if device has partial name, delete it first
      if (deviceHas) {
        shell(`content delete ${userFlag} --uri content://com.android.contacts/data --where "data1='${phone}' AND mimetype='vnd.android.cursor.item/phone_v2'"`)
      }

      shell(`content insert ${userFlag} --uri content://com.android.contacts/raw_contacts ${acctBinds}`)
      const idOut = shell(`content query ${userFlag} --uri content://com.android.contacts/raw_contacts --projection _id --sort "_id DESC LIMIT 1"`)
      const rid = idOut.match(/_id=(\d+)/)?.[1]
      if (!rid) throw new Error('no raw_contact_id')
      const safe = name.replace(/'/g, "'\\''")
      shell(`content insert ${userFlag} --uri content://com.android.contacts/data --bind raw_contact_id:i:${rid} --bind mimetype:s:vnd.android.cursor.item/name --bind data1:s:'${safe}'`)
      shell(`content insert ${userFlag} --uri content://com.android.contacts/data --bind raw_contact_id:i:${rid} --bind mimetype:s:vnd.android.cursor.item/phone_v2 --bind data1:s:${phone} --bind data2:i:1`)
      console.log(`  + ${phone} "${name}" (${source})`)
      created++
    } catch (e) {
      console.error(`  ERR ${phone}:`, e.message)
      errors++
    }
  }

  // Report phones that were sent but had no full name found
  const orphans = db.prepare(`
    SELECT DISTINCT to_number FROM messages WHERE status='sent'
    UNION
    SELECT DISTINCT to_number FROM message_history WHERE direction='outgoing'
  `).all()
    .map((r) => r.to_number)
    .filter((p) => p && !candidates.has(p))

  if (orphans.length > 0) {
    console.log(`\n=== ${orphans.length} números SEM nome completo (precisam fonte externa) ===`)
    for (const p of orphans) console.log(`  ${p} — nenhum nome completo encontrado`)
  }

  console.log('\n=== Resumo ===')
  console.log(`  criados/atualizados no device: ${created}`)
  console.log(`  já OK (nome completo local): ${skipped}`)
  console.log(`  erros: ${errors}`)
  console.log(`  órfãos sem nome conhecido: ${orphans.length}`)
  db.close()
}

main().catch((e) => { console.error(e); process.exit(1) })
