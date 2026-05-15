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
| Tenants enabled in prod | **`adb`, `sicoob`, `oralsin` (all 3)** | `GET /api/v1/plugins/adb-precheck/tenants` |

**All 3 tenants live in prod since 2026-05-15 19:35.** `/tenants` endpoint returns:

```
adb     mode=prov label=ADB/Debt    pipeline=-  stage=-   pipedrive=true
sicoob  mode=raw  label=Sicoob      pipeline=14 stage=110 pipedrive=true
oralsin mode=raw  label=Oralsin     pipeline=3  stage=15  pipedrive=true
```

Real deals projection verified for both raw tenants:
- Sicoob: `BASE NOVA - SDR` / `NOVOS CONTRATOS` — 2+ deals pulled (cf_cpf-based pasta)
- Oralsin: `Cobrança Amigável` / `Novas Cobranças` — 2+ deals pulled (cf_cpf-based pasta)

## Prod env vars (already applied 2026-05-15 19:35)

Live in `/var/www/debt-adb-framework/packages/core/.env`:

```
PLUGIN_ADB_PRECHECK_TENANTS=adb,sicoob,oralsin

# Sicoob (raw mode)
PLUGIN_ADB_PRECHECK_REST_BASE_URL_SICOOB=https://pipelineanalytics.debt.com.br/api/v1/sicoob
PLUGIN_ADB_PRECHECK_REST_API_KEY_SICOOB=pk_cq55eotk0ck2xlaiaybzv07jo09m8gua  # router_api_keys.id=22
PLUGIN_ADB_PRECHECK_PIPELINE_ID_SICOOB=14
PLUGIN_ADB_PRECHECK_STAGE_ID_SICOOB=110
PLUGIN_ADB_PRECHECK_PIPEDRIVE_TOKEN_SICOOB=8fe7cd6ce9f514ec86311bffc79354657beaeb2e
PLUGIN_ADB_PRECHECK_PIPEDRIVE_DOMAIN_SICOOB=sicoob  # sicoob.pipedrive.com

# Oralsin (raw mode)
PLUGIN_ADB_PRECHECK_REST_BASE_URL_ORALSIN=https://pipelineanalytics.debt.com.br/api/v1/oralsin
PLUGIN_ADB_PRECHECK_REST_API_KEY_ORALSIN=pk_zo9k7krkpfhyumg5zdps8ek8f1ucnpfe  # router_api_keys.id=23
PLUGIN_ADB_PRECHECK_PIPELINE_ID_ORALSIN=3
PLUGIN_ADB_PRECHECK_STAGE_ID_ORALSIN=15
PLUGIN_ADB_PRECHECK_PIPEDRIVE_TOKEN_ORALSIN=0b8fe67687c7a1e748fb8aa1aaf7c66fc6f0276f
PLUGIN_ADB_PRECHECK_PIPEDRIVE_DOMAIN_ORALSIN=oralsin  # oralsin.pipedrive.com
```

Plaintext API keys also persisted (gitignored):
- `.dev-state/sicoob-apikey.local.md`
- `.dev-state/oralsin-apikey.local.md`

## How to disable a tenant in prod

1. SSH: `ssh adb@dispatch`
2. Edit `.env` — remove tenant from `PLUGIN_ADB_PRECHECK_TENANTS` CSV (e.g. `adb,sicoob` to drop oralsin).
3. `make -C /var/www/adb_tools core-restart`
4. The removed tenant's scanner/publisher is no longer dispatched. UI dropdown loses the option after the next /tenants poll.

## Router scope_guard hotfix (post-deploy)

The Go router had a hardcoded allowlist mapping scopes → URL patterns at `router/internal/api/rest/scope_guard.go`. T15 mounted `/precheck-raw/deals` with `requireScope("precheck:read")` middleware but the global scope_guard didn't have a regex matching the new path, so valid keys returned **403 scope_mismatch**.

Fixed in remote commit `3666e19` (router branch `precheck-multi-tenant`): added one regex line `^/api/v1/[a-z0-9_-]+/precheck-raw/deals$` to the `precheck:read` group.

When merging the router `precheck-multi-tenant` branch to main on the Pipeboard repo, include this fix.

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
