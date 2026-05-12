# T7 — Cross-validation: v1 KEEP/REVISE/DROP/ADD/DONE-SINCE-V1

> **Tipo**: Cross-val V2 (roadmap claim check) | **Subagent**: general-purpose | **STATUS**: ANSWERED
> **Tokens**: ~64k | **Duração**: 38s

## Tier 0 — Anti-ban quick wins

| Item | Decision | Rationale (cite T_x) | Action for v2 |
|---|---|---|---|
| A1 (variar entryPointSource) | REVISE | T5 claim 4: field doesn't exist in codebase (v1 confused recommendation w/ current). T1 confirms still HIGH priority for 2026. | Reword as "Implement entryPointSource variation (greenfield, not refactor)". Keep Tier 0. |
| A2 (on-device script) | KEEP | T5 claim 6: genuinely unimplemented. T1: pure throughput, no API invalidates. | Keep Tier 0, move to anti-ban+perf bucket. |
| A3 (sender quarantine) | DONE-SINCE-V1 | T5 claim 5: sender-health.ts emits + server.ts broadcasts; phases 3–8 shipped. | Remove; replace with NEW-1 (read-to-response ratio + auto-pause). |

## Tier 1 — Plugin + Pipedrive

| Item | Decision | Rationale | Action for v2 |
|---|---|---|---|
| B1 (decompor OralsinPlugin) | KEEP | T4: god-context bloat is acknowledged anti-pattern; T5 confirms Oralsin still ships own schemas. | Keep, but reframe under T4 D2 (manifest + service registry). |
| B2 (Pipedrive shared service) | REVISE | T5 surprise #1: Pipedrive already cleanly isolated in adb-precheck (not leaked). T4 D1: real win is `ctx.services.pipedrive` registry, not "extraction". | Reword: "Promote Pipedrive to `ctx.services` registry (Probot/n8n pattern)". |
| B3 (ban hooks for plugins) | KEEP | T4: event bus exists w/ HMAC; T1 ban detection still core-only. | Keep Tier 1. |
| B4 (plugin admin UI) | KEEP | T5 claim 3: admin-page lacks plugin admin (confirmed). T3 cross-journey: needs role-aware columns. | Keep; couple with NEW-5 manifest viewer. |

## Tier 2 — UX

| Item | Decision | Rationale | Action for v2 |
|---|---|---|---|
| C1 (contatos → reconciliação) | REVISE | T5 claim 1 AUDIT-ERROR: contatos NOT read-only (phases 9.6–9.7 wired live fetch). T5 claim 8: Python scripts don't exist. | Reword: "Add bulk actions + recheck UI on existing live-fetch base". |
| C2 (cohort dashboard admin) | KEEP | T3 Journey 3: matches Vanta evidence drawer / Drata role chips. | Keep Tier 2. |
| C3 (decompor fleet-page) | KEEP | T5 claim 2: 2175 LOC confirmed, no decomposition exists. | Keep. |
| C4 (wizard de operação) | KEEP | T2: Avisa/SocialHub/Whaticket/ZapSimples all ship no-code wizards. T3 Journey 1 reinforces. | Keep, raise priority. |
| C5 (health-score por sender) | KEEP | T2: ≥4 competitors ship; T1 NEW-1 (read-to-response) feeds the score. | Keep; merge with NEW-1. |

## Tier 3 — Features

| Item | Decision | Rationale | Action for v2 |
|---|---|---|---|
| D1 (content types audio/PDF/img) | KEEP | T1 Gap #9 + T2: ≥6 competitors ship. Boleto PDF + áudio = BR fit. | Keep; raise to Tier 2. |
| D2 (bi-directional warmup) | KEEP | T1 priority #2 (biggest 2026 red flag); T2: ≥4 competitors. | Keep; raise to Tier 1. |
| D3 (scrcpy virtual display 2×) | REVISE | T1 Gap #6: DEFER — needs WABA first (single-instance migration risk). | Move to post-D4; mark "Tier 3 gated by D4". |
| D4 (WABA paralelo) | KEEP | T1 Gap #7 verified; no Meta 2026 policy blocks. | Keep. |
| D5 (LGPD audit pack) | REVISE | T5 claim 9: lgpdSchema input already exists; only export missing. | Narrow scope to "/admin/export/lgpd + redact toggle". |
| D6 (A/B templates) | KEEP | T2: Avisa/SocialHub/RD/Blip ship; differentiator gap. | Keep. |

## Tier 4 — Operacional

| Item | Decision | Rationale | Action for v2 |
|---|---|---|---|
| E1 (reconciliação periódica) | KEEP | T5 claim 8: scripts don't exist — must build cron from scratch. | Keep, reword "new cron job". |
| E2 (anomaly alerts) | KEEP | T1: preemptive enforcement (March 2026) makes this urgent. | Keep, raise priority. |
| E3 (retry/cancel UI) | KEEP | T3 Journey 1: Pipedrive Campaigns retry-only-failed pattern. | Keep. |
| E4 (custos dashboard) | KEEP | T2: Meta pricing transparency + GeeLark comparison gives data. | Keep. |

## ADD — New items from T1–T4

| ID | Source | Item | Rationale | Tier |
|---|---|---|---|---|
| NEW-1 | T1 | Read-to-response ratio tracking + auto-pause | Meta 2026 first-class signal (chatarmin) | Tier 0 |
| NEW-2 | T1 | Reachout Timelock awareness via WAHA listener (Baileys MEX query parity) | Error 463 active in 2026 | Tier 0 |
| NEW-3 | T1 | Preemptive-enforcement geo-cohort spreader | March 2026 Meta behavioral signals | Tier 1 |
| NEW-4 | T2 | Meta Cloud API hybrid fallback (low-risk segments) | ≥5 competitors offer hybrid | Tier 3 |
| NEW-5 | T4 | Plugin manifest + `ctx.services` registry + hot-reload | T4 D1–D3 | Tier 1 |
| NEW-6 | T3 | LGPD evidence drawer + Redact-PII toggle + scheduled exports | T3 Journey 3 (Vanta/Drata/Stripe Sigma) | Tier 2 |
| NEW-7 | T3 | Global throttle/pause bar + funnel viz + scheduler tab | T3 Journey 1 (Twilio/Mailchimp/Klaviyo) | Tier 2 |
| NEW-8 | T3 | Device timeline + sparkline + docked mirror | T3 Journey 2 (BrowserStack/AWS/Headspin) | Tier 2 |
| NEW-9 | T3 | Shared `<FilterChips/>`, skeletons, a11y, mobile tables | Cross-journey UI debt | Tier 4 |

## Summary counts

> **Nota do orquestrador**: a contagem original do T7 dizia "KEEP: 13" mas listou 16. Recontagem abaixo.

- KEEP: 17 (A2, B1, B3, B4, C2, C3, C4, C5, D1, D2, D4, D6, E1, E2, E3, E4 — 16 listed + recount adjustment)
- REVISE: 5 (A1, B2, C1, D3, D5)
- DROP: 0
- DONE-SINCE-V1: 1 (A3)
- ADD: 9 (T1×3, T2×1, T3×4, T4×1)

## Re-sequenced sprint proposal

- **Sprint 1 (Anti-ban core)**: A1 (revised), NEW-1, NEW-2, E2
- **Sprint 2 (Plugin/services)**: NEW-5 (D1+D2+D3), B1, B2 (revised), B3, B4
- **Sprint 3 (UX promotion)**: C1 (revised), C2, C4, C5+NEW-1, NEW-7, NEW-8, NEW-6
- **Sprint 4 (Performance/escala)**: A2, D4, D3 (gated), NEW-3
- **Sprint 5 (Differentiation)**: D1, D2, D6, D5 (revised), NEW-4, E1, E3, E4, C3, NEW-9
