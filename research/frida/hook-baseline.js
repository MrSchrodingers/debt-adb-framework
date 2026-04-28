/**
 * hook-baseline.js — Passive observer for WhatsApp anti-tamper / integrity surfaces.
 *
 * Discovers candidate classes at runtime by regex-matching keywords against the set
 * of loaded classes (Java.enumerateLoadedClasses), then attaches PASSIVE wrappers
 * that emit a JSONL event before delegating to the original implementation.
 * Behavior is unchanged.
 *
 * Re-enumerates every RESCAN_INTERVAL_MS to catch lazy-loaded classes WhatsApp
 * pulls in only when sending / under load.
 *
 * Events emitted (via send(payload)):
 *   - { kind: 'baseline_started', serial, keywordsPattern }
 *   - { kind: 'class_loaded',  serial, className }
 *   - { kind: 'class_skipped', serial, className, reason }   // already hooked, no methods, etc.
 *   - { kind: 'method_called', serial, className, methodName, argCount }
 *   - { kind: 'rescan_done',   serial, totalLoaded, newlyHooked, totalHooked }
 *
 * Parameters:
 *   serial — device serial label, injected via --parameters '{"serial":"..."}'.
 *            Falls back to 'unknown' (forwarder.js will inject post-hoc).
 */

'use strict';

const KEYWORDS_RE = /tamper|detect|integrity|signature|securit|automat|verif|root|emulat|antifrida|anti.?frida|trusted|attest|safetynet|playintegrit|machash|fingerprint/i;
const PACKAGE_FILTER = /^com\.whatsapp\./;
const RESCAN_INTERVAL_MS = 60_000;

const params = (typeof parameters !== 'undefined' && parameters) || {};
const serial = params.serial || 'unknown';

const hookedClasses = new Set();

function hookClassPassively(className) {
  if (hookedClasses.has(className)) {
    send({ kind: 'class_skipped', serial, className, reason: 'already_hooked' });
    return false;
  }

  let Klass;
  try {
    Klass = Java.use(className);
  } catch (e) {
    send({ kind: 'class_skipped', serial, className, reason: 'java_use_failed' });
    return false;
  }

  let methods;
  try {
    methods = Klass.class.getDeclaredMethods();
  } catch (e) {
    send({ kind: 'class_skipped', serial, className, reason: 'no_declared_methods' });
    return false;
  }

  let hookedCount = 0;
  const seen = new Set();

  for (let i = 0; i < methods.length; i++) {
    const name = methods[i].getName();
    if (seen.has(name)) continue;
    seen.add(name);

    let overloads;
    try {
      overloads = Klass[name].overloads;
    } catch (e) {
      continue;
    }
    if (!overloads || !overloads.length) continue;

    for (let j = 0; j < overloads.length; j++) {
      const overload = overloads[j];
      try {
        overload.implementation = function () {
          const args = Array.prototype.slice.call(arguments);
          send({
            kind: 'method_called',
            serial,
            className,
            methodName: name,
            argCount: args.length,
          });
          return overload.apply(this, args);
        };
        hookedCount++;
      } catch (e) {
        // Abstract / native / unhookable — skip.
      }
    }
  }

  hookedClasses.add(className);
  send({ kind: 'class_loaded', serial, className, methodsHooked: hookedCount });
  return true;
}

function rescan() {
  let totalLoaded = 0;
  let newlyHooked = 0;
  Java.enumerateLoadedClasses({
    onMatch(name) {
      totalLoaded++;
      if (PACKAGE_FILTER.test(name) && KEYWORDS_RE.test(name)) {
        if (hookClassPassively(name)) newlyHooked++;
      }
    },
    onComplete() {
      send({
        kind: 'rescan_done',
        serial,
        totalLoaded,
        newlyHooked,
        totalHooked: hookedClasses.size,
      });
    },
  });
}

Java.perform(function () {
  send({
    kind: 'baseline_started',
    serial,
    keywordsPattern: KEYWORDS_RE.source,
    rescanIntervalMs: RESCAN_INTERVAL_MS,
  });
  rescan();
  setInterval(rescan, RESCAN_INTERVAL_MS);
});
