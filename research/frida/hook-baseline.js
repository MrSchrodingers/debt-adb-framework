/**
 * hook-baseline.js — Passive observer for WhatsApp anti-tamper surfaces.
 *
 * This script attaches to a running WhatsApp process and reports invocations
 * of suspected anti-tamper / automation-detection classes WITHOUT modifying
 * behavior. Each hooked overload calls send({...}) BEFORE delegating, then
 * returns the original implementation's result via overload.apply(this, args).
 *
 * Events emitted (via send(payload)):
 *   - { kind: "baseline_started", serial }
 *   - { kind: "class_loaded", serial, className }
 *   - { kind: "class_not_found", serial, className }
 *   - { kind: "method_called", serial, className, methodName, argCount }
 *
 * Parameters:
 *   serial — device serial label, injected via --parameters '{"serial":"..."}'.
 */

'use strict';

const TARGET_CLASSES = [
  'com.whatsapp.security.AntiTamper',
  'com.whatsapp.util.AutomationDetector',
  'com.whatsapp.security.SignatureValidator',
  'com.whatsapp.client.ClientUtils',
];

const params = (typeof parameters !== 'undefined' && parameters) || {};
const serial = params.serial || 'unknown';

function hookClassPassively(className) {
  let Klass;
  try {
    Klass = Java.use(className);
  } catch (e) {
    send({ kind: 'class_not_found', serial, className });
    return;
  }

  send({ kind: 'class_loaded', serial, className });

  const methodNames = Object.getOwnPropertyNames(Klass.class.getDeclaredMethods())
    .filter((n) => typeof Klass[n] !== 'undefined' && Klass[n].overloads);

  // Fallback: enumerate via reflection if the above heuristic returns empty.
  let methods;
  try {
    methods = Klass.class.getDeclaredMethods();
  } catch (e) {
    methods = [];
  }

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
      } catch (e) {
        // Some methods can't be hooked (abstract, native bridge, etc.) — ignore.
      }
    }
  }
}

Java.perform(function () {
  send({ kind: 'baseline_started', serial });
  for (let i = 0; i < TARGET_CLASSES.length; i++) {
    hookClassPassively(TARGET_CLASSES[i]);
  }
});
