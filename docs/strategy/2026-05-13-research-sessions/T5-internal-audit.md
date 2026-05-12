# T5 — Internal Codebase Audit

> **Tipo**: Validação de claims (5-category framework) | **Subagent**: Explore (very thorough) | **STATUS**: ANSWERED

## Claims Verification (1-10)

1. **FALSE** — Claim: `contatos` tab is 528 lines AND read-only AND endpoints unused. Reality: `contacts-audit.tsx` is 528 lines (✓ line count correct), BUT it is NOT read-only. It fetches from `/api/v1/contacts/*` endpoints (line 148, 168-169) that ARE actively implemented and used. Progress.md documents that phases 9.6-9.7 (approved 2026-04-17) added REST endpoints + live fetch integration (contacts-audit.tsx rewritten with live fetch + force recheck). The v1 roadmap claim that endpoints exist but are "unused" is an AUDIT-ERROR—they were already integrated 25 days before v1 was written.

2. **VERIFIED** — Claim: `fleet-page.tsx` is 2175 lines. Actual count confirms 2175 LOC. No partial decomposers exist yet (`fleet-*` subdirectory search returns empty). The component remains monolithic as of HEAD, matching v1's assessment of over-engineering.

3. **PARTIAL** — Claim: `admin-page.tsx` is 485 lines and contains dead-letter callbacks, banned numbers, sender controls. Confirmed LOC: 485 (correct). Contains DeadLetterPanel, BannedNumbersPanel (evidenced by import statements line 2). However, v1's statement that admin is "limitado" is accurate—it notably lacks plugin admin UI, cohort dashboard, and job history, as v1 itself documents (docs:§5 C2/C4 gaps).

4. **FALSE** — Claim: `entryPointSource=click_to_chat_link` in 100% of sends. Searched extensively; NO "entryPointSource" field found anywhere in codebase. The deepLink construction at send-engine.ts:230 uses only `wa.me?text=` (read-only wa.me intent), no entryPointSource metadata. Either v1 is referencing dead code from research docs, or this is a misinterpretation of the research (which RECOMMENDS varying entryPointSource as Gap #1, not that it currently exists).

5. **DONE-SINCE-V1** — Claim: "`sender:quarantined` socket event exists but engine does NOT emit it." Counter-evidence: sender-health.ts DOES emit this event (confirmed grep). Event type defined in dispatch-emitter.ts, emitted in sender-health.test.ts and sender-health.ts, listened to in server.ts:emit broadcast, and wired in App.tsx socket handler. This was resolved by phases 3-8 before v1 was drafted.

6. **VERIFIED** — Claim: On-device script (`/data/local/tmp/send.sh`) feature search. Found NO stub, dead code, or implementation. Only references are in documentation (research-consolidated-findings.md, research-throughput-parallelism.md, v1 roadmap itself). Feature is genuinely unimplemented as future work.

7. **VERIFIED** — Claim: Pipedrive client lives ONLY in plugins/adb-precheck/. Confirmed: 5 pipedrive-*.ts files found exclusively in `/packages/core/src/plugins/adb-precheck/` (pipedrive-{api, client, formatter, publisher, activity-store}.ts + tests). Total: 10 files, 4340 LOC. No Pipedrive code in packages/core root or elsewhere.

8. **VERIFIED** — Claim: Python scripts (`resolve_no_match.py`, `tombstone_deleted.py`, `rescan_active_stale.py`) don't exist. Exhaustive search returns no .py files in repo or `.dev-state/restoration-2026-05-07/`. v1 roadmap says these 3 scripts exist as manual workarounds (§3:100), but they are missing from the codebase entirely. This appears to be aspirational documentation—v1 suggests migrating them to UI, but they don't appear to exist yet.

9. **PARTIAL** — Claim: LGPD export infrastructure. Found `lgpdSchema`, lawfulBasisSchema in api/hygiene.ts:6-12. LGPD fields are Zod-validated (lawful_basis, purpose, data_controller) and stored in hygiene jobs. However, NO `/admin/export/lgpd` or `/audit/export` endpoints exist. LGPD data is captured at creation time (input validation) but export/right-to-be-forgotten routes are not implemented—this matches v1's Tier 3 D5 (future roadmap).

10. **VERIFIED** — Claim: `aggregatePhoneStatsTruth` treats tombstoned as inclusive. Function found at job-store.ts:440. Logic: sums outcomes (valid/invalid/error) across all rows in phones_json without filtering deleted_at. Commit 7b0b593a (git show confirms) added `tombstoned` as separate bucket and updated semantics so tombstoned deals no longer count toward "with_valid" — BUT that commit post-dates v1 draft (7b0b593a is 2026-05-12 10:26 UTC, v1 written same day). The function truth-set behavior at HEAD now correctly excludes tombstoned per the commit message ("tombstoned reachable-by-phone deals no longer count").

## DONE-SINCE-V1 Items (consolidated)

- **Claim 1** (contatos tab read-only, endpoints unused) → phases 9.6–9.7 approved 2026-04-17 implemented REST `/api/v1/contacts/*` + contacts-audit.tsx live fetch integration (progress.md lines 38–39)
- **Claim 5** (`sender:quarantined` event exists but not emitted) → phases 3–8 implemented full quarantine flow including sender-health.ts emitter + server.ts socket broadcast (progress.md)

## AUDIT-ERROR Items (consolidated)

- **Claim 1** — v1 claims endpoints exist but "unused"; counter-evidence: phases 9.6–9.7 already wired them 25 days before v1 draft (progress.md 2026-04-17 approval timestamps)
- **Claim 4** — v1 claims `entryPointSource=click_to_chat_link` exists in 100% of sends; counter-evidence: no entryPointSource field found anywhere in send-engine.ts or codebase. v1 confuses research RECOMMENDATION (Gap #1) with current state.

## Surprising Discoveries

- **Pipedrive in plugins only (NOT services)**: Contrary to v1's suggestion (§5 B2) to "extract Pipedrive to shared services", it already lives cleanly isolated in `packages/core/src/plugins/adb-precheck/` with 5 dedicated modules. No leakage into core.
- **LGPD validation lands in v1 roadmap but not yet exported**: Hygiene routes validate LGPD lawful_basis/purpose/data_controller at job creation (api/hygiene.ts), but `/admin/export/lgpd` endpoint is listed as Tier 3 D5 future work—currently input-only.
- **Python reconciliation scripts are purely aspirational**: v1 (§3:100) treats `resolve_no_match.py`, `tombstone_deleted.py`, `rescan_active_stale.py` as existing workarounds, but they don't appear anywhere. This suggests v1 may have based roadmap on user complaints/workarounds described verbally rather than actual codebase audit.
- **Commit 7b0b593a landed same day as v1 draft**: Tombstone semantics commit timestamp (2026-05-12 10:26) is within 24h of v1 draft (2026-05-12), suggesting v1 was written before final phase merge or picked up stale copy of function behavior.
- **No fleet component decomposition yet**: Despite v1's callout that fleet-page.tsx (2175 LOC) is "over-engineered", no partial refactor exists (no `fleet-*` subcomponents folder). Opportunity open.

## Repo Scale Snapshot

- **packages/core**: 34,602 LOC (source .ts files, excl. tests), 180 .ts modules
- **packages/ui**: 17,872 LOC (source .tsx files), 49 .tsx components
- **packages/core/src/plugins**: 8,566 LOC (source), 22 .ts files (mostly adb-precheck)
- **Pipedrive (adb-precheck only)**: 10 files (5 source + 5 test), 4,340 LOC total
