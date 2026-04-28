import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { MessageQueue } from '../queue/message-queue.js'
import { HealthCollector } from '../monitor/health-collector.js'
import { getChanged24h } from './changed-24h.js'

// Minimal ADB stub for HealthCollector constructor
const stubAdb = {
  shell: async (_serial: string, _cmd: string) => '',
}

describe('getChanged24h', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    // Initialize message queue tables (creates audit_log)
    const queue = new MessageQueue(db)
    queue.initialize()
    // Initialize health_snapshots
    const hc = new HealthCollector(db, stubAdb as never)
    hc.initialize()
  })

  afterEach(() => {
    db.close()
  })

  it('returns empty state when no data', () => {
    const result = getChanged24h(db)
    expect(result.items).toHaveLength(0)
    expect(result.counts.device_added).toBe(0)
    expect(result.counts.key_rotation).toBe(0)
  })

  it('detects newly seen devices from health_snapshots', () => {
    const now = new Date().toISOString()
    db.prepare(`
      INSERT INTO health_snapshots (serial, battery_percent, temperature_celsius, ram_available_mb, storage_free_bytes, wifi_connected, collected_at)
      VALUES ('emulator-5554', 85, 30.0, 512, 1073741824, 1, ?)
    `).run(now)

    const result = getChanged24h(db)
    expect(result.counts.device_added).toBe(1)
    const deviceItem = result.items.find((i) => i.category === 'device_added')
    expect(deviceItem).toBeDefined()
    expect(deviceItem!.description).toContain('emulator-5554')
  })

  it('detects key rotations from audit_log', () => {
    const now = new Date().toISOString()
    db.prepare(`
      INSERT INTO audit_log (actor, action, resource_type, resource_id, created_at)
      VALUES ('api', 'rotate_key', 'plugin', 'oralsin', ?)
    `).run(now)

    const result = getChanged24h(db)
    expect(result.counts.key_rotation).toBe(1)
    const rotItem = result.items.find((i) => i.category === 'key_rotation')
    expect(rotItem).toBeDefined()
    expect(rotItem!.description).toContain('oralsin')
  })

  it('limits items to 10 most recent', () => {
    const now = Date.now()
    // Insert 15 key rotations
    for (let i = 0; i < 15; i++) {
      const ts = new Date(now - i * 60_000).toISOString()
      db.prepare(`
        INSERT INTO audit_log (actor, action, resource_type, resource_id, created_at)
        VALUES ('api', 'rotate_key', 'plugin', 'plugin-${i}', ?)
      `).run(ts)
    }

    const result = getChanged24h(db)
    expect(result.items.length).toBeLessThanOrEqual(10)
    expect(result.counts.key_rotation).toBe(15) // total count includes all
  })

  it('returns all required count keys', () => {
    const result = getChanged24h(db)
    expect(result.counts).toHaveProperty('device_added')
    expect(result.counts).toHaveProperty('device_removed')
    expect(result.counts).toHaveProperty('key_rotation')
    expect(result.counts).toHaveProperty('session_died')
    expect(result.counts).toHaveProperty('plugin_boot')
  })
})
