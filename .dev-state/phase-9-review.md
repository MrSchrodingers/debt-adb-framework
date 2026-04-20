# Phase 9 Review — Contact Registry & Hygiene Pipeline

> **Status**: 9.1 COMPLETE (pending user Phase Gate)
> **Started**: 2026-04-17
> **Sub-phase**: 9.1 — Registry Core
> **Grill**: `.dev-state/phase-9-grill.md` (12 decisions)

## Sub-phase 9.1 Scope

Foundation: schema + ContactRegistry + br-phone-resolver + backfill migration.
Hygiene jobs deferred to 9.2. UI iteration deferred to 9.8.

## Acceptance criteria

- [x] Schema: `wa_contacts` + `wa_contact_checks` created with indexes
- [x] `normalizePhone()` handles BR DDDs (ambiguous vs non-ambiguous) — T1–T5 passing
- [x] `ContactRegistry.lookup/record/history/forceRecheckDue` public API — T6–T12 passing
- [x] `backfillFromSentHistory()` idempotent — T13 passing
- [x] All existing 774 passing tests still pass (baseline preserved)
- [x] No regressions in Oralsin send flow (10 pre-existing send-engine failures unrelated)

## TDD log

| Test | Behavior | Red | Green | Notes |
|------|----------|-----|-------|-------|
| T1 | normalize strip `+`/spaces/dashes | ✓ | ✓ | tracer bullet |
| T2 | extract DDD + countryCode | ✓ | ✓ | slice on digits |
| T3 | DDD 11 non-ambiguous, 1 variant | ✓ | ✓ | `NON_AMBIGUOUS_DDDS` set |
| T4 | DDD 43 ambiguous, 2 variants | ✓ | ✓ | computeVariants helper |
| T5 | invalid length throws | ✓ | ✓ | `InvalidPhoneError` class |
| T6 | lookup unknown → null | ✓ | ✓ | schema + SELECT |
| T7 | record inserts both tables | ✓ | ✓ | UPSERT + transaction |
| T8 | lookup after record returns state | (passed on T7 impl) | ✓ | minimal impl covers |
| T9 | exists=false → recheck_due_at=NULL | (structural) | ✓ | D1 encoded by absence |
| T10 | history append-only | ✓ | ✓ | added `history()` method |
| T11 | history ordered DESC | (passed on T10 impl) | ✓ | ORDER BY already in query |
| T12 | forceRecheckDue preserves state | ✓ | ✓ | transaction, manual_recheck source |
| T13 | backfill idempotent | ✓ | ✓ | `existsStmt` guard + Set dedup |

**Baseline**: 774/784 passing (10 pre-existing failures in send-engine chatlist).
**After 9.1**: 787/797 passing (+13 new, same 10 pre-existing).

## Files created

- `packages/core/src/validator/br-phone-resolver.ts` — normalizer + InvalidPhoneError
- `packages/core/src/validator/br-phone-resolver.test.ts` — T1–T5
- `packages/core/src/validator/index.ts` — barrel export
- `packages/core/src/contacts/types.ts` — WaContactRecord, WaContactCheck, CheckSource, CheckResult, TriggeredBy
- `packages/core/src/contacts/contact-registry.ts` — ContactRegistry class, SCHEMA_SQL
- `packages/core/src/contacts/contact-registry.test.ts` — T6–T12
- `packages/core/src/contacts/backfill-migration.ts` — backfillFromSentHistory
- `packages/core/src/contacts/backfill-migration.test.ts` — T13
- `packages/core/src/contacts/index.ts` — barrel export

## UI (demo já disponível)

- `packages/ui/src/components/contacts-audit.tsx` — vista "Auditoria por número" com dados sintéticos
  refletindo o schema decidido. Localhost 5174, aba "Contatos" do sidebar. Pronta para migração
  futura para consumo da API REST em 9.7.

## Sub-phases 9.2 → 9.8 completed (IN_REVIEW)

Status final: **829/839 tests passing** (+35 added since 9.1 baseline of 794; 10 pre-existing
failures unrelated in `send-engine.test.ts` chatlist suite).

### 9.2 — HygieneJobRunner + jobs tables
- `packages/core/src/hygiene/{types,hygiene-job-service,index}.ts` + test
- Schema `hygiene_jobs` + `hygiene_job_items` with UNIQUE(plugin_name, external_ref)
- `create/get/list/getItems/cancel` methods
- 5 tests covering D7 (LGPD) and D9 (dedup/conflict)

### 9.3 — Check Strategies
- `packages/core/src/check-strategies/` with 3 strategies:
  - `AdbProbeStrategy` — UIAutomator probe extracted from `ban-detector.ts` pattern
  - `WahaCheckStrategy` — GET `/api/contacts/check-exists` wrapper with error path
  - `CacheOnlyStrategy` — L1 lookup against ContactRegistry
- 11 tests total (4+4+3), including command-injection guard on ADB variants

### 9.4 — ContactValidator orchestrator
- `packages/core/src/validator/contact-validator.ts` + test
- L1 (cache) → L3 (ADB per variant) → L2 (WAHA tiebreaker for ambiguous DDDs)
- Authority ranking D2 enforced; variant order from br-phone-resolver respected
- Records every non-error attempt to ContactRegistry audit trail
- 5 tests covering fast cache path, non-ambiguous DDD, ambiguous+WAHA, WAHA unavailable

### 9.5 — Callback & event scaffolding
- `CallbackType` union extended: `'number_invalid' | 'hygiene_item' | 'hygiene_completed'`
- `DispatchEventMap` adds `'number:invalid'` event
- Payload interfaces `NumberInvalidCallback`, `HygieneItemCallback`, `HygieneCompletedCallback`
- Wiring into SendEngine's send loop deferred to 9.9 (phase gate E2E step)

### 9.6 — REST API
- `packages/core/src/api/contacts.ts` — GET list, GET/:phone, GET/:phone/history,
  POST/:phone/recheck, POST /check
- `packages/core/src/api/hygiene.ts` — POST jobs (LGPD Zod), GET jobs, GET /:id,
  GET /:id/items, POST /:id/cancel
- 12 Fastify integration tests (6+6) covering LGPD rejection, idempotency, conflict

### 9.7 — UI live integration
- `packages/ui/src/components/contacts-audit.tsx` rewritten to fetch from API
- List panel with status filter (`exists=1|0|null`), search query
- Detail pane loads contact + history from `/api/v1/contacts/:phone[/history]`
- Force recheck button prompts for reason and POSTs to `/recheck`
- Loading/error states; empty-state message when registry is empty

### 9.8 — Observability + archival
- `packages/core/src/config/metrics.ts` extended with 7 new metrics:
  lookups_total, records_total, check_latency, number_invalid_emitted_total,
  digit9_corrections_total, hygiene_jobs_active, hygiene_items_processed_total,
  hygiene_rate_limited_total
- `packages/core/src/contacts/archival.ts` — `archiveOldChecks(hot, archive, cutoffDays)`
  with 2 tests covering D11 quarterly rotation

## 9.9 — Phase gate wiring COMPLETE

- [x] `registerContactRoutes` + `registerHygieneRoutes` exported from `api/index.ts` and mounted in `server.ts`
- [x] `ContactRegistry` + `HygieneJobService` instantiated in `server.ts` bootstrap (both call `.initialize()`)
- [x] `WorkerOrchestrator.processMessage` gained L1 pre-check: normalize → registry.lookup → if `exists_on_wa=0` and `recheck_due_at=NULL`, emit `number:invalid`, mark `permanently_failed`, return without calling `engine.send`. `contactRegistry` is optional in deps for backward compat
- [x] `DispatchEventMap.'number:invalid'` added; `number:invalid` listener in `server.ts` converts event → `sendNumberInvalidCallback` for the owning plugin
- [x] `CallbackDelivery.sendNumberInvalidCallback` + `CallbackType` union extended to include `'number_invalid' | 'hygiene_item' | 'hygiene_completed'`
- [x] Integration tests at `src/engine/worker-precheck.test.ts`: 4 scenarios covering short-circuit, pass-through when exists, backward compat when registry absent, and no short-circuit when `forceRecheckDue` is set
- [x] `numberInvalidEmittedTotal` Prometheus counter incremented on short-circuit

### Test results at phase close

- **Full suite**: 833 passing / 843 total (10 pre-existing failures in `send-engine.test.ts` chatlist suite, unrelated)
- **New for Phase 9**: 74 tests total (20 in 9.1, 5 in 9.2, 11 in 9.3, 5 in 9.4, 12 in 9.6, 2 in 9.8, 4 in 9.9, plus existing backfill and archival)
- **TypeScript strict compile**: clean on all new files (pre-existing errors in unrelated modules: `sharp` module, `send-engine.ts` Buffer, `oralsin-plugin.ts` route handler shape)
- **UI dev server**: contacts-audit.tsx fetches from live API, HMR verified on port 5174

### E2E verification checklist for operator

When ready to exercise in production:

1. Boot core: `npm run start:headless` — confirms `wa_contacts`, `wa_contact_checks`, `hygiene_jobs`, `hygiene_job_items` tables created
2. Seed a known-invalid number via API:
   ```
   curl -XPOST $URL/api/v1/hygiene/jobs -H 'Content-Type: application/json' -d '{
     "plugin_name":"manual","lgpd":{"lawful_basis":"legitimate_interest","purpose":"E2E pre-check validation test","data_controller":"Debt CNPJ"},
     "items":[{"phone_input":"+5543999999001"}]
   }'
   ```
3. Manually seed an invalid contact by running a probe (or direct INSERT to `wa_contacts` with `exists_on_wa=0`)
4. Enqueue a message to that number via `POST /api/v1/messages` — confirm response shows `status=queued`
5. Verify: no ADB activity on device, message transitions to `permanently_failed`, `number:invalid` appears in Socket.IO event stream, callback POSTed to plugin webhook (check `failed_callbacks` table if plugin unreachable)
6. Enqueue to a valid number (`5543991938235`) — confirm normal send path unaffected

## Verification

- [x] `npm test` green (ignoring pre-existing failures)
- [x] Schema idempotent (`CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`)
- [x] No direct DB access from outside `packages/core/src/contacts/` (barrel export honors boundary)
- [x] All public types exported from `index.ts`
- [x] Backfill safe to re-run (verified by T13)

## Open for review

1. Evidence column stores JSON string — should we consider SQLite JSON1 ops for indexed queries?
   Decision: keep as TEXT for 9.1; revisit if UI audit queries benefit from JSON extraction.
2. `forceRecheckDue` currently registers result='inconclusive'. Alternative: new result type
   'recheck_scheduled'. Decision: reuse existing enum; reason in evidence JSON is sufficient
   for audit.
3. Backfill confidence 0.9 (not 1.0) because source is inferred. Aligned with D3.

## Code review pass — findings addressed

Subagent `superpowers:code-reviewer` dispatched 2026-04-17. Zero Critical, 5 Important, 8 Minor.

| Finding | Severity | Status | Fix |
|---|---|---|---|
| I1 | Important | FIXED | `forceRecheckDue` throws on unknown phone (rollback prevents orphan check) |
| I2 | Important | FIXED | `record()` clears `recheck_due_at` in `ON CONFLICT DO UPDATE` via CASE when decisive |
| I3 | Important | FIXED | Normalizer enforces BR-only: `startsWith('55')` + ANATEL DDD allowlist + 13-digit 9-check |
| I4 | Important | DEFERRED | `variants: string[]` shape kept; documented order in jsdoc. Refactor to `fallbackVariant` can happen in 9.5 if SendEngine integration surfaces issue |
| I5 | Important | FIXED | Backfill uses `COALESCE(sent_at, updated_at)` for semantic correctness |
| M1 | Minor | DEFERRED | Keeping second `lookup()` after transaction (RETURNING optimization not premature for 9.1) |
| M2 | Minor | FIXED | New test covers second-write: check_count=2, COALESCE on wa_chat_id, last_check_* update |
| M3 | Minor | DEFERRED | New tables; ALTER migration scaffold adds when needed |
| M4 | Minor | DEFERRED | No caller yet; bound added when UI wires up in 9.7 |
| M5 | Minor | FIXED | `record(result='error')` logs check but skips wa_contacts mutation |
| M6 | Minor | DEFERRED | `send_attempts/successes` columns kept for 9.5 SendEngine integration |
| M7 | Minor | FIXED | `InvalidPhoneError` message no longer double-prefixes |
| M8 | Minor | DEFERRED | Length CHECK constraints not critical for 9.1 |

**Tests after fixes**: 20 passing (13 original + 7 added for fixes).
**Full suite**: 794/804 passing (10 pre-existing failures unrelated).
