#!/usr/bin/env node
/**
 * Callback Capture Server — receives and logs Dispatch callbacks
 * Verifies HMAC signature on every request
 * Usage: node scripts/callback-capture.mjs
 */
import { createServer } from 'node:http'
import { createHmac } from 'node:crypto'

const PORT = 9999
const HMAC_SECRET = 'test-hmac-secret-e2e'
const callbacks = []

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/callbacks') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(callbacks, null, 2))
    return
  }

  if (req.method === 'DELETE' && req.url === '/callbacks') {
    callbacks.length = 0
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ cleared: true }))
    return
  }

  if (req.method === 'POST') {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString()

    const signature = req.headers['x-dispatch-signature'] || ''
    const expected = createHmac('sha256', HMAC_SECRET).update(body).digest('hex')
    const hmacValid = signature === expected

    let payload
    try { payload = JSON.parse(body) } catch { payload = body }

    const entry = {
      timestamp: new Date().toISOString(),
      url: req.url,
      hmacValid,
      signatureReceived: signature.slice(0, 16) + '...',
      payload,
    }
    callbacks.push(entry)

    const icon = hmacValid ? '\u2705' : '\u274C'
    console.log(`${icon} [${entry.timestamp}] HMAC=${hmacValid ? 'OK' : 'FAIL'} event=${payload?.event ?? 'result'} key=${payload?.idempotency_key ?? '?'} status=${payload?.status ?? '?'}`)

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ received: true }))
    return
  }

  res.writeHead(404)
  res.end('Not found')
})

server.listen(PORT, () => {
  console.log(`\n=== Callback Capture Server on :${PORT} ===`)
  console.log(`  GET  /callbacks  — list all received callbacks`)
  console.log(`  DELETE /callbacks — clear captured callbacks`)
  console.log(`  POST /*          — capture callback + verify HMAC\n`)
})
