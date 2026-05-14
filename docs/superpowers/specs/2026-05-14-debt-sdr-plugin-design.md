# Design — Plugin `debt-sdr` (multi-tenant SDR outbound)

> **Status**: design aprovado nas 7 seções via brainstorming 2026-05-14.
> **Próximo passo**: invocar `writing-plans` para plano TDD-ready.
> **Constraint vinculante**: hard partition entre tenants e plugins — zero race conditions cross-tenant. User explicit: "muito precisa pois não quero de forma alguma que um device seja confundido pelo outro por race condition".

## 1. Sumário

Novo plugin `debt-sdr` que faz cold outreach multi-tenant orquestrado por Pipedrive. Cada tenant (Oralsin SDR, Sicoob SDR) tem device físico dedicado, senders próprios, sequência de 3 toques (dia 0, 2, 5) com identity gate na entrada (handshake variável). Respostas classificadas por regex + LLM (Claude Haiku 4.5) e propagadas como atualização de stage no Pipedrive do tenant.

**Devices alvo da feature**:
- **POCO C71 #2** (`863d00583048303634510c7e48da4c`) — sem root, locked, 2 senders (WA + WAB) — claimado por `oralsin-sdr`
- **Samsung Galaxy A03** (`R9QT804RWDN`) — sem root, locked, 2 senders já registrados (`5543984016805` em WA, `5543984330739` em WAB) — claimado por `sicoob-sdr`
- **POCO #1 (Serenity)** permanece com `adb-precheck` (cobrança Oralsin), **fora do escopo do SDR**

## 2. Princípios arquiteturais

1. **Plugin-first**: tudo greenfield em `packages/plugins/debt-sdr/`. Core ganha 5 mudanças mínimas, todas com flag de reversão.
2. **Hard partition por tenant**: device claimado por tenant rejeita mensagens de outros tenants (não compartilha). Plugin SDR falha init se claim conflitar — sem "split mode".
3. **Sticky sender por lead**: cada lead tem 1 sender fixo pra toda a sequência. Continuidade conversacional + response routing trivial.
4. **Cobrança intocada**: `oralsin-plugin` legacy (cobrança/billing) NÃO ganha identity gate, NÃO ganha tenant_hint. SDR é fluxo paralelo.
5. **Cascata de custo no classifier**: regex resolve ~70% dos casos a custo zero. LLM só nos ambíguos. Sample para regex training periódico.
6. **Fail-loud**: violations dos invariants (I1-I8) viram métrica Prometheus que paga on-call. Sem fallthroughs silenciosos.

## 3. Componente: isolamento de tenant (G1+G2+G3)

### 3.1 Tabela `device_tenant_assignment`

```sql
CREATE TABLE IF NOT EXISTS device_tenant_assignment (
  device_serial TEXT PRIMARY KEY,
  tenant_name TEXT NOT NULL,
  claimed_by_plugin TEXT NOT NULL,
  claimed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
```

### 3.2 Coluna nova em `sender_mapping`

```sql
ALTER TABLE sender_mapping ADD COLUMN tenant TEXT;
CREATE INDEX IF NOT EXISTS idx_sender_mapping_tenant ON sender_mapping(tenant) WHERE tenant IS NOT NULL;
```

### 3.3 Coluna nova em `messages`

```sql
ALTER TABLE messages ADD COLUMN tenant_hint TEXT;
CREATE INDEX IF NOT EXISTS idx_messages_tenant_hint
  ON messages(tenant_hint, status, created_at)
  WHERE tenant_hint IS NOT NULL;
```

### 3.4 Extensão do `PluginContext`

```ts
// packages/core/src/plugins/types.ts
export interface PluginContext {
  // ... existing
  requestDeviceAssignment(
    deviceSerial: string,
    tenantName: string,
  ): { ok: true } | { ok: false; reason: 'already_claimed'; current_tenant: string; current_plugin: string }

  assertSenderInTenant(
    senderPhone: string,
    tenantName: string,
  ): { ok: true } | { ok: false; reason: 'conflicting_tenant'; current_tenant: string }

  releaseDeviceAssignment(deviceSerial: string): { ok: boolean }
}
```

Wiring no `plugin-loader.ts` segue o mesmo padrão de `registerGeoView` (recém-implementado em 2026-05-13). Loader injeta `pluginName` automaticamente no `releaseDeviceAssignment` — plugin só consegue liberar o que ele claimou.

### 3.5 Filtro de dequeue (G2 — modificação na queue)

```ts
// packages/core/src/queue/message-queue.ts — dequeueBySender
private dequeueTenantFilter(deviceSerial: string): string {
  const a = this.dta.getAssignment(deviceSerial)
  if (!a) return 'AND tenant_hint IS NULL'                  // device livre → só legacy
  return `AND tenant_hint = '${escape(a.tenant_name)}'`     // device claimed → só msgs do tenant
}
```

**Decisão importante**: device claimed **rejeita msgs legacy** (`tenant_hint IS NULL`). Garante que oralsin-plugin legacy nunca envia em POCO #2/Samsung. Pré-condição: SDR plugin no boot valida `sender_mapping WHERE device_serial=? AND (tenant != ? OR tenant IS NULL)` — se houver, init falha com erro listando os conflitos.

## 4. Componente: Identity Gate (exclusivo do SDR)

### 4.1 Posicionamento

Módulo interno do plugin (`packages/plugins/debt-sdr/src/identity-gate/`). Cobrança Oralsin **não usa**.

### 4.2 Schema

```sql
CREATE TABLE sdr_contact_identity (
  tenant TEXT NOT NULL,
  sender_phone TEXT NOT NULL,
  contact_phone TEXT NOT NULL,
  state TEXT NOT NULL,
  -- 'pending' | 'verified' | 'wrong_number' | 'opted_out' | 'no_response'
  intro_message_id TEXT,
  nudge_message_id TEXT,
  classification TEXT,
  classifier_confidence REAL,
  raw_response TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant, sender_phone, contact_phone)
);
```

### 4.3 State machine

```
[lead pronto pra cold-1]
  ↓
[contact_phone tem outgoing em message_history?]
  ├─ sim → skip gate, marca verified, prossegue cold-1
  └─ não → enqueue handshake intro (template hash(phone)%N)
                       ↓
                  state=pending
                       ↓
              ┌────────┼────────────┬──────────┐
              ▼        ▼            ▼          ▼
       identity_   identity_     timeout    opted_out
       confirm     deny         48h sem    detectado
              │        │         reply         │
              ▼        ▼            ▼          ▼
       state=     state=         enqueue     state=
       verified   wrong_num.     nudge       opted_out
       prossegue  STOP+blkl-     state=      blacklist
       cold-1     temp 30d       pending     permanente
                                  ↓
                          ┌───────┴───────┐
                          ▼               ▼
                     resp recv.        timeout 96h
                          │               │
                       classify       state=no_response
                                       STOP
```

### 4.4 Pool de templates

20-30 variações por categoria (`INTRO`, `NUDGE`), placeholders `{nome}`, `{empresa}`. Seleção via `sha256(contact_phone)[:8] % N` — determinística, mesmo contato sempre vê a mesma variação.

### 4.5 Regra de gating

```sql
SELECT 1 FROM message_history
WHERE from_number = $sender AND to_number = $contact
  AND direction = 'outgoing'
LIMIT 1
```
Vazio → handshake. Existe → skip.

## 5. Componente: Tenant config + Pipedrive

### 5.1 Estrutura de configuração

```jsonc
// packages/plugins/debt-sdr/config.example.json
{
  "tenants": [
    {
      "name": "oralsin-sdr",
      "label": "Oralsin",
      "pipeboard_tenant": "oralsin",            // metadata pra otimização futura
      "pipedrive": {
        "domain": "oralsin-xyz",
        "api_token_env": "PIPEDRIVE_TOKEN_ORALSIN_SDR",
        "pull": {
          "stage_id": 5,
          "poll_interval_minutes": 15,
          "batch_size": 50,
          "max_age_days": 30,
          "phone_field_key": "phone"
        },
        "writeback": {
          "stage_qualified_id": 6,
          "stage_disqualified_id": 7,
          "stage_needs_human_id": 8,
          "stage_no_response_id": 9,
          "activity_subject_template": "SDR: {{outcome}}"
        }
      },
      "devices": ["863d00583048303634510c7e48da4c"],
      "senders": [
        { "phone": "554399XXXXXXX", "app": "com.whatsapp" },
        { "phone": "554399XXXXXXX", "app": "com.whatsapp.w4b" }
      ],
      "sequence_id": "oralsin-cold-v1",
      "throttle": {
        "per_sender_daily_max": 40,
        "min_interval_minutes": 8,
        "operating_hours": { "start": "09:00", "end": "18:00" },
        "tz": "America/Sao_Paulo"
      },
      "identity_gate": {
        "enabled": true,
        "nudge_after_hours": 48,
        "abort_after_hours": 96
      }
    },
    {
      "name": "sicoob-sdr",
      "label": "Sicoob",
      "pipeboard_tenant": "tenant_sicoob",
      "pipedrive": {
        "domain": "sicoob-xyz",
        "api_token_env": "PIPEDRIVE_TOKEN_SICOOB_SDR",
        "pull": { /* análogo */ },
        "writeback": { /* análogo */ }
      },
      "devices": ["R9QT804RWDN"],
      "senders": [
        { "phone": "5543984016805", "app": "com.whatsapp" },
        { "phone": "5543984330739", "app": "com.whatsapp.w4b" }
      ],
      "sequence_id": "sicoob-cold-v1",
      "throttle": { "per_sender_daily_max": 30, /* ... */ },
      "identity_gate": { "enabled": true, "nudge_after_hours": 48, "abort_after_hours": 96 }
    }
  ]
}
```

### 5.2 TenantPipedriveClient

Refactor leve do `adb-precheck/pipedrive-api.ts`: extrai classe `PipedriveHttpClient(domain, token)`. SDR mantém `Map<tenantName, TenantPipedriveClient>` — uma instância por tenant ativo. Adb-precheck continua single-instance (zero behavior change).

API mínima:
- `getDealsByStage(stageId, opts)`
- `updateDealStage(dealId, stageId)`
- `createActivity(dealId, payload)`
- `addNote(dealId, content)`

Rate limit: token bucket 35 req/s (cap de 80 req/2s da Pipedrive). Retry exponencial em 5xx + respect `Retry-After` em 429.

### 5.3 Tabela `sdr_lead_queue`

```sql
CREATE TABLE sdr_lead_queue (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  pipedrive_deal_id INTEGER NOT NULL,
  contact_phone TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  pipedrive_context_json TEXT,
  pulled_at TEXT NOT NULL,
  state TEXT NOT NULL,
  -- 'pulled' | 'gating' | 'sequencing' | 'completed' | 'aborted'
  stop_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(tenant, pipedrive_deal_id)
);
```

### 5.4 Pull worker

Cron interno do plugin (`setInterval(15min)`). Para cada tenant: GET deals filtrados, dedup por `UNIQUE(tenant, deal_id)`, blacklist check, insert em `sdr_lead_queue`. Throttle/operating_hours são gated pelo sequencer/engine (não pelo pull) — pull pode rodar 24/7.

### 5.5 Writeback flow

Plugin recebe `patient_response` via webhook callback do core → classifier → branch:
- `interested` → updateDealStage(qualified) + activity
- `not_interested` → updateDealStage(disqualified)
- `opted_out` → blacklist + activity + STOP
- `question` → updateDealStage(needs_human)
- `identity_confirm` → identity gate marca verified, sequencer engata cold-1
- `identity_deny` → blacklist temporário 30d, STOP
- `ambiguous` → operator alert (humano classifica)

Failed writeback → `sdr_pending_writebacks` table com retry exponencial (mesmo padrão de `failed_callbacks` do core).

## 6. Componente: Sequence FSM (3 toques)

### 6.1 Tabela `sdr_sequence_state`

```sql
CREATE TABLE sdr_sequence_state (
  lead_id TEXT PRIMARY KEY REFERENCES sdr_lead_queue(id) ON DELETE CASCADE,
  sequence_id TEXT NOT NULL,
  sender_phone TEXT NOT NULL,           -- sticky, sticky, sticky
  current_step INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  -- 'pending_gate' | 'awaiting_identity' | 'running' | 'awaiting_response' | 'completed' | 'aborted'
  next_action_at TEXT NOT NULL,
  last_message_id TEXT,
  last_message_sent_at TEXT,
  last_response_at TEXT,
  last_response_classification TEXT,
  attempts_total INTEGER NOT NULL DEFAULT 0,
  stop_reason TEXT,
  processing_lock TEXT,                 -- A5 backstop
  processing_lock_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### 6.2 Sequence definition (declarativa)

```ts
export const oralsinColdV1: SequenceDefinition = {
  id: 'oralsin-cold-v1',
  max_attempts: 3,
  steps: [
    { step: 1, name: 'cold-1', delay_from_previous_hours: 0,  ttl_hours: 48, template_pool_id: 'oralsin-cold-1-pt-br' },
    { step: 2, name: 'cold-2', delay_from_previous_hours: 48, ttl_hours: 72, template_pool_id: 'oralsin-cold-2-pt-br' },
    { step: 3, name: 'cold-3', delay_from_previous_hours: 72, ttl_hours: 96, template_pool_id: 'oralsin-cold-3-pt-br' },
  ],
}
```

3 toques: dia 0, dia 2, dia 5. Análogo pra `sicoob-cold-v1`. Cada step tem pool de 7-10 templates pt-BR; seleção determinística via `sha256(contact_phone:step)`.

### 6.3 Sequencer tick (cron 5min)

```ts
async tick(): Promise<TickResult> {
  // 1. UPDATE ... SET processing_lock=? WHERE processing_lock IS NULL AND next_action_at <= now() LIMIT 50 (A5 backstop)
  // 2. Pra cada row: switch(status):
  //    - pending_gate → kickoffIdentityGate
  //    - awaiting_identity → identityTimeout (nudge ou abort)
  //    - awaiting_response → responseTtlHit (advance ou no_response)
  //    - running → enqueueNextStep
  // 3. Throttle/operating-hours gate antes de enqueue real → defer se fora do horário
  // 4. Idempotency key: `sdr-${tenant}-${lead_id}-step-${n}` (I8 garante at-most-once)
}
```

### 6.4 Sticky sender

Sender é escolhido na inserção do `sdr_sequence_state` (round-robin ponderado por health) e **NUNCA muda** entre cold-1, cold-2, cold-3. Continuidade conversacional + response routing trivial.

Se sender ficar quarantined entre steps: `enqueueNextStep` detecta, defere +30min, próximo tick escolhe outro sender do mesmo tenant (se houver) ou espera released.

## 7. Componente: Response Classifier (regex + LLM híbrido)

### 7.1 Categorias

```ts
type ClassificationCategory =
  | 'identity_confirm' | 'identity_deny'           // identity phase
  | 'interested' | 'not_interested' | 'question'   // sequence phase
  | 'opted_out'                                     // cross-cutting
  | 'ambiguous'                                     // escala humano
```

### 7.2 Pipeline cascata

1. **Regex first-pass** (custo zero, ~70% hit rate): patterns por categoria, ordem priorizada (opt-out > identity_deny > identity_confirm > rest). Hit retorna confidence=1.0.
2. **LLM fallback** (Claude Haiku 4.5, ~$0.001/resp, ~700ms): só nos miss do regex. Confidence threshold 0.7 — abaixo disso retorna `ambiguous` → operator alert.
3. **Phase gating**: identity phase aceita apenas `identity_confirm`/`identity_deny`/`opted_out`. Outros viram `ambiguous`. Sequence phase aceita todos.

### 7.3 Tabela de auditoria

```sql
CREATE TABLE sdr_classifier_log (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  response_text TEXT NOT NULL,
  category TEXT NOT NULL,
  confidence REAL NOT NULL,
  source TEXT NOT NULL,                  -- 'regex' | 'llm' | 'llm_low_conf' | 'llm_error'
  llm_reason TEXT,
  latency_ms INTEGER NOT NULL,
  classified_at TEXT NOT NULL
);
```

Loga TUDO (incluindo regex hits) pra training periódico — extrai padrões frequentes do LLM e adiciona às regex pra reduzir custo.

### 7.4 Métricas observáveis

```
sdr_classifier_total{source="regex|llm|llm_low_conf|llm_error", category="..."}
sdr_classifier_latency_ms{source="..."}
sdr_classifier_ambiguous_rate           # alvo <10%
sdr_classifier_llm_cost_usd_total       # cap soft em $1/h
```

## 8. Garantias formais contra race conditions

### 8.1 Safety invariants (NUNCA podem ser violadas)

| # | Invariant | Mecanismo |
|---|---|---|
| **I1** | Device claimed por tenant X jamais executa msg com `tenant_hint ≠ X` | G2 queue dequeue filter (atomic SQL) |
| **I2** | Plugin só pode release device que ELE claimou | `pluginName` injetado pelo loader; SQL `WHERE claimed_by_plugin=?` |
| **I3** | `sender_mapping.tenant` é monotonic por phone | `setSenderTenant` throw em conflict |
| **I4** | Response entregue ao plugin SÓ se sender da resposta pertence ao tenant da msg | G5 webhook-handler tightening |
| **I5** | `sdr_contact_identity.state` muda só via classifier output OU operator action | Transitions enumeradas, sem fallthroughs |
| **I6** | Nunca 2 sends concorrentes no mesmo device | DeviceMutex (existing) |
| **I7** | Nunca 2 sends concorrentes no mesmo sender | AccountMutex (existing) |
| **I8** | Sequencer NUNCA processa `(lead_id, step_n)` 2x | `idempotencyKey` UNIQUE em messages |

### 8.2 Cenários adversariais cobertos

A1 (concurrent device claim), A2 (cross-plugin release), A3 (cross-tenant sender enqueue), A4 (lead em ambos tenants responde), A5 (cron tick parallel — backstop `processing_lock`), A6 (plugin reload mid-sequence), A7 (duplicate WAHA webhook), A8 (sender quarantined mid-tick), A9 (legacy plugin send to claimed device), A10 (operator manual sender_mapping edit).

Todos com test cases dedicados em `race-conditions.test.ts`.

### 8.3 Observability

Métricas Prometheus com alerta on-call em qualquer incremento de `sdr_invariant_violation_total{invariant="I*"}`. Outros são counters/gauges pra trend analysis.

## 9. Mudanças no core (resumo)

| Gap | Arquivo | Tipo | Reversível? |
|---|---|---|---|
| G1 | `engine/sender-mapping.ts` | ADD column `tenant` + setter | ✅ column nullable |
| G2 | `engine/device-tenant-assignment.ts` (NEW), `queue/message-queue.ts` (dequeue) | NEW table + filter modification | ✅ feature flag `DISPATCH_QUEUE_TENANT_FILTER=false` |
| G3 | `plugins/types.ts`, `plugins/plugin-loader.ts` | PluginContext extension | ✅ plugins legacy não usam |
| G4 | `plugins/adb-precheck/pipedrive-api.ts` | Extract `PipedriveHttpClient` class | ✅ refactor sem behavior change |
| G5 | `server.ts:1115-1145` | Response tightening | ✅ feature flag `DISPATCH_RESPONSE_STRICT_TENANT=false` |
| G6 | `packages/plugins/debt-sdr/` | NEW plugin (greenfield) | ✅ disable via admin API |

### Estimativa de esforço

| Componente | LOC | Test LOC | Risk |
|---|---|---|---|
| G1 (sender tenant) | ~50 | ~80 | Baixo |
| G2 (assignment + queue filter) | ~180 | ~250 | Médio (queue é hot path) |
| G3 (PluginContext) | ~70 | ~120 | Baixo |
| G4 (Pipedrive refactor) | ~100 | ~80 | Baixo |
| G5 (response tightening) | ~30 | ~80 | Médio (race) |
| G6 (plugin SDR completo) | ~2500 | ~1500 | Médio-alto |
| **Total** | **~2930 LOC** | **~2110 test LOC** | |

## 10. Estrutura de arquivos (plugin SDR)

```
packages/plugins/debt-sdr/
├── manifest.json
├── package.json
├── config.example.json
├── src/
│   ├── index.ts                         # DispatchPlugin entry
│   ├── sdr-plugin.ts                    # main class
│   ├── config/
│   │   ├── tenant-config.ts            # Zod schema + loader
│   │   └── config-validator.ts
│   ├── pipedrive/
│   │   ├── tenant-pipedrive-client.ts
│   │   └── lead-extractor.ts
│   ├── pull/
│   │   └── lead-puller.ts
│   ├── identity-gate/
│   │   ├── identity-gate.ts
│   │   ├── templates.ts
│   │   └── template-selector.ts
│   ├── sequences/
│   │   ├── sequencer.ts
│   │   ├── sequence-definition.ts
│   │   ├── templates/
│   │   │   ├── oralsin-cold-v1.ts
│   │   │   └── sicoob-cold-v1.ts
│   │   └── template-pools/
│   │       ├── oralsin-cold-1-pt-br.ts
│   │       ├── oralsin-cold-2-pt-br.ts
│   │       └── oralsin-cold-3-pt-br.ts
│   ├── classifier/
│   │   ├── classifier.ts
│   │   ├── regex-patterns.ts
│   │   └── llm-classifier.ts
│   ├── responses/
│   │   └── response-handler.ts
│   ├── throttle/
│   │   └── throttle-gate.ts
│   ├── db/
│   │   └── migrations.ts
│   ├── routes/
│   │   ├── admin-routes.ts
│   │   └── operator-routes.ts
│   └── __tests__/
│       ├── fixtures/
│       ├── classifier.test.ts
│       ├── identity-gate.test.ts
│       ├── sequencer.test.ts
│       ├── lead-puller.integration.test.ts
│       ├── race-conditions.test.ts
│       └── e2e-sdr.test.ts
```

## 11. Testing strategy

### Pyramid

- **Unit ~100 tests**: classifier patterns (40), identity gate (20), sequencer (15), throttle (8), Pipedrive client (10), G1-G3-G5 core changes (~19)
- **Integration ~35 tests**: plugin init flow (4), pull worker (5), sequencer + queue (6), response routing (3), adversarial races A1-A10 (10), Pipedrive mock + writeback (7)
- **E2E ~5-8 tests**: gated por `RUN_E2E=true`, real ADB send pra `5543991938235` (TEST_PHONE_NUMBER per CLAUDE.md), Pipedrive sandbox

### Coverage targets

- Classifier 95% / Identity gate 95% / Sequence FSM 90% / DeviceTenantAssignment 95% / Webhook tightening 95% / Throttle 90% / Pull worker 80%

### CI gates

Lint + typecheck (0 errors) → Unit (100% pass, coverage ≥80%) → Integration (100% pass) → Adversarial races A1-A10 (100% pass) → E2E (manual, pre-release).

### Operational rollout

1. **Smoke** (10min) — `/health` checks
2. **Canary** (1d) — tenant `test-sdr` com 5 leads sintéticos
3. **Limited rollout** (3d) — Oralsin SDR `daily_max=10`, operador classifica ambiguous → patterns regex aprendidas
4. **Full rollout** — Oralsin SDR `daily_max=40` + Sicoob SDR ativado

## 12. Quality gates pra ship

- [ ] Todos os 8 invariants têm test case dedicado e passam
- [ ] 10 cenários adversariais A1-A10 cobertos
- [ ] Coverage backend ≥80%, componentes críticos ≥95%
- [ ] E2E manual com TEST_PHONE_NUMBER bem-sucedido + screenshot em `reports/`
- [ ] Plugin isolation verificada via admin disable: SDR off → todas suas views/routes somem, devices liberados; SDR on → restaurado
- [ ] Métricas Prometheus expostas e gravadas com sample run de 100+ responses
- [ ] Documentação: runbook `docs/operations/sdr-runbook.md` + config example

## 13. Riscos + mitigations

| Risco | Probabilidade | Mitigação |
|---|---|---|
| **Pipedrive rate-limit em ramp-up** | Média | Token bucket client-side, respeitar `Retry-After`, throttle de pull batch |
| **LLM (Anthropic) instabilidade** | Baixa | Fallback `ambiguous` + operator alert. Sem degradação aguda |
| **Classifier acurácia <70% em 1ª semana** | Média | Sample classifier_log → adicionar regex patterns observadas. Coverage cresce ao longo de 30d |
| **Lead em ambos tenants** | Baixa | I4 + sticky sender garante separação. Edge case (mesmo phone respondendo a thread errada) registrado |
| **Bateria devices novos** | Alta (já visto) | Carregamento contínuo + monitor alert em <30% |
| **Bloqueio WhatsApp por volume** | Média | `daily_max` conservador no início (10→40), warmup gradual, sender pool rotation (4 senders novos) |
| **Race condition real em prod** | **Crítica se ocorrer** | 10 testes adversariais + métrica `invariant_violation_total` paga on-call → rollback feature flags G2/G5 |
| **POCO #2 desligar/reiniciar mid-sequence** | Baixa | State persistido em SQLite, sequencer retoma após reconnect. DeviceMutex segura sends em transit |

## 14. Não-objetivos (explícitos)

- **Cobrança/billing**: SDR é cold outreach. Cobrança Oralsin segue com seu fluxo atual via `oralsin-plugin`. Sem fusão.
- **Multi-user no mesmo device**: POCO #2 e Samsung são single-user. Sem necessidade de root.
- **Conversação completa**: pós-`qualified` ou `needs_human`, humano assume o lead. Plugin SDR não conduz negociação.
- **NLU profunda**: classifier categoriza em 7 buckets. Não interpreta nuances de tom, sarcasmo ou contexto longo.
- **A/B testing de templates**: deferido — pool com seleção determinística por hash. A/B fica pra Sprint futuro com instrumentação dedicada.
- **Cold call via voz**: só WhatsApp text.
- **Multi-idioma**: pt-BR only nesta versão.
- **Reabertura automática de leads `completed`**: deal precisa ser movido no Pipedrive pra outra stage pelo operador. Plugin SDR não re-engaja sozinho.

---

**Próximo passo**: invocar `superpowers:writing-plans` para produzir plano TDD-ready (estimado 40-50 tasks, 5 fases).
