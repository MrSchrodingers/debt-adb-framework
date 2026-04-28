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
import type { WorkerOrchestratorDeps } from './worker-orchestrator.js'
import type { AdbBridge } from '../adb/index.js'
import type { HealthSnapshot } from '../monitor/types.js'

// ---------------------------------------------------------------------------
// Harness mirrors worker-orchestrator.test.ts. Kept local so the sacrificial
// guard test stays self-contained.
// ---------------------------------------------------------------------------

function createTestDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')

  const queue = new MessageQueue(db)
  queue.initialize()

  db.exec(`
    CREATE TABLE IF NOT EXISTS alerts (
      id TEXT PRIMARY KEY,
      device_serial TEXT NOT NULL,
      severity TEXT NOT NULL,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      resolved INTEGER NOT NULL DEFAULT 0,
      resolved_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `)

  db.exec(`
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
  `)

  return db
}

function createMockAdb(): AdbBridge {
  return {
    discover: vi.fn().mockResolvedValue([]),
    shell: vi.fn().mockResolvedValue(''),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('fake-png')),
  } as unknown as AdbBridge
}

function createDeps(db: InstanceType<typeof Database>): WorkerOrchestratorDeps {
  const queue = new MessageQueue(db)
  const emitter = new DispatchEmitter()
  const adb = createMockAdb()
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

  const latestHealthMap = new Map<string, HealthSnapshot>()

  return {
    db,
    queue,
    engine,
    adb,
    emitter,
    senderMapping,
    senderHealth,
    rateLimitGuard,
    receiptTracker,
    accountMutex,
    wahaFallback,
    messageHistory,
    deviceManager,
    latestHealthMap,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }
}

const SACRIFICIAL_SERIAL = 'sacrificial-serial-X'
const SENDER_NUMBER = '5543999990001'

function seedDeviceOnline(deps: WorkerOrchestratorDeps, serial: string): void {
  deps.db.prepare(
    "INSERT OR REPLACE INTO devices (serial, brand, model, status, last_seen_at) VALUES (?, 'Test', 'Phone', 'online', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
  ).run(serial)

  deps.latestHealthMap.set(serial, {
    serial,
    batteryPercent: 80,
    temperatureCelsius: 30,
    ramAvailableMb: 1024,
    storageFreeBytes: 2e9,
    wifiConnected: true,
    collectedAt: new Date().toISOString(),
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkerOrchestrator - sacrificial-device guard', () => {
  let db: InstanceType<typeof Database>
  let deps: WorkerOrchestratorDeps
  let orchestrator: WorkerOrchestrator
  const ORIGINAL_ENV = process.env.RESEARCH_SACRIFICIAL_SERIALS

  beforeEach(() => {
    process.env.RESEARCH_SACRIFICIAL_SERIALS = SACRIFICIAL_SERIAL
    db = createTestDb()
    deps = createDeps(db)
    orchestrator = new WorkerOrchestrator(deps)
  })

  afterEach(() => {
    db.close()
    if (ORIGINAL_ENV === undefined) {
      delete process.env.RESEARCH_SACRIFICIAL_SERIALS
    } else {
      process.env.RESEARCH_SACRIFICIAL_SERIALS = ORIGINAL_ENV
    }
  })

  it('refuses to dispatch when device serial is listed in RESEARCH_SACRIFICIAL_SERIALS', async () => {
    seedDeviceOnline(deps, SACRIFICIAL_SERIAL)

    deps.senderMapping.create({
      phoneNumber: SENDER_NUMBER,
      deviceSerial: SACRIFICIAL_SERIAL,
      profileId: 0,
      appPackage: 'com.whatsapp',
    })
    deps.queue.enqueue({
      to: '5543991938235',
      body: 'should never send to sacrificial device',
      idempotencyKey: `sacrificial-test-${Date.now()}`,
      senderNumber: SENDER_NUMBER,
    })

    const dequeueSpy = vi.spyOn(deps.queue, 'dequeueBySender')

    await orchestrator.tick()

    expect(dequeueSpy).not.toHaveBeenCalled()

    const warnFn = deps.logger.warn as ReturnType<typeof vi.fn>
    const sacrificialWarn = warnFn.mock.calls.find(call => {
      const msg = call[1]
      return typeof msg === 'string' && msg.includes('RESEARCH_SACRIFICIAL_SERIALS')
    })
    expect(sacrificialWarn).toBeDefined()
    expect(sacrificialWarn![0]).toEqual({ device: SACRIFICIAL_SERIAL })
  })
})
