#!/usr/bin/env node
/**
 * forwarder.js — Stream frida JSONL output to BanPredictionDaemon TCP socket
 *                with a file fallback when the daemon is unreachable.
 *
 * Reads a JSONL file (or stdin) produced by runner.sh and forwards each line
 * to the BanPredictionDaemon listening on 127.0.0.1:9871. Lines that don't
 * contain a `serial` field have one injected from the CLI argument.
 *
 * Resilience:
 *   - On socket error / refused connection, lines are appended to
 *     /tmp/research-frida-fallback.jsonl instead of crashing the process.
 *   - A reconnect attempt is scheduled every 30s while in fallback mode.
 *   - When the socket reconnects, forwarding resumes via the live socket.
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

const { createReadStream, appendFileSync } = require('node:fs')
const { createInterface } = require('node:readline')
const { createConnection } = require('node:net')
const { stdin } = require('node:process')

const [,, filePath = '-', serial = 'unknown', portArg = '9871'] = process.argv
const PORT = Number(portArg) || 9871
const FALLBACK_FILE = '/tmp/research-frida-fallback.jsonl'
const RECONNECT_INTERVAL_MS = 30_000

// ── Connection state ──────────────────────────────────────────────────────

/** @type {import('node:net').Socket | null} */
let socket = null
let connected = false
let reconnectTimer = null

function logTransition(message) {
  console.error(`[forwarder] ${message}`)
}

function appendFallback(line) {
  try {
    appendFileSync(FALLBACK_FILE, line)
  } catch (err) {
    console.error(`[forwarder] failed to append fallback file: ${err.message}`)
  }
}

function connect() {
  const previouslyConnected = connected
  const s = createConnection({ host: '127.0.0.1', port: PORT })
  socket = s

  s.once('connect', () => {
    connected = true
    if (previouslyConnected) {
      logTransition(`reconnected → resuming socket on port ${PORT}`)
    } else {
      logTransition(`connected to daemon on port ${PORT}`)
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  })

  s.on('error', (err) => {
    if (connected) {
      logTransition(`socket error: ${err.message}`)
    } else {
      logTransition(`socket down (${err.message}) → fallback file ${FALLBACK_FILE}`)
    }
    connected = false
    try { s.destroy() } catch {}
    if (socket === s) socket = null
    scheduleReconnect()
  })

  s.on('close', () => {
    if (connected) {
      logTransition(`daemon connection closed → fallback file ${FALLBACK_FILE}`)
    }
    connected = false
    if (socket === s) socket = null
    scheduleReconnect()
  })
}

function scheduleReconnect() {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, RECONNECT_INTERVAL_MS)
  // Don't keep the process alive solely for reconnect attempts.
  if (typeof reconnectTimer.unref === 'function') reconnectTimer.unref()
}

function writeLine(line) {
  if (connected && socket && !socket.destroyed) {
    try {
      socket.write(line)
      return
    } catch (err) {
      logTransition(`socket write failed (${err.message}) → fallback file ${FALLBACK_FILE}`)
      connected = false
      try { socket.destroy() } catch {}
      socket = null
      scheduleReconnect()
    }
  }
  appendFallback(line)
}

connect()

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
  writeLine(forwarded)
})

rl.on('close', () => {
  console.error('[forwarder] input stream closed')
  if (socket && !socket.destroyed) {
    try { socket.end() } catch {}
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
})

process.on('SIGINT', () => {
  if (socket && !socket.destroyed) {
    try { socket.end() } catch {}
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  process.exit(0)
})
