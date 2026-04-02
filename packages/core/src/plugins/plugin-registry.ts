import type Database from 'better-sqlite3'
import { nanoid } from 'nanoid'
import type { PluginRecord } from './types.js'

export interface RegisterPluginParams {
  name: string
  version: string
  webhookUrl: string
  apiKey: string
  hmacSecret: string
  events: string[]
}

export interface UpdatePluginParams {
  webhookUrl?: string
  events?: string[]
}

export class PluginRegistry {
  constructor(private db: Database.Database) {}

  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS plugins (
        name TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        webhook_url TEXT NOT NULL,
        api_key TEXT NOT NULL,
        hmac_secret TEXT NOT NULL,
        events TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS failed_callbacks (
        id TEXT PRIMARY KEY,
        plugin_name TEXT NOT NULL,
        message_id TEXT NOT NULL,
        callback_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        webhook_url TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_attempt_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_failed_callbacks_plugin
        ON failed_callbacks(plugin_name);
    `)
  }

  register(params: RegisterPluginParams): void {
    this.db.prepare(`
      INSERT INTO plugins (name, version, webhook_url, api_key, hmac_secret, events, enabled, status)
      VALUES (?, ?, ?, ?, ?, ?, 1, 'active')
      ON CONFLICT(name) DO UPDATE SET
        version = excluded.version,
        webhook_url = excluded.webhook_url,
        events = excluded.events,
        updated_at = datetime('now')
    `).run(
      params.name,
      params.version,
      params.webhookUrl,
      params.apiKey,
      params.hmacSecret,
      JSON.stringify(params.events),
    )
  }

  getPlugin(name: string): PluginRecord | null {
    const row = this.db.prepare('SELECT * FROM plugins WHERE name = ?').get(name) as PluginRecord | undefined
    return row ?? null
  }

  listPlugins(): PluginRecord[] {
    return this.db.prepare('SELECT * FROM plugins ORDER BY name').all() as PluginRecord[]
  }

  updatePlugin(name: string, updates: UpdatePluginParams): void {
    if (updates.webhookUrl !== undefined) {
      this.db.prepare(
        "UPDATE plugins SET webhook_url = ?, updated_at = datetime('now') WHERE name = ?",
      ).run(updates.webhookUrl, name)
    }
    if (updates.events !== undefined) {
      this.db.prepare(
        "UPDATE plugins SET events = ?, updated_at = datetime('now') WHERE name = ?",
      ).run(JSON.stringify(updates.events), name)
    }
  }

  disablePlugin(name: string): void {
    this.db.prepare(
      "UPDATE plugins SET enabled = 0, status = 'disabled', updated_at = datetime('now') WHERE name = ?",
    ).run(name)
  }

  enablePlugin(name: string): void {
    this.db.prepare(
      "UPDATE plugins SET enabled = 1, status = 'active', updated_at = datetime('now') WHERE name = ?",
    ).run(name)
  }

  deletePlugin(name: string): void {
    this.db.prepare('DELETE FROM plugins WHERE name = ?').run(name)
  }

  rotateApiKey(name: string): string {
    const newKey = nanoid(32)
    this.db.prepare(
      "UPDATE plugins SET api_key = ?, updated_at = datetime('now') WHERE name = ?",
    ).run(newKey, name)
    return newKey
  }

  setPluginStatus(name: string, status: string): void {
    this.db.prepare(
      "UPDATE plugins SET status = ?, updated_at = datetime('now') WHERE name = ?",
    ).run(status, name)
  }

  getPluginByApiKey(apiKey: string): PluginRecord | null {
    const row = this.db.prepare(
      'SELECT * FROM plugins WHERE api_key = ? AND enabled = 1',
    ).get(apiKey) as PluginRecord | undefined
    return row ?? null
  }
}
