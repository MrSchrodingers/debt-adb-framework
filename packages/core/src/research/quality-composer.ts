/**
 * Composes QualityScoreInputs for a sender by aggregating data from:
 *   - chips registry (acquisition_date → accountAgeDays, fingerprint proxy)
 *   - chip_events (last 'banned' → daysSinceLastBan)
 *   - sender_warmup (tier + daily cap)
 *   - message_history (volumeToday, inbound/outbound 7d)
 *   - message_ack_history (ackReadRatio)
 *
 * fingerprintFreshness uses chips.acquisition_date as a proxy until the
 * chip_fingerprints table lands; the proxy underestimates freshness.
 */

import type Database from 'better-sqlite3'
import type { ChipRegistry } from '../fleet/chip-registry.js'
import type { SenderWarmup } from '../engine/sender-warmup.js'
import type { QualityScoreInputs } from './quality-score.js'
import { msToSqliteDatetime } from './sqlite-datetime.js'

export interface ComposeDeps {
  senderPhone: string
  db: Database.Database
  chips: ChipRegistry
  warmup: SenderWarmup
  now?: number
  fleetMedianReadRatio?: number
  fingerprintTtlDays?: number
}

const DEFAULT_FINGERPRINT_TTL_DAYS = 30

export function composeQualityInputs(deps: ComposeDeps): QualityScoreInputs {
  const now = deps.now ?? Date.now()
  const fingerprintTtlDays = deps.fingerprintTtlDays ?? DEFAULT_FINGERPRINT_TTL_DAYS

  const chip = deps.chips.getChipByPhone(deps.senderPhone)
  const accountAgeDays = chip
    ? daysBetween(new Date(chip.acquisition_date).getTime(), now)
    : 0

  const daysSinceLastBan = chip ? readDaysSinceLastBan(deps.db, chip.id, now) : null
  const daysSinceFingerprintRotation = chip ? accountAgeDays : fingerprintTtlDays

  const tier = deps.warmup.getTier(deps.senderPhone)
  const volumeDailyCap = tier.dailyCap
  const warmupTier = tier.tier
  const warmupTierMax = 4

  const volumeToday = countOutbound(deps.db, deps.senderPhone, now - 86_400_000, now)
  const sevenDaysAgo = now - 7 * 86_400_000
  const outboundLast7d = countOutbound(deps.db, deps.senderPhone, sevenDaysAgo, now)
  const inboundLast7d = countInbound(deps.db, deps.senderPhone, sevenDaysAgo, now)

  const ackReadRatio = readSenderReadRatio(deps.db, deps.senderPhone, now - 86_400_000, now)
  const ackFleetMedianReadRatio = deps.fleetMedianReadRatio
    ?? fleetMedianReadRatio(deps.db, now, 24)

  return {
    ackReadRatio,
    ackFleetMedianReadRatio,
    daysSinceLastBan,
    accountAgeDays,
    warmupTier,
    warmupTierMax,
    volumeToday,
    volumeDailyCap,
    daysSinceFingerprintRotation,
    fingerprintTtlDays,
    inboundLast7d,
    outboundLast7d,
  }
}

function daysBetween(fromMs: number, toMs: number): number {
  return Math.max(0, Math.floor((toMs - fromMs) / 86_400_000))
}

function readDaysSinceLastBan(db: Database.Database, chipId: string, now: number): number | null {
  const row = db
    .prepare(`
      SELECT MAX(occurred_at) AS last_ban
      FROM chip_events
      WHERE chip_id = ? AND event_type = 'banned'
    `)
    .get(chipId) as { last_ban: string | null } | undefined
  if (!row || !row.last_ban) return null
  return daysBetween(new Date(row.last_ban).getTime(), now)
}

function countOutbound(db: Database.Database, senderPhone: string, sinceMs: number, untilMs: number): number {
  const row = db
    .prepare(`
      SELECT COUNT(*) AS n
      FROM message_history
      WHERE direction = 'outgoing'
        AND from_number = ?
        AND created_at >= ?
        AND created_at <= ?
    `)
    .get(senderPhone, new Date(sinceMs).toISOString(), new Date(untilMs).toISOString()) as { n: number }
  return row.n
}

function countInbound(db: Database.Database, senderPhone: string, sinceMs: number, untilMs: number): number {
  const row = db
    .prepare(`
      SELECT COUNT(*) AS n
      FROM message_history
      WHERE direction = 'incoming'
        AND to_number = ?
        AND created_at >= ?
        AND created_at <= ?
    `)
    .get(senderPhone, new Date(sinceMs).toISOString(), new Date(untilMs).toISOString()) as { n: number }
  return row.n
}

interface PerMessageState {
  sent: boolean
  read: boolean
}

function loadAcksForRange(
  db: Database.Database,
  sinceMs: number,
  untilMs: number,
  senderPhone: string | null,
): Array<{ wahaMessageId: string; ackLevel: number; senderPhone: string | null }> {
  const sinceIso = msToSqliteDatetime(sinceMs)
  const untilIso = msToSqliteDatetime(untilMs)
  const stmt = senderPhone
    ? db.prepare(`
        SELECT h.waha_message_id AS wid, h.ack_level AS lv,
               COALESCE(h.sender_phone, m.from_number) AS sp
        FROM message_ack_history h
        LEFT JOIN message_history m ON m.waha_message_id = h.waha_message_id
        WHERE h.observed_at >= ? AND h.observed_at <= ?
          AND COALESCE(h.sender_phone, m.from_number) = ?
      `)
    : db.prepare(`
        SELECT h.waha_message_id AS wid, h.ack_level AS lv,
               COALESCE(h.sender_phone, m.from_number) AS sp
        FROM message_ack_history h
        LEFT JOIN message_history m ON m.waha_message_id = h.waha_message_id
        WHERE h.observed_at >= ? AND h.observed_at <= ?
      `)
  const rows = senderPhone
    ? (stmt.all(sinceIso, untilIso, senderPhone) as Array<{ wid: string; lv: number; sp: string | null }>)
    : (stmt.all(sinceIso, untilIso) as Array<{ wid: string; lv: number; sp: string | null }>)
  return rows.map((r) => ({ wahaMessageId: r.wid, ackLevel: r.lv, senderPhone: r.sp }))
}

function readSenderReadRatio(
  db: Database.Database,
  senderPhone: string,
  sinceMs: number,
  untilMs: number,
): number {
  const events = loadAcksForRange(db, sinceMs, untilMs, senderPhone)
  const messages = new Map<string, PerMessageState>()
  for (const e of events) {
    const s = messages.get(e.wahaMessageId) ?? { sent: false, read: false }
    if (e.ackLevel >= 1) s.sent = true
    if (e.ackLevel >= 3) s.read = true
    messages.set(e.wahaMessageId, s)
  }
  let sent = 0
  let read = 0
  for (const s of messages.values()) {
    if (!s.sent) continue
    sent++
    if (s.read) read++
  }
  return sent === 0 ? 0 : read / sent
}

export function fleetMedianReadRatio(db: Database.Database, nowMs: number, hours: number): number {
  const sinceMs = nowMs - hours * 3_600_000
  const events = loadAcksForRange(db, sinceMs, nowMs, null)
  const bySender = new Map<string, Map<string, PerMessageState>>()
  for (const e of events) {
    if (!e.senderPhone) continue
    const senderMap = bySender.get(e.senderPhone) ?? new Map<string, PerMessageState>()
    const s = senderMap.get(e.wahaMessageId) ?? { sent: false, read: false }
    if (e.ackLevel >= 1) s.sent = true
    if (e.ackLevel >= 3) s.read = true
    senderMap.set(e.wahaMessageId, s)
    bySender.set(e.senderPhone, senderMap)
  }
  const ratios: number[] = []
  for (const senderMap of bySender.values()) {
    let sent = 0
    let read = 0
    for (const s of senderMap.values()) {
      if (!s.sent) continue
      sent++
      if (s.read) read++
    }
    if (sent > 0) ratios.push(read / sent)
  }
  if (ratios.length === 0) return 0
  ratios.sort((a, b) => a - b)
  const mid = Math.floor(ratios.length / 2)
  return ratios.length % 2 === 0
    ? (ratios[mid - 1] + ratios[mid]) / 2
    : ratios[mid]
}

