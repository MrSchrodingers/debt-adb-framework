import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { getTracer, withSpan } from './tracer.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Reset module-level SDK singleton between tests by re-importing a fresh module. */
beforeEach(() => {
  // Ensure OTEL_ENABLED is NOT set so initTelemetry() stays a no-op in tests.
  delete process.env['OTEL_ENABLED']
  delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT']
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ── getTracer ─────────────────────────────────────────────────────────────────

describe('getTracer()', () => {
  it('returns a tracer object (no-op when SDK not initialised)', () => {
    const tracer = getTracer()
    expect(tracer).toBeDefined()
    expect(typeof tracer.startActiveSpan).toBe('function')
    expect(typeof tracer.startSpan).toBe('function')
  })
})

// ── withSpan ──────────────────────────────────────────────────────────────────

describe('withSpan()', () => {
  it('resolves and returns the wrapped function value', async () => {
    const result = await withSpan(
      'test.resolve',
      { attributes: { idempotency_key: 'ikey-1', plugin_name: 'test' } },
      async () => 42,
    )
    expect(result).toBe(42)
  })

  it('propagates rejection — throws the original error', async () => {
    const boom = new Error('boom')
    await expect(
      withSpan(
        'test.throw',
        { attributes: { idempotency_key: 'ikey-2' } },
        async () => { throw boom },
      ),
    ).rejects.toThrow('boom')
  })

  it('attaches attributes without crashing when SDK is off (no-op tracer)', async () => {
    // No OTEL_ENABLED set — SDK is not started. The no-op tracer should absorb all calls.
    const result = await withSpan(
      'test.attrs',
      {
        attributes: {
          idempotency_key: 'ikey-3',
          plugin_name: 'oralsin',
          batch_size: 5,
          active: true,
        },
      },
      async () => 'ok',
    )
    expect(result).toBe('ok')
  })

  it('nested withSpan calls do not interfere', async () => {
    const outer = await withSpan(
      'test.outer',
      { attributes: { idempotency_key: 'outer-1' } },
      async () => {
        const inner = await withSpan(
          'test.inner',
          { attributes: { idempotency_key: 'inner-1' } },
          async () => 'inner-result',
        )
        return `outer:${inner}`
      },
    )
    expect(outer).toBe('outer:inner-result')
  })

  it('error in nested span propagates correctly', async () => {
    await expect(
      withSpan(
        'test.outer-err',
        { attributes: { idempotency_key: 'outer-err' } },
        async () => {
          return withSpan(
            'test.inner-err',
            { attributes: { idempotency_key: 'inner-err' } },
            async () => { throw new Error('inner boom') },
          )
        },
      ),
    ).rejects.toThrow('inner boom')
  })
})
