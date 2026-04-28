import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { writeFileSync, unlinkSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { HotReloadCoordinator } from './hot-reload.js'
import { DispatchEmitter } from '../events/dispatch-emitter.js'
import { SenderScoring } from '../engine/sender-scoring.js'
import { SenderHealth } from '../engine/sender-health.js'

const fakeLogger = () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
})

describe('HotReloadCoordinator', () => {
  let tmpDir: string
  let envPath: string
  let originalSighupListeners: NodeJS.SignalsListener[]

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'hot-reload-'))
    envPath = join(tmpDir, '.env')
    writeFileSync(envPath, 'DISPATCH_TEST_VAR=initial\n')
    delete process.env.DISPATCH_TEST_VAR
    originalSighupListeners = process.listeners('SIGHUP') as NodeJS.SignalsListener[]
    process.removeAllListeners('SIGHUP')
  })

  afterEach(() => {
    try { unlinkSync(envPath) } catch { /* ignore */ }
    delete process.env.DISPATCH_TEST_VAR
    process.removeAllListeners('SIGHUP')
    for (const l of originalSighupListeners) process.on('SIGHUP', l)
  })

  it('reloads .env and re-applies registered components on reload()', async () => {
    const emitter = new DispatchEmitter()
    const coord = new HotReloadCoordinator(fakeLogger(), emitter, envPath)
    let observed = ''
    coord.register({
      name: 'test-component',
      reload: () => { observed = process.env.DISPATCH_TEST_VAR ?? '' },
    })

    writeFileSync(envPath, 'DISPATCH_TEST_VAR=updated\n')
    const result = await coord.reload()

    expect(result.ok).toBe(1)
    expect(result.failed).toEqual([])
    expect(observed).toBe('updated')
  })

  it('emits config:reloaded on full success', async () => {
    const emitter = new DispatchEmitter()
    const events: Array<{ components: number; failed: number }> = []
    emitter.on('config:reloaded', (data) => events.push(data))
    const coord = new HotReloadCoordinator(fakeLogger(), emitter, envPath)
    coord.register({ name: 'a', reload: () => {} })
    coord.register({ name: 'b', reload: () => {} })

    await coord.reload()

    expect(events).toEqual([{ components: 2, failed: 0 }])
  })

  it('emits config:reload_failed and continues remaining when one reload throws', async () => {
    const emitter = new DispatchEmitter()
    const failed: Array<{ components: number; failed: number; errors: unknown }> = []
    emitter.on('config:reload_failed', (data) => failed.push(data as typeof failed[0]))
    const coord = new HotReloadCoordinator(fakeLogger(), emitter, envPath)

    coord.register({ name: 'good-1', reload: () => {} })
    coord.register({ name: 'bad', reload: () => { throw new Error('boom') } })
    coord.register({ name: 'good-2', reload: () => {} })

    const result = await coord.reload()

    expect(result.ok).toBe(2)
    expect(result.failed).toEqual([{ name: 'bad', error: 'boom' }])
    expect(failed).toHaveLength(1)
    expect(failed[0].components).toBe(2)
    expect(failed[0].failed).toBe(1)
  })

  it('SIGHUP triggers reload via installed handler', async () => {
    const emitter = new DispatchEmitter()
    const coord = new HotReloadCoordinator(fakeLogger(), emitter, envPath)
    let calls = 0
    coord.register({ name: 'counter', reload: () => { calls++ } })
    coord.installSignalHandler()

    process.kill(process.pid, 'SIGHUP')
    // Give the async handler one microtask to run.
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))

    expect(calls).toBeGreaterThanOrEqual(1)
  })

  it('installSignalHandler is idempotent', () => {
    const emitter = new DispatchEmitter()
    const coord = new HotReloadCoordinator(fakeLogger(), emitter, envPath)
    coord.installSignalHandler()
    coord.installSignalHandler()
    coord.installSignalHandler()
    expect(process.listenerCount('SIGHUP')).toBe(1)
  })

  it('await on async reload() runs reloadables sequentially', async () => {
    const emitter = new DispatchEmitter()
    const coord = new HotReloadCoordinator(fakeLogger(), emitter, envPath)
    const order: string[] = []
    coord.register({
      name: 'first',
      reload: async () => {
        await new Promise((r) => setTimeout(r, 5))
        order.push('first')
      },
    })
    coord.register({
      name: 'second',
      reload: () => { order.push('second') },
    })

    await coord.reload()

    expect(order).toEqual(['first', 'second'])
  })
})

describe('HotReloadCoordinator – SenderScoring integration', () => {
  let tmpDir: string
  let envPath: string
  let originalSighupListeners: NodeJS.SignalsListener[]

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'hot-reload-scoring-'))
    envPath = join(tmpDir, '.env')
    writeFileSync(envPath, '')
    originalSighupListeners = process.listeners('SIGHUP') as NodeJS.SignalsListener[]
    process.removeAllListeners('SIGHUP')
  })

  afterEach(() => {
    try { unlinkSync(envPath) } catch { /* ignore */ }
    process.removeAllListeners('SIGHUP')
    for (const l of originalSighupListeners) process.on('SIGHUP', l)
    delete process.env.DISPATCH_SCORING_FAILURE_PENALTY
    delete process.env.DISPATCH_SCORING_IDLE_SATURATION_SEC
  })

  it('SenderScoring.reloadConfig updates config when SIGHUP fires', async () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE IF NOT EXISTS sender_health (
        sender_number TEXT PRIMARY KEY,
        consecutive_failures INTEGER DEFAULT 0,
        total_failures INTEGER DEFAULT 0,
        total_successes INTEGER DEFAULT 0,
        is_quarantined INTEGER DEFAULT 0,
        quarantined_at TEXT,
        quarantine_until TEXT,
        updated_at TEXT
      );
    `)
    const senderHealth = new SenderHealth(db, {
      quarantineAfterFailures: 3,
      quarantineDurationMs: 3_600_000,
    })
    const scoring = new SenderScoring(senderHealth, db, {
      failurePenalty: 1.0,
      idleSaturationSec: 3600,
    })
    scoring.initialize()

    const emitter = new DispatchEmitter()
    const coord = new HotReloadCoordinator(fakeLogger(), emitter, envPath)

    let reloadCallCount = 0
    coord.register({
      name: 'sender-scoring',
      reload: () => {
        reloadCallCount++
        scoring.reloadConfig({
          failurePenalty: parseFloat(process.env.DISPATCH_SCORING_FAILURE_PENALTY ?? '1.0'),
          idleSaturationSec: parseInt(process.env.DISPATCH_SCORING_IDLE_SATURATION_SEC ?? '3600', 10),
          rolePriorityWeights: {
            primary:  parseFloat(process.env.DISPATCH_SCORING_WEIGHT_PRIMARY  ?? '1.0'),
            overflow: parseFloat(process.env.DISPATCH_SCORING_WEIGHT_OVERFLOW ?? '0.7'),
            backup:   parseFloat(process.env.DISPATCH_SCORING_WEIGHT_BACKUP   ?? '0.5'),
            reserve:  parseFloat(process.env.DISPATCH_SCORING_WEIGHT_RESERVE  ?? '0.3'),
          },
        })
      },
    })

    writeFileSync(envPath, 'DISPATCH_SCORING_FAILURE_PENALTY=2.5\nDISPATCH_SCORING_IDLE_SATURATION_SEC=1800\n')
    coord.installSignalHandler()

    process.kill(process.pid, 'SIGHUP')
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))

    expect(reloadCallCount).toBeGreaterThanOrEqual(1)
    expect(process.env.DISPATCH_SCORING_FAILURE_PENALTY).toBe('2.5')
    expect(process.env.DISPATCH_SCORING_IDLE_SATURATION_SEC).toBe('1800')

    db.close()
  })
})
