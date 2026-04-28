/**
 * hook-whatsapp.js — Frida script for WhatsApp anti-automation research
 *
 * Hooks every method on selected security/detection classes and emits JSONL
 * events via Frida's send() API. Designed to be captured by runner.sh and
 * forwarded to BanPredictionDaemon (Task 12.2).
 *
 * Usage: frida -U -D <serial> -f com.whatsapp -l hook-whatsapp.js --no-pause
 * Or:    frida -U -D <serial> <pid> -l hook-whatsapp.js
 */

'use strict'

// Device serial is injected at runtime via --parameters '{"serial":"..."}' or
// falls back to "unknown". runner.sh always provides it.
const deviceSerial = (
  typeof Script !== 'undefined' &&
  Script.parameters &&
  Script.parameters.serial
) || 'unknown'

/**
 * Target classes. Each entry is attempted independently — if the class
 * does not exist in the current WhatsApp build the catch block logs a
 * warning and moves on.
 */
const TARGET_CLASSES = [
  'com.whatsapp.security.AntiTamper',
  'com.whatsapp.util.AutomationDetector',
  'com.whatsapp.security.SignatureValidator',
  'com.whatsapp.client.ClientUtils',
]

/**
 * Safely coerce a Java argument to a JSON-serialisable value.
 * Returns a string representation or null for non-serialisable types.
 */
function safeArg(arg) {
  if (arg === null || arg === undefined) return null
  try {
    const s = String(arg)
    // Truncate very long strings (e.g. byte arrays rendered as hex)
    return s.length > 256 ? s.slice(0, 256) + '…' : s
  } catch {
    return null
  }
}

/**
 * Hook every declared method on a class and replace with a logger that:
 *   1. Emits a structured event via send()
 *   2. Does NOT call the original — this is intentional for research:
 *      we want to see if WA behaves differently when these checks are no-ops.
 */
function hookClass(className) {
  try {
    const clazz = Java.use(className)
    const methods = clazz.class.getDeclaredMethods()

    if (methods.length === 0) {
      send(JSON.stringify({
        event: 'hook_warning',
        class: className,
        message: 'no declared methods found',
        ts: Date.now(),
        serial: deviceSerial,
      }))
      return
    }

    let hookedCount = 0

    methods.forEach(function (method) {
      const methodName = method.getName()

      // Retrieve all overloads (same name, different signatures)
      let overloads
      try {
        overloads = clazz[methodName].overloads
      } catch {
        return // not hookable (e.g. synthetic bridge methods)
      }

      overloads.forEach(function (overload) {
        overload.implementation = function () {
          const args = Array.prototype.slice.call(arguments).map(safeArg)
          send(JSON.stringify({
            event: 'method_call',
            class: className,
            method: methodName,
            args: args,
            ts: Date.now(),
            serial: deviceSerial,
          }))
          // Return a neutral value based on return type hint to avoid crashes
          // (returning undefined causes Frida to use the default for primitive types)
          return undefined
        }
        hookedCount++
      })
    })

    send(JSON.stringify({
      event: 'hook_installed',
      class: className,
      methodCount: hookedCount,
      ts: Date.now(),
      serial: deviceSerial,
    }))
  } catch (err) {
    // Class not present in this WhatsApp build — expected, not an error
    send(JSON.stringify({
      event: 'hook_skipped',
      class: className,
      reason: String(err),
      ts: Date.now(),
      serial: deviceSerial,
    }))
  }
}

/**
 * Entry point — runs after the Java runtime is ready.
 */
Java.perform(function () {
  send(JSON.stringify({
    event: 'session_start',
    targetClasses: TARGET_CLASSES,
    ts: Date.now(),
    serial: deviceSerial,
  }))

  TARGET_CLASSES.forEach(hookClass)

  send(JSON.stringify({
    event: 'hooks_ready',
    ts: Date.now(),
    serial: deviceSerial,
  }))
})
