# debt-sdr Operator Runbook

> Operational reference for the `debt-sdr` plugin — feature flags,
> activation procedure, admin & operator REST routes, daily monitoring,
> rollback. Pairs with `dispatch-runbook.md` (core-level flags).

## TL;DR — activation checklist

```bash
# 0. Ensure plugin is built and Kali host is up-to-date.
ssh adb@dispatch 'cd /var/www/debt-adb-framework && git pull && pnpm -r build'

# 1. Make sure Pipedrive tokens are in /var/www/debt-adb-framework/packages/core/.env
PIPEDRIVE_TOKEN_ORALSIN_SDR=<token>
PIPEDRIVE_TOKEN_SICOOB_SDR=<token>

# 2. Enable plugin in DISPATCH_PLUGINS.
echo 'DISPATCH_PLUGINS=oralsin,adb-precheck,debt-sdr' >> /var/www/debt-adb-framework/packages/core/.env

# 3. Crons stay OFF until you confirm tenant config + Pipedrive sandbox.
#    Leave this UNSET until you're ready to send.
unset DISPATCH_SDR_CRONS_ENABLED

# 4. Restart and check logs.
ssh adb@dispatch 'sudo systemctl restart dispatch-core.service'
ssh adb@dispatch 'journalctl -u dispatch-core.service -n 50 --no-pager'
# Expect: "debt-sdr initialized" with claimed_devices, crons_enabled=false,
#         llm_provider=stub.
```

## Feature flags

| Flag                              | Default | Purpose                                                  |
|-----------------------------------|---------|----------------------------------------------------------|
| `DISPATCH_PLUGINS`                | —       | Comma-separated plugin list. Include `debt-sdr` to load. |
| `DISPATCH_SDR_CRONS_ENABLED`      | `false` | When `true`, plugin starts LeadPuller + Sequencer crons. |
| `PIPEDRIVE_TOKEN_<TENANT>`        | —       | Per-tenant API token. Required at first Pipedrive call. |
| `DISPATCH_QUEUE_TENANT_FILTER`    | `true`  | Core flag — see dispatch-runbook.md. Keep ON in prod.    |
| `DISPATCH_RESPONSE_STRICT_TENANT` | `true`  | Core flag — see dispatch-runbook.md. Keep ON in prod.    |

**Safety property:** when `DISPATCH_SDR_CRONS_ENABLED` is unset/`false`,
the plugin loads cleanly, registers routes and metrics, but **does not
enqueue any outbound message on its own**. The Sequencer is the only
enqueue surface and it is cron-driven. Operators can hit the admin
endpoints, inspect leads, see metrics — all safe.

## Tenant config

The plugin reads `packages/plugins/debt-sdr/config.json` at boot. Use
`config.example.json` as a starting point. Each tenant needs:

```jsonc
{
  "tenants": [
    {
      "name": "oralsin-sdr",              // unique tenant key (used in metrics + DTA)
      "label": "Oralsin",                 // human-readable for templates
      "pipedrive": {
        "domain": "oralsin-xyz",          // <domain>.pipedrive.com
        "api_token_env": "PIPEDRIVE_TOKEN_ORALSIN_SDR",
        "pull": { "stage_id": 5, "poll_interval_minutes": 15, "batch_size": 50, "max_age_days": 30, "phone_field_key": "phone" },
        "writeback": { "stage_qualified_id": 6, "stage_disqualified_id": 7, "stage_needs_human_id": 8, "stage_no_response_id": 9, "activity_subject_template": "SDR: {{outcome}}" }
      },
      "devices": ["serialA", "serialB"],  // hard-claimed at init via DTA
      "senders": [
        { "phone": "554399000001", "app": "com.whatsapp" }
      ],
      "sequence_id": "oralsin-cold-v1",
      "throttle": {
        "per_sender_daily_max": 40,
        "min_interval_minutes": 8,
        "operating_hours": { "start": "09:00", "end": "18:00" },
        "tz": "America/Sao_Paulo"
      },
      "identity_gate": { "enabled": true, "nudge_after_hours": 48, "abort_after_hours": 96 }
    }
  ]
}
```

The plugin's `init()` does the following preflight (fails loud on any of
these — service won't start):

- For each tenant device: `DeviceTenantAssignment.claim()`. Cross-tenant
  collision aborts.
- For each tenant sender: `setSenderTenant()`. Conflicting tenant aborts.
- Cross-tenant senders on the claimed devices (sender row owned by a
  foreign tenant): aborts before any claim is taken.

## Admin REST routes (read-only)

Mount: `/api/v1/plugins/debt-sdr/*`. Authentication via the dispatch
plugin-API key + HMAC (set at plugin registration).

| Method | Path                              | Query / Params                                   | Returns                                                    |
|--------|-----------------------------------|--------------------------------------------------|------------------------------------------------------------|
| GET    | `/leads`                          | `tenant`, `state`, `limit` (≤200), `cursor`     | `{ leads, next_cursor }` paginated by lead id              |
| GET    | `/leads/:id`                      | `id`                                             | `{ lead, sequence_state }` — 404 when missing              |
| GET    | `/sequences/:lead_id`             | `lead_id`                                        | `{ state \| null }`                                        |
| GET    | `/alerts`                         | `tenant`, `unresolved`=`true`\|`false`, `limit` | `{ alerts }` — unresolved by default                       |
| GET    | `/classifier/log`                 | `lead_id`, `since` (ISO), `limit` (≤500)        | `{ entries }` ordered DESC by `classified_at`              |
| GET    | `/health`                         | —                                                | `{ crons_enabled, llm_provider, tenants: [{ name, pipedrive_token_present }] }` |
| GET    | `/stats`                          | —                                                | `{ tenants: [{ name, leads_by_state, sequences_by_status, alerts_unresolved }] }` |

## Operator REST routes (mutating)

| Method | Path                              | Body                       | Effect                                                          |
|--------|-----------------------------------|----------------------------|-----------------------------------------------------------------|
| PATCH  | `/sequence/:lead_id/abort`        | `{ reason }`               | `terminateSequence(lead, 'aborted', operator:reason)`           |
| PATCH  | `/sequence/:lead_id/resume`       | —                          | Reactivate an `aborted`/`no_response` sequence. 409 otherwise.  |
| PATCH  | `/alerts/:id/resolve`             | `{ resolution }`           | Mark alert resolved. 404 when unknown or already resolved.      |
| POST   | `/leads/:id/force-recheck`        | —                          | DELETE sequence_state row + reset `lead.state='pulled'`         |

**Resume safety:** resume is rejected for finalized states
(`qualified`, `disqualified`, `opted_out`, `wrong_number`,
`pending_identity`, `active`). It is **only** allowed for `aborted` and
`no_response`, so an operator cannot un-finalize a deal that already
wrote back to Pipedrive.

## Prometheus metrics

Plugin metrics are registered on the **same** registry as core, so the
existing `/metrics` endpoint (`https://dispatch.tail106aa2.ts.net/metrics`)
surfaces both. Look for these series:

| Metric                                             | Type      | Alert threshold                                           |
|----------------------------------------------------|-----------|-----------------------------------------------------------|
| `sdr_invariant_violation_total{invariant}`         | Counter   | ANY non-zero → page on-call (I1-I8 violated)              |
| `dispatch_queue_blocked_by_tenant_filter_total`    | Counter   | Sustained increase suggests cross-tenant misconfig         |
| `dispatch_response_dropped_tenant_mismatch_total`  | Counter   | Sustained increase suggests G5 routing inconsistency      |
| `sdr_classifier_total{source,category,tenant}`     | Counter   | High `llm_error` rate → LLM provider unhealthy            |
| `sdr_classifier_latency_ms{source}`                | Histogram | P95 > 2s on `llm` source → switch provider                |
| `sdr_sequence_leads{tenant,status}`                | Gauge     | Pending growth without active growth → identity stuck     |
| `sdr_classifier_llm_cost_usd_total{tenant,provider}` | Counter | Daily delta > budget → cap or switch provider             |

## Daily monitoring checks

```bash
# 1. Service health.
curl -sf https://dispatch.tail106aa2.ts.net/api/v1/health | jq '.plugins'

# 2. Plugin health (Pipedrive tokens, llm provider, crons).
curl -sf https://dispatch.tail106aa2.ts.net/api/v1/plugins/debt-sdr/health \
  -H "X-API-Key: $DISPATCH_DEBT_SDR_API_KEY" | jq

# 3. Aggregates (leads in flight, alerts queued).
curl -sf https://dispatch.tail106aa2.ts.net/api/v1/plugins/debt-sdr/stats \
  -H "X-API-Key: $DISPATCH_DEBT_SDR_API_KEY" | jq

# 4. Unresolved operator alerts.
curl -sf "https://dispatch.tail106aa2.ts.net/api/v1/plugins/debt-sdr/alerts?unresolved=true" \
  -H "X-API-Key: $DISPATCH_DEBT_SDR_API_KEY" | jq '.alerts | length'

# 5. Prometheus metrics (look for non-zero invariant counter).
curl -sf https://dispatch.tail106aa2.ts.net/metrics | grep sdr_invariant_violation_total
```

## Manual operator flows

### Abort a misbehaving sequence

```bash
curl -X PATCH https://dispatch.tail106aa2.ts.net/api/v1/plugins/debt-sdr/sequence/<lead_id>/abort \
  -H "X-API-Key: $DISPATCH_DEBT_SDR_API_KEY" -H 'Content-Type: application/json' \
  -d '{"reason":"contact_complained"}'
```

### Resolve an operator alert after manual review

```bash
curl -X PATCH https://dispatch.tail106aa2.ts.net/api/v1/plugins/debt-sdr/alerts/<id>/resolve \
  -H "X-API-Key: $DISPATCH_DEBT_SDR_API_KEY" -H 'Content-Type: application/json' \
  -d '{"resolution":"manually_classified_as_interested"}'
```

### Force a lead to re-flow through the FSM

```bash
curl -X POST https://dispatch.tail106aa2.ts.net/api/v1/plugins/debt-sdr/leads/<lead_id>/force-recheck \
  -H "X-API-Key: $DISPATCH_DEBT_SDR_API_KEY"
```

Clears the `sdr_sequence_state` row and resets `lead.state='pulled'`.
The next cron tick treats it as a fresh lead — identity gate fires
again if enabled.

## Rollback procedure

Walk the ladder. **One step at a time**, redeploy / verify between each.

1. **Stop new sends** — disable crons:
   ```bash
   ssh adb@dispatch 'sed -i s/DISPATCH_SDR_CRONS_ENABLED=true/DISPATCH_SDR_CRONS_ENABLED=false/ /var/www/debt-adb-framework/packages/core/.env'
   ssh adb@dispatch 'sudo systemctl restart dispatch-core.service'
   ```
   The plugin keeps loading (routes still work), no automatic activity.

2. **Disable the plugin entirely** — remove from `DISPATCH_PLUGINS`:
   ```bash
   ssh adb@dispatch 'sed -i s/,debt-sdr// /var/www/debt-adb-framework/packages/core/.env'
   ssh adb@dispatch 'sudo systemctl restart dispatch-core.service'
   ```
   Plugin tables remain in SQLite (idempotent migrations), state is preserved.

3. **Disable core tenant filtering** — only if step 2 wasn't enough:
   ```bash
   ssh adb@dispatch 'echo DISPATCH_QUEUE_TENANT_FILTER=false >> /var/www/debt-adb-framework/packages/core/.env'
   ssh adb@dispatch 'sudo systemctl restart dispatch-core.service'
   ```
   This is a core-level rollback documented in `dispatch-runbook.md`.

Never skip steps — each layer is an independent safety net.

## LLM provider activation

The plugin ships with `StubLlmClient` (always returns `ambiguous` →
operator alert). To activate a real provider:

1. Implement `LlmClient` interface in
   `packages/plugins/debt-sdr/src/classifier/llm-client.ts` (or a
   sibling module) — e.g. `GeminiLlmClient`, `AnthropicLlmClient`.
2. Pass it to the plugin constructor via dispatch's plugin loader
   configuration (PR + redeploy required).
3. The orchestrator does not change — same cascade, same audit log,
   same Prometheus instrumentation.

Until activation, every regex-miss falls through to `ambiguous` and an
operator alert is raised. This is intentional during pre-launch — no
production traffic ever reaches an LLM until the provider is explicitly
selected.

## Known minor bugs (non-blocking)

These are documented for context — none impact safety or correctness:

- `Sequencer.acquireLock` returns `true` even on rows that don't yet
  exist (the ON CONFLICT path in `insertSequenceState` handles the gap).
  Semantic of the return value is mildly confusing; queued for cleanup.
- `IdentityGate.blacklist` callback is a no-op — plugin does not yet
  have access to `queue.recordBan`. Operator alerts still surface
  wrong-number cases so review can permanent-blacklist manually.
- `Sequencer.hasOutgoingHistory` is hardcoded `false` — the conservative
  default means the identity gate always runs even when prior contact
  exists. Wiring `message_history` accessor is a Phase F follow-up.

## Reference

- Spec: `docs/superpowers/specs/2026-05-14-debt-sdr-plugin-design.md`
- Plan: `docs/superpowers/plans/2026-05-14-debt-sdr-plugin-plan.md`
- Phase progress: `.dev-state/progress.md`
- Handoff JSON: `.handoff/session-20260515-0249-debt-sdr.json`
