# T1 — Anti-ban Deep-dive

> **Tipo**: Validação + descoberta | **Subagent**: general-purpose + WebSearch | **STATUS**: ANSWERED
> **Tokens**: ~70k | **Duração**: 107s

## v1 Gaps Validation

1. **entryPointSource=click_to_chat_link** — VERIFIED-CURRENT — `Baileys #2441` (https://github.com/WhiskeySockets/Baileys/issues/2441, retrieved 2026-05-12) confirms WA server tracks "reachout" entry points and rate-limits them. 100% click_to_chat_link is still anomalous in 2026. Internal evidence: `docs/research-ban-risk-reality.md:12`.

2. **Reachout Timelock not mitigated** — VERIFIED-CURRENT — Error 463 still active; Baileys added `cstoken (NCT)` + MEX query `WAWebMexFetchReachoutTimelockJobQuery` to detect timelock state (Baileys #2441, 2025-2026 activity). ADB path cannot generate these tokens — wa.me sends will always count as reachout. Higher impact for BR debt collection where 90%+ are new contacts.

3. **Typing indicator absent** — VERIFIED-CURRENT but LOW signal — WA tested "revamped" typing indicator in Oct/Dec 2024 (https://www.androidpolice.com/whatsapp-new-typing-indicator-beta-android/) and rolled out Cloud API "typing indicators" in 2025 (https://developers.facebook.com/docs/whatsapp/cloud-api/typing-indicators/). The indicator is now a first-class server event — its absence is more detectable than in 2024.

4. **uinput virtual keyboard** — VERIFIED-CURRENT but LOW priority — no public reports of WA fingerprinting `POLICY_FLAG_INJECTED` in 2025-2026 search results. Defense-in-depth value unchanged; not urgent.

5. **On-device script (-30% overhead)** — VERIFIED-CURRENT — pure throughput optimization, no API change invalidates it. Internal T6 confirms 6.2s/send.

6. **Scrcpy virtual display 2× workers** — NEEDS-EVIDENCE for stability — scrcpy 3.x virtual displays mature in 2025 (https://github.com/Genymobile/scrcpy/blob/master/doc/virtual_display.md) but Android 15 freeform required for best experience; POCO C71 ships Android 15 so feasible. Internal T16 already showed "WA paralelo MESMO user → single-instance migra" — this gap needs WABA or multi-user (gap #7).

7. **WABA parallel com.whatsapp.w4b** — VERIFIED-CURRENT — `com.whatsapp.w4b` still ships as separate APK (https://apkpure.com/whatsapp-business-app/com.whatsapp.w4b). No 2026 policy blocking installation alongside personal WA. Caveat: Meta's Jan 2026 ban on "general-purpose AI chatbots" on WABA API (https://respond.io/blog/whatsapp-general-purpose-chatbots-ban) doesn't affect ADB use, but signals tighter business-app scrutiny.

8. **Sender quarantine logic missing** — VERIFIED-CURRENT — pure internal gap, no external dependency. Still ALTO priority.

9. **Content type variety (audio/sticker/img/PDF)** — VERIFIED-CURRENT — Meta 2026 tracks "template send velocity" + "read-to-response ratio" (https://chatarmin.com/en/blog/whats-app-messaging-limits, 2026). Homogeneous text content remains a flag. For BR debt collection, audio (boletoVoice) is plausible; PDF (boleto) is high-value.

10. **Bi-directional warmup** — VERIFIED-CURRENT — every 2026 warmup service (https://warmer.wadesk.io/blog/whatsapp-account-warm-up, https://whapi.cloud/whatsapp-number-warmup) emphasizes bi-directional simulation. Our 90% unidirectional traffic is the biggest single risk per `research-ban-risk-reality.md:58`.

## New 2026 Vectors (not in v1)

- **Preemptive enforcement (March 2026)** — Meta restricts BEFORE confirmed violations using behavioral signals (rapid contact-list growth, geo patterns) (https://www.chatarchitect.com/news/how-meta-fights-spam...). Highly relevant: BR debt-collection cohorts look like spam networks geographically.
- **Read-to-response ratio as first-class signal** — explicit in 2026 docs (https://chatarmin.com/en/blog/whats-app-messaging-limits). Our ~10-20% response rate is now scored directly.
- **Play Integrity hardening (May 2025 + Android Devs Blog Oct 2025)** — MEETS_STRONG_INTEGRITY now requires hardware-backed attestation + <12mo OS patch (https://android-developers.googleblog.com/2025/10/stronger-threat-detection-simpler.html, https://developer.android.com/google/play/integrity/verdicts). PlayIntegrityFork still works for MEETS_DEVICE_INTEGRITY but STRONG is increasingly out of reach on rooted POCO. WA may shift to require STRONG for high-volume senders.
- **PQXDH key rotation (2026)** — post-quantum key exchange now active. No direct impact on ADB path but changes WAHA/Baileys handshake fingerprints.
- **Truecaller iOS 18.2 Live Caller ID + spam scoring** (https://9to5mac.com/2025/01/22/...) — phone-number reputation is now cross-platform; BR carriers feed spam-tags. Numbers used for collection will accumulate Truecaller "Spam" labels → block rate spike → WA notices.
- **TLS JA4 device-side fingerprint stability** — JA4 (https://github.com/FoxIO-LLC/ja4) is now mainstream. WA Android client has a distinctive JA4; running stock WA on rooted device with normal network = no concern. Risk would emerge only if we add HTTP interception or proxying.

## Top-3 Anti-ban Priorities for v2 Roadmap

1. **Quarantine logic (Gap #8) + read-to-response ratio tracking** — Low effort (~150 LOC), high impact: directly addresses 2026 Meta signal + provides operational kill-switch. Prerequisite for everything else.
2. **Bi-directional warmup orchestrator (Gap #10) + content-type rotation (Gap #9)** — Medium effort, attacks the two biggest behavioral red flags (unidirectional + template). Mature SaaS recipe: 7-day ramp, 20→50/day, 4-5 content types (https://warmer.wadesk.io/blog/whatsapp-account-warm-up).
3. **EntryPointSource variation (Gap #1) + Reachout Timelock awareness (Gap #2)** — Medium effort, addresses the only server-side signal we can directly influence on the ADB path. Combine with Baileys-style `WAWebMexFetchReachoutTimelockJobQuery` polling via the WAHA passive listener to detect timelock state per sender.

## v1 Gaps that May Be DROPPED

- **Gap #3 (typing indicator)** — keep on radar but DROP from priority list. Implementing typing-pre-send via UIAutomator is brittle and the signal alone is weak; Cloud API path now offers it natively for legitimate WABA flows, making manual ADB simulation lower marginal value than bi-directional warmup.
- **Gap #4 (uinput)** — DROP from Tier-0/1. No 2025-2026 evidence WA detects `POLICY_FLAG_INJECTED`. Keep as Tier-3 defense-in-depth.
- **Gap #6 (scrcpy 2× workers)** — DEFER: throughput-only; revisit only after Gap #7 (WABA) is in, since scrcpy without a second WA instance reproduces internal test T16's single-instance-migration failure.

## Sources

- [Baileys Issue #2441 — 463 error / Reachout Timelock](https://github.com/WhiskeySockets/Baileys/issues/2441)
- [baileys-antiban (kobie3717)](https://github.com/kobie3717/baileys-antiban)
- [Android Devs Blog — Stronger threat detection Oct 2025](https://android-developers.googleblog.com/2025/10/stronger-threat-detection-simpler.html)
- [Play Integrity verdicts reference](https://developer.android.com/google/play/integrity/verdicts)
- [Privacy Portal — Play Integrity 2026](https://www.privacyportal.co.uk/blogs/free-rooting-tips-and-tricks/play-integrity-in-2026-basic-vs-device-vs-strong-what-actually-matters)
- [PlayIntegrityFork (osm0sis)](https://github.com/osm0sis/PlayIntegrityFork)
- [scrcpy virtual_display doc](https://github.com/Genymobile/scrcpy/blob/master/doc/virtual_display.md)
- [WhatsApp Business APK com.whatsapp.w4b](https://apkpure.com/whatsapp-business-app/com.whatsapp.w4b)
- [Respond.io — WA 2026 chatbot policy](https://respond.io/blog/whatsapp-general-purpose-chatbots-ban)
- [Chatarmin — WhatsApp Messaging Limits 2026](https://chatarmin.com/en/blog/whats-app-messaging-limits)
- [Chat Architect — How Meta fights spam 2026](https://www.chatarchitect.com/news/how-meta-fights-spam-and-what-is-essential-for-whatsapp-business-account-owners-to-know)
- [WAWarmer/Wadesk — WA Warm-Up 2026](https://warmer.wadesk.io/blog/whatsapp-account-warm-up)
- [Whapi.cloud — WhatsApp Warmup](https://whapi.cloud/whatsapp-number-warmup)
- [WA Cloud API — Typing indicators](https://developers.facebook.com/docs/whatsapp/cloud-api/typing-indicators/)
- [Android Police — WA new typing indicator](https://www.androidpolice.com/whatsapp-new-typing-indicator-beta-android/)
- [FoxIO JA4 fingerprint suite](https://github.com/FoxIO-LLC/ja4)
- [Truecaller iOS 18.2 Live Caller ID](https://9to5mac.com/2025/01/22/ios-18-2-enables-real-time-spam-and-scam-blocking-in-truecaller-app/)
- /var/www/adb_tools/docs/research-ban-risk-reality.md:34-89
- /var/www/adb_tools/docs/research-consolidated-findings.md:50-95
