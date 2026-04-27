#!/usr/bin/env node
/**
 * Print a bcrypt hash of the given plaintext password to stdout.
 *
 * Usage:
 *   npx tsx scripts/hash-password.ts "my plain password"
 *   echo -n "my plain password" | npx tsx scripts/hash-password.ts
 *
 * Output is the hash and only the hash (no trailing prose), suitable for
 * shell pipelining:
 *   HASH=$(npx tsx scripts/hash-password.ts "$PLAIN")
 */
import { hashPassword } from '../packages/core/src/api/password-hash.ts'

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')
}

async function main(): Promise<void> {
  let plain = process.argv[2]
  if (plain === undefined) {
    if (process.stdin.isTTY) {
      process.stderr.write('error: no password provided (argv[2] empty and stdin is a TTY)\n')
      process.exit(1)
    }
    plain = await readStdin()
  }
  if (!plain) {
    process.stderr.write('error: empty password\n')
    process.exit(1)
  }
  const hash = await hashPassword(plain)
  process.stdout.write(`${hash}\n`)
}

main().catch((err) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
