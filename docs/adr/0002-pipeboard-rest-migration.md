# 0002. Pipeboard integration moves from raw SQL over SSH tunnel to authenticated REST API with append-only audit

Date: 2026-05-04 (revised same day)
Status: Accepted (Pipeboard side already shipped phones/invalidate)
Supersedes: none
Related: 043_prov_telefones_invalidos, 044_backfill_phantom_consultas

> **Revision note (2026-05-04):** initial draft proposed Dispatch-side
> migrations 045/046 introducing `prov_consultas_history` +
> `api_audit_log`, with mTLS auth. The Pipeboard team shipped the
> first endpoint (`POST /phones/invalidate`) using a different
> auditing model — append-only `prov_telefones_invalidos_requests`
> with full `raw_body` JSONB per call — and `X-API-Key` auth managed
> in `public.router_api_keys`. Migrations 045/046 were dropped; this
> ADR now reflects the shipped contract.

## Context

The `adb-precheck` plugin in Dispatch (Node) reaches the Pipeboard
Postgres (Python ETL repo) through a persistent SSH tunnel managed by
`pipeboard-tunnel.service` on the Kali host:

```
/usr/bin/ssh -i /home/adb/.ssh/id_waha -N \
  -L 25432:localhost:15432 \
  ... claude@188.245.66.92
```

A `pg.Pool` (`max=4`, `application_name=dispatch-adb-precheck`) speaks
SQL directly to schema `tenant_adb`. The single class encapsulating
that surface — `PipeboardPg` in
`packages/core/src/plugins/adb-precheck/postgres-client.ts` — exposes
nine operations across four tables:

| # | Method | Table | Kind |
|---|--------|-------|------|
| 1 | `healthcheck` | — | R |
| 2 | `countPool` | `prov_consultas` | R |
| 3 | `iterateDeals` | `prov_consultas` | R (keyset, 200/page) |
| 4 | `recordInvalidPhone` | `prov_telefones_invalidos` | UPSERT |
| 5 | `clearInvalidPhone` | `prov_consultas` | UPDATE (NULL ≤9 cols) |
| 6 | `clearLocalizadoIfMatches` | `prov_consultas` | UPDATE |
| 7 | `writeInvalid` | `prov_invalidos` | INSERT |
| 8 | `archiveDealIfEmpty` | `prov_consultas` → `prov_consultas_snapshot` | DELETE+INSERT (CTE) |
| 9 | `writeLocalizado` | `prov_consultas` | UPDATE |

Per deal with N invalid phones, the writeback path issues
`3·N + (1 + 1)` round-trips. A 1k-deal scan with average 5 invalids
exercises ≈ 17k SQL statements through the tunnel.

### Pain points driving the change

1. **Mutations on `prov_consultas` are destructive.** A column NULLed by
   Dispatch overwrites whatever Pipeboard ETL had previously written,
   with no row-level history. The existing `prov_consultas_snapshot`
   table only captures the *terminal* state (deal fully empty), not
   intermediate edits.
2. **No per-call audit.** Job-level metrics live in Dispatch SQLite
   (`adb_precheck_jobs`, `adb_precheck_deals`); per-phone audit lives
   in `prov_telefones_invalidos`. Neither answers "which exact request
   touched this column at this timestamp?".
3. **Schema coupling.** Dispatch hard-codes the column whitelist
   (`PHONE_COLUMNS` array, snapshot column list, exact PK shape).
   Pipeboard cannot evolve the table without a coordinated Dispatch
   release.
4. **Operational drift.** The tunnel restarted 829 times in ~42 h on
   2026-05-04 (avg ~3 min between restarts). The Postgres at
   `188.245.66.92:15432` is shared with Temporal, so a Dispatch query
   storm contends with workflow scheduling.
5. **Security surface.** A single SSH key (`id_waha`) grants the
   `claude@hetzner` user shell access to the bastion plus loopback
   Postgres reach — far beyond what the precheck workflow needs.

### Why now

The Pipeboard rewrite already underway will introduce auditable
storage for `prov_consultas`. Repointing Dispatch at the same moment
avoids paying the migration cost twice and lets us delete the SSH
tunnel once the cutover proves stable.

## Decision

Replace the SSH-tunneled `pg.Pool` with an HTTPS REST client and back
the contract with append-only history tables on the Pipeboard side.

The change has four pillars:

1. **`PipeboardClient` interface in Dispatch.** `PipeboardPg` and a
   new `PipeboardRest` both implement the same nine-method surface.
   Selection at boot via env flag `PLUGIN_ADB_PRECHECK_BACKEND=sql|rest`
   (default: `sql` until the cutover gate).
2. **REST surface on Pipeboard.** Five endpoints cover the entire
   nine-operation matrix. Multi-statement deal writeback collapses
   into a single `POST .../writeback` call inside one
   `SERIALIZABLE` transaction.
3. **Append-only history.** A `prov_consultas_history` partitioned
   table captures every mutation as a versioned row with a JSONB diff.
   `prov_consultas` becomes a derived "current" view tagged with the
   latest `version_id`. Empty deals are flagged with `archived_at`
   instead of being deleted.
4. **Per-call audit log.** `api_audit_log` records request/response
   metadata (caller, idempotency key, status, duration, rows affected,
   correlation IDs) for every mutating call.

### Endpoint contract (Pipeboard, `tenant_adb`)

| Method | Path | Status | Scope | Replaces |
|--------|------|--------|-------|----------|
| `POST` | `/api/v1/{tenant}/precheck/phones/invalidate` | **live** | `precheck:write` | `recordInvalidPhone`, `clearInvalidPhone`, `clearLocalizadoIfMatches`, `archiveDealIfEmpty` |
| `GET`  | `/api/v1/{tenant}/precheck/healthz` | **live** | (none) | `healthcheck` |
| `GET`  | `/api/v1/{tenant}/precheck/deals` | **live** | `precheck:read` | `countPool`, `iterateDeals` |
| `POST` | `/api/v1/{tenant}/precheck/deals/localize` | **live** | `precheck:write` | `writeLocalizado` |
| `POST` | `/api/v1/{tenant}/precheck/phones/{telefone}/revalidate` | **live** | `precheck:admin` | (forensic mark only — guardrail keeps blocking; not on Dispatch path) |

**Hosts:**
- Internal (Dispatch): `https://pipelineanalytics.debt.com.br/api/v1`
  (BR geo-fenced, admin allow-list at edge, HTTP/2)
- External (provider): `https://adb.debt.com.br/api/v1`
  (paths whitelisted to `/precheck/*` only, HSTS preload, body cap 1 MiB)

**Cursor format on `GET /deals`:** opaque `base64url(JSON)`. Treat as
a black box — never parse or construct it on the client.

**`POST /deals/localize` 409:** two distinct cases discriminated by
`error.message`:
- `Idempotency-Key collision` — caller bug, regenerate key.
- `telefone is in prov_telefones_invalidos and cannot be localized` —
  guardrail rejection (phone is blocked). Treat as permanent failure
  for that phone, do not retry.

**`POST /deals/localize` `status` enum:** `applied` (row updated) or
`noop_already_localized` (UPDATE matched zero rows — deal missing or
already localized to the same phone). Both are success.

`writeInvalid` (legacy `prov_invalidos`) is **not** in the REST
surface: that table is owned by the Pipeboard ETL (Python
`sync_consultas_flow`) and represents deal-level "contato inválido"
(CPF/CNPJ issues), a different concern from per-phone invalidation.
Dispatch's call to it is removed once `BACKEND=rest`.

`POST /phones/invalidate` accepts a per-deal batch (up to 50 phones)
and is executed in a `SERIALIZABLE` transaction. Body:

```json
{
  "fonte": "dispatch_adb_precheck",
  "deal_id": 12345, "pasta": "AB-2024/12",
  "contato_tipo": "person", "contato_id": 67890,
  "motivo": "whatsapp_nao_existe",
  "job_id": "job-uuid",
  "phones": [
    { "telefone": "5543991938235", "coluna_origem": "telefone_1", "confidence": 0.92 }
  ],
  "archive_if_empty": true
}
```

Response:

```json
{
  "request_id": "uuid",
  "idempotent": false,
  "applied": [
    { "telefone": "5543991938235", "status": "applied" }
  ],
  "archived": false,
  "cleared_columns": ["telefone_1"]
}
```

`status: "duplicate_already_moved"` is success — the phone was
already blocked by a prior call, so the no-op is the expected
outcome. `Idempotency-Key` is mandatory and is
`sha256(jobId + dealKey + payloadHash)` for Dispatch; replays return
the original response with `idempotent: true`. Same key + different
body → `409 Conflict`.

After commit the handler fires
`Temporal.PipedrivePhoneInvalidationWorkflow`. Two scenarios are
generated server-side:

- `fonte=dispatch_adb_precheck` (or `debt_adb_intern_admin`) →
  one batch-per-pasta activity (replaces Dispatch's `deal_all_fail`).
- `fonte=debt_adb_provider` → one activity per phone (replaces
  Dispatch's `phone_fail`).

`pasta_summary` (the end-of-scan Note) is **not** generated by
Pipeboard and remains the responsibility of Dispatch's
`PipedrivePublisher` even after cutover.

### Auth

Per-route header `X-API-Key`, validated against
`public.router_api_keys` and gated by `requireScope` middleware.
Three scopes:

- `precheck:write` — phones/invalidate, deals/localize
- `precheck:read` — deals (GET) and audit endpoints
- `precheck:admin` — phones/{telefone}/revalidate

Two production keys exist:

- id=18 `debt_adb_intern_admin` (Dispatch) — `precheck:write`,
  rate_limit raised to 5000 req/min for batch invalidation.
- id=19 `debt_adb_provider` — `precheck:write`, 1000 req/min.

Tailscale ACL pins the router endpoint to internal hosts; no
public Caddy needed.

### Auditing model

Pipeboard records one row per phone in
`tenant_adb.prov_telefones_invalidos_requests` with full
`raw_body` JSONB, `idempotency_key`, `api_key_id`, `caller_ip`,
`status`, `request_id`. This replaces the per-row
`prov_consultas_history` model that the initial draft of this ADR
proposed. The trade-off: history is per-call, not per-tuple — but
the `raw_body` JSONB is enough to reconstruct any mutation that
went through the REST surface.

Mutations that bypass the REST surface (Pipeboard ETL, manual SQL,
revalidation drops) are not in this audit log. They are out of
scope for the Dispatch cutover and remain the Pipeboard team's
concern.

A `BEFORE INSERT/UPDATE` trigger on `prov_consultas` enforces the
blocklist: any of the 9 phone columns or `telefone_localizado`
attempting to reintroduce a blocked number is silently NULLified
with `RAISE WARNING`. This means **`BACKEND=rest` and `BACKEND=sql`
are mutually exclusive** on the Dispatch side: a SQL fallback
during the rest path would have its writes silently zeroed.

## Consequences

### Positive

- Per-row history of `prov_consultas` mutations, queryable by
  `request_id`, `job_id`, `caller`, `external_ref`.
- Fewer round-trips: `3N + 2` SQL calls per deal collapse into one
  HTTP request.
- Schema evolution decoupled: the contract is OpenAPI, not SQL.
- Tunnel + shared SSH key removed once `BACKEND=rest` is the only
  enabled mode; reduces Hetzner attack surface.
- Per-call rate limiting is server-enforceable, protecting the
  Postgres shared with Temporal.
- Dispatch SQLite continues holding job/deal state; nothing migrates
  out of `adb_precheck_jobs` or `adb_precheck_deals`.

### Negative

- Per-call latency rises from ~1–3 ms (loopback PG) to ~5–15 ms
  (HTTPS). Mitigated by collapsing per-deal writebacks; net change is
  neutral or positive at scan-job throughput level.
- Pipeboard now owns code Dispatch used to own (transactional
  writeback). Bug surface moves but does not vanish.
- Dual-write window adds operational steps: monitor divergence, run
  cutover migration, decommission tunnel.

### Migration (incremental — already in flight)

1. **[done — Pipeboard]** Migrations 043–046 on Pipeboard PG:
   `prov_telefones_invalidos` extended with `fonte` + `request_id`,
   `prov_telefones_invalidos_requests` audit log, blocklist trigger
   guardrail, scoped API keys.
2. **[done — Pipeboard]** `POST /phones/invalidate` shipped with
   Temporal workflow for Pipedrive activity emission.
3. **[done — Dispatch]** `IPipeboardClient` interface extracted;
   `PipeboardPg` continues as the SQL implementation (behaviour
   unchanged).
4. **[done — Dispatch]** `PipeboardRest` implements `applyDealInvalidation`
   against the live endpoint. Reads, localize, healthcheck still
   delegate to the SQL backend until Pipeboard ships the roadmap
   endpoints.
5. **[next — Pipeboard]** ship `GET /healthz`, `GET /deals`,
   `POST /deals/localize`, `POST /phones/{telefone}/revalidate`.
6. **[next — Dispatch]** wire the `PipeboardRest` reads + localize
   methods to the new endpoints; remove the SQL fallback for those.
7. **Cutover** in production via `PLUGIN_ADB_PRECHECK_BACKEND=rest`.
   Backends are mutually exclusive (the Pipeboard guardrail trigger
   silently zeros SQL writes during rest mode).
8. **Two weeks of REST-only operation.** If stable: disable + remove
   `pipeboard-tunnel.service`, rotate `id_waha`, close port 15432
   forwarding on the bastion.

### Risks

- **Pipeboard outage blocks scans.** Dispatch SHOULD enqueue pending
  writebacks to a local SQLite buffer (`pending_writebacks`) and
  drain on reconnect. Read paths (`countPool`, `iterateDeals`) cannot
  be buffered — scans simply pause.
- **Schema drift between current/history triggers and writeback
  endpoint.** Mitigated by integration tests that exercise the full
  writeback path and assert the resulting history row matches the
  request payload.
- **Idempotency-key collisions across job retries.** Key is
  `sha256(jobId + dealKey + payloadHash)`; collisions imply identical
  payloads, which is the desired no-op behaviour.

## Out of scope

- Migrating Oralsin plugin or Pipedrive integration to REST. Both
  already use HTTP and are unaffected.
- Repointing the Temporal tenant on the same Postgres instance.
- Changing Dispatch's SQLite storage for jobs and deal cache.

## Alternatives considered

- **Keep raw SQL, add `prov_consultas_history` triggers.** Provides
  history without the REST surface. Rejected: leaves the destructive
  schema coupling and the SSH tunnel in place; trigger overhead
  amplifies the per-deal `3N + 2` round-trip cost.
- **gRPC instead of REST.** Stronger typing but new tooling on
  Pipeboard side and incompatible with the existing Caddy/JWT setup
  used elsewhere in the stack. Rejected for operational consistency.
- **Direct Postgres connection over Tailscale (no tunnel).**
  Eliminates SSH but keeps schema coupling and lacks per-call audit.
  Rejected as a half-measure.
