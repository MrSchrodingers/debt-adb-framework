# Dispatch — Feature Roadmap v2 (validação + expansão)

> **Data**: 2026-05-13
> **Autor**: Validation orchestrator (5-track parallel research)
> **Versão**: 2.0 — substitui parcialmente `2026-05-12-feature-roadmap-and-market-analysis.md`
> **Escopo**: validar cada claim do v1, aprofundar evidência via 5 tracks de pesquisa independentes, e emitir um roadmap corrigido com KEEP / REVISE / DROP / ADD / DONE-SINCE-V1 explícitos.
> **Pesquisa-base**: ver `docs/strategy/2026-05-13-research-sessions/{T1..T7}.md` para fontes integrais.

---

## Sumário executivo

A v1 acertou na **tese de produto** (ADB device-farm + plugin SDK + integração Pipedrive nativa é diferencial inexistente no mercado BR) mas falhou em **2 categorias de auditoria**:

1. **Audit-error**: alguns claims sobre o estado do código estavam errados na data de redação (2026-05-12). T5 confirmou:
   - `contatos` tab foi rotulada "read-only" mas Phases 9.6 + 9.7 (aprovadas 2026-04-17 — **25 dias antes** do v1) já entregaram `/api/v1/contacts/*` + live fetch + force recheck na UI.
   - `entryPointSource=click_to_chat_link` foi rotulado como hardcoded em 100% dos envios; o campo **não existe em lugar nenhum do código** — v1 confundiu *recomendação* da research com *estado atual*.
   - `sender:quarantined` foi rotulado "sem lógica que emite"; o engine **já emite** o evento desde Phases 3-8.
2. **Conteúdo aspiracional como factual**: os 3 scripts Python (`resolve_no_match.py`, `tombstone_deleted.py`, `rescan_active_stale.py`) descritos como "workarounds existentes" **não existem** no repo. v1 estava parcialmente baseado em workarounds descritos verbalmente, não auditados.

Resultado da revalidação:

| Categoria | Itens | Itens do v1 |
|---|---|---|
| **KEEP** | 16 | A2, B1, B3, B4, C2, C3, C4, C5, D1, D2, D4, D6, E1, E2, E3, E4 |
| **REVISE** | 5 | A1, B2, C1, D3, D5 |
| **DROP** | 0 | — |
| **DONE-SINCE-V1** | 1 | A3 |
| **ADD** | 9 | NEW-1..NEW-9 |

A v2 também **promove 9 itens novos** descobertos nos tracks, sendo **2 anti-ban Tier 0** críticos (NEW-1 read-to-response ratio + NEW-2 Reachout Timelock awareness) e **3 padrões de UX Tier 2** com referências concretas (Twilio funnel, AWS Device Farm right-rail, Vanta evidence drawer).

Também documenta **5 lacunas críticas** que nenhum track cobriu e que bloqueiam decisões fora do escopo técnico: modelo comercial, conformidade BR Lei do Superendividamento, DR/backup, onboarding de operador, e UX teardown do novo concorrente Avisa App.

---

## §0 — Diff vs v1 (a leitura mais importante deste documento)

### DONE-SINCE-V1 — remover do roadmap

| v1 ID | v1 título | Evidência de entrega | Destino |
|---|---|---|---|
| A3 | Sender quarantine automática | T5 claim 5: `sender-health.ts` emite `sender:quarantined`, `server.ts` faz broadcast, `App.tsx` socket handler escuta. Phases 3–8 (aprovadas 2026-04-02 a 2026-04-06). | Excluído. Substituído por **NEW-1**. |

### DROP — sem invalidação total

Zero. Toda recomendação do v1 sobrevive em alguma forma. Itens parcialmente obsoletos viraram REVISE; itens que tracks indicam baixa prioridade ficam KEEP mas reescalonados.

### REVISE — manter mas corrigir escopo

| v1 ID | Mudança | Justificativa |
|---|---|---|
| **A1** (variar `entryPointSource`) | Reescrito de "FIX hardcoded value" para "ADD entryPointSource variation (greenfield)". | T5 claim 4: o campo não existe no código; T1 confirma que ainda é prioridade Tier 0 em 2026. |
| **B2** (Pipedrive shared service) | Reescrito como "promover Pipedrive para `ctx.services` registry **quando segundo plugin CRM aparecer**" (conditional, não immediate refactor). | T5 surprise #1: Pipedrive já está cleanly isolado em `plugins/adb-precheck/`, zero leakage. T4 D1 é válido como pattern, mas premissa "remove 2k LOC duplicação" é especulativa sem segundo consumer. |
| **C1** (contatos → reconciliação) | Reescrito como "adicionar bulk actions + recheck UI sobre a base live-fetch existente". | T5 claim 1 AUDIT-ERROR: `contatos` **não** é read-only. T5 claim 8: scripts Python aspiracionais (não existem). Escopo enxuga para diff sobre o que existe. |
| **D3** (scrcpy 2× workers) | Reescrito como "Tier 3 gated by D4". Move para post-D4 (WABA) no roadmap. | T1 Gap #6 NEEDS-EVIDENCE: scrcpy 3.x maduro mas teste interno T16 confirma single-instance migration ⇒ exige WABA para 2 instâncias reais. Cx2 do T6 ainda registra GeeLark cloud como alternativa de escala. |
| **D5** (LGPD audit pack) | Reescrito de "compliance pack" para escopo enxuto: `/admin/export/lgpd` + redact toggle no audit-log. | T5 claim 9: `lgpdSchema` + `lawfulBasisSchema` em `api/hygiene.ts:6-12` já valida input. Trabalho remanescente é só rota de export. |

### ADD — itens novos descobertos na pesquisa

| ID | Source | Item | Tier | Por quê |
|---|---|---|---|---|
| **NEW-1** | T1 | Read-to-response ratio tracking + auto-pause em quedas | Tier 0 | Meta 2026 trata read-to-response como sinal first-class (chatarmin docs). Nosso ratio é ~10-20% (research-ban-risk-reality.md:58). |
| **NEW-2** | T1 | Reachout Timelock awareness — poll Baileys-style `WAWebMexFetchReachoutTimelockJobQuery` via WAHA listener passivo | Tier 0 | Erro 463 ainda ativo em 2026 (Baileys #2441). ADB path não consegue gerar `cstoken` ⇒ todo send é reachout. Saber o estado timelock evita queimar números. |
| **NEW-3** | T1 | Preemptive-enforcement geo-cohort spreader (distribuir BR debt cohort geograficamente) | Tier 1 | Meta restringe **antes** de violação confirmada usando sinais comportamentais incluindo padrões geográficos (chatarchitect.com março 2026). |
| **NEW-4** | T2 | Meta Cloud API hybrid fallback para segmentos low-risk | Tier 3 | ≥5 concorrentes (Avisa, Whaticket, Z-API, SocialHub, Twilio) oferecem modo híbrido. Dispatch só ADB perde leads que toleram custo. |
| **NEW-5** | T4 | Plugin manifest (`dispatch-plugin.json`) + `ctx.services` registry + hot-reload | Tier 1 | T4 D1–D3 sintetizado: separa context de service registry (Backstage/Strapi/n8n), declarative manifest (VS Code), reload via destroy+init (Sentry/Vite). |
| **NEW-6** | T3 | LGPD evidence drawer + Redact-PII toggle + scheduled exports | Tier 2 | T3 Journey 3 (Vanta/Drata/Stripe Sigma patterns). Combina com D5 revisado. |
| **NEW-7** | T3 | Global throttle/pause bar + funnel viz + scheduler tab | Tier 2 | T3 Journey 1 (Twilio/Mailchimp/Klaviyo). Acompanha NEW-1 (auto-pause) e quarantine UI surface. |
| **NEW-8** | T3 | Device timeline + sparkline RAM/temp + docked mirror | Tier 2 | T3 Journey 2 (BrowserStack/AWS Device Farm/Headspin). |
| **NEW-9** | T3 | UI debt cleanup: `<FilterChips/>` primitive, `<Skeleton/>`, a11y, mobile tables | Tier 4 | Cross-journey debt: inconsistência de filtros, ausência de skeletons, status só-cor, tables que quebram em tablet. |

### KEEP — sobrevive sem reescrita (16 itens)

A2, B1, B3, B4, C2, C3, C4, C5, D1, D2, D4, D6, E1, E2, E3, E4. Texto preservado do v1 §5; ver lá para detalhes (cada item sintetizado abaixo para conveniência).

---

## §1 — Contexto (atualizado)

Tese, volume e operação atual permanecem como no v1 §1. Mudanças de fato:

- Phases 9.1-9.9 (adb-precheck robustness) **estão APPROVED** desde 2026-04-17. O v1 não levou isso em conta. Implicação prática: pipeline ADB→WAHA→Chatwoot está operacional; o foco do v2 desloca da "construção dos blocos" para "operacionalização + diferenciação".
- Commits `7b0b593a`, `4187838a`, `b1a9f70d` (pós-v1) adicionaram semântica tombstone + dashboard surface + roadmap v1 + protocolo desta sessão.
- POCO Serenity validado com Magisk 28.1 + Zygisk-Assistant + PlayIntegrityFork v16; segundo device (POCO C71) catalogado em `.dev-state/progress.md`.

---

## §2 — Pesquisa de mercado v2

Matriz competitiva atualizada via T2 (15 produtos, 60 dias de releases, 26 fontes citadas com data de acesso). Ver `docs/strategy/2026-05-13-research-sessions/T2-market.md` para tabela completa. Highlights:

- **Avisa App "Disparo em Massa"** (avisaapp.com.br) — lançado **2026-04-28**, BR, Meta Tech Provider, Excel import + template approval. Não é concorrente direto (usa Cloud API, custo por conversa), mas é a primeira chegada de uma BSP-wrapped solution focada em "disparo massa" no varejo BR pós-CADE.
- **Baileys 7.0.0-rc.10** (2026-05-06) — 10º RC do rewrite. Banimento persistente na comunidade.
- **WAHA 2026.3** (2026-05-?) — release major: novo WPP engine, controle @lid/@c.us merge per-engine, GOWS device-sync depth env vars.

**Features que Dispatch falta (anunciadas por ≥2 concorrentes)**:
1. Multi-content (audio/sticker/PDF/img) — 6 concorrentes
2. Bi-directional warmup — 4 concorrentes
3. Quality-score auto-pause — 4 concorrentes
4. Meta Cloud API hybrid fallback — 5 concorrentes
5. A/B templates + AI suggestions — 4 concorrentes
6. Operator no-code wizard — 4 concorrentes

**Moat candidates únicos do Dispatch** (T2 + T6 C2):
1. OCR-based on-device ban detection (Tesseract crop)
2. Plugin SDK + HMAC callbacks + Pipedrive co-tenant publisher
3. Hybrid ADB-outbound + WAHA-inbound separation (sobrevive a ban outbound)
4. Tombstone semantics + Pipedrive↔Dispatch lookupDeals reconciliation
5. UIAutomator post-send behavioral validation

**Pricing trends 2026**:
- Meta Cloud API BR Marketing: US$ 0.0625 (+18% YoY); Utility/Auth: US$ 0.0068; per-message billing efetivo desde Jul/2025; BRL local prevista H2/2026.
- BR warmup tier (ProtectZap): R$ 49 / ciclo 2 semanas.
- GeeLark cloud-phone: US$ 0.007/min cap US$ 1.20/device/day OU US$ 29.90/device/mo — competitive vs farm físico em alta paralelização.

---

## §3 — Inventário de UI atualizado (T5 audit)

**Correções do v1**:
- `contatos` (528 LOC) é **NÃO read-only**; consume `/api/v1/contacts/*` desde Phases 9.6-9.7. Gap real: faltam bulk actions, recheck em massa, dashboard agregado.
- `fleet-page.tsx` (2175 LOC) **confirmado over-engineered**; nenhum decomposer parcial existe em `packages/ui/src/components/fleet-*`. Oportunidade aberta.
- `admin-page.tsx` (485 LOC) tem DeadLetterPanel + BannedNumbersPanel; gap real é plugin admin UI + cohort dashboard + job history.

**Repo scale snapshot (T5)**:
- `packages/core`: 34.602 LOC source / 180 .ts modules
- `packages/ui`: 17.872 LOC source / 49 .tsx components
- `packages/core/src/plugins`: 8.566 LOC / 22 .ts files (maioria adb-precheck)
- Pipedrive em adb-precheck: 10 files / 4.340 LOC total

**UI debt observado em T3 cross-journey**:
- Inconsistência de filter chips (`audit-log.tsx:218`, `oralsin-messages.tsx:45`, `sender-dashboard.tsx:133`)
- Sem `<Skeleton/>` — todo lugar reinventa `<p>Carregando...</p>`
- Tables `overflow-x-auto` quebram em tablet
- CommandPalette existe mas não registra bulk actions
- A11y: status só-cor, sem `aria-live` em toasts, sem `aria-label` em pills

---

## §4 — Gaps anti-ban v2 (T1)

Cada gap do v1 §4 validado contra evidência 2026. Decisões priorizadas (ver `T1-anti-ban.md` para validações 1-10 individuais):

### Mantido com confirmação 2026
- **Gap #1** entryPointSource variation — VERIFIED-CURRENT (Baileys #2441 ativo)
- **Gap #2** Reachout Timelock — VERIFIED-CURRENT, agora monitorável via MEX query
- **Gap #5** On-device script — VERIFIED-CURRENT (pure throughput)
- **Gap #7** WABA paralelo — VERIFIED-CURRENT (sem policy block)
- **Gap #8** Sender quarantine logic — **PARCIALMENTE DONE-SINCE-V1** (engine emite; falta auto-pause policy + UI surface)
- **Gap #9** Multi-content — VERIFIED-CURRENT (Meta 2026 rastreia velocity + read-to-response)
- **Gap #10** Bi-directional warmup — VERIFIED-CURRENT (#1 red flag em 2026)

### Rebaixados / desfeitos
- **Gap #3** typing indicator — KEEP-LOW: agora first-class no Cloud API, mas simulação via UIAutomator é frágil; sinal isolado é fraco. Não Tier 0/1.
- **Gap #4** uinput virtual keyboard — KEEP-DEFER: sem evidência 2025-2026 de detecção de `POLICY_FLAG_INJECTED`. Defense-in-depth Tier 3.
- **Gap #6** scrcpy 2× workers — DEFER pós-WABA (single-instance migration ainda bloqueia sem 2ª app).

### Novos vetores 2026 (T1 §"New 2026 Vectors")
1. **Preemptive enforcement** (Meta março 2026) — restringe antes de violação confirmada usando sinais comportamentais + geográficos. Crítico para cohort BR.
2. **Read-to-response ratio** como sinal first-class (chatarmin 2026).
3. **Play Integrity STRONG hardening** (Android Dev Blog Oct 2025) — agora requer hardware-backed attestation + <12mo OS patch. POCO rooted fica em DEVICE_INTEGRITY no máximo.
4. **PQXDH key rotation** (2026) — sem impacto direto no ADB path.
5. **Truecaller iOS 18.2 Live Caller ID** — phone-number reputation cross-platform; números de cobrança acumulam "Spam" labels.
6. **TLS JA4** mainstream — risco só se proxiarmos.

### Top-3 prioridades anti-ban v2

1. **NEW-1 + restante de Gap #8** (auto-pause + read-to-response ratio) — ~150 LOC, low effort, alto impacto, prerequisito de tudo.
2. **D2 + Gap #9** (warmup orchestrator + content rotation) — ataca os 2 maiores red flags 2026 (unidirectional + template).
3. **A1 revisado + NEW-2** (entryPointSource variation + Timelock monitoring) — single server-side signal influenciável no ADB path.

---

## §5 — Arquitetura de plugins v2 (T4)

3 design decisions validadas contra 8 produtos comparáveis (ver `T4-plugin-arch.md` para detalhes):

**D1 — Service registry separado de context**. Inspiração: Backstage `ApiRegistry`, Probot `context.octokit`, n8n `httpRequestWithAuthentication`.
- Plugins consomem `ctx.services.pipedrive.createNote(...)` em vez de instanciar HTTP client próprio.
- Core mantém auth cache + rate-limit pool + retry como serviço compartilhado.
- **Trigger**: ativar quando segundo plugin CRM aparecer (Cx1 do T6). Hoje, com 1 só consumer, é especulativo.

**D2 — Plugin manifest (`dispatch-plugin.json`) com capabilities + activation events + SDK semver range**. Inspiração: VS Code `contributes`, Strapi register/bootstrap.
- Loader valida manifest, alerta em SDK incompatível, lazy-load no primeiro evento matching.
- Plugin admin UI consome este manifest para renderizar lista + status.

**D3 — Hot-reload via `destroy()` + re-init com fresh context**. Inspiração: Sentry `addIntegration`, Vite `handleHotUpdate`.
- Gate atrás de `DISPATCH_ENV=development`.
- Defer Terraform-style gRPC isolation para v3.

**Anti-patterns conscientemente evitados**:
- God-context bloat (VS Code monolithic namespace) — risk crescente em nosso PluginContext atual (12 fields).
- Sync hooks blocking hot path (Vite proíbe sync `transform`).
- Sem process boundary + sem version pinning (Terraform isola via gRPC; nós rodamos in-process sem ABI guarantee).

---

## §6 — Roadmap por tier (v2 consolidado)

### Tier 0 — Anti-ban core + UI wiring de backend já pronto

- **A1 revisado** — Implementar entryPointSource variation (50% wa.me / 30% search bar / 20% chat list). Adições greenfield em `send-engine.ts`.
- **NEW-1** — Read-to-response ratio tracking + auto-pause policy. ~150 LOC.
- **NEW-2** — Reachout Timelock awareness via WAHA listener (poll periódico MEX query).
- **E2** (promovido) — Anomaly alerts proativos (preemptive enforcement signal mitigation).

### Tier 1 — Plugin & services (escalável)

- **NEW-5** — Plugin manifest + `ctx.services` registry + hot-reload (D1+D2+D3 do T4).
- **B1** — Decompor OralsinPlugin sob a nova arquitetura.
- **B2 revisado** — Promover Pipedrive a `ctx.services.pipedrive` quando segundo plugin CRM aparecer.
- **B3** — Hooks de ban detection acessíveis a plugins.
- **B4** — Plugin admin UI no `admin-page.tsx`.
- **NEW-3** — Geo-cohort spreader (BR debt cohort).

### Tier 2 — UX promotion

- **C1 revisado** — Bulk actions + recheck UI em `contatos` (live-fetch base).
- **C2** — Cohort dashboard no admin.
- **C4** — Wizard de operação ("Quero fazer um disparo").
- **C5 + NEW-1** — Health-score visível por sender (alimentado pelo ratio).
- **NEW-7** — Throttle/pause bar global + funnel viz + scheduler tab.
- **NEW-8** — Device timeline + sparkline + docked mirror.
- **NEW-6** — LGPD evidence drawer + Redact-PII toggle + scheduled exports.
- **D1** (promovido) — Multi-content (audio + PDF primeiro).

### Tier 3 — Performance / escala / diferenciação

- **A2** — On-device script (-30% overhead).
- **D4** — WABA paralelo (`com.whatsapp.w4b`).
- **D3 gated** — Scrcpy 2× workers (apenas após D4).
- **D2** — Bi-directional warmup orchestrator (gating: D1 + sender pool stable).
- **D6** — A/B testing de templates.
- **NEW-4** — Meta Cloud API hybrid fallback.
- **D5 revisado** — `/admin/export/lgpd` + redact toggle.

### Tier 4 — Operacional / qualidade de vida

- **C3** — Decompor `fleet-page.tsx`.
- **E1** — Reconciliação periódica automática.
- **E3** — Retry/cancel manual no UI.
- **E4** — Dashboard de custos.
- **NEW-9** — UI debt cleanup (`<FilterChips/>`, `<Skeleton/>`, a11y, mobile tables).

---

## §7 — Sprints 1-5 (plan format, T7 re-sequenced)

> Aplicando `superpowers:writing-plans`: cada sprint mapeia (a) arquivos afetados, (b) deliverable verificável, (c) gates para iniciar próximo sprint. Sem placeholders.

### Sprint 1 — Anti-ban core (2 semanas)

**Goal**: tirar o Dispatch da "blind zone" anti-ban — sair de "espera ban acontecer" para "detecta degradação cedo + reage".

**Files (touch list)**:
- `packages/core/src/engine/send-engine.ts` — adicionar variação entryPointSource (3 strategies).
- `packages/core/src/engine/strategies/entry-point-*.ts` — criar 3 arquivos (wa-me, search-bar, chat-list).
- `packages/core/src/health/response-ratio.ts` — criar (NEW-1, ratio tracker).
- `packages/core/src/health/sender-health.ts` — adicionar auto-pause em queda ratio.
- `packages/core/src/waha/timelock-poller.ts` — criar (NEW-2, MEX query parity).
- `packages/core/src/alerts/preemptive-monitor.ts` — criar (E2 promovido).
- `packages/ui/src/components/sender-dashboard.tsx` — surface do ratio + quarantine badge.
- Testes: 5 arquivos `.test.ts` colocados.

**Deliverable**: read-to-response ratio visível por sender; auto-pause em ratio < 5% por 1h; Timelock state surface no admin; entryPointSource em 3 strategies com round-robin ponderado.

**Gate**: E2E real para 5543991938235 cobrindo cada strategy + 1 simulação de ratio drop.

### Sprint 2 — Plugin manifest + services (3 semanas)

**Goal**: pavimentar SDK para 2º plugin CRM. Sem fazer extração de Pipedrive (gating em demanda real).

**Files (touch list)**:
- `packages/core/src/plugins/manifest.ts` — criar (schema `dispatch-plugin.json`).
- `packages/core/src/plugins/loader.ts` — refactor para consumir manifest + activation events.
- `packages/core/src/plugins/services-registry.ts` — criar (`ctx.services.*` stub).
- `packages/core/src/plugins/reload.ts` — criar (`reloadPlugin(name)` gated em DEV).
- `packages/plugins/oralsin/dispatch-plugin.json` — criar manifest do Oralsin.
- `packages/plugins/adb-precheck/dispatch-plugin.json` — criar manifest do adb-precheck.
- `packages/ui/src/pages/admin/plugin-admin.tsx` — criar (B4).
- `packages/core/src/api/admin/plugins.ts` — admin routes para enable/disable/inspect.

**Deliverable**: 2 plugins existentes rodam via manifest; loader avisa em SDK incompat; UI admin lista plugins com status + reload button (DEV only).

**Gate**: ambos plugins iniciam após restart; manifest validation falha graciosamente com mock plugin SDK errado.

### Sprint 3 — UX promotion (3 semanas)

**Goal**: tornar Dispatch operável por não-dev. Aproveitar backend pronto (quarantine, contatos live-fetch).

**Files (touch list)**:
- `packages/ui/src/components/throttle-bar.tsx` — criar (NEW-7).
- `packages/ui/src/components/funnel-card.tsx` — criar (NEW-7).
- `packages/ui/src/pages/scheduler.tsx` — criar (NEW-7).
- `packages/core/src/api/admin/messages.ts` — adicionar `/messages/funnel?campaignId`.
- `packages/ui/src/components/contacts-audit.tsx` — adicionar bulk actions + recheck button (C1 revisado).
- `packages/ui/src/components/device-grid.tsx` — sparkline embed + docked mirror (NEW-8).
- `packages/ui/src/pages/device-timeline.tsx` — criar sub-tab (NEW-8).
- `packages/ui/src/components/evidence-drawer.tsx` — criar (NEW-6).
- `packages/ui/src/components/cohort-dashboard.tsx` — criar (C2).
- `packages/ui/src/pages/operator-wizard.tsx` — criar wizard 4-passos (C4).

**Deliverable**: operador novo consegue (a) ver fila + funnel; (b) pausar tudo globalmente com motivo; (c) abrir contato e dar recheck; (d) ver device timeline; (e) lançar disparo via wizard.

**Gate**: usabilidade test com não-dev (Matheus + 1 op Oralsin) em ambiente staging.

### Sprint 4 — Performance / escala (3 semanas)

**Goal**: tirar throughput do platô atual (760 msg/h) para ≥1.5k msg/h em 1 device.

**Files (touch list)**:
- `scripts/on-device/send.sh` — criar shell script device-side (A2).
- `packages/core/src/adb/on-device-runner.ts` — criar wrapper (push + exec).
- `packages/core/src/adb/waba-profile-mapper.ts` — criar (D4, mapeia profile + app).
- `packages/core/src/engine/scrcpy-display.ts` — criar (D3, **gated por D4**).
- `packages/core/src/health/geo-spreader.ts` — criar (NEW-3, distribuição BR).

**Deliverable**: A2 reduz overhead per-send de ~9s para ~6.2s; D4 dobra senders no mesmo device físico via WABA; D3 só ativa após D4 estável por 1 semana.

**Gate**: medir 1.5k msg/h sustentado por 4h em E2E real; sem regressões em ban rate.

### Sprint 5 — Differentiation + hardening (3 semanas)

**Goal**: features que viram argumento de venda + closing gaps de qualidade.

**Files (touch list)**:
- `packages/core/src/engine/content-strategies/{audio,pdf,image}.ts` — criar 3 strategies (D1).
- `packages/plugins/oralsin/templates/ab-router.ts` — criar (D6).
- `packages/plugins/warmup/` — criar plugin novo (D2 bi-directional warmup orchestrator).
- `packages/core/src/cloud-api/hybrid-router.ts` — criar (NEW-4, Meta Cloud fallback).
- `packages/core/src/api/admin/export-lgpd.ts` — criar (D5 revisado).
- `packages/ui/src/lib/redact.ts` — criar (NEW-6 PII toggle).
- `packages/ui/src/components/filter-chips.tsx` — criar primitive (NEW-9).
- `packages/ui/src/components/skeleton.tsx` — adoptar shadcn (NEW-9).
- `packages/ui/src/pages/cost-dashboard.tsx` — criar (E4).
- Refactor: decompor `fleet-page.tsx` em 5 sub-componentes (C3).

**Deliverable**: PDF boleto + áudio enviáveis; A/B test ativo no Oralsin; cohort warmup rodando; export LGPD funcional; UI consistente.

**Gate**: 1 caso real Oralsin de boleto PDF enviado; relatório QA UI sem regressões de a11y.

---

## §8 — Open Questions (T6 lacunas)

> Itens que **nenhum track cobriu** e que precisam de dispatch dedicado ou input do business antes de virar roadmap. Registrados para evitar drift.

| ID | Pergunta | Por que importa | Próxima ação |
|---|---|---|---|
| **L1** | Como um operador não-dev aprende Dispatch no primeiro dia? | Bloqueia venda/embed fora da Oralsin. T3 mapeou power-user, não onboarding. | Dispatch focado de pesquisa + sessão UX teardown. |
| **L2** | Qual o modelo comercial do Dispatch? Per-device? Per-msg? SaaS? OSS+suporte? | T2 mapeou concorrência mas Dispatch não tem GTM definido. Bloqueia decisão sobre Sprint 5 hybrid fallback (NEW-4). | Brainstorm de negócio com stakeholders + research de modelos comparáveis (n8n cloud, Strapi, Backstage). |
| **L3** | Conformidade BR Lei do Superendividamento + CDC art. 42-A | Janelas de cobrança (8h-20h), registro opt-out, threshold de assédio. Risco regulatório real Oralsin. T3 só cobriu LGPD. | Consulta jurídica + dispatch de research sobre Reclame Aqui / decisões CADE. |
| **L4** | Disaster recovery & backup story | SQLite WAL backup, device-loss recovery, plugin state replay. Phase 8 menciona mas não detalha. | Brainstorm + plan dedicado pós-Sprint 2 (depende do manifest). |
| **L5** | UX teardown de Avisa App | Novo concorrente BR (abr-2026); T3 citou Twilio/Mailchimp/Klaviyo mas não Avisa. | Dispatch focado de research. |

---

## §9 — Métricas de sucesso (atualizadas)

Mantém v1 §7 com adições:

- **Ban rate** (bans/1000 msgs) — baseline ainda a estabelecer (Sprint 1 NEW-1 cria a medição).
- **Read-to-response ratio** — target 25%+ em 60 dias pós-NEW-1 (vs ~10-20% atual).
- **Throughput sustentado** — 760 msg/h baseline → target 1.5k+ msg/h pós-Sprint 4.
- **MTTR de ban** — target < 15 min com NEW-1 + NEW-2 (vs target v1 de < 30 min).
- **Coverage Pipeboard** — 9.34% → 30%+ em 60 dias (mantido).
- **Pre-emptive flag detection rate** — % de senders que recebem soft-pause antes de ban duro (NEW-1 + E2).

---

## §10 — Riscos e premissas (revisado)

| Risco | Probabilidade | Impacto | Mitigação primária |
|---|---|---|---|
| **Preemptive enforcement Meta 2026** | Alta | Alto | NEW-1 + NEW-2 + NEW-3 (Sprint 1 e 2). |
| **Play Integrity STRONG hardening** | Média | Alto | Defender DEVICE_INTEGRITY; STRONG impossível em rooted. Plan B = WABA + hybrid fallback NEW-4. |
| **Audit error pattern do v1** | Baixa (já mitigada) | Médio | T5 re-audit de cada v2 claim antes de Sprint inicio. |
| **Concorrência Avisa App + similar** | Média | Médio | Wizard (C4) + moat features (multi-content + warmup) em Sprints 3-5. |
| **Custo chip/device BR** | Baixa | Médio | E4 dashboard de custo dá argumento + estimativa antecipada. |
| **LGPD/Lei 14.181 compliance** | Alta | Alto | D5 revisado + NEW-6 evidence drawer + L3 (open question) para Lei Superendividamento. |
| **Bịp Device + Whaticket combo** | Baixa | Médio | Janela 12-18 meses; NEW-5 manifest + plugin SDK como diferencial técnico inalcançável por copy. |

---

## Anexo A — Quality gates aplicados

| Gate | Pass? | Evidência |
|---|---|---|
| Cobertura — 10 gaps v1 com decisão | ✓ | T1 §"v1 Gaps Validation" entradas 1-10; T7 tabelas Tier 0-4 |
| Novidades — ≥5 ADDs citados | ✓ | 9 NEWs com source track + URL/file:line |
| Concorrência — matriz com URLs | ✓ | T2 com 26 footnotes + retrieval date 2026-05-12 |
| UX — 3 journeys × ≥3 patterns | ✓ | T3 com 5 patterns/journey + URLs |
| Plugin arch — 3 design decisions concretas | ✓ | T4 D1/D2/D3 com produto de referência |
| Internal audit — 10/10 claims classificados | ✓ | T5 com 5-category framework por claim |
| Cross-val — ≥1 falsificação documentada | ✓ | T6 F1/F2/F3 |
| Format — `## Diff vs v1` presente | ✓ | §0 deste documento |
| Plan format — Sprints 1-5 atualizadas | ✓ | §7 com files + deliverable + gate por sprint |
| Sources — cada claim crítico cita | ✓ | Anexo B |

## Anexo B — Referências

**Tracks** (cada um com fontes integrais — clicar para abrir):
- `docs/strategy/2026-05-13-research-sessions/T1-anti-ban.md` (17 URLs 2024-2026 + 2 internal docs)
- `docs/strategy/2026-05-13-research-sessions/T2-market.md` (26 footnotes + retrieval date 2026-05-12)
- `docs/strategy/2026-05-13-research-sessions/T3-ux.md` (~15 product URLs + file:line do codebase)
- `docs/strategy/2026-05-13-research-sessions/T4-plugin-arch.md` (8 product docs + file:line plugin SDK)
- `docs/strategy/2026-05-13-research-sessions/T5-internal-audit.md` (10 claims com file:line + commits)
- `docs/strategy/2026-05-13-research-sessions/T6-cross-val-divergences.md`
- `docs/strategy/2026-05-13-research-sessions/T7-cross-val-roadmap.md`
- `docs/strategy/2026-05-13-research-sessions/state.json` (state machine completo, audit trail)

**Documentos do projeto referenciados**:
- `docs/strategy/2026-05-12-feature-roadmap-and-market-analysis.md` (v1, substituído por este)
- `docs/PRD-dispatch.md`
- `docs/research-ban-risk-reality.md`
- `docs/research-consolidated-findings.md`
- `.dev-state/progress.md`

**Commits relevantes** (validados via T5):
- `7b0b593a` — tombstone semantics + coverage recálculo (2026-05-12)
- `4187838a` — tombstoned filter + visual indicator (pre-v1)
- `b1a9f70d` — feature roadmap v1 (2026-05-12)
- Phases 9.1-9.9 — APPROVED 2026-04-17 (contact registry + REST + UI live fetch)
