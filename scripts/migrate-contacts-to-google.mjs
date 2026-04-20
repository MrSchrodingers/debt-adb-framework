#!/usr/bin/env node
// Migrate contacts from "Local Phone Account" to the device's Google account
// so WhatsApp picks them up in its contact sync.
//
// Usage:
//   node scripts/migrate-contacts-to-google.mjs <device_serial>
//
// Reads every raw_contact in Local Phone Account, extracts its name + phones,
// re-creates it in the Google account, then deletes the original Local row.

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import Database from '/var/www/adb_tools/node_modules/.pnpm/better-sqlite3@11.10.0/node_modules/better-sqlite3/lib/index.js'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEVICE = process.argv[2]
const USER_ARG = process.argv[3] ?? 'current'
if (!DEVICE) {
  console.error('Usage: node scripts/migrate-contacts-to-google.mjs <device_serial> [user|all|current]')
  process.exit(1)
}

function adb(...args) {
  const res = execFileSync('adb', ['-s', DEVICE, ...args], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  return res
}

function shell(cmd) {
  return adb('shell', cmd)
}

// All `content` commands need --user flag to target the correct profile's ContactsProvider
let USER_FLAG = ''
function contentCmd(op, rest) {
  return `content ${op} ${USER_FLAG} ${rest}`
}

function resolveUsers() {
  if (USER_ARG === 'all') {
    const out = shell('pm list users')
    const ids = [...out.matchAll(/UserInfo\{(\d+):/g)].map((m) => parseInt(m[1], 10))
    return ids
  }
  if (USER_ARG === 'current') {
    const out = shell('am get-current-user').trim()
    return [parseInt(out, 10) || 0]
  }
  return [parseInt(USER_ARG, 10) || 0]
}

function detectGoogleAccount() {
  // dumpsys account groups accounts by user id
  const out = shell('dumpsys account')
  const m = out.match(/Account \{name=([^,}]+),\s*type=com\.google\}/)
  if (!m) return null
  return { type: 'com.google', name: m[1].trim() }
}

function listLocalRawContacts() {
  const out = shell(
    `content query ${USER_FLAG} --uri content://com.android.contacts/raw_contacts --where "account_type='Local Phone Account'" --projection _id`,
  )
  return [...out.matchAll(/_id=(\d+)/g)].map((m) => m[1])
}

function getRawContactData(rawId) {
  const out = shell(
    `content query ${USER_FLAG} --uri content://com.android.contacts/data --where "raw_contact_id=${rawId}" --projection mimetype`,
  )
  const names = []
  const phones = []
  // list mimetypes; then fetch per mimetype for data1
  const rows = out.split('\n').filter((l) => l.startsWith('Row:'))
  for (const row of rows) {
    const mime = row.match(/mimetype=(\S+)/)?.[1] ?? ''
    if (mime === 'vnd.android.cursor.item/name') {
      const d = shell(
        `content query ${USER_FLAG} --uri content://com.android.contacts/data --where "raw_contact_id=${rawId} AND mimetype='vnd.android.cursor.item/name'" --projection data1`,
      )
      const n = d.match(/data1=([^,\n]+)/)?.[1]
      if (n) names.push(n.trim())
    } else if (mime === 'vnd.android.cursor.item/phone_v2') {
      const d = shell(
        `content query ${USER_FLAG} --uri content://com.android.contacts/data --where "raw_contact_id=${rawId} AND mimetype='vnd.android.cursor.item/phone_v2'" --projection data1`,
      )
      for (const m of d.matchAll(/data1=([^,\n]+)/g)) phones.push(m[1].trim())
    }
  }
  return { names: [...new Set(names)], phones: [...new Set(phones)] }
}

function createInGoogle(account, name, phone) {
  // 1. insert raw_contact
  shell(
    `content insert ${USER_FLAG} --uri content://com.android.contacts/raw_contacts --bind account_type:s:${account.type} --bind account_name:s:${account.name}`,
  )
  // 2. get new id
  const idOut = shell(
    `content query ${USER_FLAG} --uri content://com.android.contacts/raw_contacts --projection _id --sort "_id DESC LIMIT 1"`,
  )
  const newId = idOut.match(/_id=(\d+)/)?.[1]
  if (!newId) throw new Error('failed to get new raw_contact_id')
  // 3. insert name
  const safeName = name.replace(/'/g, "'\\''")
  shell(
    `content insert ${USER_FLAG} --uri content://com.android.contacts/data --bind raw_contact_id:i:${newId} --bind mimetype:s:vnd.android.cursor.item/name --bind data1:s:'${safeName}'`,
  )
  // 4. insert phone
  shell(
    `content insert ${USER_FLAG} --uri content://com.android.contacts/data --bind raw_contact_id:i:${newId} --bind mimetype:s:vnd.android.cursor.item/phone_v2 --bind data1:s:${phone} --bind data2:i:1`,
  )
  return newId
}

function deleteRawContact(rawId) {
  shell(`content delete ${USER_FLAG} --uri content://com.android.contacts/raw_contacts --where "_id=${rawId}"`)
}

function loadDbContactNames() {
  const dbPath = path.resolve(__dirname, '..', 'packages', 'core', 'dispatch.db')
  if (!existsSync(dbPath)) {
    console.warn('WARN: dispatch.db not found, will trust on-device names')
    return new Map()
  }
  const db = new Database(dbPath, { readonly: true })
  const rows = db.prepare('SELECT phone, name FROM contacts').all()
  db.close()
  const map = new Map()
  for (const r of rows) map.set(r.phone, r.name)
  return map
}

function runForUser(userId, dbNames) {
  USER_FLAG = `--user ${userId}`
  console.log(`\n--- profile/user ${userId} ---`)

  const googleAccount = detectGoogleAccount()
  const fallbackAccount = { type: null, name: null }
  const account = googleAccount ?? fallbackAccount
  console.log(`  conta destino: ${googleAccount ? `${account.name} (com.google)` : 'Local Phone Account (sem Google neste profile)'}`)

  const localIds = listLocalRawContacts()
  console.log(`  ${localIds.length} raw_contacts no Local Phone Account`)

  const stats = { migrated: 0, skipped: 0, errors: 0 }

  for (const rawId of localIds) {
    try {
      const { names, phones } = getRawContactData(rawId)
      if (phones.length === 0) { stats.skipped++; continue }
      for (const phone of phones) {
        const digits = phone.replace(/\D/g, '')
        const dbName = dbNames.get(digits)
        const onDeviceName = names[0]
        const finalName = dbName ?? onDeviceName ?? `Contato ${digits.slice(-4)}`
        console.log(`    rawId=${rawId} phone=${phone} → "${finalName}"`)
        if (googleAccount) {
          createInGoogle(account, finalName, phone)
        } else {
          // No Google account on this profile: re-create as Local (no-op churn but ensures WA sees)
          // Skip — already in Local, nothing to migrate
          stats.skipped++
          continue
        }
      }
      if (googleAccount) deleteRawContact(rawId)
      stats.migrated++
    } catch (err) {
      console.error(`    ERR rawId=${rawId}:`, err.message)
      stats.errors++
    }
  }
  return stats
}

async function main() {
  console.log('=== Migração Local Phone Account → Google no device', DEVICE, '===')
  const users = resolveUsers()
  console.log('Profiles alvo:', users.join(', '))

  const dbNames = loadDbContactNames()
  console.log(`${dbNames.size} nomes conhecidos no dispatch.db`)

  const totals = { migrated: 0, skipped: 0, errors: 0 }
  for (const u of users) {
    const s = runForUser(u, dbNames)
    totals.migrated += s.migrated
    totals.skipped += s.skipped
    totals.errors += s.errors
  }

  console.log('\n=== Resumo total ===')
  console.log(`  migrados: ${totals.migrated}`)
  console.log(`  pulados:  ${totals.skipped}`)
  console.log(`  erros:    ${totals.errors}`)

  console.log('\nAgora abra o WhatsApp e puxe para atualizar, ou abra qualquer chat.')
  console.log('Os contatos devem aparecer com o nome em vez do número.')
}

main().catch((e) => { console.error(e); process.exit(1) })
