import type Database from 'better-sqlite3'
import { nanoid } from 'nanoid'
import type { PluginRecord, PluginStatus } from './types.js'

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
  // Cached prepared statements — initialized lazily after initialize()
  private stmtRegister!: Database.Statement
  private stmtGetPlugin!: Database.Statement
  private stmtListPlugins!: Database.Statement
  private stmtUpdateWebhookUrl!: Database.Statement
  private stmtUpdateEvents!: Database.Statement
  private stmtDisable!: Database.Statement
  private stmtEnable!: Database.Statement
  private stmtDelete!: Database.Statement
  private stmtRotateApiKey!: Database.Statement
  private stmtSetStatus!: Database.Statement
  private stmtGetByApiKey!: Database.Statement

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
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
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
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        last_attempt_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        abandoned_at TEXT,
        abandoned_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_failed_callbacks_plugin
        ON failed_callbacks(plugin_name);
      CREATE INDEX IF NOT EXISTS idx_failed_callbacks_retry
        ON failed_callbacks(attempts, created_at);
    `)

    // Idempotent ALTER guard for pre-existing production databases.
    // SQLite does not support ADD COLUMN IF NOT EXISTS, so we check PRAGMA first.
    // IMPORTANT: the partial index on abandoned_at must be created AFTER the column
    // exists, so it cannot be in the CREATE TABLE exec block above.
    const cols = this.db.prepare('PRAGMA table_info(failed_callbacks)').all() as Array<{ name: string }>
    const colNames = new Set(cols.map((c) => c.name))
    if (!colNames.has('abandoned_at')) {
      this.db.exec('ALTER TABLE failed_callbacks ADD COLUMN abandoned_at TEXT')
    }
    if (!colNames.has('abandoned_reason')) {
      this.db.exec('ALTER TABLE failed_callbacks ADD COLUMN abandoned_reason TEXT')
    }

    // Partial index for fast retry-list scans (skip abandoned rows).
    // Created here — after ALTER guard — so the column is guaranteed to exist.
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_failed_callbacks_abandoned ON failed_callbacks(abandoned_at) WHERE abandoned_at IS NULL',
    )

    this.prepareStatements()
  }

  private prepareStatements(): void {
    this.stmtRegister = this.db.prepare(`
      INSERT INTO plugins (name, version, webhook_url, api_key, hmac_secret, events, enabled, status)
      VALUES (?, ?, ?, ?, ?, ?, 1, 'active')
      ON CONFLICT(name) DO UPDATE SET
        version = excluded.version,
        webhook_url = excluded.webhook_url,
        api_key = excluded.api_key,
        hmac_secret = excluded.hmac_secret,
        events = excluded.events,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    `)
    this.stmtGetPlugin = this.db.prepare('SELECT * FROM plugins WHERE name = ?')
    this.stmtListPlugins = this.db.prepare('SELECT * FROM plugins ORDER BY name')
    this.stmtUpdateWebhookUrl = this.db.prepare(
      "UPDATE plugins SET webhook_url = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ?",
    )
    this.stmtUpdateEvents = this.db.prepare(
      "UPDATE plugins SET events = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ?",
    )
    this.stmtDisable = this.db.prepare(
      "UPDATE plugins SET enabled = 0, status = 'disabled', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ?",
    )
    this.stmtEnable = this.db.prepare(
      "UPDATE plugins SET enabled = 1, status = 'active', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ?",
    )
    this.stmtDelete = this.db.prepare('DELETE FROM plugins WHERE name = ?')
    this.stmtRotateApiKey = this.db.prepare(
      "UPDATE plugins SET api_key = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ?",
    )
    this.stmtSetStatus = this.db.prepare(
      "UPDATE plugins SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ?",
    )
    this.stmtGetByApiKey = this.db.prepare(
      'SELECT * FROM plugins WHERE api_key = ? AND enabled = 1',
    )
  }

  register(params: RegisterPluginParams): void {
    this.stmtRegister.run(
      params.name,
      params.version,
      params.webhookUrl,
      params.apiKey,
      params.hmacSecret,
      JSON.stringify(params.events),
    )
  }

  getPlugin(name: string): PluginRecord | null {
    const row = this.stmtGetPlugin.get(name) as PluginRecord | undefined
    return row ?? null
  }

  listPlugins(): PluginRecord[] {
    return this.stmtListPlugins.all() as PluginRecord[]
  }

  updatePlugin(name: string, updates: UpdatePluginParams): void {
    if (updates.webhookUrl !== undefined) {
      this.stmtUpdateWebhookUrl.run(updates.webhookUrl, name)
    }
    if (updates.events !== undefined) {
      this.stmtUpdateEvents.run(JSON.stringify(updates.events), name)
    }
  }

  disablePlugin(name: string): void {
    this.stmtDisable.run(name)
  }

  enablePlugin(name: string): void {
    this.stmtEnable.run(name)
  }

  deletePlugin(name: string): void {
    this.stmtDelete.run(name)
  }

  rotateApiKey(name: string): string {
    const newKey = nanoid(32)
    this.stmtRotateApiKey.run(newKey, name)
    return newKey
  }

  setPluginStatus(name: string, status: PluginStatus): void {
    this.stmtSetStatus.run(status, name)
  }

  getPluginByApiKey(apiKey: string): PluginRecord | null {
    const row = this.stmtGetByApiKey.get(apiKey) as PluginRecord | undefined
    return row ?? null
  }
}
