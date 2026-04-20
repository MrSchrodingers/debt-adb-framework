import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { MessageQueue } from '../queue/index.js'
import { SendEngine } from './send-engine.js'
import { SendStrategy } from './send-strategy.js'
import { SenderMapping } from './sender-mapping.js'
import { SenderHealth } from './sender-health.js'
import { ReceiptTracker } from './receipt-tracker.js'
import { AccountMutex } from './account-mutex.js'
import { WahaFallback } from './waha-fallback.js'
import { DispatchEmitter } from '../events/index.js'
import { DeviceManager } from '../monitor/index.js'
import { MessageHistory } from '../waha/index.js'
import { RateLimitGuard } from '../config/rate-limits.js'
import { WorkerOrchestrator } from './worker-orchestrator.js'
import { ContactRegistry } from '../contacts/contact-registry.js'
import type { WorkerOrchestratorDeps } from './worker-orchestrator.js'
import type { AdbBridge } from '../adb/index.js'

const EXTRA_SCHEMAS_SQL = `
  CREATE TABLE IF NOT EXISTS alerts (
    id TEXT PRIMARY KEY,
    device_serial TEXT NOT NULL,
    severity TEXT NOT NULL,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    resolved INTEGER NOT NULL DEFAULT 0,
    resolved_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE TABLE IF NOT EXISTS health_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    serial TEXT NOT NULL,
    battery_percent REAL NOT NULL,
    temperature_celsius REAL NOT NULL,
    ram_available_mb REAL NOT NULL,
    storage_free_bytes REAL NOT NULL,
    wifi_connected INTEGER NOT NULL,
    collected_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )
`

function seedSchemas(db: InstanceType<typeof Database>): void {
  db.pragma('journal_mode = WAL')
  const queue = new MessageQueue(db)
  queue.initialize()
  db.exec(EXTRA_SCHEMAS_SQL)
}

function makeDeps(db: InstanceType<typeof Database>, contactRegistry?: ContactRegistry): WorkerOrchestratorDeps {
  const queue = new MessageQueue(db)
  const emitter = new DispatchEmitter()
  const adb = {
    discover: vi.fn().mockResolvedValue([]),
    shell: vi.fn().mockResolvedValue(''),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('fake-png')),
  } as unknown as AdbBridge
  const strategy = new SendStrategy({ prefillWeight: 100, searchWeight: 0, typingWeight: 0 })
  const engine = new SendEngine(adb, queue, emitter, strategy)
  const senderMapping = new SenderMapping(db)
  senderMapping.initialize()
  const senderHealth = new SenderHealth(db)
  const rateLimitGuard = new RateLimitGuard()
  const receiptTracker = new ReceiptTracker(db, queue, emitter)
  receiptTracker.initialize()
  const accountMutex = new AccountMutex()
  const wahaFallback = new WahaFallback(
    senderMapping,
    queue,
    vi.fn().mockRejectedValue(new Error('no WAHA')) as unknown as (url: string, init: RequestInit) => Promise<Response>,
    undefined,
  )
  const messageHistory = new MessageHistory(db)
  messageHistory.initialize()
  const deviceManager = new DeviceManager(db, emitter, adb)
  deviceManager.initialize()
  return {
    db, queue, engine, adb, emitter, senderMapping, senderHealth,
    rateLimitGuard, receiptTracker, accountMutex, wahaFallback,
    messageHistory, deviceManager,
    latestHealthMap: new Map(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    contactRegistry,
  }
}

describe('WorkerOrchestrator L1 pre-check integration', () => {
  let db: InstanceType<typeof Database>
  let registry: ContactRegistry

  beforeEach(() => {
    db = new Database(':memory:')
    seedSchemas(db)
    registry = new ContactRegistry(db)
    registry.initialize()
  })

  afterEach(() => {
    db.close()
  })

  it('short-circuits known-invalid number before ADB send, emits number:invalid event', async () => {
    registry.record('5543991938235', {
      phone_input: '+5543991938235',
      phone_variant_tried: '5543991938235',
      source: 'adb_probe',
      result: 'not_exists',
      confidence: 0.95,
      evidence: { has_invite_cta: true },
      device_serial: 'poco-1',
      waha_session: null,
      triggered_by: 'hygiene_job:batch-001',
      latency_ms: 4800,
      ddd: '43',
    })

    const deps = makeDeps(db, registry)
    const orchestrator = new WorkerOrchestrator(deps)

    const msg = deps.queue.enqueue({
      to: '+5543991938235',
      body: 'hi',
      idempotencyKey: 'pre-check-test-1',
    })
    // message stays in 'queued' — the pre-check runs regardless of status

    const events: unknown[] = []
    deps.emitter.on('number:invalid', (data) => events.push(data))

    const engineSend = vi.spyOn(deps.engine, 'send')

    const result = await orchestrator.processMessage(msg, 'poco-1', true, 'com.whatsapp')

    expect(result).toBe(false)
    expect(engineSend).not.toHaveBeenCalled()
    expect(events).toHaveLength(1)
    expect((events[0] as { phone_normalized: string }).phone_normalized).toBe('5543991938235')
    expect((events[0] as { source: string }).source).toBe('cache')

    const finalMsg = deps.queue.getById(msg.id)
    expect(finalMsg?.status).toBe('permanently_failed')
  })

  it('lets valid number through when registry says exists=true', async () => {
    registry.record('5511987654321', {
      phone_input: '+5511987654321',
      phone_variant_tried: '5511987654321',
      source: 'adb_probe',
      result: 'exists',
      confidence: 0.95,
      evidence: null,
      device_serial: 'poco-1',
      waha_session: null,
      triggered_by: 'pre_check',
      latency_ms: 4500,
      ddd: '11',
      wa_chat_id: '5511987654321@c.us',
    })

    const deps = makeDeps(db, registry)
    const orchestrator = new WorkerOrchestrator(deps)

    const msg = deps.queue.enqueue({
      to: '+5511987654321',
      body: 'hi',
      idempotencyKey: 'pre-check-test-2',
    })
    // message stays in 'queued' — the pre-check runs regardless of status

    const engineSend = vi.spyOn(deps.engine, 'send').mockResolvedValue({
      screenshot: Buffer.from(''),
      durationMs: 100,
      contactRegistered: false,
      dialogsDismissed: 0,
    })

    await orchestrator.processMessage(msg, 'poco-1', true, 'com.whatsapp')
    expect(engineSend).toHaveBeenCalledTimes(1)
  })

  it('passes through when contactRegistry is undefined (backward compat)', async () => {
    const deps = makeDeps(db, undefined)
    const orchestrator = new WorkerOrchestrator(deps)

    const msg = deps.queue.enqueue({
      to: '+5543991938235',
      body: 'hi',
      idempotencyKey: 'pre-check-test-3',
    })
    // message stays in 'queued' — the pre-check runs regardless of status

    const engineSend = vi.spyOn(deps.engine, 'send').mockResolvedValue({
      screenshot: Buffer.from(''),
      durationMs: 100,
      contactRegistered: false,
      dialogsDismissed: 0,
    })

    await orchestrator.processMessage(msg, 'poco-1', true, 'com.whatsapp')
    expect(engineSend).toHaveBeenCalledTimes(1)
  })

  it('does not short-circuit when recheck_due_at is set (forced recheck pending)', async () => {
    registry.record('5543991938235', {
      phone_input: '+5543991938235',
      phone_variant_tried: '5543991938235',
      source: 'adb_probe',
      result: 'not_exists',
      confidence: 0.95,
      evidence: null,
      device_serial: 'poco-1',
      waha_session: null,
      triggered_by: 'hygiene_job:batch-001',
      latency_ms: 4800,
      ddd: '43',
    })
    registry.forceRecheckDue('5543991938235', 'operator override for E2E test')

    const deps = makeDeps(db, registry)
    const orchestrator = new WorkerOrchestrator(deps)

    const msg = deps.queue.enqueue({
      to: '+5543991938235',
      body: 'hi',
      idempotencyKey: 'pre-check-test-4',
    })
    // message stays in 'queued' — the pre-check runs regardless of status

    const engineSend = vi.spyOn(deps.engine, 'send').mockResolvedValue({
      screenshot: Buffer.from(''),
      durationMs: 100,
      contactRegistered: false,
      dialogsDismissed: 0,
    })

    await orchestrator.processMessage(msg, 'poco-1', true, 'com.whatsapp')
    expect(engineSend).toHaveBeenCalledTimes(1)
  })
})
