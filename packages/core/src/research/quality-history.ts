/**
 * Persists composite quality score samples per sender.
 *
 * Stored as time-series. Watcher writes one row per (sender, tick).
 * Trend endpoints read this directly. Components_json keeps the full
 * decomposition so we can debug a regression without recomputing inputs
 * from cold history.
 */

import type Database from 'better-sqlite3'
import { nanoid } from 'nanoid'
import type { QualityScoreComponents } from './quality-score.js'

export interface QualitySample {
  id: string
  senderPhone: string
  computedAt: string
  total: number
  components: QualityScoreComponents
}

export interface RecordParams {
  senderPhone: string
  total: number
  components: QualityScoreComponents
  computedAt?: string
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS chip_quality_history (
    id TEXT PRIMARY KEY,
    sender_phone TEXT NOT NULL,
    computed_at TEXT NOT NULL DEFAULT (datetime('now')),
    total_score INTEGER NOT NULL,
    components_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_chip_quality_history_sender_time
    ON chip_quality_history(sender_phone, computed_at);
`

export class QualityHistory {
  constructor(private readonly db: Database.Database) {}

  initialize(): void {
    this.db.exec(SCHEMA_SQL)
  }

  record(params: RecordParams): string {
    const id = nanoid()
    this.db
      .prepare(`
        INSERT INTO chip_quality_history (id, sender_phone, computed_at, total_score, components_json)
        VALUES (?, ?, COALESCE(?, datetime('now')), ?, ?)
      `)
      .run(
        id,
        params.senderPhone,
        params.computedAt ?? null,
        params.total,
        JSON.stringify(params.components),
      )
    return id
  }

  latest(senderPhone: string): QualitySample | null {
    const row = this.db
      .prepare(`
        SELECT id, sender_phone, computed_at, total_score, components_json
        FROM chip_quality_history
        WHERE sender_phone = ?
        ORDER BY computed_at DESC
        LIMIT 1
      `)
      .get(senderPhone) as RawRow | undefined
    return row ? rowToSample(row) : null
  }

  sampleAtOrBefore(senderPhone: string, atIso: string): QualitySample | null {
    const row = this.db
      .prepare(`
        SELECT id, sender_phone, computed_at, total_score, components_json
        FROM chip_quality_history
        WHERE sender_phone = ? AND computed_at <= ?
        ORDER BY computed_at DESC
        LIMIT 1
      `)
      .get(senderPhone, atIso) as RawRow | undefined
    return row ? rowToSample(row) : null
  }

  series(senderPhone: string, sinceIso: string, untilIso?: string): QualitySample[] {
    const until = untilIso ?? new Date().toISOString()
    const rows = this.db
      .prepare(`
        SELECT id, sender_phone, computed_at, total_score, components_json
        FROM chip_quality_history
        WHERE sender_phone = ? AND computed_at >= ? AND computed_at <= ?
        ORDER BY computed_at ASC
      `)
      .all(senderPhone, sinceIso, until) as RawRow[]
    return rows.map(rowToSample)
  }

  latestPerSender(): QualitySample[] {
    const rows = this.db
      .prepare(`
        SELECT h.id, h.sender_phone, h.computed_at, h.total_score, h.components_json
        FROM chip_quality_history h
        INNER JOIN (
          SELECT sender_phone, MAX(computed_at) AS max_at
          FROM chip_quality_history
          GROUP BY sender_phone
        ) latest ON latest.sender_phone = h.sender_phone AND latest.max_at = h.computed_at
        ORDER BY h.total_score ASC
      `)
      .all() as RawRow[]
    return rows.map(rowToSample)
  }

  prune(retentionDays: number): number {
    const result = this.db
      .prepare(`
        DELETE FROM chip_quality_history
        WHERE computed_at < datetime('now', ?)
      `)
      .run(`-${retentionDays} days`)
    return result.changes
  }
}

interface RawRow {
  id: string
  sender_phone: string
  computed_at: string
  total_score: number
  components_json: string
}

function rowToSample(row: RawRow): QualitySample {
  return {
    id: row.id,
    senderPhone: row.sender_phone,
    computedAt: row.computed_at,
    total: row.total_score,
    components: JSON.parse(row.components_json) as QualityScoreComponents,
  }
}
