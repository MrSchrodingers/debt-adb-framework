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
import { DeviceCircuitBreaker } from './device-circuit-breaker.js'
import type { WorkerOrchestratorDeps } from './worker-orchestrator.js'
import type { AdbBridge } from '../adb/index.js'
import type { HealthSnapshot } from '../monitor/types.js'

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

function createTestDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')

  // MessageQueue.initialize() creates messages, contacts, sender_health tables
  const queue = new MessageQueue(db)
  queue.initialize()

  // alerts table (needed by selectDevice / dispatcher)
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

  // health_snapshots table (referenced by HealthCollector)
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

function createMockAdb(overrides: Partial<AdbBridge> = {}): AdbBridge {
  return {
    discover: vi.fn().mockResolvedValue([]),
    shell: vi.fn().mockImplementation(async (_serial: string, cmd: string) => {
      if (cmd.includes('get-current-user')) return '0\n'
      if (cmd.includes('dumpsys power')) return 'Display Power: state=ON\nmHoldingDisplaySuspendBlocker=true\n'
      if (cmd.includes('content://com.android.contacts')) return ''
      if (cmd.includes('am start')) return 'Starting: Intent'
      if (cmd.includes('uiautomator dump')) return ''
      if (cmd.includes('cat /sdcard/window_dump.xml')) return '<hierarchy></hierarchy>'
      return ''
    }),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('fake-png')),
    ...overrides,
  } as unknown as AdbBridge
}

function createDeps(
  db: InstanceType<typeof Database>,
  overrides: Partial<WorkerOrchestratorDeps> = {},
): WorkerOrchestratorDeps {
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
    ...overrides,
  }
}

const DEVICE_SERIAL = 'test-device-001'
const DEVICE_SERIAL_2 = 'test-device-002'
const SENDER_NUMBER = '5543999990001'
const SENDER_NUMBER_2 = '5543999990002'

/** Insert an online device into DB + health map so selectDevice finds it. */
function seedDeviceOnline(deps: WorkerOrchestratorDeps): void {
  deps.db.prepare(
    "INSERT OR REPLACE INTO devices (serial, brand, model, status, last_seen_at) VALUES (?, 'Test', 'Phone', 'online', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
  ).run(DEVICE_SERIAL)

  deps.latestHealthMap.set(DEVICE_SERIAL, {
    serial: DEVICE_SERIAL,
    batteryPercent: 80,
    temperatureCelsius: 30,
    ramAvailableMb: 1024,
    storageFreeBytes: 2e9,
    wifiConnected: true,
    collectedAt: new Date().toISOString(),
  })
}

/** Create a sender_mapping record so the orchestrator can resolve a profile. */
function seedSenderMapping(deps: WorkerOrchestratorDeps): void {
  deps.senderMapping.create({
    phoneNumber: SENDER_NUMBER,
    deviceSerial: DEVICE_SERIAL,
    profileId: 0,
    appPackage: 'com.whatsapp',
  })
}

/** Enqueue a single message with the shared sender number. */
function enqueueTestMessage(deps: WorkerOrchestratorDeps, suffix = ''): ReturnType<MessageQueue['enqueue']> {
  return deps.queue.enqueue({
    to: '5543991938235',
    body: `Test message${suffix}`,
    idempotencyKey: `test-${Date.now()}-${Math.random()}`,
    senderNumber: SENDER_NUMBER,
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkerOrchestrator', () => {
  let db: InstanceType<typeof Database>
  let deps: WorkerOrchestratorDeps
  let orchestrator: WorkerOrchestrator

  beforeEach(() => {
    db = createTestDb()
    deps = createDeps(db)
    orchestrator = new WorkerOrchestrator(deps)
  })

  afterEach(() => {
    db.close()
  })

  // 1. processes message successfully
  it('processes message successfully', async () => {
    seedDeviceOnline(deps)
    seedSenderMapping(deps)
    const msg = enqueueTestMessage(deps)

    // Mock engine.send to succeed — must also update status because the real
    // SendEngine.send() calls queue.updateStatus(id, 'locked', 'sending') then
    // queue.updateStatus(id, 'sending', 'sent') internally.
    vi.spyOn(deps.engine, 'send').mockImplementation(async (message) => {
      deps.queue.updateStatus(message.id, 'locked', 'sending')
      deps.queue.updateStatus(message.id, 'sending', 'sent')
      return { screenshot: Buffer.from('ok'), durationMs: 100, contactRegistered: false, dialogsDismissed: 0 }
    })

    await orchestrator.tick()

    const updated = deps.queue.getById(msg.id)
    expect(updated).not.toBeNull()
    expect(updated!.status).toBe('sent')
  })

  // 2. skips batch when sender at daily cap
  it('skips batch when sender at daily cap', async () => {
    // RateLimitGuard with maxPerSenderPerDay=0 means canSend(0) === false
    const cappedGuard = new RateLimitGuard({ maxPerSenderPerDay: 0 })
    deps = createDeps(db, { rateLimitGuard: cappedGuard })
    orchestrator = new WorkerOrchestrator(deps)

    seedDeviceOnline(deps)
    seedSenderMapping(deps)
    const msg = enqueueTestMessage(deps)

    await orchestrator.tick()

    const updated = deps.queue.getById(msg.id)
    expect(updated).not.toBeNull()
    // Message should be requeued back to 'queued' since sender is capped
    expect(updated!.status).toBe('queued')
  })

  // 3. skips batch when sender quarantined
  it('skips batch when sender quarantined', async () => {
    seedDeviceOnline(deps)
    seedSenderMapping(deps)

    // Quarantine the sender: 3 consecutive failures triggers quarantine
    deps.senderHealth.recordFailure(SENDER_NUMBER)
    deps.senderHealth.recordFailure(SENDER_NUMBER)
    deps.senderHealth.recordFailure(SENDER_NUMBER)
    expect(deps.senderHealth.isQuarantined(SENDER_NUMBER)).toBe(true)

    const msg = enqueueTestMessage(deps)

    await orchestrator.tick()

    const updated = deps.queue.getById(msg.id)
    expect(updated).not.toBeNull()
    expect(updated!.status).toBe('queued')
  })

  // 4. skips when no device online
  it('skips when no device online', async () => {
    // No device seeded - getDevices returns empty
    const msg = enqueueTestMessage(deps)

    await orchestrator.tick()

    // Message stays queued - tick() exits before dequeueBySender
    const updated = deps.queue.getById(msg.id)
    expect(updated).not.toBeNull()
    expect(updated!.status).toBe('queued')
  })

  // 5. records senderHealth success on send
  it('records senderHealth success on send', async () => {
    seedDeviceOnline(deps)
    seedSenderMapping(deps)
    enqueueTestMessage(deps)

    vi.spyOn(deps.engine, 'send').mockImplementation(async (message) => {
      deps.queue.updateStatus(message.id, 'locked', 'sending')
      deps.queue.updateStatus(message.id, 'sending', 'sent')
      return { screenshot: Buffer.from('ok'), durationMs: 50, contactRegistered: false, dialogsDismissed: 0 }
    })

    await orchestrator.tick()

    const status = deps.senderHealth.getStatus(SENDER_NUMBER)
    expect(status).not.toBeNull()
    expect(status!.totalSuccesses).toBe(1)
    expect(status!.consecutiveFailures).toBe(0)
  })

  // 6. records senderHealth failure when ADB + WAHA fail
  it('records senderHealth failure when both ADB and WAHA fail', async () => {
    seedDeviceOnline(deps)
    seedSenderMapping(deps)
    enqueueTestMessage(deps)

    // ADB send fails — simulate real engine behavior: transition locked→sending, then throw
    vi.spyOn(deps.engine, 'send').mockImplementation(async (message) => {
      deps.queue.updateStatus(message.id, 'locked', 'sending')
      throw new Error('ADB failed')
    })
    // WAHA fallback also fails (already mocked to reject in createDeps, but be explicit)
    vi.spyOn(deps.wahaFallback, 'send').mockRejectedValue(new Error('WAHA down'))

    await orchestrator.tick()

    const status = deps.senderHealth.getStatus(SENDER_NUMBER)
    expect(status).not.toBeNull()
    expect(status!.totalFailures).toBe(1)
  })

  // 7. requeues message on ADB+WAHA failure when attempts < maxRetries
  it('requeues message on ADB+WAHA failure when attempts < maxRetries', async () => {
    seedDeviceOnline(deps)
    seedSenderMapping(deps)
    const msg = enqueueTestMessage(deps)

    // Verify message starts at attempts=0 with maxRetries=3
    expect(msg.attempts).toBe(0)
    expect(msg.maxRetries).toBe(3)

    // ADB send fails — simulate real engine behavior: transition locked→sending, then throw
    vi.spyOn(deps.engine, 'send').mockImplementation(async (message) => {
      deps.queue.updateStatus(message.id, 'locked', 'sending')
      throw new Error('ADB failed')
    })
    // WAHA fallback also fails
    vi.spyOn(deps.wahaFallback, 'send').mockRejectedValue(new Error('WAHA down'))

    await orchestrator.tick()

    const updated = deps.queue.getById(msg.id)
    expect(updated).not.toBeNull()
    // Should be requeued (not permanently_failed) since attempts(0)+1 < maxRetries(3)
    expect(updated!.status).toBe('queued')
    expect(updated!.attempts).toBe(1)
  })

  // 8. permanently fails message when attempts >= maxRetries
  it('permanently fails message when attempts >= maxRetries', async () => {
    seedDeviceOnline(deps)
    seedSenderMapping(deps)
    const msg = enqueueTestMessage(deps)

    // Simulate message already at attempts=2 (maxRetries=3 → 2+1 >= 3 → permanent fail)
    deps.db.prepare('UPDATE messages SET attempts = 2 WHERE id = ?').run(msg.id)

    // ADB send fails — simulate real engine behavior: transition locked→sending, then throw
    vi.spyOn(deps.engine, 'send').mockImplementation(async (message) => {
      deps.queue.updateStatus(message.id, 'locked', 'sending')
      throw new Error('ADB failed')
    })
    // WAHA fallback also fails
    vi.spyOn(deps.wahaFallback, 'send').mockRejectedValue(new Error('WAHA down'))

    const failedEvents: unknown[] = []
    deps.emitter.on('message:failed', (data) => failedEvents.push(data))

    await orchestrator.tick()

    const updated = deps.queue.getById(msg.id)
    expect(updated).not.toBeNull()
    expect(updated!.status).toBe('permanently_failed')
    expect(failedEvents).toHaveLength(1)
  })

  // 9. processes batches on multiple devices in parallel
  it('processes batches on multiple devices in parallel', async () => {
    seedDeviceOnline(deps)

    // Seed second device
    deps.db.prepare(
      "INSERT OR REPLACE INTO devices (serial, brand, model, status, last_seen_at) VALUES (?, 'Test', 'Phone2', 'online', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
    ).run(DEVICE_SERIAL_2)
    deps.latestHealthMap.set(DEVICE_SERIAL_2, {
      serial: DEVICE_SERIAL_2,
      batteryPercent: 75,
      temperatureCelsius: 32,
      ramAvailableMb: 900,
      storageFreeBytes: 1.5e9,
      wifiConnected: true,
      collectedAt: new Date().toISOString(),
    })

    // Map sender 1 to device 1, sender 2 to device 2
    seedSenderMapping(deps)
    deps.senderMapping.create({
      phoneNumber: SENDER_NUMBER_2,
      deviceSerial: DEVICE_SERIAL_2,
      profileId: 0,
      appPackage: 'com.whatsapp',
    })

    // Enqueue messages for both senders
    const msg1 = deps.queue.enqueue({
      to: '5543991938235',
      body: 'Msg device 1',
      idempotencyKey: `parallel-d1-${Date.now()}`,
      senderNumber: SENDER_NUMBER,
    })
    const msg2 = deps.queue.enqueue({
      to: '5543991938235',
      body: 'Msg device 2',
      idempotencyKey: `parallel-d2-${Date.now()}`,
      senderNumber: SENDER_NUMBER_2,
    })

    const processedDevices: string[] = []
    vi.spyOn(deps.engine, 'send').mockImplementation(async (message, deviceSerial) => {
      processedDevices.push(deviceSerial as string)
      deps.queue.updateStatus(message.id, 'locked', 'sending')
      deps.queue.updateStatus(message.id, 'sending', 'sent')
      return { screenshot: Buffer.from('ok'), durationMs: 50, contactRegistered: false, dialogsDismissed: 0 }
    })

    await orchestrator.tick()

    // Both messages should be sent
    expect(deps.queue.getById(msg1.id)!.status).toBe('sent')
    expect(deps.queue.getById(msg2.id)!.status).toBe('sent')

    // Both devices should have been used
    expect(processedDevices).toHaveLength(2)
    expect(processedDevices).toContain(DEVICE_SERIAL)
    expect(processedDevices).toContain(DEVICE_SERIAL_2)
  })

  // 10. suppresses log spam for capped sender
  it('suppresses log spam for capped sender', async () => {
    const cappedGuard = new RateLimitGuard({ maxPerSenderPerDay: 0 })
    deps = createDeps(db, { rateLimitGuard: cappedGuard })
    orchestrator = new WorkerOrchestrator(deps)

    seedDeviceOnline(deps)
    seedSenderMapping(deps)

    // First tick - should log warn about daily limit
    enqueueTestMessage(deps, '-1')
    await orchestrator.tick()

    const warnFn = deps.logger.warn as ReturnType<typeof vi.fn>
    expect(warnFn).toHaveBeenCalledTimes(1)
    expect(warnFn.mock.calls[0][1]).toMatch(/daily limit/)

    // Second tick within 60s cooldown - requeues silently, no new warn
    enqueueTestMessage(deps, '-2')
    await orchestrator.tick()

    // warn still called only once total (the second tick hits cappedSendersCooldown and returns early)
    expect(warnFn).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Circuit breaker wiring integration tests
// ---------------------------------------------------------------------------
// These tests verify that per-send ADB failures are wired through to the
// DeviceCircuitBreaker instance via the real class (not a mock), catching the
// bug where recordFailure was never called because processMessage swallows all
// errors and the batch-end recordSuccess was called unconditionally.
// ---------------------------------------------------------------------------

describe('WorkerOrchestrator — circuit breaker wiring', () => {
  let db: InstanceType<typeof Database>
  let deps: WorkerOrchestratorDeps
  let orchestrator: WorkerOrchestrator
  let breaker: DeviceCircuitBreaker

  beforeEach(() => {
    db = createTestDb()

    // Initialize circuit-breaker table on the same in-memory DB
    breaker = new DeviceCircuitBreaker(db, new DispatchEmitter(), {
      failureThreshold: 5,
      cooldownMs: 300_000,
    })
    breaker.initialize()

    // High quarantine threshold so sender quarantine doesn't prevent circuit breaker from
    // accumulating failures — we want to test the circuit breaker, not the sender quarantine.
    const senderHealthNoQuarantine = new SenderHealth(db, { quarantineAfterFailures: 100 })
    deps = createDeps(db, { circuitBreaker: breaker, senderHealth: senderHealthNoQuarantine })
    // Zero inter-message delays so batch tests don't time out waiting for rate-limit sleep
    vi.spyOn(deps.rateLimitGuard, 'getInterMessageDelay').mockReturnValue(0)
    orchestrator = new WorkerOrchestrator(deps)
  })

  afterEach(() => {
    db.close()
  })

  // 11. ADB failures increment the circuit-breaker counter per-send;
  //     after failureThreshold failures the breaker opens.
  it('opens circuit breaker after failureThreshold consecutive ADB failures (wiring test)', async () => {
    seedDeviceOnline(deps)
    seedSenderMapping(deps)

    // ADB send always fails; WAHA fallback also fails so messages requeue
    vi.spyOn(deps.engine, 'send').mockImplementation(async (message) => {
      deps.queue.updateStatus(message.id, 'locked', 'sending')
      throw new Error('ADB connection refused')
    })
    vi.spyOn(deps.wahaFallback, 'send').mockRejectedValue(new Error('WAHA down'))

    // Drive 5 ticks, each enqueuing a fresh message to a unique phone to
    // avoid auto-ban blocking subsequent enqueues on the same number.
    for (let i = 0; i < 5; i++) {
      deps.queue.enqueue({
        to: `554399193${8200 + i}`,
        body: `CB test ${i}`,
        idempotencyKey: `cb-iter-${i}-${Date.now()}`,
        senderNumber: SENDER_NUMBER,
      })
      await orchestrator.tick()
    }

    const state = breaker.getState(DEVICE_SERIAL)
    expect(state).not.toBeNull()
    expect(state!.state).toBe('open')
    // consecutiveFailures is >= threshold because batches may grow and record more
    // failures within the same tick after the circuit opens (for-loop does not bail mid-batch)
    expect(state!.consecutiveFailures).toBeGreaterThanOrEqual(5)
    expect(breaker.canUse(DEVICE_SERIAL)).toBe(false)
  })

  // 12. After circuit opens, tickDevice short-circuits (canUse = false) and
  //     does NOT attempt to dequeue / process any more messages.
  it('short-circuits tickDevice when circuit is open (canUse = false)', async () => {
    seedDeviceOnline(deps)
    seedSenderMapping(deps)

    const sendSpy = vi.spyOn(deps.engine, 'send').mockImplementation(async (message) => {
      deps.queue.updateStatus(message.id, 'locked', 'sending')
      throw new Error('ADB connection refused')
    })
    vi.spyOn(deps.wahaFallback, 'send').mockRejectedValue(new Error('WAHA down'))

    // Exhaust threshold — use unique phones to avoid auto-ban blocking enqueues
    for (let i = 0; i < 5; i++) {
      deps.queue.enqueue({
        to: `554399193${9200 + i}`,
        body: `Open test ${i}`,
        idempotencyKey: `open-iter-${i}-${Date.now()}`,
        senderNumber: SENDER_NUMBER,
      })
      await orchestrator.tick()
    }

    expect(breaker.canUse(DEVICE_SERIAL)).toBe(false)

    // 6th tick: circuit is open — no further sends should happen
    const sendCallsBefore = sendSpy.mock.calls.length
    deps.queue.enqueue({
      to: '5543991939300',
      body: 'After open test',
      idempotencyKey: `after-open-${Date.now()}`,
      senderNumber: SENDER_NUMBER,
    })
    await orchestrator.tick()

    expect(sendSpy.mock.calls.length).toBe(sendCallsBefore) // no new send attempts
  })
})

// ---------------------------------------------------------------------------
// Task 5.4 — Auto-ban trigger tests
// ---------------------------------------------------------------------------

describe('WorkerOrchestrator — auto-ban (Task 5.4)', () => {
  let db: InstanceType<typeof Database>
  let deps: WorkerOrchestratorDeps
  let orchestrator: WorkerOrchestrator

  beforeEach(() => {
    db = createTestDb()
    // High quarantine threshold so sender quarantine doesn't interfere
    const senderHealth = new SenderHealth(db, { quarantineAfterFailures: 100 })
    deps = createDeps(db, { senderHealth })
    vi.spyOn(deps.rateLimitGuard, 'getInterMessageDelay').mockReturnValue(0)
    orchestrator = new WorkerOrchestrator(deps)
  })

  afterEach(() => db.close())

  // C1 — positive path: NoWhatsAppError on ADB triggers immediate ban (single attempt)
  it('bans recipient immediately when ADB throws NoWhatsAppError (recipient-specific)', async () => {
    seedDeviceOnline(deps)
    seedSenderMapping(deps)
    const msg = deps.queue.enqueue({
      to: '5543991938235',
      body: 'NoWA ban test',
      idempotencyKey: `ban-nowa-${Date.now()}`,
      senderNumber: SENDER_NUMBER,
      maxRetries: 3,
    })

    vi.spyOn(deps.engine, 'send').mockImplementation(async (message) => {
      deps.queue.updateStatus(message.id, 'locked', 'sending')
      const err = new Error('Recipient 5543991938235 is not on WhatsApp — number cannot receive messages')
      err.name = 'NoWhatsAppError'
      throw err
    })
    // WAHA fallback must NOT be called for recipient-specific errors
    const wahaFallbackSpy = vi.spyOn(deps.wahaFallback, 'send')

    await orchestrator.tick()

    const updated = deps.queue.getById(msg.id)
    expect(updated!.status).toBe('permanently_failed')
    // Recipient IS banned
    expect(deps.queue.isBlacklisted('5543991938235')).toBe(true)
    // WAHA fallback must not have been called (recipient problem, not infra)
    expect(wahaFallbackSpy).not.toHaveBeenCalled()
  })

  // C1 — negative path: generic infra error (timeout) reaching maxRetries must NOT ban
  it('does NOT ban recipient when permanently_failed due to infrastructure errors (timeout)', async () => {
    seedDeviceOnline(deps)
    seedSenderMapping(deps)
    const msg = deps.queue.enqueue({
      to: '5543991938400',
      body: 'Infra fail test',
      idempotencyKey: `infra-fail-${Date.now()}`,
      senderNumber: SENDER_NUMBER,
      maxRetries: 1, // one attempt → permanent fail immediately
    })

    vi.spyOn(deps.engine, 'send').mockImplementation(async (message) => {
      deps.queue.updateStatus(message.id, 'locked', 'sending')
      throw new Error('Timeout: 30000ms exceeded')
    })
    vi.spyOn(deps.wahaFallback, 'send').mockRejectedValue(new Error('WAHA API error: 503 Service Unavailable'))

    await orchestrator.tick()

    const updated = deps.queue.getById(msg.id)
    expect(updated!.status).toBe('permanently_failed')
    // Recipient must NOT be banned — this was an infra failure, not a recipient problem
    expect(deps.queue.isBlacklisted('5543991938400')).toBe(false)
  })

  it('does NOT ban when message is requeued for retry (below maxRetries threshold)', async () => {
    seedDeviceOnline(deps)
    seedSenderMapping(deps)
    const msg = deps.queue.enqueue({
      to: '5543991938111',
      body: 'Retry test',
      idempotencyKey: `ban-retry-${Date.now()}`,
      senderNumber: SENDER_NUMBER,
      maxRetries: 3, // attempts=0, so 0+1=1 < 3 → requeue, not permanently_failed
    })

    vi.spyOn(deps.engine, 'send').mockImplementation(async (message) => {
      deps.queue.updateStatus(message.id, 'locked', 'sending')
      throw new Error('transient ADB failure')
    })
    vi.spyOn(deps.wahaFallback, 'send').mockRejectedValue(new Error('WAHA down'))

    await orchestrator.tick()

    const updated = deps.queue.getById(msg.id)
    expect(updated!.status).toBe('queued') // requeued, not permanently failed
    // No ban — single failure below threshold
    expect(deps.queue.isBlacklisted('5543991938111')).toBe(false)
  })
})
