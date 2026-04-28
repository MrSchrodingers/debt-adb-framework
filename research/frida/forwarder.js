#!/usr/bin/env node
/**
 * forwarder.js — Stream frida JSONL output to BanPredictionDaemon TCP socket
 *
 * Reads a JSONL file (or stdin) produced by runner.sh and forwards each line
 * to the BanPredictionDaemon listening on 127.0.0.1:9871. Lines that don't
 * contain a `serial` field have one injected from the CLI argument.
 *
 * Usage:
 *   node research/frida/forwarder.js <jsonl_file> [device_serial] [port]
 *   tail -f /tmp/whatsapp-hook.jsonl | node research/frida/forwarder.js - [serial] [port]
 *
 * Arguments:
 *   jsonl_file     — path to the JSONL file output by runner.sh, or "-" for stdin
 *   device_serial  — serial to inject when the event lacks one (default: "unknown")
 *   port           — daemon TCP port (default: 9871)
 */

'use strict'

const { createReadStream, watchFile } = require('node:fs')
const { createInterface } = require('node:readline')
const { createConnection } = require('node:net')
const { stdin } = require('node:process')

const [,, filePath = '-', serial = 'unknown', portArg = '9871'] = process.argv
const PORT = Number(portArg) || 9871

// ── Connect to BanPredictionDaemon ─────────────────────────────────────────

const socket = createConnection({ host: '127.0.0.1', port: PORT }, () => {
  console.error(`[forwarder] connected to daemon on port ${PORT}`)
})

socket.on('error', (err) => {
  console.error(`[forwarder] socket error: ${err.message}`)
  process.exit(1)
})

socket.on('close', () => {
  console.error('[forwarder] daemon connection closed')
})

// ── Read JSONL source ─────────────────────────────────────────────────────

const inputStream = filePath === '-'
  ? stdin
  : createReadStream(filePath)

const rl = createInterface({ input: inputStream, crlfDelay: Infinity })

rl.on('line', (line) => {
  if (!line.trim()) return

  let obj
  try {
    obj = JSON.parse(line)
  } catch {
    // Malformed JSON from frida — skip
    return
  }

  // Inject serial if missing (frida logs before parameters are parsed)
  if (!obj.serial) obj.serial = serial

  // Forward to daemon as a newline-delimited JSON line
  const forwarded = JSON.stringify(obj) + '\n'
  if (!socket.destroyed) {
    socket.write(forwarded)
  }
})

rl.on('close', () => {
  console.error('[forwarder] input stream closed')
  socket.end()
})

process.on('SIGINT', () => {
  socket.end()
  process.exit(0)
})
