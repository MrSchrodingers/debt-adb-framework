#!/usr/bin/env node
// Harvest names from WhatsApp's own contact cache (wa.db) — where the other
// party set a wa_name — and register them as local contacts on the device.
//
// Target: contacts that show up in chat list as raw phone numbers because:
//   • WhatsApp knows a wa_name (set by the other user)
//   • No local phonebook entry exists
//   • WA shows phone when no local contact maps to the number
//
// Usage:
//   node scripts/sync-wa-names-to-contacts.mjs <device_serial> [profile_id]

import { execFileSync } from 'node:child_process'
import { existsSync, unlinkSync } from 'node:fs'
import Database from '/var/www/adb_tools/node_modules/.pnpm/better-sqlite3@11.10.0/node_modules/better-sqlite3/lib/index.js'

const DEV = process.argv[2]
const PROFILE = process.argv[3] ?? 'auto'
if (!DEV) {
  console.error('Usage: node scripts/sync-wa-names-to-contacts.mjs <device_serial> [profile_id]')
  process.exit(1)
}

function adb(...args) {
  return execFileSync('adb', ['-s', DEV, ...args], { encoding: 'utf8' })
}
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

function pullWaDb(profile) {
  const tmpPath = `/tmp/wa-harvest-${DEV}-${profile}.db`
  if (existsSync(tmpPath)) unlinkSync(tmpPath)
  shell(`su -c 'cp /data/user/${profile}/com.whatsapp/databases/wa.db /sdcard/wa-h.db && chmod 644 /sdcard/wa-h.db'`)
  adb('pull', '/sdcard/wa-h.db', tmpPath)
  return tmpPath
}

function harvestWaNames(waDbPath) {
  const db = new Database(waDbPath, { readonly: true })
  const rows = db.prepare(`
    SELECT jid, COALESCE(wa_name, display_name) AS name, number
    FROM wa_contacts
    WHERE COALESCE(wa_name, display_name) IS NOT NULL
      AND COALESCE(wa_name, display_name) != ''
      AND display_name IS NULL       -- only missing local name
      AND is_whatsapp_user = 1
  `).all()
  db.close()
  // derive number from jid if number column is NULL
  return rows.map((r) => {
    let phone = r.number
    if (!phone && r.jid) {
      const m = r.jid.match(/^(\d{10,15})@/)
      if (m) phone = m[1]
    }
    return { phone, name: r.name?.replace(/[|~]/g, '').trim() }
  }).filter((r) => r.phone && r.name && r.name.length >= 2)
}

async function main() {
  const profile = resolveProfile()
  console.log(`=== harvest names do WA → contacts locais (device=${DEV} profile=${profile}) ===`)

  const google = detectGoogleAccount()
  const acctBinds = google
    ? `--bind account_type:s:${google.type} --bind account_name:s:${google.name}`
    : `--bind account_type:n: --bind account_name:n:`
  console.log('Account destino:', google ? `${google.name} (com.google)` : 'Local Phone Account')

  const waDb = pullWaDb(profile)
  const harvest = harvestWaNames(waDb)
  console.log(`${harvest.length} candidatos com wa_name sem local name`)

  const userFlag = `--user ${profile}`
  let created = 0
  let skipped = 0
  let errors = 0

  for (const { phone, name } of harvest) {
    try {
      const existing = shell(
        `content query ${userFlag} --uri content://com.android.contacts/phone_lookup/${phone} --projection display_name`,
      )
      if (existing.includes('display_name=')) { skipped++; continue }

      shell(`content insert ${userFlag} --uri content://com.android.contacts/raw_contacts ${acctBinds}`)
      const idOut = shell(
        `content query ${userFlag} --uri content://com.android.contacts/raw_contacts --projection _id --sort "_id DESC LIMIT 1"`,
      )
      const rid = idOut.match(/_id=(\d+)/)?.[1]
      if (!rid) throw new Error('no raw_contact_id')
      const safe = name.replace(/'/g, "'\\''")
      shell(`content insert ${userFlag} --uri content://com.android.contacts/data --bind raw_contact_id:i:${rid} --bind mimetype:s:vnd.android.cursor.item/name --bind data1:s:'${safe}'`)
      shell(`content insert ${userFlag} --uri content://com.android.contacts/data --bind raw_contact_id:i:${rid} --bind mimetype:s:vnd.android.cursor.item/phone_v2 --bind data1:s:${phone} --bind data2:i:1`)
      console.log(`  + ${name} (${phone}) rawId=${rid}`)
      created++
    } catch (e) {
      console.error(`  ERR ${phone} "${name}":`, e.message)
      errors++
    }
  }

  console.log('\n=== Resumo ===')
  console.log(`  criados: ${created}`)
  console.log(`  já existiam: ${skipped}`)
  console.log(`  erros: ${errors}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
