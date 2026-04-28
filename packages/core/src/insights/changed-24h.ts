import type Database from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'

export type ChangedCategory = 'device_added' | 'device_removed' | 'key_rotation' | 'session_died' | 'plugin_boot'

export interface ChangedItem {
  category: ChangedCategory
  description: string
  occurred_at: string
}

export interface Changed24hResponse {
  counts: Record<ChangedCategory, number>
  items: ChangedItem[]
}

export function getChanged24h(db: Database.Database): Changed24hResponse {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const items: ChangedItem[] = []

  // Devices added: first health snapshot within 24h window
  try {
    const addedRows = db.prepare(`
      SELECT serial, MIN(collected_at) AS first_seen
      FROM health_snapshots
      WHERE collected_at >= ?
      GROUP BY serial
      HAVING MIN(collected_at) >= ?
      ORDER BY first_seen DESC
    `).all(cutoff, cutoff) as { serial: string; first_seen: string }[]

    for (const r of addedRows) {
      items.push({
        category: 'device_added',
        description: `Device ${r.serial} first seen`,
        occurred_at: r.first_seen,
      })
    }
  } catch {
    // health_snapshots table may not exist
  }

  // Devices removed: devices whose last snapshot was more than 30 minutes ago,
  // but they had a snapshot within the 24h window (became stale recently)
  try {
    const removedRows = db.prepare(`
      SELECT serial, MAX(collected_at) AS last_seen
      FROM health_snapshots
      WHERE collected_at >= ?
      GROUP BY serial
      HAVING MAX(collected_at) < datetime('now', '-30 minutes')
      ORDER BY last_seen DESC
    `).all(cutoff) as { serial: string; last_seen: string }[]

    for (const r of removedRows) {
      items.push({
        category: 'device_removed',
        description: `Device ${r.serial} last seen (offline)`,
        occurred_at: r.last_seen,
      })
    }
  } catch {
    // Table doesn't exist
  }

  // Key rotations from audit_log
  try {
    const rotationRows = db.prepare(`
      SELECT resource_id, created_at
      FROM audit_log
      WHERE action = 'rotate_key'
        AND created_at >= ?
      ORDER BY created_at DESC
      LIMIT 20
    `).all(cutoff) as { resource_id: string | null; created_at: string }[]

    for (const r of rotationRows) {
      items.push({
        category: 'key_rotation',
        description: `API key rotated for plugin: ${r.resource_id ?? 'unknown'}`,
        occurred_at: r.created_at,
      })
    }
  } catch {
    // audit_log may not exist
  }

  // Plugin boots from audit_log (action = 'plugin_boot' or resource_type = 'plugin' + action = 'upsert')
  try {
    const bootRows = db.prepare(`
      SELECT resource_id, action, created_at
      FROM audit_log
      WHERE resource_type = 'plugin'
        AND action IN ('boot', 'upsert', 'enable')
        AND created_at >= ?
      ORDER BY created_at DESC
      LIMIT 20
    `).all(cutoff) as { resource_id: string | null; action: string; created_at: string }[]

    for (const r of bootRows) {
      items.push({
        category: 'plugin_boot',
        description: `Plugin ${r.resource_id ?? 'unknown'} ${r.action}`,
        occurred_at: r.created_at,
      })
    }
  } catch {
    // audit_log may not exist
  }

  // WAHA sessions that died: managed_sessions with updated_at < 1h ago and within 24h window
  // (updated_at reflects last state change — a status change to 'stopped' or similar)
  try {
    // Check if managed_sessions has an updated_at column
    const colInfo = db.prepare("PRAGMA table_info(managed_sessions)").all() as { name: string }[]
    const hasUpdatedAt = colInfo.some((c) => c.name === 'updated_at')

    if (hasUpdatedAt) {
      const sessionRows = db.prepare(`
        SELECT session_name, updated_at
        FROM managed_sessions
        WHERE updated_at >= ?
          AND managed = 0
        ORDER BY updated_at DESC
        LIMIT 20
      `).all(cutoff) as { session_name: string; updated_at: string }[]

      for (const r of sessionRows) {
        items.push({
          category: 'session_died',
          description: `Session ${r.session_name} marked unmanaged/died`,
          occurred_at: r.updated_at,
        })
      }
    }
  } catch {
    // managed_sessions may not exist or schema differs
  }

  // Sort all items by occurred_at DESC, take top 10
  items.sort((a, b) => b.occurred_at.localeCompare(a.occurred_at))
  const topItems = items.slice(0, 10)

  // Count by category
  const counts: Record<ChangedCategory, number> = {
    device_added: 0,
    device_removed: 0,
    key_rotation: 0,
    session_died: 0,
    plugin_boot: 0,
  }
  for (const item of items) {
    counts[item.category]++
  }

  return { counts, items: topItems }
}

export function registerChanged24hRoutes(
  server: FastifyInstance,
  db: Database.Database,
): void {
  server.get('/api/v1/insights/changed-24h', async () => {
    return getChanged24h(db)
  })
}
