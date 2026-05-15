# ADB Precheck Multi-Tenant — Design Spec

**Date**: 2026-05-14
**Author**: Daniel (DEBT) + AI architect
**Status**: Draft (post-brainstorming, pre-implementation plan)
**Related**:
- Existing plugin: `packages/core/src/plugins/adb-precheck-plugin.ts`
- Existing router: `pipeboard_ecosystem/router/internal/api/rest/precheck*.go`
- Existing UI: `packages/ui/src/components/adb-precheck-tab.tsx`
- Sister spec: `2026-05-06-adb-precheck-robustness-design.md`

---

## 1. Problem statement

The ADB Precheck plugin today is hardcoded to a single tenant (`adb`). With two
new physical devices in the fleet (3 devices total) and two new clients
(`Sicoob`, `Oralsin`), we need to run **three precheck workflows in parallel on
three different devices**, each pulling from a different Pipeboard tenant
schema, while:

- Preventing race conditions on the physical device (only one scan per device
  at a time, regardless of tenant).
- Hygienizing dirty phone strings for the two new tenants (their Pipeboard
  schemas hold raw Pipedrive mirrors, not the `prov_consultas` pipeline).
- Emitting formatted Pipedrive Notes + Activities (with `done=1`) for each
  scanned deal so the CRM operator sees the WhatsApp existence verdict.
- Preserving the existing `tenant_adb` flow byte-for-byte (zero regression).

## 2. Current state (verified during exploration)

### 2.1 Plugin architecture

`AdbPrecheckPlugin` is instantiated once at boot with a single
`IPipeboardClient` bound to a single tenant via `restBaseUrl`. All routes are
mounted under `/api/v1/plugins/adb-precheck/*`. The plugin owns:

- SQLite tables: `adb_precheck_jobs`, `adb_precheck_deals`,
  `pipedrive_activities`, `pending_writebacks`, `pasta_locks`.
- Shared registry: `wa_contacts`, `wa_contact_checks` (global cache across all
  consumers).
- Lock manager: `PastaLockManager` (SQLite-backed, survives restart).

### 2.2 Pipeboard router (Go)

- URL pattern: `/api/v1/{tenant}/precheck/*`.
- Some handlers honor `{tenant}` (deals, deals/count, phone-state); others
  hardcode `tenant_adb` (`precheck.go:548`, `precheck_localize.go:227`,
  `precheck_dispatched.go:247`).
- `precheckAllowedTenants = {"adb": true}` whitelist gates **every** precheck
  handler (`precheck.go:76`).
- New tenants need new API keys with appropriate scopes
  (`scripts/create_router_apikey.py` already exists).

### 2.3 Tenant schemas (Postgres)

Confirmed via `\dt` on prod DB:

| Schema | Has `prov_consultas`? | Phone source |
|---|---|---|
| `tenant_adb` | ✅ (full ETL: prov_consultas, prov_invalidos, prov_telefones_invalidos, snapshots, audit partitions) | 9 normalized columns |
| `tenant_sicoob` | ❌ raw Pipedrive mirror only (`negocios`, `pessoas`, `pipelines`, `etapas_funil`) | `pessoas.cf_telefone_contatos_primary_value` + `custom_fields_jsonb` |
| `tenant_oralsin` | ❌ same as Sicoob | same |

Verified pipelines/stages:
- Sicoob: pipeline `BASE NOVA - SDR` (id=14), stage `NOVOS CONTRATOS` (id=110).
- Oralsin: pipeline `Cobrança Amigável` (id=3), stage `Novas Cobranças` (id=15).

Sample raw phones (Sicoob `pessoas`): `(43) 984292585`, `55047991501806`,
`43991509875`. Existing `normalizeBrPhone` handles all observed shapes.

### 2.4 Device locking

`DeviceMutex` (in-process, FIFO waiters, 60s timeout) serializes ADB UI actions
between `WorkerOrchestrator` (sends) and `AdbProbeStrategy` (probes). Lock is
tenant-agnostic today; needs a `describeHolder` extension for UI visibility.

## 3. Architectural decisions (validated with user)

| # | Decision | Rationale |
|---|---|---|
| D1 | One scan per device (any tenant) | Aligned with `DeviceMutex`; ban-OCR and WA context stay clean. User-confirmed. |
| D2 | New router endpoint `GET /api/v1/{tenant}/precheck-raw/deals` for sicoob/oralsin | Router stays single source of truth; plugin remains transport-agnostic. User-confirmed. |
| D3 | Write-back for sicoob/oralsin: Pipedrive Note + Activity (`done=1`) + shared cache + HMAC callback | No `prov_consultas` writeback (schemas don't support it). User-confirmed. |
| D4 | Phasing: tracer bullet vertical Sicoob → Oralsin → Hardening | Real feedback in ~1 sprint. Reuse delta minimal for Oralsin. User-confirmed. |
| D5 | Pipedrive tokens as env vars per tenant (`PLUGIN_ADB_PRECHECK_PIPEDRIVE_TOKEN_<TENANT>`) | Simplest auth model; per-tenant rate buckets already isolated. User-confirmed. |
| D6 | Single plugin instance with internal multi-tenant dispatch | Preserves global wa_contacts cache, single DeviceMutex, unified routes. |
| D7 | Tenant whitelist split in router: `precheckProvTenants` (writes) vs `precheckAllowedTenants` (reads + raw) | Locks down legacy prov_* endpoints to adb only; sicoob/oralsin only get raw + read. |
| D8 | Client-side phone hygienization (TS) in Phase B; server-side SQL helper deferred to hardening | Reuses existing `normalizeBrPhone`; zero new Go code in critical path. |

## 4. Dependency graph

```
                    ┌──── Phase A (Foundation) ────┐
                    │  - TenantRegistry            │
                    │  - SQLite migrations         │
                    │  - DeviceMutex.describeHolder│
                    │  - /tenants, /devices        │
                    └──────────────┬───────────────┘
                                   ▼
                    ┌──── Phase B (Sicoob E2E) ────┐
              ┌─────┤  Router R1+R2+R3             │
              │     │  Plugin  T2+T4(sicoob)+T6    │
              │     │  UI      U1+U2+U5            │
              │     └──────────────┬───────────────┘
              │                    ▼
              │     ┌──── Phase C (Oralsin) ───────┐
              │     │  Config delta only           │
              │     │  Validate parallelism real   │
              │     └──────────────┬───────────────┘
              │                    ▼
              │     ┌──── Phase D (Hardening) ─────┐
              └────►│  C5 metrics, C6 health       │
                    │  U3 lanes, U4 preview, U6+U7 │
                    │  R4 SQL helper (optional)    │
                    └──────────────────────────────┘

Critical path:    A → B → C → D
Parallelizable:   within B, Router/Plugin/UI work in parallel after interface
                  is frozen.
```

## 5. Component design

### 5.1 Router (Go) — sicoob/oralsin support

#### R1: `GET /api/v1/{tenant}/precheck-raw/deals`

New file `router/internal/api/rest/precheck_raw_deals.go`. Query params:

```
pipeline_id    required, int64    (Sicoob: 14, Oralsin: 3)
stage_id       optional, int64    (Sicoob: 110, Oralsin: 15)
exclude_after  optional, ISO 8601 (mirrors /precheck/deals)
cursor         optional, base64url opaque (encodes negocios.id)
limit          optional, 1..1000, default 200
```

SQL (parameterized; schema name from `tenant_<tenant>`):

```sql
SELECT
  COALESCE(n.cf_id_cpf_cnpj::text, n.cf_matrícula, n.id::text)  AS pasta,
  n.id                                                          AS deal_id,
  'person'                                                      AS contato_tipo,
  COALESCE(n.person_id, n.id)                                   AS contato_id,
  n.person_name                                                 AS contato_nome,
  'principal'                                                   AS contato_relacao,
  s.name                                                        AS stage_nome,
  p.name                                                        AS pipeline_nome,
  n.update_time                                                 AS update_time,
  pe.cf_telefone_contatos_primary_value                         AS whatsapp_hot,
  pe.custom_fields_jsonb->>'phone_other_1'                      AS telefone_hot_1,
  pe.custom_fields_jsonb->>'phone_other_2'                      AS telefone_hot_2,
  pe.custom_fields_jsonb->>'phone_other_3'                      AS telefone_1,
  pe.custom_fields_jsonb->>'phone_other_4'                      AS telefone_2,
  pe.custom_fields_jsonb->>'phone_other_5'                      AS telefone_3,
  NULL::text                                                    AS telefone_4,
  NULL::text                                                    AS telefone_5,
  NULL::text                                                    AS telefone_6,
  FALSE                                                         AS localizado,
  NULL::text                                                    AS telefone_localizado
FROM   <schema>.negocios n
LEFT  JOIN <schema>.pessoas       pe ON pe.id = n.person_id
LEFT  JOIN <schema>.pipelines     p  ON p.id  = n.pipeline_id
LEFT  JOIN <schema>.etapas_funil  s  ON s.id  = n.stage_id
WHERE  n.pipeline_id = $1
  AND  ($2::bigint IS NULL OR n.stage_id = $2)
  AND  COALESCE(n.is_deleted, FALSE) = FALSE
  AND  COALESCE(n.is_archived, FALSE) = FALSE
  AND  ($3::timestamptz IS NULL OR n.update_time < $3)
  AND  ($4::bigint IS NULL OR n.id > $4)
ORDER BY n.id ASC
LIMIT $5;
```

> The exact mapping of `custom_fields_jsonb` keys to `telefone_*` columns will
> be validated with a spike at start of Phase B. The shape above is a working
> hypothesis; final keys come from inspecting Pipedrive custom-field metadata
> for each tenant. If a tenant has fewer secondary phones, the missing
> positions stay NULL.

Response shape: identical to existing `dealRow` struct (`precheck_deals.go`).
The TS client cannot tell the response apart from `/precheck/deals`.

Cursor: base64url of `{"id": <bigint>}` (single-column key — `negocios.id` is
unique within a tenant schema). Simpler than adb's composite cursor.

#### R2: Whitelist split

Edit `precheck.go:76`:

```go
// Tenants enrolled in any precheck endpoint (raw or prov).
var precheckAllowedTenants = map[string]bool{
    "adb":     true,
    "sicoob":  true,  // raw-only
    "oralsin": true,  // raw-only
}

// Tenants with full prov_consultas/prov_telefones_invalidos infrastructure.
// Gates the legacy /precheck/* write paths.
var precheckProvTenants = map[string]bool{
    "adb": true,
}
```

Every handler in `precheck.go`, `precheck_dispatched.go`,
`precheck_localize.go`, `precheck_revalidate.go`, `precheck_audit_smell.go`,
and `precheck_phone_state.go` that mutates `prov_*` swaps its gate from
`precheckAllowedTenants[tenant]` to `precheckProvTenants[tenant]`. Failure
returns `404 tenant not enrolled in precheck-prov`.

`precheck_deals.go` (read-only) stays on `precheckAllowedTenants` — sicoob and
oralsin gain access automatically, but the underlying query targets
`prov_consultas` which doesn't exist for them, so it fails with `404
prov_consultas not found in schema tenant_sicoob`. This is intentional: the
raw endpoint is the right path, the legacy one stays adb-shaped.

#### R3: Projection helper

`router/internal/api/rest/precheck_raw_projection.go`:

- `buildRawDealsQuery(schema, pipelineID, *stageID, *excludeAfter, *cursor, limit)` returns SQL + args.
- `encodeRawCursor(id int64) string` / `decodeRawCursor(s string) (int64, error)` — base64url JSON of `{"id": N}`.
- Re-uses the existing `dealRow` struct via export (rename to `DealRow` if it is currently package-private).

#### R4 (deferred to hardening): SQL hygienization helper

`tenant_<schema>.extract_pessoa_phones(pessoa_row) RETURNS text[]` —
normalizes + dedupes + drops obvious garbage. Only enabled in Phase D if
client-side normalization becomes a bottleneck.

### 5.2 Plugin (TypeScript) — multi-tenant dispatch

#### T1: Tenant registry

New file `packages/core/src/plugins/adb-precheck/tenant-registry.ts`:

```ts
export type TenantId = 'adb' | 'sicoob' | 'oralsin'

export interface TenantConfig {
  id: TenantId
  label: string
  mode: 'prov' | 'raw'
  restBaseUrl: string
  restApiKey: string
  defaultPipelineId?: number
  defaultStageId?: number
  pipedrive?: {
    apiToken: string
    companyDomain?: string
  }
  writeback: {
    invalidate: boolean
    localize: boolean
    pipedriveNote: boolean
    pipedriveActivity: boolean
  }
}

export class TenantRegistry {
  static fromEnv(env = process.env): TenantRegistry
  list(): TenantConfig[]
  get(id: TenantId): TenantConfig
  has(id: TenantId): boolean
}
```

Env var convention:

```
PLUGIN_ADB_PRECHECK_TENANTS=adb,sicoob,oralsin

# adb keeps existing (unsuffixed) vars — zero migration

PLUGIN_ADB_PRECHECK_REST_BASE_URL_SICOOB=https://gows-chat.debt.com.br/api/v1/sicoob
PLUGIN_ADB_PRECHECK_REST_API_KEY_SICOOB=...
PLUGIN_ADB_PRECHECK_PIPELINE_ID_SICOOB=14
PLUGIN_ADB_PRECHECK_STAGE_ID_SICOOB=110
PLUGIN_ADB_PRECHECK_PIPEDRIVE_TOKEN_SICOOB=8fe7cd6c...
PLUGIN_ADB_PRECHECK_PIPEDRIVE_DOMAIN_SICOOB=<subdomain>

PLUGIN_ADB_PRECHECK_REST_BASE_URL_ORALSIN=https://gows-chat.debt.com.br/api/v1/oralsin
PLUGIN_ADB_PRECHECK_REST_API_KEY_ORALSIN=...
PLUGIN_ADB_PRECHECK_PIPELINE_ID_ORALSIN=3
PLUGIN_ADB_PRECHECK_STAGE_ID_ORALSIN=15
PLUGIN_ADB_PRECHECK_PIPEDRIVE_TOKEN_ORALSIN=0b8fe676...
PLUGIN_ADB_PRECHECK_PIPEDRIVE_DOMAIN_ORALSIN=<subdomain>
```

Validation in `config-schema.ts`: for each tenant in `TENANTS`, the matching
env vars MUST be present. Fail-fast at boot.

#### T2: PipeboardRawRest client

New file `packages/core/src/plugins/adb-precheck/pipeboard-raw-rest.ts`.
Implements `IPipeboardClient` with `mode='raw'` semantics:

| Method | `raw` behavior |
|---|---|
| `iterateDeals(params)` | `GET /precheck-raw/deals?pipeline_id=...&stage_id=...&cursor=...` |
| `countPool()` | returns `-1` (unsupported — UI already collapses to `null`) |
| `applyDealInvalidation()` | throws `NotSupportedByRawBackendError` |
| `applyDealLocalization()` | throws `NotSupportedByRawBackendError` |
| `lookupDeals()` | throws `NotYetSupportedError` (deferred) |
| `aggregatePhoneDddDistribution()` | iterates deals client-side, identical strategy to `PipeboardRest` |
| `healthcheck()` | `GET /precheck-raw/healthz` (or shared `/precheck/healthz`) |

Reuses `PHONE_COLUMNS`, `normalizeBrPhone`, cursor scheme via
`URLSearchParams`. Zero duplication with `PipeboardRest` beyond the path base
and explicit refusal of write ops.

#### T3: Scan params + job store multi-tenant

`scanParamsSchema` gains:

```ts
tenant: z.enum(['adb', 'sicoob', 'oralsin']).default('adb'),
pipeline_id: z.number().int().optional(),
stage_id: z.number().int().optional(),
```

SQLite migration (idempotent):

```sql
ALTER TABLE adb_precheck_jobs       ADD COLUMN tenant TEXT NOT NULL DEFAULT 'adb';
ALTER TABLE adb_precheck_deals      ADD COLUMN tenant TEXT NOT NULL DEFAULT 'adb';
ALTER TABLE pipedrive_activities    ADD COLUMN tenant TEXT NOT NULL DEFAULT 'adb';
ALTER TABLE pending_writebacks      ADD COLUMN tenant TEXT NOT NULL DEFAULT 'adb';

CREATE INDEX IF NOT EXISTS idx_adb_precheck_jobs_tenant
  ON adb_precheck_jobs(tenant, status);
CREATE INDEX IF NOT EXISTS idx_adb_precheck_deals_tenant
  ON adb_precheck_deals(tenant, scanned_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pipedrive_activities_dedup_tenant
  ON pipedrive_activities(tenant, dedup_key);
```

`PrecheckJobStore` methods accept optional `tenant` filter:
`aggregateStats(tenant?)`, `listJobs(tenant?, limit)`,
`countScannedSince(thresholdIso, tenant?)`, etc. Omitted → global aggregate.

#### T4: Pipedrive per-tenant publishers

`AdbPrecheckPlugin` holds `Map<TenantId, PipedrivePublisher>`. Each tenant:

- Own `PipedriveClient` with own token, own rate bucket.
- Own `companyDomain` for deal links in notes.
- Same `PipedriveActivityStore` (shared SQLite) but dedup key now
  `(tenant, scenario, deal_id, phone, job_id)`.
- Activities created with `done: 1` (user feedback during brainstorming).
- Note header includes tenant label:
  `📊 Pré-check WhatsApp — Sicoob (BASE NOVA - SDR)`.
- For `mode='raw'`, `pasta_summary` groups by derived `pasta`
  (CPF/CNPJ → `cf_matrícula` → `n.id`). When the fallback hits `n.id`, one
  pasta == one deal — naturally degrades to "summary per deal".

#### T5: DeviceMutex.describeHolder

`engine/device-mutex.ts` gains optional context:

```ts
class DeviceMutex {
  async acquire(serial: string, ctx?: { tenant: string; jobId: string }): Promise<() => void>
  isHeld(serial: string): boolean
  describeHolder(serial: string): { tenant: string; jobId: string; since: string } | null
}
```

New endpoint:

```
GET /api/v1/plugins/adb-precheck/devices/availability

Response:
{
  "devices": [
    {"serial":"R8A1234567","available":true},
    {"serial":"R8A2345678","available":false,"tenant":"sicoob","job_id":"7d3a","since":"2026-05-14T20:00:00Z"}
  ]
}
```

`handleStartScan` calls `deviceMutex.isHeld(serial)` pre-job-creation. If
held, returns `409 device_busy {tenant, job_id, since}`.

#### T6: Scanner mode='raw'

`PrecheckScanner.runJob` branches on the resolved `TenantConfig.mode`:

- `mode='prov'` (adb): existing behavior, no changes.
- `mode='raw'` (sicoob/oralsin): same L1→L3→L2 validation, same cache priming,
  same snapshot writer, same Pipedrive emit. Skips `recordInvalidPhone`,
  `clearInvalidPhone`, `archiveDealIfEmpty`, `writeLocalizado`.

Fail-fast guard: if `tenant.writeback.invalidate === false` but the scanner
attempts an invalidation, throw a runtime error. Prevents regressions if the
config flag is set wrong.

#### T7: New routes

```
GET  /api/v1/plugins/adb-precheck/tenants
GET  /api/v1/plugins/adb-precheck/devices/availability
GET  /api/v1/plugins/adb-precheck/admin/tenant-health
GET  /api/v1/plugins/adb-precheck/stats/global?tenant=...&breakdown=tenant
GET  /api/v1/plugins/adb-precheck/jobs?tenant=...
POST /api/v1/plugins/adb-precheck/scan         (body includes tenant; 409 if device busy)
```

All existing endpoints accept optional `?tenant=`. Omitted → current behavior
(global aggregate or adb default depending on the endpoint).

### 5.3 UI (React) — tenant-aware layout

#### U1: Tenant selector

`components/adb-precheck/tenant-selector.tsx` + `tenant-context.tsx` (provider
+ hook). Mounted in `adb-precheck-tab.tsx` header. Persisted in localStorage
(`adb-precheck.tenant`). Includes `Global (todos)` option. Color per tenant:
`adb=sky`, `sicoob=violet`, `oralsin=amber`.

#### U2: Device availability + submit guard

`components/adb-precheck/device-availability-card.tsx`. Polls
`/devices/availability` every 5s. Disables "Iniciar scan" when selected device
is busy; tooltip shows `tenant`/`job_id`/`since`. Server-side 409 handled with
toast.

#### U3: Jobs lane view

When tenant selector is `Global`, jobs tab shows three Kanban-style columns
(adb / sicoob / oralsin). When a specific tenant is selected, filter mode
(flat list). Component: `jobs-lane-view.tsx`.

#### U4: Pipedrive Note preview

`pipedrive-note-preview.tsx` — pure renderer reusing the formatter Markdown.
Shows what the next pasta_summary Note will look like for the first deal in
the current scan query.

#### U5: Pipeline/Stage picker

`pipeline-stage-picker.tsx` — active when tenant is sicoob/oralsin. Defaults
from `TenantConfig`. Hygienization mode disabled in raw mode.

#### U6: Visão Geral breakdown

`tenant-breakdown.tsx` — when `Global` selected, `StatCard` rows show
breakdown per tenant. Backend supports via `?breakdown=tenant`.

#### U7: Locks panel device entries

`LocksPanel` consumes `/devices/availability` in addition to pasta locks.
Shows device locks colored by tenant.

## 6. Concurrency model

```
DeviceMutex (in-process)
  └── 1 holder per serial (any tenant)

PastaLockManager (SQLite, persists across restart)
  └── 1 holder per (pasta) — serializes scan ↔ publisher

PipedrivePublisher (in-process, per tenant)
  └── Token bucket per tenant (no cross-tenant interference)

Idempotency
  - REST writes (adb only): sha256(jobId | dealKey | body); tenant baked into URL
  - SQLite jobs: PK uuid (no tenant in unicidade); coluna tenant denormalizada
  - Pipedrive intents: dedup key = (tenant, scenario, deal_id, phone, job_id)
  - Snapshot files: data/probe-snapshots/<tenant>/<date>/<file>.png
```

Race table:

| # | Race | Defense | Location |
|---|---|---|---|
| 1 | Submit to busy device between polls | 409 `device_busy` from `handleStartScan` | `adb-precheck-plugin.ts` |
| 2 | Two scans grab same pasta | `ScanInProgressError` → 409 | `scanner.ts` (existing) |
| 3 | Phantom device holder after crash | 60s acquire timeout + boot watchdog | `device-mutex.ts` + `job-store.ts` |
| 4 | Cross-tenant deal_id collision in Pipedrive dedup | Dedup key includes tenant (migration) | `pipedrive-activity-store.ts` |
| 5 | Callback delivered to wrong receiver | Payload `tenant` field + `X-Dispatch-Tenant` header | `adb-precheck-plugin.ts` |
| 6 | UI shows stale data after tenant switch | `useTenant()` deps invalidate queries | `tenant-context.tsx` |
| 7 | Device disconnect mid-scan | Reactive `checkDeviceReady` (3 throws → 30min backoff) | `scanner.ts` (existing) |
| 8 | Pipedrive token expired | `onAuthError` → alert + halt that tenant only | `pipedrive-client.ts` |

## 7. Observability

Metrics gain `tenant` label:

- `precheck_jobs_total{tenant, status}`
- `precheck_deals_scanned_total{tenant, outcome}`
- `precheck_phones_checked_total{tenant, source, outcome}`
- `precheck_device_lock_seconds{tenant, device_serial}` (histogram)
- `precheck_pipeboard_request_total{tenant, op, status}` (extend existing)
- `precheck_pipedrive_request_total{tenant, kind, status}` (new)
- `precheck_active_jobs{tenant}` (gauge)

Logs (pino JSON): include `tenant` in every payload; prefix
`[adb-precheck:<tenant>]`. `correlationId` stays `job_id`.

Grafana dashboard `monitoring/grafana/dispatch-precheck-multi-tenant.json`:

- One row per tenant + Global row (4 panels: jobs / throughput / success rate
  / cache hit ratio).
- Device occupancy heatmap (device × time, hover shows tenant).
- Alert: `precheck_device_lock_seconds > 1800` → `dispatch_alert`.

Tenant health endpoint
`GET /api/v1/plugins/adb-precheck/admin/tenant-health` exposes per-tenant
`router_health`, `pipedrive_health`, `active_jobs`,
`last_successful_scan`, `writebacks_pending`, `callback_failures_24h`.

## 8. Phase plan (summary)

| Phase | Scope | Effort |
|---|---|---|
| A — Foundation | Tenant registry, migrations, DeviceMutex.describeHolder, /tenants, /devices, regression-safe | M (3-5d) |
| B — Sicoob tracer bullet | Router R1+R2+R3, Plugin T2+T4+T6, UI U1+U2+U5; real E2E | G (7-10d) |
| C — Oralsin | Config delta + paralelism real | P (2-3d) |
| D — Hardening | Metrics, Grafana, U3/U4/U6/U7, optional R4 SQL helper | M (3-5d) |
| **Total** | | **15-23d** |

Detailed task list with subagent allocation, gates and milestones is the
output of the next step (`superpowers:writing-plans`).

## 9. Risks & contingencies

**High**

- Sicoob/Oralsin `custom_fields_jsonb` layouts incompatible → 1h spike at
  start of Phase B to inspect 50 deals per tenant; adjust R1 query before
  coding.
- Pipedrive token bad scope discovered only in E2E → healthcheck in boot
  (C6); fail tenant degraded-mode if unauthorized.
- Router build/deploy mismatch → deploy to staging first; checklist in
  phase-B review.

**Medium**

- SQLite migration on prod DB → `IF NOT EXISTS` everywhere; test against
  prod dump before applying.
- Pipedrive 80 req/s saturation with 3 tenants → per-tenant token buckets
  already isolate (C1); 429 surfaces in metric.
- Cross-tenant deal_id dedup → migration sets unique index `(tenant,
  dedup_key)`; regression test specifically.

**Low**

- UI breakdown panel slow at >10k jobs → existing pagination + index handles.
- Operator forgets to switch tenant → localStorage persists; colored badge;
  confirm modal on submit.

**Contingency**

- If Phase B reveals >30% scanner code branching on `mode`, fork into
  `AdbPrecheckRawPlugin` (sibling plugin). Costs ~3 extra days.
- If router deploy blocks, plugin falls back to direct PG SSH tunnel (Opt-B
  of section R4); 2 extra days; swap to router when available.

## 10. Deferred scope

1. `POST /precheck-raw/deals/lookup` analog for sicoob/oralsin — not blocking.
2. Hygienization mode for raw tenants — meaningless without `prov_consultas`
   to freeze; disabled in UI.
3. Per-tenant Geo views (DDD heatmap) — trivial once `tenant` column exists;
   add on demand.
4. Server-side `extract_pessoa_phones()` SQL helper (R4 Opt-B) — gate on
   actual performance pressure.
5. Multi-pipeline simultaneous scan within a tenant — out of scope; today
   one scan = one pipeline.

## 11. Open questions for review

(Pre-implementation; flag anything before the writing-plans step.)

- Should `pipeline_id` / `stage_id` overrides on a scan be saved to
  `adb_precheck_jobs.params_json` for audit, or do we just snapshot the
  resolved values? **Proposed: snapshot resolved values in params_json (already
  happens today).**
- Color scheme for tenants — `sky/violet/amber` proposed. Confirm or adjust?
- Tenant label strings — `ADB/Debt`, `Sicoob`, `Oralsin`. OK?
- Should the `Global` job lane mode be the default when no tenant is
  selected, or always Filter mode? **Proposed: Lane mode for Global,
  Filter for specific tenant.**

---

**Next step**: invoke `superpowers:writing-plans` to produce a step-by-step
implementation plan with subagent allocation, code review gates, and
verification checkpoints.
