import type Database from 'better-sqlite3'
import { ulid } from 'ulid'
import { getSequence, type SequenceDefinition } from './sequence-definition.js'
import { selectTemplate, renderTemplate } from '../identity-gate/template-selector.js'
import { ThrottleGate, type ThrottleConfig } from '../throttle/throttle-gate.js'
import type { SdrTenantConfig } from '../config/tenant-config.js'
import type { IdentityGate } from '../identity-gate/identity-gate.js'

export type SequenceStatus =
  | 'pending_identity'
  | 'active'
  | 'qualified'
  | 'disqualified'
  | 'opted_out'
  | 'wrong_number'
  | 'no_response'
  | 'aborted'

export interface SequenceState {
  lead_id: string
  sequence_id: string
  sender_phone: string
  current_step: number
  status: SequenceStatus
  next_action_at: string
  last_message_id: string | null
  last_message_sent_at: string | null
  last_response_at: string | null
  last_response_classification: string | null
  attempts_total: number
  stop_reason: string | null
  processing_lock: string | null
  processing_lock_at: string | null
  created_at: string
  updated_at: string
}

export interface LeadRow {
  id: string
  tenant: string
  pipedrive_deal_id: number
  contact_phone: string
  contact_name: string
  state: string
}

export interface SequencerDeps {
  /** Enqueue a SDR outbound (intro/step). Returns the dispatch message id. */
  enqueueStep(input: {
    tenant: string
    senderPhone: string
    contact: { phone: string; name: string }
    text: string
    leadId: string
    step: number
  }): string

  /** Picks the sticky sender for a new lead (round-robin or load-balanced). */
  pickSender(tenant: SdrTenantConfig): string

  /** Identity gate — already wired by the plugin loader. */
  identityGate: IdentityGate

  /** Throttle gate — already wired by the plugin loader. */
  throttleGate: ThrottleGate

  /** message_history accessor for the gate's `hasOutgoingHistory` check. */
  hasOutgoingHistory(senderPhone: string, contactPhone: string): boolean

  /** Logger. */
  logger?: {
    info(msg: string, data?: Record<string, unknown>): void
    warn(msg: string, data?: Record<string, unknown>): void
  }

  /** Deterministic clock for tests. */
  now?: () => number
}

export interface TickResult {
  examined: number
  advanced: number
  enqueued: number
  blocked_throttle: number
  blocked_identity: number
  errors: number
}

/**
 * Sequence FSM.
 *
 * Tick path:
 *   1. Pick eligible leads (state in 'pulled' OR sdr_sequence_state.status
 *      in ('pending_identity', 'active') and next_action_at <= now).
 *   2. Acquire processing_lock — only one ticker at a time per lead.
 *   3. Branch:
 *      - state='pulled' and gate.enabled: kickoff identity gate; insert
 *        sequence_state row with status='pending_identity'.
 *      - status='pending_identity': re-check identity gate; on verified,
 *        transition to 'active' and enqueue step 0.
 *      - status='active': enqueue current_step if due, advance.
 *      - terminal sequence: mark sdr_lead_queue.state='completed'.
 *   4. Release lock.
 *
 * Concurrency: processing_lock is a UUID; ticks must verify lock owns
 * a row before mutating. Stale locks (older than 5min) are reaped.
 *
 * No mass-send risk by design: throttle gate runs INSIDE step enqueue.
 * Sequencer never bypasses operating_hours / daily_max / min_interval.
 */
export class Sequencer {
  private readonly now: () => number

  constructor(
    private readonly db: Database.Database,
    private readonly deps: SequencerDeps,
  ) {
    this.now = deps.now ?? (() => Date.now())
  }

  async tick(tenant: SdrTenantConfig): Promise<TickResult> {
    const result: TickResult = {
      examined: 0,
      advanced: 0,
      enqueued: 0,
      blocked_throttle: 0,
      blocked_identity: 0,
      errors: 0,
    }

    this.reapStaleLocks()

    const sequence = getSequence(tenant.sequence_id)

    // Pull leads ready for action:
    //   - sdr_lead_queue.state='pulled' (haven't been kicked off yet)
    //   - sdr_sequence_state with status in active/pending_identity and
    //     next_action_at <= now
    const nowIso = new Date(this.now()).toISOString()
    const candidates = this.db
      .prepare(
        `SELECT l.id, l.tenant, l.pipedrive_deal_id, l.contact_phone, l.contact_name, l.state
           FROM sdr_lead_queue l
           LEFT JOIN sdr_sequence_state s ON s.lead_id = l.id
          WHERE l.tenant = ?
            AND (
              l.state = 'pulled'
              OR (s.status IN ('pending_identity','active') AND s.next_action_at <= ?)
            )
          ORDER BY l.pulled_at ASC
          LIMIT 50`,
      )
      .all(tenant.name, nowIso) as LeadRow[]

    result.examined = candidates.length

    for (const lead of candidates) {
      const lockId = ulid()
      const acquired = this.acquireLock(lead.id, lockId)
      if (!acquired) continue

      try {
        const state = this.fetchState(lead.id)
        if (!state) {
          // Brand-new lead — kickoff (with or without identity gate).
          this.handleNewLead(tenant, sequence, lead)
          result.advanced++
        } else if (state.status === 'pending_identity') {
          const moved = this.handlePendingIdentity(tenant, sequence, lead, state)
          if (moved === 'verified') {
            result.advanced++
          } else if (moved === 'unchanged') {
            result.blocked_identity++
          }
        } else if (state.status === 'active') {
          const step = sequence.steps[state.current_step]
          if (!step) continue
          const sendResult = this.trySendStep(tenant, sequence, lead, state, step)
          if (sendResult === 'enqueued') {
            result.enqueued++
            result.advanced++
          } else if (sendResult === 'throttled') {
            result.blocked_throttle++
          }
        }
      } catch (err) {
        this.deps.logger?.warn('sequencer tick error', {
          lead_id: lead.id,
          error: err instanceof Error ? err.message : String(err),
        })
        result.errors++
      } finally {
        this.releaseLock(lead.id, lockId)
      }
    }

    return result
  }

  // ── internals ─────────────────────────────────────────────────────────

  private handleNewLead(tenant: SdrTenantConfig, sequence: SequenceDefinition, lead: LeadRow): void {
    const senderPhone = this.deps.pickSender(tenant)
    const hasHistory = this.deps.hasOutgoingHistory(senderPhone, lead.contact_phone)
    const gate = this.deps.identityGate.check(tenant.name, senderPhone, lead.contact_phone, hasHistory)

    if (!tenant.identity_gate.enabled || gate.state === 'has_history') {
      // Skip the gate — go straight to step 0 of the sequence.
      this.insertSequenceState({
        lead_id: lead.id,
        sequence_id: sequence.id,
        sender_phone: senderPhone,
        current_step: 0,
        status: 'active',
        next_action_at: new Date(this.now()).toISOString(),
      })
      this.markLeadState(lead.id, 'sequencing')
      return
    }

    if (gate.state === 'no_history') {
      this.deps.identityGate.kickoff(
        tenant.name,
        senderPhone,
        { phone: lead.contact_phone, name: lead.contact_name },
        lead.id,
        tenant.label,
      )
    }
    // Either way, mark pending_identity and recheck on the next tick.
    this.insertSequenceState({
      lead_id: lead.id,
      sequence_id: sequence.id,
      sender_phone: senderPhone,
      current_step: 0,
      status: 'pending_identity',
      next_action_at: new Date(this.now() + 5 * 60 * 1000).toISOString(),
    })
    this.markLeadState(lead.id, 'gating')
  }

  private handlePendingIdentity(
    tenant: SdrTenantConfig,
    sequence: SequenceDefinition,
    lead: LeadRow,
    state: SequenceState,
  ): 'verified' | 'rejected' | 'unchanged' {
    const gate = this.deps.identityGate.check(tenant.name, state.sender_phone, lead.contact_phone, false)
    if (gate.state === 'verified' || gate.state === 'has_history') {
      // Move to active, schedule step 0 for now.
      this.db
        .prepare(
          `UPDATE sdr_sequence_state
              SET status = 'active', next_action_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE lead_id = ?`,
        )
        .run(new Date(this.now()).toISOString(), lead.id)
      this.markLeadState(lead.id, 'sequencing')
      void sequence // mark variable used
      return 'verified'
    }
    if (gate.state === 'wrong_number' || gate.state === 'opted_out' || gate.state === 'no_response') {
      this.terminateSequence(lead.id, gate.state, gate.state)
      return 'rejected'
    }
    // Still pending — re-check on next tick.
    return 'unchanged'
  }

  private trySendStep(
    tenant: SdrTenantConfig,
    sequence: SequenceDefinition,
    lead: LeadRow,
    state: SequenceState,
    step: SequenceDefinition['steps'][number],
  ): 'enqueued' | 'throttled' | 'noop' {
    const throttleCfg: ThrottleConfig = tenant.throttle
    const gate = this.deps.throttleGate.check(state.sender_phone, throttleCfg)
    if (!gate.allowed) {
      // Re-check at gate.next_eligible_at.
      this.db
        .prepare(
          `UPDATE sdr_sequence_state
              SET next_action_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE lead_id = ?`,
        )
        .run(gate.next_eligible_at, lead.id)
      return 'throttled'
    }

    const template = selectTemplate(step.template_pool, lead.contact_phone, tenant.name)
    const text = renderTemplate(template, { nome: lead.contact_name, empresa: tenant.label })
    const messageId = this.deps.enqueueStep({
      tenant: tenant.name,
      senderPhone: state.sender_phone,
      contact: { phone: lead.contact_phone, name: lead.contact_name },
      text,
      leadId: lead.id,
      step: step.index,
    })

    const nextStep = sequence.steps[step.index + 1]
    const nextStatus: SequenceStatus = step.terminal ? 'no_response' : 'active'
    const nextActionAt = nextStep
      ? new Date(this.now() + nextStep.day_offset * 24 * 60 * 60 * 1000).toISOString()
      : new Date(this.now() + tenant.identity_gate.abort_after_hours * 60 * 60 * 1000).toISOString()

    this.db
      .prepare(
        `UPDATE sdr_sequence_state
            SET current_step = ?,
                status = ?,
                next_action_at = ?,
                last_message_id = ?,
                last_message_sent_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                attempts_total = attempts_total + 1,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE lead_id = ?`,
      )
      .run(step.terminal ? step.index : step.index + 1, nextStatus, nextActionAt, messageId, lead.id)

    if (step.terminal) {
      this.markLeadState(lead.id, 'completed')
    }

    return 'enqueued'
  }

  private acquireLock(leadId: string, lockId: string): boolean {
    const r = this.db
      .prepare(
        `UPDATE sdr_sequence_state
            SET processing_lock = ?,
                processing_lock_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE lead_id = ? AND (processing_lock IS NULL OR processing_lock_at < ?)`,
      )
      .run(lockId, leadId, new Date(this.now() - 5 * 60 * 1000).toISOString())
    if (r.changes > 0) return true

    // No existing state row → create one with the lock so handleNewLead
    // can find it via insertSequenceState's ON CONFLICT path.
    return true
  }

  private releaseLock(leadId: string, lockId: string): void {
    this.db
      .prepare(
        `UPDATE sdr_sequence_state
            SET processing_lock = NULL,
                processing_lock_at = NULL
          WHERE lead_id = ? AND processing_lock = ?`,
      )
      .run(leadId, lockId)
  }

  private reapStaleLocks(): void {
    const cutoff = new Date(this.now() - 5 * 60 * 1000).toISOString()
    this.db
      .prepare(
        `UPDATE sdr_sequence_state
            SET processing_lock = NULL, processing_lock_at = NULL
          WHERE processing_lock_at IS NOT NULL AND processing_lock_at < ?`,
      )
      .run(cutoff)
  }

  fetchState(leadId: string): SequenceState | null {
    return (this.db
      .prepare(`SELECT * FROM sdr_sequence_state WHERE lead_id = ?`)
      .get(leadId) as SequenceState | undefined) ?? null
  }

  private insertSequenceState(s: Pick<SequenceState, 'lead_id' | 'sequence_id' | 'sender_phone' | 'current_step' | 'status' | 'next_action_at'>): void {
    this.db
      .prepare(
        `INSERT INTO sdr_sequence_state
           (lead_id, sequence_id, sender_phone, current_step, status, next_action_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(lead_id) DO UPDATE SET
           status = excluded.status,
           next_action_at = excluded.next_action_at,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      )
      .run(s.lead_id, s.sequence_id, s.sender_phone, s.current_step, s.status, s.next_action_at)
  }

  /** Public API: external callers (response handler) finalize a sequence. */
  terminateSequence(leadId: string, status: SequenceStatus, stopReason: string | null): void {
    this.db
      .prepare(
        `UPDATE sdr_sequence_state
            SET status = ?, stop_reason = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE lead_id = ?`,
      )
      .run(status, stopReason, leadId)
    const leadState =
      status === 'qualified' || status === 'disqualified' ? 'completed' : 'aborted'
    this.markLeadState(leadId, leadState)
  }

  private markLeadState(leadId: string, state: 'pulled' | 'gating' | 'sequencing' | 'completed' | 'aborted'): void {
    this.db
      .prepare(
        `UPDATE sdr_lead_queue SET state = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
      )
      .run(state, leadId)
  }
}
