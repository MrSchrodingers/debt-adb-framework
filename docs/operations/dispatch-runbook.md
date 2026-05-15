# Dispatch Operations Runbook

> Operational reference for Dispatch core (debt-adb-framework). Covers
> feature flags, rollback procedures, and incident response for SDR /
> tenant-aware routing.

## SDR-related feature flags

The debt-sdr plugin lands behind two flags that can be flipped at boot
without code changes. Defaults are safe (filtering ON). Disable them
ONLY as part of a rollback procedure when SDR is misbehaving in prod.

### `DISPATCH_QUEUE_TENANT_FILTER`

| Field   | Value                                                                  |
|---------|------------------------------------------------------------------------|
| Default | `true` (filter enabled — G2 active)                                    |
| Effect  | When `false`, `MessageQueue.dequeueBySender` ignores `tenant_hint` and the active `device_tenant_assignment` rows. Queue reverts to legacy "any msg to any device" behavior. |
| Scope   | Affects every plugin that enqueues with a `tenantHint`; legacy plugins (`oralsin`, `adb-precheck`) enqueue with null tenant and are unaffected. |
| When to flip | Emergency rollback after deploying the SDR plugin when cross-tenant filtering is causing legitimate messages to stall in `queued`. |

### `DISPATCH_RESPONSE_STRICT_TENANT`

| Field   | Value                                                                   |
|---------|-------------------------------------------------------------------------|
| Default | `true` (G5 tightening on)                                               |
| Effect  | When `false`, the WAHA response webhook handler stops comparing `sender_mapping.tenant` against `messages.tenant_hint`. Responses route to the originating plugin by phone alone, restoring pre-SDR behavior. |
| Scope   | Affects `waha:message_received` event handler only. Outbound paths unchanged. |
| When to flip | Emergency rollback when legitimate patient replies are being dropped (look for `response routing dropped — sender/msg tenant mismatch (G5)` in pino logs). |

## Rollback order — SDR misbehavior in prod

The flags compose. Walk the ladder one step at a time, redeploying /
restarting between each step. **Never disable more than one safeguard at
once** — that strips multiple invariants simultaneously and makes the
root cause harder to find.

1. **Disable the plugin first.** This stops new SDR enqueues without
   touching the core invariants.
   ```bash
   curl -X POST https://dispatch.tail106aa2.ts.net/api/v1/admin/plugins/debt-sdr/disable \
     -H "X-API-Key: $DISPATCH_API_KEY"
   ```
   Verify: `GET /api/v1/admin/plugins/debt-sdr` returns `enabled: false`.
   In-flight SDR messages already queued will continue under the existing
   filter — that is intentional, drains naturally.

2. **If the queue is still wedged**, disable the dequeue filter:
   ```bash
   # On Kali prod box:
   sudo systemctl edit dispatch.service
   # Add under [Service]:
   Environment="DISPATCH_QUEUE_TENANT_FILTER=false"
   sudo systemctl restart dispatch.service
   ```
   This re-opens the queue to all (device, tenant) combinations. Use
   only when you can confirm the wedge is in the queue filter, not in
   the plugin itself.

3. **If patient replies still misroute**, disable response tightening:
   ```bash
   sudo systemctl edit dispatch.service
   # Append under [Service]:
   Environment="DISPATCH_RESPONSE_STRICT_TENANT=false"
   sudo systemctl restart dispatch.service
   ```
   Responses now route by phone alone (legacy). Operators must
   manually screen the conversation since the tenant guard is off.

4. **Investigate root cause** before reverting. Don't re-enable in
   reverse without a fix — a flag-flip cycle that goes
   "OFF → fix? → ON → still broken" wastes operator trust.

5. **Re-enable in reverse order** once the bug is fixed:
   `STRICT_TENANT=true` → restart → `QUEUE_TENANT_FILTER=true` → restart →
   re-enable plugin via admin API.

## Smoke tests after re-enable

Run on the prod box (Kali) once flags are back on:

```bash
# 1. Confirm DTA table is present and well-formed
sqlite3 /var/lib/dispatch/dispatch.db ".schema device_tenant_assignment"

# 2. Confirm tenant column is present on sender_mapping
sqlite3 /var/lib/dispatch/dispatch.db "PRAGMA table_info('sender_mapping')" | grep tenant

# 3. Confirm tenant_hint column is present on messages
sqlite3 /var/lib/dispatch/dispatch.db "PRAGMA table_info('messages')" | grep tenant_hint

# 4. Tail logs for the next dequeue cycle — should see no
# "blocked_by_tenant_filter" climbing while plugin is loaded.
journalctl -u dispatch.service -f | grep -i tenant
```

If any of the schema checks fail, the migrations didn't run — investigate
the boot logs before restoring traffic.

## Related artifacts

- Spec: `docs/superpowers/specs/2026-05-14-debt-sdr-plugin-design.md`
- Plan: `docs/superpowers/plans/2026-05-14-debt-sdr-plugin-plan.md`
- Phase A commits: G1, G2.1, G2.2, G2.3, G3, G5 (search `feat(sdr-` in
  git log).
