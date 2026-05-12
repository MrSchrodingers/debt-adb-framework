# T6 — Cross-validation: Divergences, Confluences, Gaps

> **Tipo**: Cross-val V1 | **Subagent**: general-purpose | **STATUS**: ANSWERED
> **Tokens**: ~52k | **Duração**: 35s

## Confluências de alta confiança

- **C1** — Bi-directional warmup is the #1 gap — T1 (Gap #10, top-3 priority), T2 (advertised by ProtectZap, MaturaGo, WAWarmer, WMI), T3 implicit (no scheduler/heatmap). Implication: v2 must ship a warmup orchestrator; mature SaaS recipe exists.
- **C2** — Multi-content (audio/PDF/sticker) is a real moat-gap, not paranoia — T1 (Gap #9, behavioral signal), T2 (≥6 competitors advertise it), T3 (no media UI in oralsin-messages). Implication: text-only is both a market and ban-risk gap; v2 must add at minimum audio+PDF for boleto use-case.
- **C3** — Quality-score / quarantine surfacing is converging consensus — T1 (Gap #8 top priority), T2 (4 competitors advertise quality-score), T3 (no global throttle/pause bar), T5 (event already emitted). Implication: backend work is done; v2 is mostly UX wiring + auto-pause policy.

## Conflitos

- **Cx1** — T4-D1 recommends moving Pipedrive into `ctx.services` shared registry / T5 finds Pipedrive already cleanly isolated in `plugins/adb-precheck/` with no leakage. Resolution: D1 is still valid for FUTURE plugins (salesforce/hubspot), but T4's premise ("removes 2k LOC duplication") is speculative — there's no second consumer yet. Reframe D1 as "extract WHEN second CRM plugin lands", not "extract now".
- **Cx2** — T1 keeps Gap #6 (scrcpy 2× workers) as DEFER pending WABA / T2 shows GeeLark cloud-phones at US$29.90/device/mo are already cost-competitive vs physical farms. Resolution: revisit physical-scrcpy track only after WABA parallel; otherwise consider GeeLark-style cloud option as alternative scaling lever.

## Falsificações (T5 contradiz pesquisa externa)

- **F1** — v1 claimed `entryPointSource=click_to_chat_link` is hardcoded in 100% of sends; T5 confirms the field does NOT exist anywhere in send-engine.ts. T1 still lists it as top-3 priority — this is a NEW feature, not a fix. Implication: roadmap must label it "ADD entryPointSource variation", not "FIX hardcoded value".
- **F2** — v1 referenced Python reconciliation scripts (`resolve_no_match.py` etc.) as existing workarounds; T5 found zero `.py` files in repo. Implication: v1 partially based on verbal/aspirational input — every other v1 claim accepted by T1-T4 should be re-checked against T5's audit method before v2.
- **F3** — v1 said `sender:quarantined` is unemitted; T5 shows phases 3-8 already wired emitter + socket broadcast + App.tsx handler. Implication: T1's "Gap #8 quarantine logic missing" is overstated; remaining work is auto-pause policy + UI surface, not engine emission.

## Lacunas críticas

- **L1** — Operator onboarding & training UX: no track addressed how a non-dev operator learns Dispatch. T3 mapped power-user journeys but not first-day flow. Required for v2 if Dispatch is sold/embedded outside Oralsin.
- **L2** — Pricing/commercial model: T2 maps competitor pricing exhaustively but no track proposes Dispatch's own model (per-device? per-msg? SaaS? OSS+support?). Blocks any GTM.
- **L3** — BR Lei do Superendividamento + CDC art. 42-A compliance beyond LGPD: T3 covered LGPD redaction; nobody covered debt-collection-specific BR rules (collection-hour windows, opt-out registry, harassment thresholds). Critical for Oralsin's actual regulator risk.
- **L4** — Disaster recovery & backup story: no track covered SQLite WAL backup, device-loss recovery, plugin-state replay. Phase-8 hardening bullet exists but no concrete plan.
- **L5** — Avisa App UX patterns: T2 identified Avisa as new BR competitor (Apr 2026); T3 cited Twilio/Mailchimp/Klaviyo but not Avisa. Worth a UX teardown dispatch.

## Decisões recomendadas para a síntese do v2

- Re-audit every remaining v1 claim with T5's method before promoting to v2 — the entryPointSource and Python-scripts errors signal systemic v1 drift.
- Group v2 priorities into: (a) UX-only wiring of done backend (quarantine, ack-rate, funnel, throttle bar); (b) genuine new features (entryPointSource variation, warmup orchestrator, multi-content); (c) deferred (scrcpy, uinput, typing, gRPC plugins).
- Open question-registry for L1-L5 lacunas; dispatch focused subagents on L2 (pricing) and L3 (debt-collection BR compliance) before v2 GTM section.
- Reframe T4-D1 as conditional (trigger: 2nd CRM plugin), not immediate refactor.
- Add Avisa App UX teardown to T3 follow-up.
