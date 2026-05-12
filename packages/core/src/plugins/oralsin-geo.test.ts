import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { GeoViewRegistry } from '../geo/registry.js'
import { buildOralsinSendsView } from './oralsin-plugin.js'

describe('oralsin.sends geo view', () => {
  let db: Database.Database
  let registry: GeoViewRegistry

  beforeEach(() => {
    db = new Database(':memory:')
    db.prepare(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, to_number TEXT, body TEXT, status TEXT,
        sender_number TEXT, plugin_name TEXT, created_at TEXT
      )
    `).run()
    const ins = db.prepare(`INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)`)
    const now = new Date().toISOString()
    ins.run('m1', '5511987654321', 'hi', 'sent',   null, 'oralsin', now)
    ins.run('m2', '5511987654322', 'hi', 'sent',   null, 'oralsin', now)
    ins.run('m3', '5521987654323', 'hi', 'sent',   null, 'oralsin', now)
    ins.run('m4', '5521987654324', 'hi', 'failed', null, 'oralsin', now)
    ins.run('m5', '5511987654325', 'hi', 'sent',   null, 'other',   now)
    registry = new GeoViewRegistry()
    registry.register('oralsin', buildOralsinSendsView(db))
  })

  it('aggregates sent messages by DDD', async () => {
    const view = registry.get('oralsin.sends')!
    const r = await view.aggregate({ window: '24h', filters: { status: 'sent' } })
    expect(r.buckets).toEqual({ '11': 2, '21': 1 })
    expect(r.total).toBe(3)
  })

  it('filters by status', async () => {
    const view = registry.get('oralsin.sends')!
    const r = await view.aggregate({ window: '24h', filters: { status: 'failed' } })
    expect(r.buckets).toEqual({ '21': 1 })
  })

  it('excludes other plugins', async () => {
    const view = registry.get('oralsin.sends')!
    const r = await view.aggregate({ window: '24h', filters: { status: 'sent' } })
    expect(r.buckets['11']).toBe(2)
  })

  it('drill returns phones for given DDD', async () => {
    const view = registry.get('oralsin.sends')!
    const r = await view.drill('11', { window: '24h', filters: { status: 'sent' }, page: 1, pageSize: 50 })
    expect(r.rows.map(x => x.phone)).toEqual(['5511987654321', '5511987654322'])
    expect(r.total).toBe(2)
  })
})
