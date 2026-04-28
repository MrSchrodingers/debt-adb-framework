/**
 * Manual circuit breaker — pause dispatch chains on demand.
 *
 * Three scopes (most-specific wins):
 *   1. PER-MESSAGE   — block a single in-flight idempotency_key from advancing
 *   2. PER-CHAIN     — block a chain identified by (plugin, sender_phone, device_serial)
 *                      OR by correlation_id / chain_key (whichever the caller provides)
 *   3. GLOBAL        — pause every send (full kill-switch)
 *
 * State is persisted in SQLite so a restart preserves the pause. Every
 * write fires a structured Telegram/Slack alert (via DispatchEmitter →
 * server.ts handler) so operators see the action.
 *
 * Resume operations clear the row and emit a complementary event.
 */

import type Database from 'better-sqlite3'
import type { DispatchEmitter } from '../events/dispatch-emitter.js'

export type PauseScope = 'global' | 'plugin' | 'sender' | 'device' | 'chain' | 'message'

export interface PauseRecord {
  scope: PauseScope
  /**
   * Composite key — semantics depend on scope:
   *  - global  → fixed string '*'
   *  - plugin  → plugin name
   *  - sender  → digits-only sender phone
   *  - device  → device serial
   *  - chain   → free-form chain key (plugin:correlation_id, plugin:sender:device, etc.)
   *  - message → idempotency_key
   */
  key: string
  reason: string
  paused_by: string
  paused_at: string
  resumed_at: string | null
}

export interface PauseDecision {
  paused: boolean
  match?: { scope: PauseScope; key: string; reason: string; paused_at: string; paused_by: string }
}

export interface PauseEventPayload {
  action: 'pause' | 'resume'
  scope: PauseScope
  key: string
  reason: string
  by: string
  at: string
}

export class DispatchPauseState {
  private stmtUpsert!: Database.Statement
  private stmtResume!: Database.Statement
  private stmtListActive!: Database.Statement
  private stmtListAll!: Database.Statement
  private stmtCheck!: Database.Statement
  private memCache = new Map<string, PauseRecord>() // scope|key → record (active only)

  constructor(
    private readonly db: Database.Database,
    private readonly emitter: DispatchEmitter,
  ) {}

  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dispatch_pause (
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        reason TEXT NOT NULL,
        paused_by TEXT NOT NULL,
        paused_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        resumed_at TEXT DEFAULT NULL,
        PRIMARY KEY (scope, key)
      );
      CREATE INDEX IF NOT EXISTS idx_dispatch_pause_active
        ON dispatch_pause(scope, key) WHERE resumed_at IS NULL;
    `)

    this.stmtUpsert = this.db.prepare(`
      INSERT INTO dispatch_pause (scope, key, reason, paused_by, paused_at, resumed_at)
      VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL)
      ON CONFLICT(scope, key) DO UPDATE SET
        reason = excluded.reason,
        paused_by = excluded.paused_by,
        paused_at = excluded.paused_at,
        resumed_at = NULL
    `)
    this.stmtResume = this.db.prepare(`
      UPDATE dispatch_pause SET resumed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE scope = ? AND key = ? AND resumed_at IS NULL
    `)
    this.stmtListActive = this.db.prepare(`
      SELECT scope, key, reason, paused_by, paused_at, resumed_at
      FROM dispatch_pause WHERE resumed_at IS NULL ORDER BY paused_at DESC
    `)
    this.stmtListAll = this.db.prepare(`
      SELECT scope, key, reason, paused_by, paused_at, resumed_at
      FROM dispatch_pause ORDER BY paused_at DESC LIMIT ?
    `)
    this.stmtCheck = this.db.prepare(`
      SELECT scope, key, reason, paused_by, paused_at, resumed_at
      FROM dispatch_pause WHERE scope = ? AND key = ? AND resumed_at IS NULL
    `)

    // Hydrate in-memory cache so the hot-path doesn't hit SQLite per-tick
    this.memCache.clear()
    const active = this.stmtListActive.all() as PauseRecord[]
    for (const row of active) {
      this.memCache.set(`${row.scope}|${row.key}`, row)
    }
  }

  /**
   * Pause a scope/key. Idempotent — re-pausing the same key updates reason+by.
   * Emits 'dispatch:paused' with structured payload.
   */
  pause(scope: PauseScope, key: string, reason: string, by: string): PauseRecord {
    if (!key && scope !== 'global') {
      throw new Error(`pause(): key is required for scope='${scope}'`)
    }
    const effectiveKey = scope === 'global' ? '*' : key
    this.stmtUpsert.run(scope, effectiveKey, reason, by)
    const row = this.stmtCheck.get(scope, effectiveKey) as PauseRecord
    this.memCache.set(`${scope}|${effectiveKey}`, row)
    this.emitter.emit('dispatch:paused', {
      action: 'pause',
      scope,
      key: effectiveKey,
      reason,
      by,
      at: row.paused_at,
    })
    return row
  }

  /**
   * Resume a scope/key. Returns false if no active pause matched.
   * Emits 'dispatch:resumed' with structured payload.
   */
  resume(scope: PauseScope, key: string, by: string): boolean {
    const effectiveKey = scope === 'global' ? '*' : key
    const cacheKey = `${scope}|${effectiveKey}`
    const existing = this.memCache.get(cacheKey)
    if (!existing) return false

    const result = this.stmtResume.run(scope, effectiveKey)
    this.memCache.delete(cacheKey)
    this.emitter.emit('dispatch:resumed', {
      action: 'resume',
      scope,
      key: effectiveKey,
      reason: existing.reason,
      by,
      at: new Date().toISOString(),
    })
    return result.changes > 0
  }

  /**
   * Hot-path check — synchronous, in-memory, ~O(scopes-active).
   *
   * Returns the most-specific match. Caller passes the full chain context;
   * we evaluate every scope from most-specific (message) to least (global).
   */
  isPaused(ctx: {
    messageId?: string
    chainKey?: string
    deviceSerial?: string
    senderPhone?: string
    pluginName?: string
  }): PauseDecision {
    const tries: Array<[PauseScope, string | undefined]> = [
      ['message', ctx.messageId],
      ['chain',   ctx.chainKey],
      ['device',  ctx.deviceSerial],
      ['sender',  ctx.senderPhone],
      ['plugin',  ctx.pluginName],
      ['global',  '*'],
    ]
    for (const [scope, key] of tries) {
      if (!key) continue
      const hit = this.memCache.get(`${scope}|${key}`)
      if (hit) {
        return {
          paused: true,
          match: {
            scope, key, reason: hit.reason,
            paused_at: hit.paused_at, paused_by: hit.paused_by,
          },
        }
      }
    }
    return { paused: false }
  }

  /** Admin: list every active pause. */
  listActive(): PauseRecord[] {
    return this.stmtListActive.all() as PauseRecord[]
  }

  /** Admin: history (active + past), most recent first. */
  listHistory(limit = 100): PauseRecord[] {
    return this.stmtListAll.all(limit) as PauseRecord[]
  }
}
