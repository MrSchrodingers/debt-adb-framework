# Dispatch — Estudo de produto, mercado e roadmap de sugestões

> **Data**: 2026-05-12
> **Escopo**: análise de produto, posicionamento competitivo, gaps técnicos identificados em research interna, oportunidades de UI/UX, plugin architecture e Pipedrive.
> **Fontes**: codebase auditada (`packages/core`, `packages/ui`), `docs/research-*` (4 docs internas de 2026-04), `docs/PRD-dispatch.md`, pesquisa de mercado (Bịp Device, WPPConnect, Evolution API, BSPs oficiais, warmup services).

---

## 1. Contexto e objetivo (estado da arte)

**Tese do produto**: enquanto o mercado de envio massivo de WhatsApp se divide entre WAHA/Baileys (Web protocol, banimento em onda quando Meta atualiza) e API oficial Meta (R$ 0,20–0,50/conversa, proibitivo a partir de 100k msg/mês), Dispatch ocupa o tier de **ADB sobre devices físicos** — preserva fingerprint completo (SIM real, IP da operadora, touch patterns, timing), separa outbound (ADB) de inbound (WAHA listener passivo), e tem plugin SDK que isola regras de negócio por cliente (Oralsin para cobrança odontológica, adb-precheck para validação Pipeboard).

**Volume alvo PRD**: 500–5.000 msg/dia hoje, 30+ devices no curto prazo. Custo Meta para o mesmo volume: ~R$ 6k–60k/mês.

**Operação atual**:
- 4 perfis × 1 device (POCO Serenity, root + Magisk + PlayIntegrityFork)
- ~190 msg/h/sender, ~760 msg/h em 4 senders
- Stack outbound: ADB intent (`am start wa.me?text=...`) → typing/clipboard → send → screenshot → OCR ban detection
- Stack inbound: WAHA Plus GoWS como listener (webhooks `message.any` + `message.ack`)
- Plugin Oralsin enfileira jobs vindos do NotificationBilling externo
- Plugin adb-precheck pré-valida números via L3 ADB + L2 WAHA tiebreaker, propaga para Pipeboard

---

## 2. Pesquisa de mercado (resumo)

### 2.1 Posicionamento competitivo

| Tier | Exemplos | Vetor | Encaixe |
|---|---|---|---|
| **DIY device-farm** | Bịp Device (`bipdevice.io`), GeeLark, devicefarmer-stf | Toolkit JS scripting sobre ADB | Dispatch concorre tecnicamente, mas oferece app + plugin + CRM integrado |
| **WhatsApp-Web não-oficial** | WPPConnect, Baileys, Evolution API, WAHA | WebSocket / Baileys protocol | Mais barato, mais frágil — onda de ban quando Meta atualiza |
| **Chip warming** | MaturaGo, ProtectZap, WMI, Maturador PRO MAX | Bot loops entre números próprios | Camada **acima** do envio; Dispatch poderia oferecer como feature |
| **Bulk sender Web (BR)** | ZapSimples, ZapTurbo, Dispara Aí, Clickmassa | Chrome extension ou WAHA wrapper | Tier de baixo custo, R$ 100–700/mês, sem anti-ban real |
| **CRM/atendimento** | Whaticket, Letalk, Blip, Huggy | Multi-agent inbox + Business API | Enterprise, foco em atendimento não em outbound massivo |
| **API oficial** | Z-API, Maytapi, Twilio, Meta Cloud | Business API certificada | Zero ban, mas R$ 0,20–0,50/conversa + obrigatório templates |

**Diferencial técnico observado** (não tem concorrente direto):
- ADB real device farm + plugin SDK + telemetria por device + integração CRM nativa.
- Bịp Device é o mais próximo, mas é DIY tooling sem CRM nem plugin model.

### 2.2 Bịp Device especificamente

- URL: `bipdevice.io` (Vietnã, não BR como o nome sugeria).
- Posicionamento: **screen-mirror + JS-scripted Android automation**, gratuito, suporta N devices.
- "Bịp Automation" (mesmo autor): anti-detect tool com canal YouTube de demos WhatsApp/chip farm.
- **Não é produto turnkey**: requer dev para escrever scripts em JS.
- Nenhuma integração CRM.

### 2.3 Features anti-ban anunciadas pelo warmup tier (BR)

Padrões observados em ProtectZap, MaturaGo, Maturador PRO MAX, WMI:
1. Bi-directional saved contacts entre números maturados
2. Rotating residential proxies dedicados (caso DataImpulse)
3. Schedules randomizados + 8+ tipos de conteúdo (texto/áudio/imagem/sticker/PDF)
4. Quality-score monitoring + auto-pause em tier degradado
5. Rotação de número dentro da campanha
6. Typing simulation (delays + jitter)

Dispatch **já tem** o equivalente para todos exceto (1) bi-directional warmup, (2) rotating proxies (irrelevante: device real usa IP da operadora), (3) tipos de conteúdo variados (hoje só texto), (4) quality-score automatizado, (5) rotação de número (existe nos senders, mas distribução é round-robin ponderado, não diversifica per-mensagem).

### 2.4 Reclamações conhecidas dos concorrentes

- **Evolution API GitHub #2228**: endpoint `whatsappNumbers` causa ban em massa ao checar números. Comunidade reclama de "restart PM2 todo dia". Migração para WasenderAPI/Whapi.
- **Baileys/WPPConnect**: bans em onda quando Meta atualiza WhatsApp Web.
- **Meta 15-Jan-2026**: bloqueia chatbots de terceiros (gerais) na Business API → afeta integrações OpenAI/Claude diretas.
- **Chip warming barato**: proxies compartilhados causam ban em cadeia.
- **Web-tier senders BR**: nenhum publica anti-ban real, só aviso "não faça spam".

### 2.5 Modelos de pricing observados

- Flat-rate "ilimitado" Web: R$ 97–700/mês (ZapSimples, ZapTurbo)
- Por sessão/linha: Clickmassa cobra por número + assentos + módulos opcionais
- Pay-per-message BSP: R$ 0,20–0,50 por conversa
- Fixed BSP: Maytapi US$ 24/mês ilimitado BR
- Chip warming: R$ 30–80/chip/mês típico

---

## 3. Tabs e features sub-utilizadas (auditoria UI)

Inventário de `App.tsx` (linhas 1–60):

| Tab | LOC | Status real | Achados |
|---|---|---|---|
| `devices` | — | Ativo | DeviceGrid + DeviceDetail, socket events bem cobertos |
| `queue` | — | Ativo | MessageList + polling `/metrics/by-status` |
| `senders` | 317 | Ativo | SenderDashboard com health tracking |
| `sessions` | 772 | Ativo | SessionManager (WAHA pairing, QR, etc) |
| `metricas` | — | Ativo | MetricsDashboard com Recharts |
| `auditoria` | — | Ativo | AuditLog |
| `plugins` | 186 | **Hub raso** | Só lista Oralsin + adb-precheck e roteia para sub-tabs; nada de admin/enable/disable |
| `contatos` | 528 | **Sub-utilizado** | ContactsAudit é só leitura — sem bulk actions, sem recheck manual em massa, sem stats agregadas |
| `admin` | 485 | **OK mas limitado** | Dead-letter callbacks, banned numbers, sender controls. Sem plugin admin, sem job history, sem cohort dashboard |
| `mirror` | — | Ativo | DevicesGridMirror, screencap polling 1Hz, fullscreen overlay |
| `fleet` | **2175** | **Over-engineered** | Chip lifecycle completo (CRUD + pagamentos + calendário + SMS) — gigante mas funcional |

**Sub-utilizados ou com gap real**:

- **`contatos`** — read-only quando a API já suporta bulk recheck (`/contacts/recheck`). Operador hoje usa script Python externo (`resolve_no_match.py`, `tombstone_deleted.py`) para reconciliação. Esses 3 scripts deveriam virar botões no `contatos`.
- **`plugins` hub** — não tem visão de quais plugins estão registrados no `plugin_registry`, nem health por plugin, nem callback queue, nem enable/disable. É essencialmente um router pra tabs hardcoded.
- **`admin`** — falta plugin admin (registrar/enable/disable), falta visão de jobs recentes (hoje fica dentro de adb-precheck-tab), falta cohort/reconciliação dashboard (78 → 73 phones em rejected_no_match não tem UI hoje).

**Over-engineered**:
- **`fleet`** — 2175 linhas em um arquivo. Decompor em sub-componentes melhoraria manutenção e onboarding.

---

## 4. Gaps técnicos críticos identificados em `docs/research-*`

Síntese de `research-ban-risk-reality.md`, `research-consolidated-findings.md`, `research-throughput-parallelism.md`:

### Gaps confirmados pela research interna mas **não implementados**:

| # | Gap | Impacto | Doc |
|---|---|---|---|
| 1 | **`entryPointSource=click_to_chat_link` em 100% dos envios** — não varia | ALTO — assinatura anômala server-side. Research recomenda 50% wa.me + 30% search + 20% chat-list | `research-ban-risk-reality.md:59,82-89` |
| 2 | **Reachout Timelock não mitigado** — wa.me?text= é tratado como reachout pelo WhatsApp | MÉDIO — 60s entre msgs novos contatos | `research-ban-risk-reality.md:34-38` |
| 3 | **Typing indicator ausente** — wa.me?text= não gera "digitando..." pro destinatário | BAIXO-MÉDIO — sinal fraco mas detectável | `research-consolidated-findings.md` (Typing Indicator section) |
| 4 | **uinput virtual keyboard** — eventos indistinguíveis de hardware | MÉDIO | `research-ban-risk-reality.md:94-98` |
| 5 | **On-device script** — push+execute em 1 ADB call (-30% overhead) | ALTO — throughput 3× | `research-consolidated-findings.md` (T6) |
| 6 | **Scrcpy virtual display** — 2 workers paralelos no mesmo device | ALTO — 2× throughput | `research-consolidated-findings.md` (T12-T16) |
| 7 | **WABA paralelo** — `com.whatsapp.w4b` em outro profile (dobra senders por device) | ALTO | Roadmap research Fase 2 |
| 8 | **Quarantine de sender** — `sender:quarantined` event existe mas sem lógica de bloqueio | MÉDIO | App.tsx:55 referencia evento; engine não emite |
| 9 | **Tipos de conteúdo (áudio, sticker, imagem, PDF)** — só texto hoje | MÉDIO — concorrentes warmup usam 8+ tipos | Concorrência |
| 10 | **Bi-directional warmup entre números próprios** | MÉDIO — padrão de mercado | Concorrência |

### Já implementado e funcionando:

- Rate limit per-sender com volume scaling (`pair-rate-limiter.ts`)
- Jitter 0.8–1.5× sobre delay base, cap 300s
- Retry com backoff exponencial (5 tentativas)
- Ban detection OCR via Tesseract (`ban-detector.ts`)
- Behavioral validation (UIAutomator dump após send)
- Contact registration pre-send (`contact-registrar.ts`)
- Sender warm-up por tier (`sender-warmup.ts`)
- Auto-recovery de WA crash
- Lock per-pasta com renewal (15min, deployed `77115d68`)
- Device-failure recovery loop com pre-flight (`684d8a62`)
- Reconciliação Dispatch↔Pipeboard via `lookupDeals` (`d0a2ebb3`)
- Tombstone semantics + dashboard surface (`7b0b593a`, `4187838a`)

---

## 5. Sugestões priorizadas

### Tier 0 — Anti-ban, melhor relação esforço/risco

**A1. Variar `entryPointSource`** (Gap #1, research linha 59)
- Hoje: 100% wa.me?text=
- Alvo: 50% wa.me, 30% search bar (`am start whatsapp://search?...`), 20% chat list
- Impacto: reduz anomalia server-side mais visível
- Esforço: ~200 LOC em `send-engine.ts` + 3 code paths de abertura
- Risco: baixo — caminho de search/chat-list precisa de UI dump pra confirmar abriu certo

**A2. On-device script** (Gap #5, research T6)
- Push 1 shell script ao device, executa via `adb shell sh /data/local/tmp/send.sh "<phone>" "<text>"`, retorna status
- Impacto: ~30% menos overhead ADB, ~6.2s/send vs 9s atual
- Esforço: ~150 LOC + testes E2E
- Risco: baixo — script vive no device, sem alterações comportamentais visíveis

**A3. Quarantine automática de sender com N bans consecutivos**
- Hoje: `sender:quarantined` event no socket mas sem lógica que emite
- Alvo: contador per-sender de bans nas últimas 24h, quarantine automática em ≥3, alerta operacional
- UI: badge "quarantined" no SenderDashboard, botão "approve" para reativar
- Esforço: ~100 LOC engine + ~40 UI
- Risco: muito baixo — fail-safe operacional, evita queimar mais números

### Tier 1 — Plugins e Pipedrive (separação de regras de negócio)

**B1. Decompor `OralsinPlugin` para isolar regras Oralsin do core**
- Hoje: schemas Zod e sender mapping de Oralsin vivem no plugin, mas há acoplamento sutil (sender-mapping no core conhece formato Oralsin)
- Alvo: plugin valida formato Oralsin antes de enfileirar, core não conhece nada Oralsin-específico
- Esforço: ~200 LOC refactor + manter testes

**B2. Pipedrive como serviço compartilhado entre plugins**
- Hoje: integração Pipedrive vive **apenas** no plugin `adb-precheck` (10+ arquivos `pipedrive-*.ts`)
- Alvo: extrair `PipedriveClient` + `PipedrivePublisher` para `packages/core/src/pipedrive/` como serviço, plugins consomem via `PluginContext.pipedrive`
- Beneficia: Oralsin pode publicar notes/activities sem reimplementar
- Esforço: ~300 LOC + manter contratos `pipedrive_activities`/`pipedrive_notes`

**B3. Hooks de ban detection acessíveis a plugins**
- Hoje: `ban-detector.ts` chama-se no core, plugins não veem o evento
- Alvo: emitir `dispatch:ban_detected` no `PluginEventBus`, plugin Oralsin pode escutar e disparar callback ao NotificationBilling
- Esforço: ~80 LOC

**B4. Plugin admin no UI**
- Hoje: tab `admin` não lista plugins, não permite enable/disable
- Alvo: nova seção em `admin-page.tsx`: tabela `plugin_registry`, status, callbacks pending, HMAC config, botão enable/disable, "trigger reconciliation"
- Esforço: ~250 LOC backend (admin routes) + ~200 UI

### Tier 2 — UI/UX (tabs sub-utilizadas viram úteis)

**C1. Promote `contatos` de read-only para reconciliação operacional**
- Adicionar botões: "Reconciliar agora", "Tombstone selecionados", "Re-enqueue stale"
- Mostrar dashboard: rejected_no_match cohort size, drift count, tombstoned/dia (sparkline 14 dias)
- Migrar os 3 scripts Python (`resolve_no_match.py`, `tombstone_deleted.py`, `rescan_active_stale.py`) para endpoints `/admin/reconcile/*` + UI buttons
- Esforço: ~400 LOC (3 endpoints + UI panel + 6 testes)

**C2. Cohort dashboard no `admin`**
- Tile "Saúde do registro de contatos" mostrando:
  - X phones live / Y tombstoned (com sparkline)
  - Cohort `rejected_no_match` atual
  - Last reconciliation timestamp
  - Botão "Run reconciliation now"
- Esforço: ~150 LOC

**C3. Decompor `fleet-page.tsx`** (2175 → ~5 arquivos de 300-500 LOC)
- Subcomponents: ChipsTable, PaymentsCalendar, ChipMessages, ChipReports, ChipDetail
- Sem mudança de comportamento, só manutenção
- Esforço: ~400 LOC de refactor (-2000 do original)

**C4. Wizard de operação ("Quero fazer um disparo")**
- Padrão de mercado observado em Dispara Aí, Clickmassa: 4 passos (canais → audiência → conteúdo → envio)
- Hoje Dispatch tem só `send-form.tsx` cru — operador precisa entender o plugin model
- Alvo: wizard que esconde a complexidade plugin, ajuda operador iniciante
- Esforço: ~600 LOC novo componente

**C5. Health-score visível por sender**
- Inspirado em ProtectZap "quality monitoring"
- Score 0-100 calculado de: ban detections, send failures, ack rate, response rate, volume relative to peers
- Tile no SenderDashboard + cor (verde/amarelo/vermelho)
- Esforço: ~200 LOC

### Tier 3 — Features novas (diferencial competitivo)

**D1. Tipos de conteúdo: áudio, imagem, PDF, sticker, document**
- Concorrência warmup usa 8+ tipos; Dispatch só texto
- Cobrança usa muito boleto PDF + áudio personalizado
- Esforço: estimar 400-800 LOC por tipo (PDF e áudio são os mais úteis)

**D2. Aquecimento bi-direcional ("warmup")**
- Plugin novo: `warmup` recebe lista de números próprios + crontab + tipos de mensagem; envia entre eles para subir reputation
- Padrão BR R$ 30-80/chip/mês — Dispatch poderia oferecer como módulo
- Esforço: ~800 LOC plugin novo + testes

**D3. Scrcpy virtual display para 2× throughput** (Gap #6)
- Research confirmou que funciona: T12-T16
- Habilita 2 workers paralelos no mesmo device físico
- Esforço: alto — ~600 LOC + testes E2E reais
- Risco: médio — virtual displays podem ser instáveis em devices não-Magisk

**D4. WABA paralelo** (Gap #7)
- `com.whatsapp.w4b` em outro profile = dobra senders/device sem novo chip
- Esforço: ~300 LOC; já tem groundwork no `wa-account-mapper`

**D5. Compliance & LGPD audit pack**
- Cobrança no Brasil é regulada (Lei do Superendividamento, BC nº 9, LGPD)
- Endpoint `/admin/export/lgpd` que monta um zip por CPF: todas as msgs, contacts, callbacks, status
- Selo "Compliance LGPD" como diferencial vs Web-tier
- Esforço: ~300 LOC

**D6. A/B testing de templates de mensagem**
- Plugin Oralsin tem msg templates; hoje não há split
- Endpoint `/oralsin/templates/ab` com variantes; engine atribui randomicamente; métricas de response rate por variante
- Esforço: ~250 LOC

### Tier 4 — Operacional / qualidade de vida

**E1. Reconciliação periódica automática**
- Hoje: operador roda `resolve_no_match.py` manualmente
- Alvo: cron interno (1× por dia) que roda lookupDeals + tombstone, surface no admin
- Esforço: ~150 LOC

**E2. Anomaly alerts proativos**
- Trigger Slack/email/socket quando:
  - error_rate > 5% em janela de 1h
  - stale_ui > 10 em janela de 1h
  - Pool tombstoned cresce > 5% num dia
  - Sender quarantined
- Esforço: ~200 LOC + integração webhook

**E3. Job retry/cancel manual no UI**
- Hoje: jobs failed precisam de SQL pra inspecionar/relançar
- Alvo: botão "Retry job" + "Cancel" no admin
- Esforço: ~100 LOC

**E4. Dashboard de custos**
- Comparativo: "se este volume fosse na Meta API custaria R$ X" / "Dispatch custou R$ Y em chips + infra"
- Tile no overview principal
- Argumento comercial direto
- Esforço: ~150 LOC (cost model + UI)

---

## 6. Roadmap proposto (priorização sugerida)

**Sprint 1 (1-2 semanas) — Anti-ban quick wins**
- A1 (variar entryPointSource)
- A3 (quarantine automática)
- E1 (reconciliação periódica)
- C2 (cohort dashboard no admin)

**Sprint 2 (2-3 semanas) — Plugin architecture**
- B1 (decompor Oralsin)
- B2 (Pipedrive como serviço compartilhado)
- B4 (plugin admin no UI)

**Sprint 3 (2-3 semanas) — UX promotion**
- C1 (contatos como reconciliação operacional)
- C3 (decompor fleet)
- C5 (health-score visível)

**Sprint 4 (3-4 semanas) — Performance/escala**
- A2 (on-device script)
- D4 (WABA paralelo)
- D3 (scrcpy virtual display) — se A2+D4 não atingirem meta de throughput

**Sprint 5 (2-3 semanas) — Diferencial competitivo**
- D1 (tipos de conteúdo: PDF + áudio primeiro)
- D2 (warmup module)
- D5 (LGPD audit pack)

---

## 7. Métricas de sucesso sugeridas

- **Ban rate** (bans/1000 msgs): hoje desconhecido, mensurar baseline antes de A1/A2
- **Throughput sustentado** (msgs/h/sender 24h): target 250+ (vs 190 atual)
- **MTTR de ban** (tempo até retomada após sender quarantinado): target < 30 min (com A3)
- **Coverage do pool Pipeboard** (`fresh + stale` / `pool_total`): hoje 9.34%, target 30%+ em 60 dias
- **Customer NPS** se aplicável (Oralsin é cliente captive hoje)

---

## 8. Riscos e premissas

- **Risco de detecção server-side ML do WhatsApp**: research interna confirma que existe e está crescendo. Sprint 1 mitiga, mas roadmap não substitui um Plan B para BSP oficial caso a Meta endureça.
- **Custo de chip e device**: assumimos R$ 50–100/chip BR, R$ 500–1000/POCO. Escala 30 devices = capex ~R$ 30-50k. Vale modelo em planilha.
- **LGPD/Lei 14.181 (Superendividamento)**: cobrança WhatsApp é regulada. D5 não é opcional para enterprise.
- **Concorrência**: nenhum competidor BR oferece o stack Dispatch hoje, mas Bịp Device + Whaticket combinados se aproximam. Janela de 12-18 meses.

---

## Anexo A — Pesos sugeridos para decisão

Para a priorização entre Sprints, sugiro avaliar cada item por:

| Critério | Peso |
|---|---|
| Redução de risco de ban | 30% |
| Throughput / capacidade | 20% |
| Diferenciação vs mercado | 15% |
| Esforço de implementação (inverso) | 15% |
| Compliance / segurança | 10% |
| UX para operador | 10% |

Aplicando ao Sprint 1: A1 e A3 saem com score mais alto que C2/E1 — mas C2/E1 são incluídas no sprint pelo baixo esforço e por habilitarem visibilidade que potencializa A1/A3 (sem cohort dashboard, operador não percebe se A1 melhorou taxa de ban).
