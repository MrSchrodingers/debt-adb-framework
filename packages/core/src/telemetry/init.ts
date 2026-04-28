/**
 * Telemetry bootstrap — imported as the FIRST side-effect in main.ts so that
 * OpenTelemetry auto-instrumentation patches are applied before any HTTP /
 * Fastify / SQLite modules are loaded.
 *
 * This file has NO other imports; it is intentionally minimal to avoid
 * circular-dependency risks at startup.
 */
import { initTelemetry } from './tracer.js'

initTelemetry()
