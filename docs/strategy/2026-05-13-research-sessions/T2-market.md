# T2 — Market Competitive v2

> **Tipo**: Comparação de alternativas + descoberta | **Subagent**: general-purpose + WebSearch | **STATUS**: ANSWERED
> **Tokens**: ~79k | **Duração**: 144s

## Competitor Matrix (updated 2026-05-12)

| Feature | Dispatch | Bịp [^1] | WPPConnect [^2] | Evolution API [^3] | Whaticket [^4] | Z-API [^5] | Maytapi [^6] | MaturaGo/ProtectZap [^7] | ZapSimples [^8] | GeeLark [^9] | Avisa App [^10] | Twilio WA [^11] | SocialHub [^12] |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Physical-device farm (real SIM/IP) | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ (cloud bots) | ✗ | ✓ (cloud) | ✗ | ✗ | ✗ |
| ADB intent-based outbound | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ (cloud Android) | ✗ | ✗ | ✗ |
| WAHA/Baileys backend | ✓ (inbound) | ✗ | ✓ | ✓ | ✓ | ✗ | ✓ (own) | partial | ? | ✗ | ✗ | ✗ | ✗ |
| Meta Cloud API official | ✗ | ✗ | ✗ | ✓ (integration) | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✓ (Tech Provider) | ✓ | ✓ |
| Plugin/SDK extensibility | ✓ | ✓ (JS scripting) | ✓ (lib) | ✓ (lib) | ✗ | ? | ✗ | ✗ | ✗ | ✓ (RPA) | ✗ | ✗ | ✗ |
| Native CRM integration | ✓ (Pipedrive) | ✗ | ✗ | ✗ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ | ✓ (own CRM) |
| Chip warming/bi-directional | ✗ | ? | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ (core) | ✗ | ✗ | ✗ | ✗ | ✗ |
| Quality-score/health monitor | partial | ✗ | ✗ | ✗ | ✗ | ✓ | ✗ | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ |
| Number validation pre-send | ✓ (adb-precheck) | ✗ | ✓ (risky) [^3] | ✓ (risky) [^3] | ? | ✓ | ✓ | N/A | ? | ✗ | ✓ | ✓ | ✓ |
| Multi-content (audio/PDF/sticker) | ✗ (text-only) | ? | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (8+ tipos) | ✓ | ? | ✓ | ✓ | ✓ |
| Anti-detect fingerprint per device | ✓ (physical) | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ (cloud) | ✗ | ✗ | ✗ |
| Residential proxy rotation | N/A | ✓ | manual | manual | ✗ | ✗ | ✗ | ✓ (ProtectZap) | ✗ | ✓ | ✗ | ✗ | ✗ |
| OCR-based ban detection | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Audit/LGPD export | partial | ✗ | ✗ | ✗ | ? | ? | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ | ✓ |
| Self-hosted | ✓ | ✓ | ✓ | ✓ | partial | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |

## New BR Competitors since 2026-03-01

- **Avisa App "Disparo em Massa"** [^10] (avisaapp.com.br) — launched April 28, 2026; Meta Tech Provider since early 2026; Excel import + Meta template approval + scheduling. Pricing not public (Meta per-conversation pass-through). Anti-ban claim: relies on Meta Official API (zero ban risk).
- **WAHA 2026.3** [^13] (waha.devlike.pro/blog/waha-2026-3, May 2026) — not new but major release: new WPP engine, per-engine @lid/@c.us merge control, GOWS device-sync depth env vars. Subscription donation model (Plus).
- **Baileys 7.0.0-rc.10** [^14] (released ~May 6, 2026) — 10th RC of major rewrite; persistent ban issues in community.
- **WAHA 2026.1** [^15] — per-session API keys, GOWS storage toggle.

No new pure device-farm BR entrant found since 2026-03-01; GeeLark and Bịp remain non-BR.

## Features Dispatch Lacks (announced by ≥2 competitors)

- **Multi-content sending (audio/sticker/PDF/image)** — ProtectZap [^7], MaturaGo [^7], Evolution [^3], Whaticket [^4], Avisa [^10], ZapSimples [^8]. Dispatch is text-only.
- **Bi-directional warmup between owned numbers** — ProtectZap [^7], MaturaGo [^7], WAWarmer [^16], WMI. Dispatch absent.
- **Quality-score per sender (auto-pause degraded)** — ProtectZap [^7], GeeLark [^9], Avisa [^10], Z-API dashboard [^5]. Dispatch has partial (badge only).
- **Meta Cloud API fallback for low-risk segments** — Avisa [^10], Whaticket [^4], Z-API [^5], SocialHub [^12], Twilio [^11]. Dispatch lacks hybrid mode.
- **Message-template A/B + AI suggestions** — Avisa [^10], SocialHub [^12], RD Conversas [^17], Blip [^18]. Dispatch absent.
- **Operator wizard / no-code campaign builder** — Avisa [^10], SocialHub [^12], Whaticket [^4], ZapSimples [^8]. Dispatch is dev-facing.

## Moat candidates (no competitor advertises)

1. **OCR-based on-device ban detection** with Tesseract crop — none of WAHA/Baileys/BSPs do this; they rely on API response codes. Unique signal.
2. **Plugin SDK with HMAC callbacks + Pipedrive co-tenant publisher** — Bịp has JS scripting but no plugin contract; Evolution/WAHA are libraries, not platforms.
3. **Hybrid ADB-outbound + WAHA-inbound separation** — keeps inbound signal alive even after outbound ban. No competitor splits the two stacks.
4. **Tombstone semantics + cohort reconciliation against external CRM** — Pipedrive↔Dispatch lookupDeals reconciliation has no parallel.
5. **Behavioral validation via UIAutomator dump post-send** — anti-ban tier-0; competitors stop at HTTP ack.

## Pricing trends 2026

- **Meta Cloud API BR conversation cost** [^19][^20]: Marketing ~US$ 0.0625 (~R$ 0.33), Utility/Auth ~US$ 0.0068 (~R$ 0.036). Marketing rose ~18% in 2026. Per-message billing replaced 24h-window conversation billing (effective July 2025). Local BRL billing expected H2/2026.
- **BSP fixed-fee tier**: Twilio adds US$ 0.005/msg flat on top of Meta [^11]. Whaticket from US$ 49/mo (3 agents) [^4]. No true "unlimited" plans in 2026 [^11].
- **BR warmup tier**: ProtectZap from R$ 49 for 2-week chip warm cycle [^7]. Aligns with prior R$ 30–80/chip estimate.
- **Web-tier senders** (Baileys/WAHA wrappers): R$ 97–700/mo flat-rate "ilimitado" remains [^21]; PostZap and similar offer flat pricing.
- **GeeLark cloud-phone** [^9]: US$ 0.007/min (cap US$ 1.20/device/day) or US$ 29.90/device/mo rental — cost-competitive vs physical farm at high parallelism.

## Recent complaints summary

- **Evolution API**: Issue #2228 [^22] — `whatsappNumbers` endpoint causes mass account bans (no rate limit); Issue #2298 — instances restricted after 1-2 days of normal use (24h QR block).
- **SocialHub** (Reclame Aqui) [^23]: 58.3% resolution rate; refund/billing/cancellation issues (Nov 2025–Apr 2026 window).
- **Z-API** (Reclame Aqui) [^24]: 50% resolution rate, 9-day avg response; account blocking, cancellation refusal, trial issues.
- **Meta WhatsApp Business Terms (Jan 15, 2026)** [^25]: bans general-purpose AI chatbots on Cloud API; structured bots still allowed. Brazil's CADE ordered Meta to suspend the policy [^26] — currently in legal limbo.

[^1]: https://www.youtube.com/@BipDevice — accessed 2026-05-12
[^2]: https://github.com/wppconnect-team/wppconnect — accessed 2026-05-12
[^3]: https://github.com/EvolutionAPI/evolution-api/issues/2228 — accessed 2026-05-12
[^4]: https://whaticket.com/pt/ — accessed 2026-05-12
[^5]: https://z-api.io/ — accessed 2026-05-12
[^6]: https://maytapi.com/ — referenced via gurusup BSP comparison — accessed 2026-05-12
[^7]: https://www.protectzap.com.br/ and https://maturago.com.br/ — accessed 2026-05-12
[^8]: https://app.zapsimples.com.br/ — accessed 2026-05-12
[^9]: https://www.geelark.com/use-scenarios/price-comparison/ — accessed 2026-05-12
[^10]: https://economiasc.com/2026/04/28/avisa-app-lanca-modulo-de-disparo-em-massa-e-entra-no-mercado-de-marketing-via-whatsapp/ — accessed 2026-05-12
[^11]: https://www.twilio.com/en-us/whatsapp/pricing — accessed 2026-05-12
[^12]: https://www.socialhub.pro/ferramenta-de-disparo-em-massa-no-whatsapp/ — accessed 2026-05-12
[^13]: https://waha.devlike.pro/blog/waha-2026-3/ — accessed 2026-05-12
[^14]: https://github.com/WhiskeySockets/Baileys/releases — accessed 2026-05-12
[^15]: https://waha.devlike.pro/blog/waha-2026-1/ — accessed 2026-05-12
[^16]: https://warmer.wadesk.io/ — accessed 2026-05-12
[^17]: https://www.rdstation.com/produtos/conversas/campanhas-de-whatsapp/ — accessed 2026-05-12
[^18]: https://www.blip.ai/en/pricing/ — accessed 2026-05-12
[^19]: https://blog.umbler.com/br/custo-api-oficial-do-whatsapp-2026/ — accessed 2026-05-12
[^20]: https://authkey.io/blogs/whatsapp-pricing-update-2026/ — accessed 2026-05-12
[^21]: https://postzap.com.br/ — accessed 2026-05-12
[^22]: https://github.com/EvolutionAPI/evolution-api/issues/2228 — accessed 2026-05-12
[^23]: https://www.reclameaqui.com.br/empresa/socialhub-servicos-digitais-ltda/ — accessed 2026-05-12
[^24]: https://www.reclameaqui.com.br/empresa/z-api/ — accessed 2026-05-12
[^25]: https://techcrunch.com/2025/10/18/whatssapp-changes-its-terms-to-bar-general-purpose-chatbots-from-its-platform/ — accessed 2026-05-12
[^26]: https://techcrunch.com/2026/01/13/brazil-orders-meta-to-suspend-policy-banning-third-party-ai-chatbots-from-whatsapp/ — accessed 2026-05-12
