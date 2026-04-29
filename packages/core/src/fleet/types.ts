/**
 * Internal chip fleet types.
 *
 * This module tracks the operator's OWNED SIM cards (CapEx + OpEx) — NOT
 * customer billing, NOT Stripe. It records how much each chip costs to acquire
 * and to keep alive month-to-month, who paid for it, when the next plan
 * renewal is due, which device it currently lives in, and any messages
 * received from the carrier (recharge confirmations, expiry warnings, etc).
 *
 * Phase 3 of `docs/superpowers/plans/2026-04-28-product-roadmap-anti-ban-fleet.md`.
 */

export type ChipStatus = 'active' | 'inactive' | 'banned' | 'retired'
export type ChipPlanType = 'postpago' | 'prepago' | 'controle'

/**
 * Carrier identifier (lowercase, no spaces). Free-form by design — operators
 * occasionally take chips from MVNOs not in the canonical list (Surf, Veek,
 * etc) and we don't want to block them on a hardcoded enum. The Zod schema
 * normalizes to lowercase but does not restrict to a closed set.
 */
export type ChipCarrier = string

export interface Chip {
  id: string
  phone_number: string
  carrier: ChipCarrier
  plan_name: string
  plan_type: ChipPlanType
  acquisition_date: string
  acquisition_cost_brl: number
  monthly_cost_brl: number
  payment_due_day: number
  payment_method: string | null
  paid_by_operator: string
  invoice_ref: string | null
  invoice_path: string | null
  device_serial: string | null
  status: ChipStatus
  acquired_for_purpose: string | null
  retirement_date: string | null
  notes: string | null
  created_at: string
}

/**
 * Lifecycle event. `event_type` is intentionally an open string column so we
 * can extend without migrations. Canonical values:
 *   - acquired         : chip first added to fleet
 *   - recharged        : prepago top-up
 *   - plan_paid        : monthly bill settled (controle/postpago)
 *   - plan_changed     : carrier swapped the plan tier
 *   - banned           : WA banned this number
 *   - returned         : ban appealed and lifted
 *   - retired          : chip taken out of rotation
 *   - replaced         : same number, new physical SIM
 *   - transferred      : chip moved to a different operator
 *   - sms_received     : a carrier SMS landed (mirrored from chip_messages)
 */
export interface ChipEvent {
  id: string
  chip_id: string
  event_type: string
  occurred_at: string
  operator: string | null
  metadata_json: string | null
  notes: string | null
}

export interface ChipPayment {
  id: string
  chip_id: string
  /** "YYYY-MM" — calendar month the payment refers to. */
  period: string
  amount_brl: number
  paid_at: string
  paid_by_operator: string
  payment_method: string | null
  receipt_path: string | null
  notes: string | null
}

export type ChipMessageCategory =
  | 'recharge_confirmation'
  | 'expiry_warning'
  | 'balance'
  | 'promo'
  | 'fraud_alert'
  | 'other'

export interface ChipMessage {
  id: string
  chip_id: string
  from_number: string
  message_text: string
  received_at: string
  category: ChipMessageCategory | null
  /**
   * Always 'manual' for v1 — adb_sms_dump is reserved for the future ADB SMS
   * auto-importer (TODO in `chip-registry.ts`).
   */
  source: 'manual' | 'adb_sms_dump'
  raw_json: string | null
  created_at: string
}

/** Renewal-watcher classification of a chip's payment due date. */
export type RenewalStatus = 'overdue' | 'due_today' | 'upcoming' | 'paid'

export interface RenewalCalendarEntry {
  chip_id: string
  phone_number: string
  carrier: string
  plan_name: string
  monthly_cost_brl: number
  payment_due_day: number
  next_due_date: string
  days_until_due: number
  status: RenewalStatus
  paid_for_period: string | null
}

export interface MonthlySpendSummary {
  period: string
  total_brl: number
  paid_brl: number
  outstanding_brl: number
  by_carrier: Record<string, { count: number; total_brl: number; paid_brl: number }>
  by_operator: Record<string, { count: number; total_brl: number }>
  active_chips: number
}
