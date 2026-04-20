#!/usr/bin/env node
import 'dotenv/config'
import { createServer } from './server.js'

// ── CLI arg parsing ──

function parseArgs(args: string[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg.startsWith('--') && i + 1 < args.length) {
      const key = arg.slice(2)
      result[key] = args[++i]
    }
  }
  return result
}

const cliArgs = parseArgs(process.argv.slice(2))

// CLI args override env vars
if (cliArgs['port']) process.env.PORT = cliArgs['port']
if (cliArgs['db-path']) process.env.DB_PATH = cliArgs['db-path']
if (cliArgs['api-key']) process.env.DISPATCH_API_KEY = cliArgs['api-key']
if (cliArgs['log-file']) process.env.LOG_FILE = cliArgs['log-file']

const port = Number(process.env.PORT) || 7890

// ── Start server ──

const core = await createServer(port)

console.log(`Dispatch ADB Framework — headless mode`)
console.log(`  Port:     ${port}`)
console.log(`  Database: ${process.env.DB_PATH || 'dispatch.db'}`)
console.log(`  PID:      ${process.pid}`)

core.shutdown.installSignalHandlers(async () => {
  await core.server.close()
})
