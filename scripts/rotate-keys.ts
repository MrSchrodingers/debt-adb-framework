#!/usr/bin/env tsx
/**
 * Key Rotation Script — Task 11.4
 *
 * Rotates plugin API keys and/or DISPATCH_API_KEY in .env.
 * Every rotation is audit-logged in the SQLite database.
 *
 * Usage:
 *   pnpm tsx scripts/rotate-keys.ts --plugin oralsin
 *   pnpm tsx scripts/rotate-keys.ts --all-plugins
 *   pnpm tsx scripts/rotate-keys.ts --core
 *   pnpm tsx scripts/rotate-keys.ts --all-plugins --core --show-keys
 *   pnpm tsx scripts/rotate-keys.ts --all-plugins --dry-run
 *   pnpm tsx scripts/rotate-keys.ts --all-plugins --core --remote
 *
 * Flags:
 *   --plugin <name>   Rotate one plugin's API key in the DB.
 *   --all-plugins     Rotate every active plugin's API key in the DB.
 *   --core            Replace DISPATCH_API_KEY in .env with a new random key.
 *   --remote          Also push the updated .env line(s) to adb@dispatch via SSH.
 *   --dry-run         Print what would be done without modifying anything.
 *   --show-keys       Include new key values in the summary table (default: hidden).
 *   --db <path>       SQLite path (default: dispatch.db or DB_PATH env).
 *   --env <path>      .env file path (default: .env).
 */

import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import Database from 'better-sqlite3'
import { PluginRegistry } from '../packages/core/src/plugins/plugin-registry.js'
import { AuditLogger } from '../packages/core/src/config/audit-logger.js'

// ── Types ──────────────────────────────────────────────────────────────────

interface RotationResult {
  kind: 'plugin' | 'core'
  name: string
  newKey: string
  auditId?: number
  error?: string
}

// ── Arg parsing ────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): {
  plugin: string | null
  allPlugins: boolean
  core: boolean
  remote: boolean
  dryRun: boolean
  showKeys: boolean
  dbPath: string
  envPath: string
} {
  let plugin: string | null = null
  let allPlugins = false
  let core = false
  let remote = false
  let dryRun = false
  let showKeys = false
  let dbPath = process.env.DB_PATH ?? 'dispatch.db'
  let envPath = '.env'

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--plugin':
        plugin = argv[++i] ?? null
        break
      case '--all-plugins':
        allPlugins = true
        break
      case '--core':
        core = true
        break
      case '--remote':
        remote = true
        break
      case '--dry-run':
        dryRun = true
        break
      case '--show-keys':
        showKeys = true
        break
      case '--db':
        dbPath = argv[++i] ?? dbPath
        break
      case '--env':
        envPath = argv[++i] ?? envPath
        break
    }
  }

  return { plugin, allPlugins, core, remote, dryRun, showKeys, dbPath, envPath }
}

// ── Core (.env) key rotation ───────────────────────────────────────────────

function generateApiKey(): string {
  return randomBytes(32).toString('base64url')
}

function rotateEnvKey(envPath: string, newKey: string): void {
  const content = readFileSync(envPath, 'utf8')
  const keyPattern = /^DISPATCH_API_KEY=.*$/m
  const replacement = `DISPATCH_API_KEY=${newKey}`

  if (!keyPattern.test(content)) {
    // Key does not exist yet — append it
    writeFileSync(envPath, content.trimEnd() + `\nDISPATCH_API_KEY=${newKey}\n`, 'utf8')
  } else {
    writeFileSync(envPath, content.replace(keyPattern, replacement), 'utf8')
  }
}

/**
 * Push the .env file to the remote Kali dispatch server via SCP.
 * Uses execFileSync (not execSync) to prevent shell injection — args are
 * passed as a proper argv array, never interpolated into a shell string.
 */
function pushEnvToRemote(envPath: string, dryRun: boolean): void {
  const remoteTarget = 'adb@dispatch'
  const remotePath = `~/debt-adb-framework/${envPath}`

  if (dryRun) {
    process.stdout.write(`[dry-run] Would scp ${envPath} to ${remoteTarget}:${remotePath}\n`)
    return
  }

  try {
    // execFileSync — no shell expansion, safe against path injection
    execFileSync('scp', [envPath, `${remoteTarget}:${remotePath}`], { stdio: 'inherit' })
  } catch (err) {
    process.stderr.write(
      `Warning: remote push failed — ${err instanceof Error ? err.message : String(err)}\n`,
    )
  }
}

// ── Formatting ─────────────────────────────────────────────────────────────

function maskKey(key: string, show: boolean): string {
  if (show) return key
  return key.slice(0, 4) + '...' + key.slice(-4)
}

function printTable(results: RotationResult[], showKeys: boolean, dryRun: boolean): void {
  const prefix = dryRun ? '[dry-run] ' : ''
  process.stdout.write('\n')
  process.stdout.write(`${prefix}Key Rotation Summary\n`)
  process.stdout.write('-'.repeat(70) + '\n')

  const rows: string[] = []
  for (const r of results) {
    if (r.error) {
      rows.push(`  FAIL  ${r.kind.padEnd(6)} ${r.name.padEnd(20)} ERROR: ${r.error}`)
    } else {
      const keyDisplay = r.newKey ? maskKey(r.newKey, showKeys) : '(unchanged)'
      const auditPart = r.auditId ? ` (audit #${r.auditId})` : ''
      rows.push(`  OK    ${r.kind.padEnd(6)} ${r.name.padEnd(20)} ${keyDisplay}${auditPart}`)
    }
  }

  if (rows.length === 0) {
    process.stdout.write('  No rotations requested.\n')
  } else {
    rows.forEach((row) => process.stdout.write(row + '\n'))
  }

  process.stdout.write('-'.repeat(70) + '\n')

  if (results.length > 0 && !showKeys) {
    process.stdout.write('  (Add --show-keys to reveal new key values)\n')
  }
  process.stdout.write('\n')
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  if (!args.plugin && !args.allPlugins && !args.core) {
    process.stderr.write(
      'Error: at least one of --plugin <name>, --all-plugins, or --core is required.\n' +
        'Run with --dry-run to preview without making changes.\n',
    )
    process.exit(1)
  }

  // Open DB (required for plugin/audit operations)
  const dbNeeded = args.plugin !== null || args.allPlugins || args.core
  let db: Database.Database | null = null
  let registry: PluginRegistry | null = null
  let auditLogger: AuditLogger | null = null

  if (dbNeeded && !args.dryRun) {
    db = new Database(args.dbPath)
    db.pragma('journal_mode = WAL')
    registry = new PluginRegistry(db)
    registry.initialize()
    auditLogger = new AuditLogger(db)
  } else if (dbNeeded && args.dryRun && (args.plugin || args.allPlugins)) {
    // Open DB read-only for listing plugins in dry-run mode
    db = new Database(args.dbPath, { readonly: true })
    registry = new PluginRegistry(db)
    registry.initialize()
  }

  const results: RotationResult[] = []

  // ── Plugin rotation ──────────────────────────────────────────────────────
  if (args.plugin || args.allPlugins) {
    let pluginsToRotate: string[] = []

    if (args.plugin) {
      pluginsToRotate = [args.plugin]
    } else if (args.allPlugins && registry) {
      const allPlugins = registry.listPlugins()
      pluginsToRotate = allPlugins.map((p) => p.name)
    }

    for (const name of pluginsToRotate) {
      if (args.dryRun) {
        const fakeKey = generateApiKey()
        results.push({ kind: 'plugin', name, newKey: fakeKey })
        continue
      }

      if (!registry || !auditLogger || !db) {
        results.push({ kind: 'plugin', name, newKey: '', error: 'DB not initialized' })
        continue
      }

      const existing = registry.getPlugin(name)
      if (!existing) {
        results.push({ kind: 'plugin', name, newKey: '', error: 'Plugin not found in DB' })
        continue
      }

      try {
        const newKey = registry.rotateApiKey(name)

        // Audit-log: key value intentionally not stored, only the prefix for tracing
        auditLogger.log({
          actor: 'rotate-keys-script',
          action: 'rotate_key',
          resourceType: 'plugin',
          resourceId: name,
          beforeState: { key_prefix: existing.api_key.slice(0, 4) },
          afterState: { key_prefix: newKey.slice(0, 4) },
        })

        const lastId = (db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id

        results.push({ kind: 'plugin', name, newKey, auditId: lastId })
      } catch (err) {
        results.push({
          kind: 'plugin',
          name,
          newKey: '',
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  // ── Core (DISPATCH_API_KEY) rotation ─────────────────────────────────────
  if (args.core) {
    const newKey = generateApiKey()

    if (args.dryRun) {
      process.stdout.write(
        `[dry-run] Would replace DISPATCH_API_KEY in '${args.envPath}' with a new 32-byte base64url key.\n`,
      )
      results.push({ kind: 'core', name: 'DISPATCH_API_KEY', newKey })
    } else {
      try {
        rotateEnvKey(args.envPath, newKey)

        let auditId: number | undefined
        if (auditLogger && db) {
          auditLogger.log({
            actor: 'rotate-keys-script',
            action: 'rotate_key',
            resourceType: 'env',
            resourceId: 'DISPATCH_API_KEY',
            afterState: { key_prefix: newKey.slice(0, 4) },
          })
          auditId = (db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id
        }

        results.push({ kind: 'core', name: 'DISPATCH_API_KEY', newKey, auditId })
      } catch (err) {
        results.push({
          kind: 'core',
          name: 'DISPATCH_API_KEY',
          newKey: '',
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  // ── Remote push ──────────────────────────────────────────────────────────
  if (args.remote && args.core) {
    pushEnvToRemote(args.envPath, args.dryRun)
  }

  if (db) db.close()

  printTable(results, args.showKeys, args.dryRun)

  const hasErrors = results.some((r) => r.error !== undefined)
  process.exit(hasErrors ? 1 : 0)
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
