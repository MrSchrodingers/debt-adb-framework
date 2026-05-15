import type Database from 'better-sqlite3'
import { ulid } from 'ulid'
import { selectTemplate, renderTemplate } from './template-selector.js'
import { INTRO_TEMPLATES, NUDGE_TEMPLATES } from './templates.js'
import type { Classification } from '../classifier/classifier.js'

export type IdentityState =
  | 'pending'
  | 'verified'
  | 'wrong_number'
  | 'opted_out'
  | 'no_response'

export type GateCheck =
  | { state: 'no_history' }
  | { state: 'has_history' }
  | { state: IdentityState; row: IdentityRow }

export interface IdentityRow {
  tenant: string
  sender_phone: string
  contact_phone: string
  state: IdentityState
  intro_message_id: string | null
  nudge_message_id: string | null
  classification: string | null
  classifier_confidence: number | null
  raw_response: string | null
  created_at: string
  updated_at: string
}

export interface ContactRef {
  phone: string
  name: string
}

/**
 * Bridge to side-effect collaborators. Kept narrow so identity-gate
 * stays unit-testable without spinning up the whole plugin loader.
 */
export interface IdentityGateDeps {
  /** Enqueues an outbound handshake/nudge via PluginContext.enqueue. Returns the dispatch message id. */
  enqueueHandshake(input: {
    tenant: string
    senderPhone: string
    contact: ContactRef
    text: string
    leadId: string
    kind: 'intro' | 'nudge'
  }): string

  /**
   * Record an opt-out / wrong-number on the central blacklist. Wrap
   * around the core queue's recordBan call.
   */
  blacklist(phone: string, reason: string, meta?: { ttlDays?: number }): void

  /**
   * Emit an operator alert when the gate ends up ambiguous (Task 26).
   * Idempotent per (lead, message).
   */
  raiseOperatorAlert(input: {
    tenant: string
    leadId: string
    messageId: string
    responseText: string
    reason: string
    llmReason?: string
  }): void
}

/**
 * Identity-gate state machine — spec §4.3.
 *
 * Public API mirrors the plan's interface so the sequencer (Phase D)
 * can drive it without knowing the internal table layout. Persistence
 * is the composite PK `(tenant, sender_phone, contact_phone)` on
 * sdr_contact_identity (Task 13 migration).
 *
 * Gating rule: when an outgoing message already exists in
 * `message_history` for (sender, contact), the gate is bypassed and
 * the lead is treated as `has_history` — no handshake, no re-verify.
 * The check is the caller's responsibility (the gate doesn't reach
 * into message_history directly).
 */
export class IdentityGate {
  private readonly intro: readonly string[]
  private readonly nudge: readonly string[]

  constructor(
    private readonly db: Database.Database,
    private readonly deps: IdentityGateDeps,
    pools: { intro?: readonly string[]; nudge?: readonly string[] } = {},
  ) {
    this.intro = pools.intro ?? INTRO_TEMPLATES
    this.nudge = pools.nudge ?? NUDGE_TEMPLATES
  }

  /**
   * Inspect identity state. `hasOutgoingHistory` is the result of a
   * `message_history` lookup the caller already performed — keeping
   * the dependency outside the gate makes the unit test surface tiny.
   */
  check(
    tenant: string,
    senderPhone: string,
    contactPhone: string,
    hasOutgoingHistory: boolean,
  ): GateCheck {
    const row = this.fetchRow(tenant, senderPhone, contactPhone)
    if (row) return { state: row.state, row }
    if (hasOutgoingHistory) return { state: 'has_history' }
    return { state: 'no_history' }
  }

  /**
   * Initiate handshake: pick a deterministic template, enqueue the
   * outbound, and create a `pending` row. Idempotent — re-calling
   * after a row already exists returns the existing intro id.
   */
  kickoff(tenant: string, senderPhone: string, contact: ContactRef, leadId: string, tenantLabel: string): {
    ok: true
    messageId: string
    state: 'pending'
  } {
    const existing = this.fetchRow(tenant, senderPhone, contact.phone)
    if (existing && existing.intro_message_id) {
      return { ok: true, messageId: existing.intro_message_id, state: 'pending' }
    }

    const template = selectTemplate(this.intro, contact.phone, tenant)
    const text = renderTemplate(template, { nome: contact.name, empresa: tenantLabel })
    const messageId = this.deps.enqueueHandshake({
      tenant,
      senderPhone,
      contact,
      text,
      leadId,
      kind: 'intro',
    })

    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO sdr_contact_identity
           (tenant, sender_phone, contact_phone, state, intro_message_id, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', ?, ?, ?)
         ON CONFLICT (tenant, sender_phone, contact_phone) DO UPDATE SET
           intro_message_id = COALESCE(intro_message_id, excluded.intro_message_id),
           state = CASE WHEN state IN ('verified','opted_out','wrong_number') THEN state ELSE 'pending' END,
           updated_at = excluded.updated_at`,
      )
      .run(tenant, senderPhone, contact.phone, messageId, now, now)

    return { ok: true, messageId, state: 'pending' }
  }

  /**
   * Send the day-2 nudge when the intro went unanswered. Idempotent —
   * re-calls on an already-nudged row are no-ops. Returns null when
   * the row no longer needs a nudge (state moved on).
   */
  triggerNudge(
    tenant: string,
    senderPhone: string,
    contact: ContactRef,
    leadId: string,
    tenantLabel: string,
  ): { ok: true; messageId: string } | { ok: false; reason: 'state_moved' | 'already_nudged' | 'no_row' } {
    const row = this.fetchRow(tenant, senderPhone, contact.phone)
    if (!row) return { ok: false, reason: 'no_row' }
    if (row.state !== 'pending') return { ok: false, reason: 'state_moved' }
    if (row.nudge_message_id) return { ok: false, reason: 'already_nudged' }

    const template = selectTemplate(this.nudge, contact.phone, tenant)
    const text = renderTemplate(template, { nome: contact.name, empresa: tenantLabel })
    const messageId = this.deps.enqueueHandshake({
      tenant,
      senderPhone,
      contact,
      text,
      leadId,
      kind: 'nudge',
    })

    this.db
      .prepare(
        `UPDATE sdr_contact_identity
            SET nudge_message_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE tenant = ? AND sender_phone = ? AND contact_phone = ?`,
      )
      .run(messageId, tenant, senderPhone, contact.phone)

    return { ok: true, messageId }
  }

  /**
   * Apply classifier output to identity state. Spec §4.3 transition
   * table — opt-out beats wrong-number which beats confirm; ambiguous
   * leaves the state unchanged but raises an operator alert.
   */
  handleClassification(
    tenant: string,
    senderPhone: string,
    contact: ContactRef,
    leadId: string,
    messageId: string,
    responseText: string,
    classification: Classification,
  ): IdentityState | 'unchanged' {
    const row = this.fetchRow(tenant, senderPhone, contact.phone)
    if (!row) return 'unchanged'
    if (row.state !== 'pending') {
      // Already terminal — do nothing (we can still record audit
      // elsewhere; this method only advances state).
      return 'unchanged'
    }

    switch (classification.category) {
      case 'identity_confirm':
        this.transition(row, 'verified', classification, responseText)
        return 'verified'
      case 'identity_deny':
        this.transition(row, 'wrong_number', classification, responseText)
        this.deps.blacklist(contact.phone, 'sdr_wrong_number_30d', { ttlDays: 30 })
        return 'wrong_number'
      case 'opted_out':
        this.transition(row, 'opted_out', classification, responseText)
        this.deps.blacklist(contact.phone, 'sdr_opt_out')
        return 'opted_out'
      case 'ambiguous':
        this.deps.raiseOperatorAlert({
          tenant,
          leadId,
          messageId,
          responseText,
          reason: 'classifier_ambiguous',
          llmReason: classification.reason,
        })
        return 'unchanged'
      default:
        // 'interested', 'not_interested', 'question' — illegal in
        // identity phase (the orchestrator's phase gate already routed
        // these to 'ambiguous', but be defensive).
        this.deps.raiseOperatorAlert({
          tenant,
          leadId,
          messageId,
          responseText,
          reason: `unexpected_category_in_identity_phase:${classification.category}`,
          llmReason: classification.reason,
        })
        return 'unchanged'
    }
  }

  /** 96h cron path: mark state=no_response and stop the lead. */
  markNoResponse(tenant: string, senderPhone: string, contactPhone: string): boolean {
    const r = this.db
      .prepare(
        `UPDATE sdr_contact_identity
            SET state = 'no_response', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE tenant = ? AND sender_phone = ? AND contact_phone = ?
            AND state = 'pending'`,
      )
      .run(tenant, senderPhone, contactPhone)
    return r.changes > 0
  }

  /** Test helper — direct row fetch. */
  fetchRow(tenant: string, senderPhone: string, contactPhone: string): IdentityRow | null {
    return (this.db
      .prepare(
        `SELECT * FROM sdr_contact_identity
          WHERE tenant = ? AND sender_phone = ? AND contact_phone = ?`,
      )
      .get(tenant, senderPhone, contactPhone) as IdentityRow | undefined) ?? null
  }

  private transition(
    row: IdentityRow,
    next: IdentityState,
    classification: Classification,
    responseText: string,
  ): void {
    this.db
      .prepare(
        `UPDATE sdr_contact_identity
            SET state = ?,
                classification = ?,
                classifier_confidence = ?,
                raw_response = ?,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE tenant = ? AND sender_phone = ? AND contact_phone = ?`,
      )
      .run(
        next,
        classification.category,
        classification.confidence,
        responseText,
        row.tenant,
        row.sender_phone,
        row.contact_phone,
      )
  }

  /** Test/admin helper: list pending rows older than `sinceIso`. */
  listPendingOlderThan(sinceIso: string, limit = 100): IdentityRow[] {
    return this.db
      .prepare(
        `SELECT * FROM sdr_contact_identity
          WHERE state = 'pending'
            AND updated_at < ?
          ORDER BY updated_at ASC
          LIMIT ?`,
      )
      .all(sinceIso, limit) as IdentityRow[]
  }
}

/** Convenience: deterministic message id for tests / fixtures. */
export function newHandshakeMessageId(): string {
  return `sdr-hs-${ulid()}`
}
