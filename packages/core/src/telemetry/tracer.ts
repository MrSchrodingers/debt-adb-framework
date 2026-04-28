import { NodeSDK } from '@opentelemetry/sdk-node'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node'
import { trace, SpanStatusCode, type Tracer, type SpanOptions } from '@opentelemetry/api'

const TRACER_NAME = '@dispatch/core'
const TRACER_VERSION = '0.1.0'

let sdk: NodeSDK | null = null

/**
 * Initialize OpenTelemetry SDK. Idempotent — calling more than once is safe.
 * MUST be called BEFORE any HTTP/fastify/sqlite modules are required so
 * auto-instrumentation patches are applied in time.
 *
 * Controlled by env vars:
 *   OTEL_ENABLED=true             — explicit enable flag
 *   OTEL_EXPORTER_OTLP_ENDPOINT   — also enables when set (standard OTel env)
 *   OTEL_SERVICE_NAME             — override reported service name
 */
export function initTelemetry(): void {
  if (sdk) return

  const enabled =
    process.env.OTEL_ENABLED === 'true' ||
    Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT)
  if (!enabled) return // No-op when telemetry is disabled (tests, local dev)

  const endpoint =
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://127.0.0.1:4318/v1/traces'

  sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME ?? 'dispatch-core',
    traceExporter: new OTLPTraceExporter({ url: endpoint }),
    instrumentations: [
      getNodeAutoInstrumentations({
        // fs instrumentation is extremely noisy in our context (SQLite, screenshots)
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  })

  sdk.start()

  process.on('SIGTERM', () => {
    sdk?.shutdown().catch(() => {})
  })
}

/**
 * Return the project tracer for manual spans.
 * Always returns a valid Tracer instance — a no-op tracer when the SDK has not
 * been started (so instrumented code is safe in test and dev environments).
 */
export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME, TRACER_VERSION)
}

/**
 * Wrap an async function in a named OTel span.
 * - Sets span status to OK on resolve.
 * - Records exception and sets ERROR status on throw (re-throws).
 * - Optional `attributes` are set on the span before fn() is called.
 *
 * Use this for one-shot business boundaries (enqueue, dequeue, callback).
 * For operations that spawn child spans, use `getTracer().startActiveSpan()`
 * directly so child HTTP calls are nested under the active context.
 */
export async function withSpan<T>(
  name: string,
  options: SpanOptions & { attributes?: Record<string, string | number | boolean> },
  fn: () => Promise<T>,
): Promise<T> {
  const { attributes, ...spanOptions } = options
  return getTracer().startActiveSpan(name, spanOptions, async (span) => {
    if (attributes) {
      span.setAttributes(attributes)
    }
    try {
      const result = await fn()
      span.setStatus({ code: SpanStatusCode.OK })
      return result
    } catch (err) {
      span.recordException(err as Error)
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      })
      throw err
    } finally {
      span.end()
    }
  })
}
