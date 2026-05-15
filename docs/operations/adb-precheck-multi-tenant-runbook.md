# ADB Precheck Multi-Tenant — Operations Runbook

**Date deployed**: 2026-05-15
**Branch merged**: `phase/precheck-multi-tenant` → `main` (commit `e308fbe8`)
**Spec**: `docs/superpowers/specs/2026-05-14-adb-precheck-multi-tenant-design.md`
**Plan**: `docs/superpowers/plans/2026-05-14-adb-precheck-multi-tenant-plan.md`
**Implementation summary**: 39/40 tasks complete (E2E live-device validation T36-T38 deferred to operator).

## Status

| Component | Status | Endpoint |
|-----------|--------|----------|
| Dispatch core (Kali) | Active | https://dispatch.tail106aa2.ts.net/api/v1/health |
| Pipeboard router (Docker, 188.245.66.92) | Active (healthy) | http://127.0.0.1:18080/api/v1/{tenant}/precheck-raw/healthz |
| Tenants enabled in prod | `adb` (only) | `GET /api/v1/plugins/adb-precheck/tenants` |

**Sicoob is NOT yet active in prod** — code is deployed and tested, but env vars in `/var/www/debt-adb-framework/packages/core/.env` only include adb. Operator must opt in (see "Enable Sicoob" below).

## How to enable Sicoob in prod

1. Copy the API key plaintext from `.dev-state/sicoob-apikey.local.md` (gitignored, local-dev only).
2. SSH to Kali: `ssh adb@dispatch`
3. Edit `/var/www/debt-adb-framework/packages/core/.env`:
   ```
   PLUGIN_ADB_PRECHECK_TENANTS=adb,sicoob
   PLUGIN_ADB_PRECHECK_REST_BASE_URL_SICOOB=http://pipeboard-router:18080/api/v1/sicoob
   PLUGIN_ADB_PRECHECK_REST_API_KEY_SICOOB=<plaintext from .local.md>
   PLUGIN_ADB_PRECHECK_PIPELINE_ID_SICOOB=14
   PLUGIN_ADB_PRECHECK_STAGE_ID_SICOOB=110
   PLUGIN_ADB_PRECHECK_PIPEDRIVE_TOKEN_SICOOB=<sicoob Pipedrive token>
   PLUGIN_ADB_PRECHECK_PIPEDRIVE_DOMAIN_SICOOB=<sicoob-subdomain>
   ```
4. `make -C /var/www/adb_tools core-restart` (NOPASSWD systemd restart)
5. Verify: `curl -H "X-API-Key: $KEY" https://dispatch.tail106aa2.ts.net/api/v1/plugins/adb-precheck/tenants` should now include `sicoob`.

## Architecture (TL;DR)

- **Single AdbPrecheckPlugin** instance, internal `Map<TenantId, IPipeboardClient>` + `Map<TenantId, PrecheckScanner>` + `Map<TenantId, PipedrivePublisher>`.
- **adb tenant** → `mode='prov'`, uses legacy `PipeboardRest` against `/api/v1/adb/precheck/*` (writes to prov_consultas).
- **sicoob/oralsin tenants** → `mode='raw'`, uses new `PipeboardRawRest` against `/api/v1/{tenant}/precheck-raw/deals` (read-only projection of `negocios JOIN pessoas`; no writebacks to prov_*).
- **All tenants** emit Pipedrive Notes + Activities (done=1). Per-tenant `PipedrivePublisher` with own token, own rate bucket, dedup_key namespaced by `(tenant, dedup_key)` via UNIQUE INDEX.
- **DeviceMutex** tenant-agnostic but tracks `{tenant, jobId, since}` on the holder for the new `GET /devices/availability` endpoint and 409 `device_busy` body.
- **UI** has `TenantSelector` in header (localStorage `adb-precheck.tenant`), `DeviceAvailabilityCard`, `PipelineStagePicker` (raw only), hygienization disabled in raw mode.

## Smoke tests (post-deploy)

```bash
# Core health
curl -fsS https://dispatch.tail106aa2.ts.net/api/v1/health
# Plugin tenants (requires PLUGIN_ADB_PRECHECK_API_KEY)
curl -fsS -H "X-API-Key: $KEY" https://dispatch.tail106aa2.ts.net/api/v1/plugins/adb-precheck/tenants
# Device availability
curl -fsS -H "X-API-Key: $KEY" https://dispatch.tail106aa2.ts.net/api/v1/plugins/adb-precheck/devices/availability

# Router raw healthz (Pipeboard host, internal)
ssh -i ~/.ssh/id_waha claude@188.245.66.92 'curl -sS http://127.0.0.1:18080/api/v1/sicoob/precheck-raw/healthz'
ssh -i ~/.ssh/id_waha claude@188.245.66.92 'curl -sS http://127.0.0.1:18080/api/v1/adb/precheck-raw/healthz'
ssh -i ~/.ssh/id_waha claude@188.245.66.92 'curl -sS http://127.0.0.1:18080/api/v1/adb/precheck/healthz'
```

## E2E real-scan validation (deferred to operator)

Phase B.4 tasks T36 (real Sicoob scan limit=3), T37 (adb regression), T38 (parallel sicoob+adb) require:
- 3 physical Android devices connected via ADB
- Sicoob env vars active in `.env`
- Operator launches scan via UI tenant selector

Recommended order:
1. Enable Sicoob env vars + restart.
2. Verify `/tenants` shows both adb + sicoob.
3. Run sicoob scan with `limit=3` via UI → check Pipedrive Notes+Activities appear in sicoob's CRM.
4. Run adb scan in parallel on different device → confirm DeviceMutex isolates them.
5. Confirm no cross-tenant Pipedrive collisions.

## Rollback

If Sicoob causes regressions:
1. Edit `.env`: `PLUGIN_ADB_PRECHECK_TENANTS=adb` (remove sicoob).
2. `make core-restart`.
3. Sicoob no longer dispatched; adb keeps working byte-for-byte unchanged.

For full rollback of the multi-tenant feature: `git revert e308fbe8` (the merge commit) on main, push, redeploy. The migration is additive — rolling back leaves the tenant/dedup_key columns in place (no destructive change required).

## Known follow-ups (post-merge tech debt)

- **PipedriveView (`pipedrive-view.tsx`)**: 6 fetches NOT yet tenant-aware. Operator views see all tenants mixed. Tracked for follow-up.
- **PluginHeader subtitle**: hardcoded "Pipeboard tenant_adb · pre-validacao WhatsApp". Should derive from selected tenant. Minor.
- **Sicoob Pipedrive token (`PIPEDRIVE_TOKEN_SICOOB`)**: not yet populated — operator must obtain from Sicoob Pipedrive admin.

## Quality gates met

- 1976+ tests passing (vitest), 0 regressions
- 4 router Go integration tests against tenant_sicoob real DB (PASS)
- Code review (T39) — C1 (cross-tenant pasta isolation) + I2 (unknown tenant 400) fixed pre-deploy
- Back-compat: `PLUGIN_ADB_PRECHECK_TENANTS=adb` (default) reproduces previous behavior byte-for-byte
- Migration idempotency verified — re-running `initialize()` is a no-op via `idempotentAlter`
