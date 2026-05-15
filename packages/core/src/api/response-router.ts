/**
 * G5 (debt-sdr): tenant-aware response routing.
 *
 * Pure function that decides whether a patient response captured by
 * WAHA should be forwarded to the originating plugin's callback URL.
 * The invariant (I4): a sender owned by tenant A must not deliver
 * responses to a plugin whose original message was tenant_hint=B.
 * Cross-tenant deliveries leak conversation context across the hard
 * partition (e.g. Sicoob CRM ingesting an Oralsin patient's reply).
 *
 * Reversible via env DISPATCH_RESPONSE_STRICT_TENANT=false (Task 10
 * rollback procedure).
 */

export type RouteResponseDecision =
  | { deliver: true }
  | { deliver: false; reason: 'no_history' }
  | { deliver: false; reason: 'no_message' }
  | { deliver: false; reason: 'no_plugin' }
  | {
      deliver: false
      reason: 'tenant_mismatch'
      sender_tenant: string
      msg_tenant: string
    }

export interface RouteResponseInput {
  /** Outgoing-message lookup result (most-recent outgoing from sender→patient). */
  outgoingMessageId: string | null
  /** Resolved message (from queue.getById). May be null if message was purged. */
  message: { pluginName: string | null; tenantHint: string | null } | null
  /** Tenant of the sender (from sender_mapping). Null for legacy senders. */
  senderTenant: string | null
  /**
   * Feature flag value. When false, the strict tenant check is bypassed
   * entirely (rollback path). Defaults to true when undefined / any value
   * other than the literal string 'false'.
   */
  strictTenantFlag: string | undefined
}

export function routeResponse(input: RouteResponseInput): RouteResponseDecision {
  if (!input.outgoingMessageId) return { deliver: false, reason: 'no_history' }
  if (!input.message) return { deliver: false, reason: 'no_message' }
  if (!input.message.pluginName) return { deliver: false, reason: 'no_plugin' }

  const strict = input.strictTenantFlag !== 'false'
  if (strict) {
    const sender = input.senderTenant
    const msg = input.message.tenantHint
    // Drop only when BOTH sides have a tenant and they differ. Legacy
    // (null) on either side delivers — needed for backwards compat with
    // pre-G2 sends and unclaimed senders.
    if (sender !== null && msg !== null && sender !== msg) {
      return { deliver: false, reason: 'tenant_mismatch', sender_tenant: sender, msg_tenant: msg }
    }
  }

  return { deliver: true }
}
