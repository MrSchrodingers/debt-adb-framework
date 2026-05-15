# Development Progress — DEBT ADB Framework

> **Last updated**: 2026-05-15T13:30:00-03:00
> **Current phase**: ADB-PRECHECK MULTI-TENANT — Phase A APPROVED (10/40 tasks), Phase B.1 STARTING
>
> ## ADB-PRECHECK MULTI-TENANT STATUS
>
> - **Spec**: `docs/superpowers/specs/2026-05-14-adb-precheck-multi-tenant-design.md`
> - **Plan**: `docs/superpowers/plans/2026-05-14-adb-precheck-multi-tenant-plan.md` (40 tasks, 5 sub-phases)
> - **Branch**: `phase/precheck-multi-tenant` (HEAD `abe03ed7`)
> - **Tests**: 1959/1959 passing, 0 regressions (Phase A gate)
> - **Phase A APPROVED 2026-05-15**: T1 TenantRegistry, T2 barrel, T3 SQLite migration (tenant column on 4 tables; UNIQUE pipedrive_activities deferred to T23 — dedup_key not yet a column), T4 DeviceMutex describeHolder, T5 scanner+probe ctx propagation, T6 GET /tenants, T7 GET /devices/availability, T8 handleStartScan 409, T9 server.ts wires TenantRegistry, T10 gate
> - **Next**: Phase B.1 (router Go) — T11 spike → T12 whitelist split → T13-T16 /precheck-raw projection+handler+test → T17 API key → T18 router build
>
> ## DEBT-SDR PLUGIN STATUS (paused, OFF in prod)
>
> - **Spec**: `docs/superpowers/specs/2026-05-14-debt-sdr-plugin-design.md`
> - **Plan**: `docs/superpowers/plans/2026-05-14-debt-sdr-plugin-plan.md` (50 tasks, 5 phases)
> - **Branch**: `main` (HEAD `9c651666`)
> ## DEBT-SDR PLUGIN STATUS
>
> - **Spec**: `docs/superpowers/specs/2026-05-14-debt-sdr-plugin-design.md`
> - **Plan**: `docs/superpowers/plans/2026-05-14-debt-sdr-plugin-plan.md` (50 tasks, 5 phases)
> - **Branch**: `main` (HEAD `9c651666`)
> - **Tests**: 1944 core + 271 plugin (+4 skipped E2E) = 2215 passing, 0 regressions
> - **Kali prod**: deployed HEAD `9c65166`, `dispatch-core.service` active (PID 64671, 126MB), all 7 SDR metrics visible at /metrics, plugin OFF (`DISPATCH_PLUGINS` does not include `debt-sdr`)
> - **Runbook**: `docs/operations/sdr-runbook.md`
> - **Handoff**: `.handoff/session-20260515-0249-debt-sdr.json`
>
> ### Completed phases
> - **Phase A (Tasks 1-10) ✅** — sender_mapping.tenant + DeviceTenantAssignment + messages.tenant_hint + dequeue tenant filter + PluginContext G3 API + response webhook G5 + server wire + feature flags + runbook
> - **Phase B (Tasks 11-17) ✅** — plugin scaffold + Zod config validator + SDR migrations 6 tables + init flow + destroy + server boot registration + smoke
> - **Phase C (Tasks 18-26) ✅** — regex classifier (6 categories) + provider-neutral LlmClient + StubLlmClient + cascade orchestrator + audit log + identity gate templates + IdentityGate FSM + OperatorAlerts
> - **Phase D (Tasks 27-38) ✅** — TenantPipedriveClient + lead extractor + LeadPuller + sequences (oralsin/sicoob cold-v1) + ThrottleGate + Sequencer FSM + ResponseHandler + PendingWritebacks + wire crons (OFF by default via DISPATCH_SDR_CRONS_ENABLED)
> - **Phase E (Tasks 39-50) ✅** — admin+operator routes (11 endpoints, 17 tests) + Prometheus metrics (7 instruments on core registry) + race-condition tests A1-A10 + 12 integration tests + E2E scaffold (RUN_E2E gated) + full local pass + sdr-runbook.md + Kali deploy + production smoke + progress.md + quality gates
>
> ### Production smoke results (2026-05-15T11:53)
> - `GET /api/v1/health` → `{"status":"ok"}` (via 127.0.0.1 and via https://dispatch.tail106aa2.ts.net)
> - `GET /metrics` (X-API-Key auth) → all 7 SDR metrics present with HELP+TYPE: `sdr_invariant_violation_total`, `dispatch_queue_blocked_by_tenant_filter_total`, `dispatch_response_dropped_tenant_mismatch_total`, `sdr_classifier_total`, `sdr_classifier_latency_ms`, `sdr_sequence_leads`, `sdr_classifier_llm_cost_usd_total`
> - `dispatch-core.service` active, oralsin + adb-precheck loaded; `debt-sdr` not in `DISPATCH_PLUGINS` (intentional — plugin OFF until operator opts in per runbook)
>
> ### Constraints active
> - **No Anthropic yet** — provider TBD (maybe Gemini). StubLlmClient default.
> - **No mass send** — DISPATCH_SDR_CRONS_ENABLED=false by default. Test phone 5543991938235 only.
> - **Commits without co-author footer.**
>
> ## EARLIER: ADB-PRECHECK ROBUSTNESS — IMPLEMENTATION COMPLETE (Phases A-E + Phase Gate)
> **Last delivery**: Pure UI state classifier (8 states, 9 fixtures), 3-level retry pipeline
>   (in-probe recover, end-of-scan, manual sweep), in-place Pipedrive note upsert via PUT,
>   SQLite-backed pasta locks with monotonic fence tokens, quota-bounded XML snapshot
>   persistence for unknowns, audit columns (attempt_phase, triggered_by, parent_job_id,
>   revises_row_id, http_verb), admin endpoints (/admin/locks, /admin/probe-snapshots),
>   note revision history endpoint, manual sweep endpoint (POST /retry-errors).
> **Next action**: Operator E2E run on POCO Serenity via `scripts/e2e-precheck-scale.sh`,
>   then merge to main and deploy.
> **Spec**: `docs/superpowers/specs/2026-05-06-adb-precheck-robustness-design.md` (980 lines)
> **Plan**: `docs/superpowers/plans/2026-05-06-adb-precheck-robustness-plan.md` (2664 lines, 32 tasks)
> **Branch**: `phase/precheck-robustness` — 34 commits, 1732 tests passing (137 files), zero regressions
> **Runbook**: `docs/operations/adb-precheck-runbook.md` + `adb-precheck-snapshot-calibration.md`
> **Earlier sprint** (PLUGIN HARDENING): COMPLETE — Phone-blocklist refactor `prov_telefones_invalidos`,
>   138 phantom rows backfilled, migrations 043+044 applied. Branch `hardening/plugin-system`
>   ready for PR. 784 tests passing.

## Phase Status

| Phase | Title | Status | Started | Approved | Blocker |
|-------|-------|--------|---------|----------|---------|
| 1 | Tracer Bullet — 1 msg ponta-a-ponta | `APPROVED` | 2026-04-01 | 2026-04-01 | — |
| 2 | Multi-Device + Health Monitoring | `APPROVED` | 2026-04-02 | 2026-04-02 | — |
| 3 | Send Engine Robusto + Anti-Ban | `APPROVED` | 2026-04-02 | 2026-04-02 | — |
| 4 | WAHA Listener Passivo | `APPROVED` | 2026-04-02 | 2026-04-02 | — |
| 5 | Session Management + Inbox Automation | `APPROVED` | 2026-04-02 | 2026-04-02 | — |
| 6 | Dashboard Operacional | `APPROVED` | 2026-04-06 | 2026-04-06 | — |
| 7 | Plugin System + Plugin Oralsin | `APPROVED` | 2026-04-02 | 2026-04-02 | — |
| 8 | Multi-Profile + Hardening + Docker | `APPROVED` | 2026-04-06 | 2026-04-06 | — |
| 9.1 | Contact Registry Core (normalizer + registry + backfill) | `APPROVED` | 2026-04-17 | 2026-04-17 | 20 tests green (13 TDD + 7 post-review fixes). Code review: 0 Critical, I1/I2/I3/I5/M2/M5/M7 fixed, I4/M1/M3/M4/M6/M8 deferred with justification. 794/804 full suite (10 pre-existing unrelated) |
| 9.2 | HygieneJobRunner + jobs tables | `APPROVED` | 2026-04-17 | 2026-04-17 | 5 tests, Zod LGPD (D7), UNIQUE external_ref idempotent (D9), cancel path |
| 9.3 | Check Strategies (ADB/WAHA/Cache) | `APPROVED` | 2026-04-17 | 2026-04-17 | 11 tests, command-injection guard, error path covered |
| 9.4 | ContactValidator orchestrator | `APPROVED` | 2026-04-17 | 2026-04-17 | 5 tests, L1→L3→L2 per D2/D6/D8, WAHA tiebreaker for ambiguous DDDs |
| 9.5 | Callback types + events scaffolded | `APPROVED` | 2026-04-17 | 2026-04-17 | CallbackType union extended (number_invalid, hygiene_item, hygiene_completed); SendEngine inline pre-check deferred to 9.9 E2E wiring |
| 9.6 | REST API endpoints | `APPROVED` | 2026-04-17 | 2026-04-17 | 12 tests, /contacts/* and /hygiene/* with Zod, LGPD enforcement in hygiene route |
| 9.7 | UI integration (live fetch) | `APPROVED` | 2026-04-17 | 2026-04-17 | contacts-audit.tsx rewritten to consume /api/v1/contacts, force recheck wired |
| 9.8 | Observability + archival | `APPROVED` | 2026-04-17 | 2026-04-17 | 7 Prometheus metrics added, archiveOldChecks() with 2 tests (D11 quarterly rotation) |
| 9.9 | Phase gate + E2E wiring | `APPROVED` | 2026-04-17 | 2026-04-17 | Routes registered (server.ts), ContactRegistry+HygieneJobService instantiated on boot, L1 pre-check live in WorkerOrchestrator.processMessage, number_invalid callback wired via CallbackDelivery + event listener. 4 new integration tests passing. TypeScript clean on all new code. Full suite 833/843 (10 pre-existing unrelated) |

### Status Legend
- `READY` — Dependencies met, can start
- `IN_PROGRESS` — Active development
- `IN_REVIEW` — Code complete, under review
- `BLOCKED` — Waiting on dependency phase(s)
- `APPROVED` — Review passed, phase complete
- `FAILED_REVIEW` — Review found blocking issues, needs fixes

## Dependency Graph (Quick Reference)

```
1 → 2 → 3 → 7 (critical path)
1 → 4 → 5 → 7 (parallel track)
2 + 4 → 6 (dashboard needs both)
3 + 6 → 8 (hardening last)
```

## Phase Approval Log

| Phase | Approved At | Reviewer | Notes |
|-------|------------|----------|-------|
| 1 | 2026-04-01 | Claude Opus 4.6 + Matheus | 14/14 criteria verified, 27 tests, 2 E2E sends, grill review resolved 3 blockers, code review fixed 2 criticals |
| 2 | 2026-04-02 | Claude Opus 4.6 + Matheus | 8/8 criteria verified, 78 tests, 12 grill decisions, 8 commits, simplify fixed 10 findings, review fixed 2 criticals + 4 importants |
| 3 | 2026-04-02 | Claude Opus 4.6 + Matheus | 7/8 criteria verified, 145 tests, 18 grill decisions, 9 commits, simplify fixed 6 findings, review fixed 2 criticals + 3 importants. Temporal.io + Redis architecture. E2E: 5 rate-limited msgs on POCO Serenity |
| 4 | 2026-04-02 | Claude Opus 4.6 + Matheus | 10/10 criteria verified, 188 tests (43 new), 17 grill decisions, 7 commits, simplify fixed 6 findings, review fixed 2 criticals + 4 importants. Shared WAHA Plus GoWS, HMAC SHA-512, webhook-first, 90-day retention |
| 5 | 2026-04-02 | Claude Opus 4.6 + Matheus | 8/8 criteria verified, 231 tests (43 new), 12 grill decisions, 6 commits, simplify fixed 8 findings. Scope redefined: WAHA native handles bridge, Dispatch manages sessions + inbox automation. Shared http-utils, N+1 fix |
| 7 | 2026-04-02 | Claude Opus 4.6 + Matheus | 8/8 criteria verified, 276 tests (45 new), 18 grill decisions, 8 commits, simplify fixed 9 findings. Hub-Spoke plugin model, PluginContext sandbox, 4 contracts with real JSON, batch enqueue, HMAC callback, correlation fix. E2E: plugin enqueue → ADB send on POCO Serenity |
| 6 | 2026-04-06 | Claude Opus 4.6 + Matheus | 22/22 criteria verified, 354 tests (78 new). Improvement plan: 16 items across 4 tracks (Dashboard, Debt, UX, Hardening). Pagination+filters, Recharts metrics, audit log with timeline+CSV, responsive sidebar, toast notifications, relative timestamps |
| 8 | 2026-04-06 | Claude Opus 4.6 + Matheus | 14/14 hardening criteria verified, 354 tests. API auth (X-API-Key), CORS restricted, pino-roll log rotation, graceful shutdown, shell rate limiting, multi-device worker with health-score selection. Deferred: multi-profile, Docker, encryption |

## Phase 7 Grill Progress

See `.dev-state/phase-7-grill.md` for 18 confirmed decisions.
Grill COMPLETE. Key: scope reduced — removed Oralsin-side code (DispatchNotifier, fallback chain,
FlowStepConfig). Plugin = Hub-Spoke in-process adapter with restricted PluginContext. 4 contracts
with real JSON payloads. Batch enqueue, ordered senders[] fallback, 3 correlation gaps to fix.

## Phase 5 Grill Progress

See `.dev-state/phase-5-grill.md` for 12 confirmed decisions.
Grill COMPLETE. Key: scope redefined from "Chatwoot Bridge Bidirecional" to "Session Management +
Inbox Automation". WAHA native Chatwoot App already handles message bridging. Dispatch manages
sessions (managed flag), automates inbox creation (WAHA + Chatwoot), and provides admin UI.

## Phase 4 Grill Progress

See `.dev-state/phase-4-grill.md` for 17 confirmed decisions.
Grill COMPLETE. Key: shared WAHA Plus GoWS instance, webhook-first, HMAC auth, no session creation needed.

## Active Blockers

None.

## Deferred to Phase 3

- **Worker-per-device**: Phase 2 uses single-device worker pattern. Grill decision #1 specifies
  per-device workers, but actual multi-device send requires Phase 3's robust send engine.
- **Per-device send lock**: `engine.isProcessing` is a single boolean. Phase 3 will track
  `send_phase` per device/message for proper multi-device locking.

## Phase 3 Grill Progress

See `.dev-state/phase-3-grill.md` for 18 confirmed decisions.
Grill ✅ COMPLETE. Key: Temporal.io + Redis, signal-driven dispatcher, behavioral ban validation.

## Phase 2 Grill Progress

See `.dev-state/phase-2-grill.md` for 12 confirmed decisions.
Grill ✅ COMPLETE. All decisions resolved.

## Root Hiding Stack (Anti-Ban T3)

Configured on POCO Serenity (9b01005930533036340030832250ac):
- Magisk 28.1 + Zygisk (built-in)
- DenyList: com.whatsapp, com.whatsapp.w4b, com.google.android.gms
- PlayIntegrityFork v16 (osm0sis & chiteroman) — Play Integrity spoof at framework level
- Zygisk-Assistant v2.1.4 (snake-4) — root hiding for DenyList apps
- verifiedbootstate=orange at prop level (normal — PIF spoofs at Java level)
- WhatsApp running post-install, PID confirmed

## Test Configuration

```
TEST_PHONE_NUMBER=5543991938235
DEVICE_SERIAL=9b01005930533036340030832250ac  (POCO Serenity)
```

## Session Notes

- 2026-04-01: Project created. PRD, plan, and 8 GitHub issues ready.
  ADB validated on POCO Serenity. Bloatware removed. Device healthy.
  Ready to scaffold Turborepo and start Phase 1.
- 2026-04-01: Phase 1 started. Turborepo scaffolded with pnpm workspaces.
  packages/core (Fastify+SQLite+adbkit), packages/ui (Vite+React+Tailwind),
  packages/electron (Electron shell). All deps installed, core starts on :7890,
  UI starts on :5173, vitest runs. Used @devicefarmer/adbkit (fork of adbkit).
- 2026-04-01: Phase 1 implementation complete. All modules: ADB Bridge, Message Queue
  (SQLite WAL + BEGIN IMMEDIATE), Send Engine (char-by-char typing), REST API, Socket.IO,
  UI (React), Electron shell. E2E validated on POCO Serenity. 27 tests passing.
  Grill review: added worker loop (auto 5s + manual endpoint), error handling (try-catch
  + failed status), contacts table (dedup). Code review: fixed command injection (digits-only
  validation), worker race condition (workerRunning guard), manual send locking (dequeue path).
  Ready for Phase Gate.
- 2026-04-01/02: Phase 2 grill started. 9 decisions confirmed (worker-per-device, send_phase
  tracking, 7-day health retention, root WA mapper, 4 profiles×2 apps, senderNumber obrigatório,
  plugin-owned distribution, auto-resolve alerts, sequential profile switching for Phase 2).
  MUMD research: tested scrcpy virtual displays + config_multiuserVisibleBackgroundUsers.
  Confirmed MUMD requires root (Phase 8). Profile map documented for 4 WA numbers.
  Root/unlock deferred as separate task — Phase 2 proceeds with profile batching.
- 2026-04-02: Phase 2 grill completed (12/12 decisions). Resolved: alert thresholds (global
  defaults + per-device JSON override, 8 thresholds), device actions safety (send-lock guard
  + "Você tem certeza?" confirmation), UI hierarchy (3-level: device grid → detail → account,
  Phase 2 implements levels 1-2, scales to 50+ devices). Phase 2 status → IN_PROGRESS.
- 2026-04-02: Phase 2 TDD Red complete. 4 test files (monitor/): device-manager (10 tests),
  health-collector (9 tests), wa-account-mapper (9 tests), alert-system (14 tests). All fail
  (modules not implemented). Types file + DispatchEmitter updated with device:health, alert:new.
  Existing 26 tests still pass.
- 2026-04-02: Phase 2 implementation complete. 4 core modules (DeviceManager, HealthCollector,
  WaAccountMapper, AlertSystem) + monitor API routes + server integration (polling loops) +
  UI (DeviceGrid, DeviceDetail w/ Recharts spark charts, AlertPanel) + device actions
  (screenshot, reboot, restart-wa with send-lock guard + confirmation).
  78/78 tests passing. E2E: POCO Serenity detected online, health metrics (100% battery,
  25.6°C, 1163MB RAM, 38GB storage), WA+WABA on profiles 0 and 10, monitor API endpoints
  verified. Screenshot proof: reports/phase-2-e2e-20260402-120315.png.
- 2026-04-02: Phase 3 started. Grill complete (18 decisions). Major architectural shift:
  Temporal.io for workflow orchestration (everywhere, including Electron embedded), Redis for
  hot state (rate limits, volume counters, send phase, cooldowns). Central Dispatcher as
  signal-driven Temporal Workflow (zero polling). Per-number rate limits, per-device serial
  execution. Ban detection: post-send OCR + behavioral validation (wa.me intent) + UIAutomator
  countdown extraction. Retry: 5 attempts, exponential backoff (30s-480s). Auto-recovery:
  UIAutomator + pidof crash detection. Jitter: 0.8-1.5x on scaled_delay (floor 20s, cap 300s).
  See `.dev-state/phase-3-grill.md` for full decisions.
- 2026-04-02: Phase 4 started. Grill complete (17 decisions). Explored WAHA production
  server (37.27.210.137): WAHA Plus GoWS 2026.3.1, 136 existing sessions, Traefik v2.11,
  Redis+Postgres. Key: Dispatch does NOT create sessions (already exist), adds webhook to
  existing ones. HMAC SHA-512 per-session. message.any + session.status + message.ack events.
  Dedup outgoing by to_number + ±30s window. Media download to local filesystem (StorageAdapter
  for future S3). 90-day retention. Webhook-first + gap-fill on reconnect (no periodic polling).
  Independence: WAHA ban ≠ ADB ban. Auto-restart failed sessions via API.
  See `.dev-state/phase-4-grill.md` for full decisions.
- 2026-04-02: Phase 4 implementation complete. 5 modules: MessageHistory (SQLite, CRUD,
  dedup, 90-day cleanup), SessionManager (discover, health check, webhook config, backoff
  5s-80s 5x max), WebhookHandler (HMAC SHA-512 timing-safe, message.any/session.status/
  message.ack processing, dedup), WahaHttpClient (fetch + res.ok guards), API routes
  (6 endpoints, Zod validation, preParsing raw body for HMAC). 188 tests passing (43 new).
  Simplify: fixed 6 findings (HMAC raw body, res.ok guards, SQL params, sargable dedup).
  Review: fixed 4 findings (HMAC enforcement, Zod validation, dead code, restart backoff).
  E2E: webhook receiver processes outgoing+incoming, message_history persists correctly.
- 2026-04-02: Phase 5 started. Grill complete (12 decisions). MAJOR SCOPE CHANGE: renamed from
  "Chatwoot Bridge Bidirecional" to "Session Management + Inbox Automation". WAHA Plus already
  has native Chatwoot App integration (chat.debt.com.br, v4.11.0, account_id=1, same server
  37.27.210.137). 8 oralsin_* sessions already connected to Chatwoot inboxes (1:1). Incoming
  and outgoing bridging NOT needed — WAHA native handles it. Operator replies continue via
  WAHA native. New scope: managed_sessions table (separate from whatsapp_accounts), Chatwoot
  HTTP client, inbox creation automation (WAHA + Chatwoot in one flow), QR code display via
  Socket.IO, admin UI in Electron. Credentials: CHATWOOT_API_TOKEN env var.
  See `.dev-state/phase-5-grill.md` for full decisions.
- 2026-04-02: Phase 7 started. Grill complete (18 decisions). SCOPE CHANGE: removed Oralsin-side
  code (DispatchNotifier, FlowStepConfig, fallback chain ADB→WAHA→SMS) — all Oralsin business logic.
  Plugin model: Hub-Spoke, in-process adapter with restricted PluginContext (no ADB access).
  4 contracts defined with real JSON: request (batch enqueue), callback (result), ACK webhook,
  response webhook. Sender fallback via ordered senders[] array with roles. Batch enqueue with
  bulk insert. Context as pass-through opaque JSON. Send options: global defaults + per-message
  override (max_retries, priority only). Auth: API key + HMAC via env vars. Plugin discovery via
  dispatch.config.json. 3 correlation gaps identified (adb_send history insert, waha_message_id
  linkage) — to be fixed in Phase 7. Admin API for plugin management.
  See `.dev-state/phase-7-grill.md` for full decisions.
- 2026-04-02: Phase 7 implementation complete. 6 modules: PluginRegistry (SQLite CRUD, upsert,
  admin API), PluginEventBus (dispatch, isolation, 5s timeout, listener cleanup), CallbackDelivery
  (HMAC SHA-256, 3 retries, failed_callbacks), PluginLoader (lifecycle, PluginContext sandbox,
  generic route registration, pino logger), OralsinPlugin (Zod validation, batch enqueue, 3 routes),
  correlation fix (adb_send insert, waha_message_id linkage, ACK event). Queue extended with 6 new
  fields. 276 tests (45 new). Simplify: fixed 9 findings (listener leak, dead code, generic routes,
  guarded callbacks, pino logger, single query stats, union types). E2E: plugin enqueue → ADB send
  to 5543991938235 → delivered (screenshot proof). 7 commits.
- 2026-05-13: Geolocalização (plugin-first) shipped. Tab "Geolocalização" no sidebar dispara mapa do
  BR (deck.gl GeoJsonLayer choropleth, base map=null) com heatmap por DDD + drill modal.
  **Constraint plugin-first respeitada**: core fornece registry/topology/endpoints genéricos; plugins
  contribuem views via `ctx.registerGeoView(...)` — core sem plugins retorna `{views:[]}`+EmptyState UI.
  4 views no MVP: `oralsin.sends` + `adb-precheck.{no-match, valid, pipedrive-mapped}`.
  Backend: GeoViewRegistry (LRU 60s, timeout 5s/8s), 3 endpoints REST genéricos, 3 índices DDD
  expressionais. Frontend lazy-loaded (215KB gz chunk separado).
  Audit findings: schemas confirmados antes do TDD; em prod, smoke surfou bug onde pipedrive-mapped
  bucketava tudo em DDD '55' — primary_valid_phone tem 11 OU 13 dígitos; SQL agora strip 55 com CASE
  condicional. Segundo bug: composite PK em adb_precheck_deals (sem col `id`) → drill 503 → fixado.
  Tests: 1893/1893 (10 novos no geo). 20 commits, deploy em Kali via SSH (HEAD `71405370`).
  Topology source: gist guilhermeprokisch (67 DDDs, license ainda open — follow-up).
  Aba "global" cross-plugin deferida: implementável como plugin separado sem mudar contract.
  Specs: `docs/superpowers/specs/2026-05-14-geolocation-plugin-contract-design.md`
  Plan: `docs/superpowers/plans/2026-05-14-geolocation-plugin-contract-plan.md`
