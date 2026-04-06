import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { Dispatcher, selectDevice } from './dispatcher.js'
import type { SenderState } from './types.js'
import type { DeviceRecord, HealthSnapshot } from '../monitor/types.js'

function makeSender(overrides: Partial<SenderState> & { senderNumber: string }): SenderState {
  return {
    banned: false,
    banExpiresAt: null,
    sendCountInWindow: 0,
    lastSendAt: null,
    cooldownExpiresAt: null,
    ...overrides,
  }
}

function makeDevice(serial: string, status: DeviceRecord['status'] = 'online'): DeviceRecord {
  return {
    serial,
    brand: 'TestBrand',
    model: 'TestModel',
    status,
    lastSeenAt: new Date().toISOString(),
    alertThresholds: null,
  }
}

function makeHealth(serial: string, overrides: Partial<HealthSnapshot> = {}): HealthSnapshot {
  return {
    serial,
    batteryPercent: 80,
    temperatureCelsius: 30,
    ramAvailableMb: 1024,
    storageFreeBytes: 2_000_000_000,
    wifiConnected: true,
    collectedAt: new Date().toISOString(),
    ...overrides,
  }
}

describe('Dispatcher', () => {
  let dispatcher: Dispatcher
  let currentTime: number

  beforeEach(() => {
    currentTime = 1000000
    dispatcher = new Dispatcher(() => currentTime)
  })

  describe('selectSender', () => {
    it('selects the number with fewest sends in window', async () => {
      const senders = [
        makeSender({ senderNumber: '5543999990001', sendCountInWindow: 15 }),
        makeSender({ senderNumber: '5543999990002', sendCountInWindow: 5 }),
        makeSender({ senderNumber: '5543999990003', sendCountInWindow: 10 }),
      ]

      const decision = await dispatcher.selectSender(senders)
      expect(decision).not.toBeNull()
      expect(decision!.senderNumber).toBe('5543999990002')
    })

    it('returns null when no senders have expired cooldown', async () => {
      const future = currentTime + 60_000
      const senders = [
        makeSender({ senderNumber: '5543999990001', cooldownExpiresAt: future }),
        makeSender({ senderNumber: '5543999990002', cooldownExpiresAt: future }),
      ]

      const decision = await dispatcher.selectSender(senders)
      expect(decision).toBeNull()
    })

    it('skips banned numbers', async () => {
      const senders = [
        makeSender({ senderNumber: '5543999990001', banned: true, banExpiresAt: Date.parse('2026-04-03T00:00:00Z') }),
        makeSender({ senderNumber: '5543999990002', sendCountInWindow: 10 }),
      ]

      const decision = await dispatcher.selectSender(senders)
      expect(decision).not.toBeNull()
      expect(decision!.senderNumber).toBe('5543999990002')
    })

    it('returns null when all numbers are banned', async () => {
      const senders = [
        makeSender({ senderNumber: '5543999990001', banned: true }),
        makeSender({ senderNumber: '5543999990002', banned: true }),
      ]

      const decision = await dispatcher.selectSender(senders)
      expect(decision).toBeNull()
    })

    it('selects sender with expired cooldown over one still cooling', async () => {
      const senders = [
        makeSender({ senderNumber: '5543999990001', cooldownExpiresAt: currentTime - 1000, sendCountInWindow: 10 }),
        makeSender({ senderNumber: '5543999990002', cooldownExpiresAt: currentTime + 5000, sendCountInWindow: 2 }),
      ]

      const decision = await dispatcher.selectSender(senders)
      expect(decision).not.toBeNull()
      expect(decision!.senderNumber).toBe('5543999990001')
    })
  })

  describe('getNextDispatchTime', () => {
    it('returns earliest cooldown expiry across all numbers', async () => {
      const senders = [
        makeSender({ senderNumber: '5543999990001', cooldownExpiresAt: currentTime + 30_000 }),
        makeSender({ senderNumber: '5543999990002', cooldownExpiresAt: currentTime + 10_000 }),
        makeSender({ senderNumber: '5543999990003', cooldownExpiresAt: currentTime + 20_000 }),
      ]

      const nextTime = await dispatcher.getNextDispatchTime(senders)
      expect(nextTime).toBe(currentTime + 10_000)
    })

    it('returns null when no numbers available (all banned)', async () => {
      const senders = [
        makeSender({ senderNumber: '5543999990001', banned: true }),
      ]

      const nextTime = await dispatcher.getNextDispatchTime(senders)
      expect(nextTime).toBeNull()
    })

    it('returns current time when a number has no cooldown', async () => {
      const senders = [
        makeSender({ senderNumber: '5543999990001', cooldownExpiresAt: null }),
      ]

      const nextTime = await dispatcher.getNextDispatchTime(senders)
      expect(nextTime).toBeLessThanOrEqual(currentTime)
    })
  })

  describe('isAllBanned', () => {
    it('returns false when at least one number is active', () => {
      const senders = [
        makeSender({ senderNumber: '5543999990001', banned: true }),
        makeSender({ senderNumber: '5543999990002', banned: false }),
      ]
      expect(dispatcher.isAllBanned(senders)).toBe(false)
    })

    it('returns true when all numbers are banned', () => {
      const senders = [
        makeSender({ senderNumber: '5543999990001', banned: true }),
        makeSender({ senderNumber: '5543999990002', banned: true }),
      ]
      expect(dispatcher.isAllBanned(senders)).toBe(true)
    })

    it('returns true for empty array', () => {
      expect(dispatcher.isAllBanned([])).toBe(true)
    })
  })
})

describe('selectDevice', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    // Create alerts table (normally created by AlertSystem)
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
  })

  afterEach(() => {
    db.close()
  })

  it('distributes messages across multiple devices based on health score', () => {
    const devices = [
      makeDevice('device-A'),
      makeDevice('device-B'),
    ]
    const healthMap = new Map<string, HealthSnapshot>([
      ['device-A', makeHealth('device-A', { batteryPercent: 90, temperatureCelsius: 25, ramAvailableMb: 2048, storageFreeBytes: 5_000_000_000 })],
      ['device-B', makeHealth('device-B', { batteryPercent: 50, temperatureCelsius: 40, ramAvailableMb: 512, storageFreeBytes: 1_000_000_000 })],
    ])

    const result = selectDevice(devices, healthMap, db)
    expect(result).not.toBeNull()
    // device-A should have higher score (better battery, lower temp, more ram/storage)
    expect(result!.serial).toBe('device-A')
  })

  it('skips devices with active ban alert', () => {
    const devices = [
      makeDevice('banned-device'),
      makeDevice('healthy-device'),
    ]
    const healthMap = new Map<string, HealthSnapshot>([
      ['banned-device', makeHealth('banned-device', { batteryPercent: 100, temperatureCelsius: 20, ramAvailableMb: 4096, storageFreeBytes: 10_000_000_000 })],
      ['healthy-device', makeHealth('healthy-device', { batteryPercent: 50, temperatureCelsius: 35, ramAvailableMb: 512, storageFreeBytes: 1_000_000_000 })],
    ])

    // Insert unresolved ban alert for banned-device
    db.prepare(
      "INSERT INTO alerts (id, device_serial, severity, type, message) VALUES ('a1', 'banned-device', 'critical', 'waha_session_banned', 'Device banned')"
    ).run()

    const result = selectDevice(devices, healthMap, db)
    expect(result).not.toBeNull()
    expect(result!.serial).toBe('healthy-device')
  })

  it('deprioritizes devices with battery < 15%', () => {
    const devices = [
      makeDevice('low-battery'),
      makeDevice('normal-battery'),
    ]
    const healthMap = new Map<string, HealthSnapshot>([
      ['low-battery', makeHealth('low-battery', { batteryPercent: 10, temperatureCelsius: 25, ramAvailableMb: 4096, storageFreeBytes: 10_000_000_000 })],
      ['normal-battery', makeHealth('normal-battery', { batteryPercent: 20, temperatureCelsius: 35, ramAvailableMb: 512, storageFreeBytes: 1_000_000_000 })],
    ])

    const result = selectDevice(devices, healthMap, db)
    expect(result).not.toBeNull()
    // Despite better raw stats, low-battery device gets 0.1x multiplier
    expect(result!.serial).toBe('normal-battery')
  })

  it('returns null when no healthy device available', () => {
    // All offline
    const devices = [
      makeDevice('device-A', 'offline'),
      makeDevice('device-B', 'offline'),
    ]
    const healthMap = new Map<string, HealthSnapshot>()

    const result = selectDevice(devices, healthMap, db)
    expect(result).toBeNull()
  })

  it('returns null when all devices are banned', () => {
    const devices = [
      makeDevice('device-A'),
      makeDevice('device-B'),
    ]
    const healthMap = new Map<string, HealthSnapshot>([
      ['device-A', makeHealth('device-A')],
      ['device-B', makeHealth('device-B')],
    ])

    db.prepare(
      "INSERT INTO alerts (id, device_serial, severity, type, message) VALUES ('a1', 'device-A', 'critical', 'waha_session_banned', 'Banned')"
    ).run()
    db.prepare(
      "INSERT INTO alerts (id, device_serial, severity, type, message) VALUES ('a2', 'device-B', 'critical', 'waha_session_banned', 'Banned')"
    ).run()

    const result = selectDevice(devices, healthMap, db)
    expect(result).toBeNull()
  })

  it('calculates health score correctly', () => {
    const devices = [makeDevice('device-A')]
    // batteryPercent=80, temp=30, ram=1000, storage=2e9
    // score = 80*0.3 + (100-30)*0.3 + (1000/1000)*0.2 + min(2e9/1e9,100)*0.2
    //       = 24 + 21 + 0.2 + 0.4 = 45.6
    const healthMap = new Map<string, HealthSnapshot>([
      ['device-A', makeHealth('device-A', { batteryPercent: 80, temperatureCelsius: 30, ramAvailableMb: 1000, storageFreeBytes: 2_000_000_000 })],
    ])

    const result = selectDevice(devices, healthMap, db)
    expect(result).not.toBeNull()
    expect(result!.serial).toBe('device-A')
  })

  it('ignores resolved ban alerts', () => {
    const devices = [makeDevice('device-A')]
    const healthMap = new Map<string, HealthSnapshot>([
      ['device-A', makeHealth('device-A')],
    ])

    // Insert resolved ban alert
    db.prepare(
      "INSERT INTO alerts (id, device_serial, severity, type, message, resolved, resolved_at) VALUES ('a1', 'device-A', 'critical', 'waha_session_banned', 'Was banned', 1, '2026-01-01T00:00:00Z')"
    ).run()

    const result = selectDevice(devices, healthMap, db)
    expect(result).not.toBeNull()
    expect(result!.serial).toBe('device-A')
  })

  it('skips devices without health data (no snapshot)', () => {
    const devices = [
      makeDevice('no-health'),
      makeDevice('has-health'),
    ]
    const healthMap = new Map<string, HealthSnapshot>([
      // no entry for 'no-health'
      ['has-health', makeHealth('has-health')],
    ])

    const result = selectDevice(devices, healthMap, db)
    expect(result).not.toBeNull()
    expect(result!.serial).toBe('has-health')
  })
})
