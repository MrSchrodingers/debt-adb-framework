# Plan: Anti-Ban + Fleet Management Roadmap

**Date**: 2026-04-28
**Status**: Proposed
**Owner**: Matheus
**Estimated**: 5-7 semanas (7 fases obrigatórias + 1 opcional)

---

## Summary

Roadmap de produto consolidando 5 features convergentes (análise interna + research competitivo) + 1 opcional, endereçando 4 dores reais do usuário:

1. **Ban rate alto via WAHA GOWS** (problema sistêmico, confirmado em issues `devlikeapro/waha` #1362/#1610/#1456/#1584/#1159)
2. **Gestão interna de custos da frota de chips** (CapEx aquisição + OpEx mensal + ciclo de vida) — **NÃO É STRIPE**, é controle financeiro interno do parque de chips que hoje é planilha solta
3. **Auditoria ponta-a-ponta fragmentada** entre Pipeboard/Oralsin/Dispatch/Chatwoot
4. **Pipeline cold-outbound** sujeito a ban — opcional pivot pra inbound-first

## Non-goals

- ❌ Stripe / pagamento de cliente / subscription multi-tenant SaaS
- ❌ BSP integration / WhatsApp Business API oficial
- ❌ ML/LLM features (separate roadmap)
- ❌ Mobile companion app (PWA atual basta)
- ❌ Distributed dispatch multi-region (overkill no estágio atual)

---

## Strategic Context

| Findings | Implicação |
|---|---|
| BipDevice (vietnamita) tem ROM custom rotacionando IMEI/MAC/SIM-info nativamente | POCO C71 com root já tem a base — falta plumbing |
| WAHA GOWS bans são problema sistêmico (5+ issues abertas em 2026) | ADB-first não é hedge — é a estratégia |
| Maturação de chip é commodity no mercado BR (WMI, Esquenta Chip) | Sem warmup orchestrator, Dispatch atrás do padrão |
| Meta Out/2025: limites por Business Portfolio, não por número | Considerar se algum dia integrar WABA |
| Honeymoon surveillance Meta: ~20 sinais nas 1ª 24h de chip novo | Warmup precisa proteção especial T+0 a T+24h |
| Quality Score já parcial (calibrator + BPD per-sender override) | Falta consolidar em score + dashboard |

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                       DISPATCH ROADMAP V2                            │
│                                                                      │
│  ┌─────────────┐                                                     │
│  │  Phase 1    │   Warmup Orchestrator + Honeymoon (5-7d)            │
│  └──────┬──────┘                                                     │
│         │                                                            │
│  ┌──────▼──────┐                                                     │
│  │  Phase 1.5  │   Template Engine + Linter (2d) ← anti-ban concreto │
│  └──────┬──────┘                                                     │
│         │                                                            │
│  ┌──────▼──────┐                                                     │
│  │  Phase 2    │   Quality Dashboard + Burst Detector (4-5d)         │
│  └──────┬──────┘                                                     │
│         │                                                            │
│  ┌──────▼──────────────┐    ┌──────────────────────┐                 │
│  │  Phase 4            │    │  Phase 3             │                 │
│  │  DDD Router +       │    │  Chip Cost Manager   │                 │
│  │  Fingerprint Rot.   │    │  + Bulk Import       │                 │
│  └──────┬──────────────┘    │  (parallel track)    │                 │
│         │                   └──────────────────────┘                 │
│  ┌──────▼──────┐                                                     │
│  │  Phase 5    │   E2E Correlation Timeline (3-4d)                   │
│  └──────┬──────┘                                                     │
│         │                                                            │
│  ┌──────▼──────┐                                                     │
│  │  Phase 5.5  │   LGPD Compliance Suite (2-3d) ← enterprise BR      │
│  └──────┬──────┘                                                     │
│         │                                                            │
│  ┌──────▼──────────┐                                                 │
│  │  Phase 6 (OPT)  │   Inbound-First Funnel (7-10d)                  │
│  └─────────────────┘                                                 │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  Cross-cutting Phase 7: Headless API Hardening                 │  │
│  │  (threads através das phases 1-5.5: OpenAPI, SSE, NDJSON,      │  │
│  │  sender CRUD, outbound webhooks, idempotency-key)              │  │
│  └────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Phase 1: Warmup Orchestrator + Honeymoon Protection

**Deps**: módulo `engine/sender-warmup.ts` já existe (foundation)
**Esforço**: 5-7 dias
**Issue GitHub**: #(criar)

### Goal
Máquina de estado que automaticamente agenda curva de warmup 30d para chip novo. Protege janela de honeymoon (T+0 a T+24h). Mistura tráfego sintético inter-chip com tráfego real low-priority.

### State Machine

```
NEW (chip recém-cadastrado)
  └─► HONEYMOON  (T+0 a T+24h: max 5 msgs, só sintético, sem horário pico)
        └─► WARMING_P1  (D2-7:   5-20 msgs/dia, mix sintético + real)
              └─► WARMING_P2  (D8-14:  20-80 msgs/dia)
                    └─► WARMING_P3  (D15-21: 80-300 msgs/dia)
                          └─► WARMING_P4  (D22-30: 300-1000 msgs/dia)
                                └─► ACTIVE  (full volume)
                                      └─► QUARANTINED  (ban detected)
                                            └─► RETIRED  (3 quarantines OR operator)
```

### Files

```
CREATE:
  packages/core/src/engine/warmup-orchestrator.ts          (state machine)
  packages/core/src/engine/warmup-curve.ts                 (daily volume calculator)
  packages/core/src/engine/synthetic-warmup.ts             (chip↔chip generator)
  packages/core/src/engine/honeymoon-guard.ts              (T+0..T+24h rules)
  packages/core/src/engine/warmup-orchestrator.test.ts
  packages/core/src/engine/warmup-curve.test.ts
  packages/core/src/engine/synthetic-warmup.test.ts
  packages/core/src/engine/honeymoon-guard.test.ts
  packages/core/src/api/warmup.ts                          (REST: state, advance, override, schedule)
  packages/ui/src/components/warmup-console.tsx            (UI dashboard)

MODIFY:
  packages/core/src/queue/message-queue.ts                 (consume warmup cap on dequeue)
  packages/core/src/engine/worker-orchestrator.ts          (warmup-aware throttling)
  packages/core/src/server.ts                              (wire orchestrator + routes)

DB MIGRATIONS (idempotent CREATE IF NOT EXISTS):
  chip_warmup_state    (chip_phone, current_phase, started_at, advanced_at, daily_volume_cap, msgs_today)
  synthetic_messages   (id, sender_phone, recipient_phone, text, generated_at, delivered_at, is_synthetic=1)
  warmup_overrides     (chip_phone, action, operator, occurred_at, reason)
```

### Curva Detalhada

| Fase | Dias | Cap diário | Mix sintético/real | Restrições especiais |
|---|---|---|---|---|
| HONEYMOON | T+0 a T+24h | 5 | 100% sintético | Sem horário pico (10h-18h evitar), sem broadcast pattern, sem grupos |
| WARMING_P1 | D2-7 | 20 | 70/30 | Sem broadcast, max 5 destinatários únicos/dia |
| WARMING_P2 | D8-14 | 80 | 40/60 | Volume crescente intra-fase (jitter ±15%) |
| WARMING_P3 | D15-21 | 300 | 20/80 | Permite broadcast peq. (≤50 dest), variar template |
| WARMING_P4 | D22-30 | 1000 | 5/95 | Quase produção, métrica de ack-rate sob observação |
| ACTIVE | D30+ | sem cap | 0/100 | Volume normal, sob Quality Score (Phase 2) |

### Synthetic Group Warming

Pool de chips em WARMING_P1+ conversa entre si com mensagens orgânicas:
- Library de seeds: 200+ trocas naturais ("oi tudo bem", "vc tá bem?", "tô em casa", emojis)
- Cadência: 2-8h entre mensagens, peso na hora do dia (mais à noite/manhã)
- Length variation, typing cadence (delay 30s-3min antes de "send")
- Tagged em DB com `is_synthetic=1` → excluído de billing/metrics públicos

### Acceptance Criteria

- [x] Chip novo entra `NEW → HONEYMOON` automaticamente ao ser inserido em `sender_mapping`
- [x] Cap diário enforced via queue (mensagens sobre o cap ficam em `pending` até next-day reset)
- [x] Operator pode `skip-warmup` com audit log (auditável)
- [x] Synthetic messages NÃO aparecem em `/api/v1/messages` (filtro `is_synthetic`)
- [x] Honeymoon guard bloqueia mensagem real (não-sintética) durante T+0..T+24h
- [x] Tests TDD: state transitions (todas), curve calculator, synthetic distribution, honeymoon enforcement
- [x] E2E: cadastra chip novo no sender_mapping → confirma transição automática para HONEYMOON em <60s

### Risks

| Risk | Mitigation |
|---|---|
| Synthetic conversations detectáveis se padronizadas | Variação heavy: cadência, length, time-of-day, weekend ≠ weekday |
| Dois chips warming trocam msg idêntica (spike) | Hash dedup last-N entre pares |
| Synthetic competindo com workload real por device-time | Priority class na queue: real > synthetic, synthetic só quando device idle |
| Carrier vê tráfego só p/ outros chips do mesmo CPF (suspeito) | Mix com seeds incluindo números fora da frota (whitelist 10-20 contatos amigáveis) |

---

## Phase 1.5: Template Engine + Personalization Linter

**Deps**: Phase 1 (warmup é onde primeiro chip novo precisa de template)
**Esforço**: 2 dias
**Issue**: #(criar)

### Goal
Mensagens hoje vão hardcoded ou interpoladas client-side antes de enqueue. Risco: `Olá {nome}` literal escapa = giveaway óbvio de bot. Engine server-side força interpolação + linter bloqueia send com placeholder não-substituído. Audit registra qual template gerou cada mensagem.

### Schema

```sql
CREATE TABLE IF NOT EXISTS message_templates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,                            -- null = global, else plugin/tenant scope
  name TEXT NOT NULL,
  body TEXT NOT NULL,                        -- "Olá {nome}, sua fatura..."
  required_vars_json TEXT NOT NULL,          -- ["nome", "valor", "vencimento"]
  optional_vars_json TEXT,
  approved_by_operator TEXT NOT NULL,        -- audit
  approved_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',     -- active, deprecated, archived
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, name)
);

ALTER TABLE messages ADD COLUMN template_id TEXT;  -- audit qual template gerou
```

### Files

```
CREATE:
  packages/core/src/templates/template-engine.ts        (interpolação server-side)
  packages/core/src/templates/template-engine.test.ts
  packages/core/src/templates/template-linter.ts        (detecta placeholders sobrando)
  packages/core/src/templates/template-linter.test.ts
  packages/core/src/templates/template-registry.ts      (CRUD)
  packages/core/src/templates/template-registry.test.ts
  packages/core/src/api/templates.ts                    (REST)
  packages/ui/src/components/templates/builder.tsx
  packages/ui/src/components/templates/library.tsx

MODIFY:
  packages/core/src/queue/message-queue.ts              (linter pré-enqueue)
  packages/core/src/plugins/oralsin/index.ts            (aceita template_id no enqueue)
```

### Linter Rules

```typescript
// Pré-send pipeline:
const placeholders = body.match(/\{[a-zA-Z_][a-zA-Z0-9_]*\}/g) ?? []
if (placeholders.length > 0) {
  throw new TemplateLintError({
    code: 'UNSUBSTITUTED_PLACEHOLDER',
    placeholders,
    body,
  })
}

// Detecta também:
// - emoji obviamente repetitivo (mesmo emoji 5+ vezes seguidas)
// - URLs encurtadas conhecidas em blocklist (bit.ly, tinyurl etc — flagged como spam-like)
// - bloco de capslock ≥10 char consecutivos
// - mais de 3 quebras de linha consecutivas (formatting estranho)
```

### API

```
GET    /api/v1/templates                        (filtros: tenant, status)
POST   /api/v1/templates                        (cria + aprovação operator)
GET    /api/v1/templates/:id
PATCH  /api/v1/templates/:id/deprecate
POST   /api/v1/templates/:id/render             (preview com vars substituídas)
POST   /api/v1/templates/lint                   (lint ad-hoc body sem template salvo)
```

### Acceptance
- [x] POST /messages com `{ template_id, vars: {...} }` interpola server-side
- [x] Bypass legacy (POST /messages com `text` direto) ainda funciona, mas passa pelo linter
- [x] Linter bloqueia mensagem com placeholder sobrando + retorna erro estruturado
- [x] message_history audita `template_id` usado
- [x] Tests: interpolation correctness, missing-var detection, optional-var handling, edge cases (vars com chaves duplas `{{escape}}`, unicode)

---

## Phase 2: Number Quality Dashboard

**Deps**: Phase 1 (warmup state alimenta score)
**Esforço**: 4-5 dias
**Issue**: #(criar)

### Goal
Score composto 0-100 por sender, atualizado horariamente. Auto-pause se queda >30 pontos em 24h OR score absoluto <40. Dashboard visual + cohort analytics.

### Score Formula

```typescript
qualityScore = clamp(0, 100, Math.round(
    0.30 * ackRateScore         // P05 do read-rate normalizado vs benchmark fleet
  + 0.20 * banHistoryScore       // 1 - exp(-days_since_last_ban / 30)
  + 0.15 * ageScore              // 1 - exp(-account_age_days / 90)
  + 0.10 * warmupCompletion      // (warmup_phase / 5)
  + 0.10 * volumeFitScore        // gaussian centrada no cap diário da fase
  + 0.10 * fingerprintFreshness  // 1 - (days_since_rotation / 30)
  + 0.05 * recipientResponseRate // incoming / outgoing últimos 7d
) * 100)
```

### Auto-Pause Triggers

- **Score absoluto < 40**: pause + Telegram severity warning
- **Δ score > -30 em 24h**: pause + Telegram severity error
- **Burst detector**: ≥3 senders entrando QUARANTINED em <10min → fleet-wide auto-pause + Telegram critical
- Operator unpause exige confirmação UI (modal "Are you sure? Reason:")

### Files

```
CREATE:
  packages/core/src/research/quality-score.ts
  packages/core/src/research/quality-score.test.ts
  packages/core/src/research/quality-watcher.ts        (cron horário + auto-pause)
  packages/core/src/research/quality-watcher.test.ts
  packages/core/src/research/burst-detector.ts
  packages/core/src/research/burst-detector.test.ts
  packages/core/src/api/quality.ts                     (REST: summary, trend/:phone, components/:phone, cohort)
  packages/ui/src/components/quality-dashboard.tsx     (substitui ack-rate-page como tab principal)

MODIFY:
  packages/core/src/research/ban-prediction-daemon.ts  (consulta quality score além de ack-rate)
  packages/core/src/server.ts                          (wire quality watcher + cron)

DB:
  chip_quality_history  (chip_phone, computed_at, total_score, components_json)
```

### Cohort Analytics
- Group senders by `acquisition_month × carrier × DDD`
- Show ban-rate ao longo do tempo (cohort retention curve)
- Identifica canais de aquisição ruins (ex: chips Vivo de mar/26 banando 2× mais que Claro)

### Acceptance
- [x] Score recomputado a cada hora para todos os senders ACTIVE/WARMING_P*
- [x] Auto-pause dispara em <2min após threshold cross
- [x] Burst detector dispara fleet-wide pause em <30s
- [x] Dashboard mostra: ranking senders, components per-sender, trend 30d, cohort table
- [x] Tests: pure scorer, watcher logic, burst detector window, auto-pause idempotency

---

## Phase 3: Internal Chip Cost Manager  ← **ATENÇÃO: NÃO É STRIPE**

**Deps**: nenhuma (track paralelo)
**Esforço**: 4-5 dias
**Issue**: #(criar)

### Goal — clarificado pelo usuário
**Gestão interna de pagamento dos chips da frota.** Hoje é planilha solta / nada. Resolve:

1. Quanto custou cada chip pra adquirir (R$, data, fornecedor, NF)
2. Quanto custa por mês manter o plano (carrier, plan name, dia do vencimento, valor)
3. Quem do time pagou (operador X / cartão Y / método Z), com receipt anexado
4. Histórico de eventos (chip banido, chip retirado, plano mudou, transferido)
5. ROI por chip (R$ gasto vs msgs entregues)
6. Alertas: plano vencendo, plano em atraso, chip caro com volume baixo
7. Renewal calendar: tela mensal de "o que precisa pagar nos próximos 30d"

**Sem cobrança externa, sem tenant subscription, sem Stripe. É CFO interno da frota.**

### DB Schema

```sql
CREATE TABLE IF NOT EXISTS chips (
  id TEXT PRIMARY KEY,
  phone_number TEXT NOT NULL UNIQUE,
  carrier TEXT NOT NULL,                    -- vivo, claro, tim, oi, surf, etc
  plan_name TEXT NOT NULL,                  -- "Vivo Controle 30GB", etc
  acquisition_date TEXT NOT NULL,
  acquisition_cost_brl REAL NOT NULL,       -- preço do chip + ativação
  monthly_cost_brl REAL NOT NULL,
  payment_due_day INTEGER NOT NULL,         -- 1-31, dia do vencimento
  payment_method TEXT,                      -- "cartão Inter 1234", "Pix CNPJ", etc
  paid_by_operator TEXT NOT NULL,           -- quem comprou inicialmente
  invoice_ref TEXT,                         -- # da NF de aquisição
  invoice_path TEXT,                        -- caminho do PDF/imagem
  status TEXT NOT NULL DEFAULT 'active',    -- active, banned, quarantined, retired
  acquired_for_purpose TEXT,                -- "campanha Oralsin SP", "frota geral"
  retirement_date TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chip_payments (
  id TEXT PRIMARY KEY,
  chip_id TEXT NOT NULL REFERENCES chips(id),
  period TEXT NOT NULL,                     -- "2026-04"
  amount_brl REAL NOT NULL,
  paid_at TEXT NOT NULL,
  paid_by_operator TEXT NOT NULL,
  payment_method TEXT,
  receipt_path TEXT,                        -- comprovante anexado
  notes TEXT,
  UNIQUE (chip_id, period)
);

CREATE TABLE IF NOT EXISTS chip_events (
  id TEXT PRIMARY KEY,
  chip_id TEXT NOT NULL REFERENCES chips(id),
  event_type TEXT NOT NULL,                 -- acquired, plan_paid, plan_changed, banned,
                                            -- returned, retired, replaced, transferred
  occurred_at TEXT NOT NULL,
  operator TEXT,
  metadata_json TEXT,                       -- { from_plan, to_plan, replaced_chip_id, etc }
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_chips_status ON chips(status);
CREATE INDEX IF NOT EXISTS idx_chips_due ON chips(payment_due_day);
CREATE INDEX IF NOT EXISTS idx_chip_payments_period ON chip_payments(period);
CREATE INDEX IF NOT EXISTS idx_chip_events_chip ON chip_events(chip_id, occurred_at);
```

### Costing Math

- **ROI por chip**: `total_msgs_lifetime / (acquisition_cost + sum(monthly_costs))`
- **Depreciação linear**: 12 meses a partir de aquisição
- **Custo efetivo por mensagem (mês X)**: `monthly_cost / msgs_count_in_month`
- **Alert chip caro**: monthly_cost > 2× fleet-avg AND msg_count < fleet-avg/2

### Casos de Negócio Cobertos

| Cenário | Comportamento |
|---|---|
| Chip banido mid-month | Marca status=banned + chip_event(banned). Não estorna pagamento já feito (perda registrada). |
| Chip substituído (chip novo herda contexto) | chip_event(replaced) com metadata.replaced_chip_id; novo chip retoma campanhas do antigo |
| Plano mudou (upgrade) | chip_event(plan_changed) + UPDATE chips.monthly_cost |
| Operador transferido (X passa frota pra Y) | chip_event(transferred) + UPDATE paid_by_operator |
| Pagamento atrasado >5d | Cron alerta Telegram + UI badge "OVERDUE" no chip |
| Renewal upcoming (próximos 7d) | Tela "Renewal Calendar" lista o que vence |

### Files

```
CREATE:
  packages/core/src/fleet/chip-registry.ts
  packages/core/src/fleet/chip-registry.test.ts
  packages/core/src/fleet/chip-payments.ts
  packages/core/src/fleet/chip-payments.test.ts
  packages/core/src/fleet/chip-events.ts
  packages/core/src/fleet/cost-reports.ts          (ROI, depreciação, alertas)
  packages/core/src/fleet/cost-reports.test.ts
  packages/core/src/fleet/renewal-watcher.ts       (cron alertas)
  packages/core/src/fleet/renewal-watcher.test.ts
  packages/core/src/api/fleet.ts                   (REST: chips CRUD, payments record, events log, reports)
  packages/ui/src/components/fleet/index.tsx
  packages/ui/src/components/fleet/chips-list.tsx
  packages/ui/src/components/fleet/payments-recorder.tsx
  packages/ui/src/components/fleet/renewal-calendar.tsx
  packages/ui/src/components/fleet/cost-reports.tsx

MODIFY:
  packages/core/src/server.ts (wire fleet routes + renewal watcher cron)
  packages/ui/src/components/admin-page.tsx (add "Frota" tab)
  packages/core/src/api/sender-mapping.ts (POST/DELETE — provisionamento programático)
```

### Endpoints

```
GET    /api/v1/fleet/chips                          (list with filters)
POST   /api/v1/fleet/chips                          (cadastra chip novo)
GET    /api/v1/fleet/chips/:id
PATCH  /api/v1/fleet/chips/:id                      (status, plan, etc)
DELETE /api/v1/fleet/chips/:id                      (retire — não exclui, marca retired)

POST   /api/v1/fleet/chips/:id/payments             (registra pagamento + receipt upload)
GET    /api/v1/fleet/chips/:id/payments
GET    /api/v1/fleet/payments?period=2026-04        (todos pagamentos do mês)

POST   /api/v1/fleet/chips/:id/events               (log manual)
GET    /api/v1/fleet/chips/:id/events

GET    /api/v1/fleet/reports/monthly-spend?period=2026-04
GET    /api/v1/fleet/reports/roi-per-chip?since=90d
GET    /api/v1/fleet/reports/per-operator
GET    /api/v1/fleet/reports/depreciation
GET    /api/v1/fleet/reports/renewal-calendar?days=30
GET    /api/v1/fleet/reports/overdue
```

### UI Layout

```
/admin/frota
├── [Chips] (default)
│   ├── Lista com filtros (carrier, status, operador)
│   ├── Cards com phone + R$/mês + status + dias-até-vencimento
│   ├── Drilldown: timeline de events + payments + receipt thumbnails
│   ├── [+ Cadastrar chip] modal (com upload de NF de aquisição)
│   └── [↑ Importar lote (CSV)]   ← bulk import wizard
├── [Pagamentos]
│   ├── Recorder: chip dropdown + period + amount + método + receipt upload
│   └── Histórico: tabela paginada com filtros
├── [Calendário de Renovações] (visual mensal — chips a pagar nos próximos 30d)
└── [Relatórios]
    ├── Gasto mensal (chart bar)
    ├── ROI ranking (chart horizontal bar — melhor → pior)
    ├── Por operador (tabela)
    └── Depreciação (chart line acumulado)
```

### Bulk Import Wizard (within Phase 3)

Endpoint `POST /api/v1/fleet/chips/bulk-import` aceita CSV com colunas:
```
phone_number,carrier,plan_name,acquisition_date,acquisition_cost_brl,monthly_cost_brl,payment_due_day,payment_method,paid_by_operator,acquired_for_purpose,notes
```

UI: drag-drop CSV → server faz dry-run validation → preview com erros por linha (formato fone, valor numérico, due_day 1-31) → confirma → transação única:
1. INSERT chips
2. INSERT sender_mapping (provisionamento programático)
3. INSERT chip_warmup_state com phase=NEW (Phase 1 transiciona p/ HONEYMOON automático)
4. (opcional) chama Chatwoot inbox automation já existente
5. Telegram alerta sucesso com count

Rollback transacional se qualquer step falhar. Files added:
- `packages/core/src/fleet/bulk-import.ts` + tests
- `packages/ui/src/components/fleet/bulk-import-wizard.tsx`

### Acceptance
- [x] Cadastra chip → aparece em sender_mapping automaticamente (one-way: chip → sender_mapping; sender_mapping CRUD existente continua para senders sem chip-tracking)
- [x] Registra pagamento → atualiza UI <1s + atualiza overdue/calendar status
- [x] Cron renewal-watcher dispara Telegram 7d antes do vencimento E no dia do vencimento E em D+5 atraso
- [x] Reports endpoints retornam JSON válido + UI renderiza chart sem regressão
- [x] Tests: chip CRUD, payment idempotency (chip_id + period unique), event log, cost calculations, overdue trigger

---

## Phase 4: DDD-Match Router + IMEI/MAC Rotation

**Deps**: Phase 1 (warmup state) + Phase 2 (quality score)
**Esforço**: 3-4 dias

### Goal A: DDD-Match Router

Modificar `selectSender()` no algoritmo de distribuição para preferir sender com DDD igual ao recipient. Ataca o fingerprint cross-region que o WhatsApp usa.

```typescript
// Em distribution algorithm, adicionar weight:
const dddBonus = senderDDD === recipientDDD
  ? Number(process.env.DISPATCH_DDD_MATCH_BONUS ?? 0.15)
  : 0
const finalWeight = healthScore * inverseSendCount + dddBonus
```

Edge cases:
- Recipient com DDD não-mapeado na frota → fallback round-robin normal
- Normalização do 9º dígito (DDDs 11-19, 21-28, 31-38, 41-49, 51-59, 61-69 obrigatório 9º dígito; outros opcional). Reusa biblioteca já presente em `contacts/normalizer.ts`
- Cooldown matrix integrado: cross-tenant lookup `(recipient, last_send_ts)` — se < N dias, força sender DIFERENTE

### Goal B: IMEI/MAC/Serial Rotation Hooks

POCO C71 com root permite escrita de identifiers via Magisk module ou comandos privilegiados. Cadência: cada 14-30d randomizado por chip.

⚠️ **ALTO RISCO** — testar APENAS em dispositivo sacrificial primeiro (Phase 4 pode ser parcial enquanto não temos 2º POCO).

### Files

```
CREATE:
  packages/core/src/engine/ddd-router.ts           (computa bonus, normaliza)
  packages/core/src/engine/ddd-router.test.ts
  packages/core/src/engine/cooldown-matrix.ts      (cross-tenant recipient cooldown)
  packages/core/src/engine/cooldown-matrix.test.ts
  packages/core/src/devices/fingerprint-rotator.ts (IMEI/MAC/serial rotation, GATED por env)
  packages/core/src/devices/fingerprint-rotator.test.ts
  scripts/rotate-fingerprint.sh                    (CLI manual antes de automatizar)

MODIFY:
  packages/core/src/engine/worker-orchestrator.ts  (chama ddd-router + cooldown-matrix)
  packages/core/src/research/quality-score.ts      (component fingerprintFreshness lê last_rotated_at)

DB:
  chip_fingerprints     (chip_phone, rotated_at, prev_imei, new_imei, prev_mac, new_mac, prev_serial_hash, new_serial_hash, success, error_msg)
  recipient_cooldowns   (recipient_phone, last_sender_phone, last_sent_at)  -- TTL 30d via cleanup cron
```

### Acceptance
- [x] DDD-match: recipient 41 + fleet com sender 41 → router escolhe 41 com prob ≥85%
- [x] Cooldown: mesmo recipient não recebe 2 msgs do mesmo sender em janela de 7d (configurável)
- [x] Fingerprint rotation: TESTAR APENAS em sacrificial. Chip deixa device offline ~60s, volta com novo IMEI. Validar que sticks após reboot
- [x] Tests: DDD normalization (9º dígito), cooldown enforcement, rotation idempotency
- [x] Feature flag `DISPATCH_FINGERPRINT_ROTATION_ENABLED=false` por default

### Risks
| Risk | Mitigation |
|---|---|
| IMEI write brick device | Sacrificial first; rollback via Magisk safe-mode; backup boot.img antes |
| Carrier locks SIM on IMEI change | Rotation cadence ≥14d; whitelist carriers tolerantes (TIM histórico tolerante) |
| Magisk anti-tamper trip rotation attempt | Use Zygisk-Assistant DenyList exclusion para o comando |

---

## Phase 5: End-to-End Correlation Timeline

**Deps**: Phase 4 (router populates timeline)
**Esforço**: 3-4 dias

### Goal
Página única mostra ciclo de vida completo de uma cobrança/mensagem: Pipeboard → Oralsin → Dispatch → POCO → WAHA → Chatwoot → Pipeboard outcome (paid/disputed/etc).

### Schema Approach

`correlation_id` já flui em logs. Adicionar coleção estruturada de eventos com origem cross-system:

```sql
CREATE TABLE IF NOT EXISTS correlation_events (
  id TEXT PRIMARY KEY,
  correlation_id TEXT NOT NULL,
  source_system TEXT NOT NULL,       -- pipeboard | oralsin | dispatch | poco_adb | waha | chatwoot
  event_type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  payload_json TEXT,                  -- estrutura específica do evento
  ingested_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_correlation_id ON correlation_events(correlation_id, occurred_at);
```

### Cross-System Integration

| System | Como popular |
|---|---|
| Dispatch (interno) | Wire em emitter — todo evento com correlation_id grava aqui automaticamente |
| Oralsin plugin | Já passa correlation_id no enqueue → automatic |
| Pipeboard | Endpoint novo `/api/v1/correlation/ingest` recebe webhook do Pipeboard com payment outcome |
| Chatwoot | Custom attribute `correlation_id` na conversa (Chatwoot API webhook → ingest) |
| POCO ADB logs | Logs locais já têm correlation_id, agente coletor opcional |
| WAHA | Já passa via webhook, correlationId em metadata |

### Files

```
CREATE:
  packages/core/src/audit/correlation-tracker.ts
  packages/core/src/audit/correlation-tracker.test.ts
  packages/core/src/audit/correlation-ingest.ts          (HTTP receiver para sistemas externos)
  packages/core/src/audit/correlation-ingest.test.ts
  packages/core/src/api/correlation.ts                   (REST: timeline/:id, ingest)
  packages/ui/src/components/correlation-timeline.tsx    (vertical timeline com swimlanes por system)

MODIFY:
  packages/core/src/events/dispatch-emitter.ts           (auto-write correlation_events)
  packages/core/src/plugins/oralsin/index.ts             (passa correlation_id no callback)

DB:
  correlation_events (schema acima)
```

### UI Layout

```
/admin/correlation/:correlation_id

Vertical timeline (swimlanes por system, eixo vertical = tempo):
                  Pipeboard │ Oralsin │ Dispatch │ POCO │ WAHA │ Chatwoot
T=0s              ●─débito ─►●─enqueue
T=12s                                  ●─enqueued
T=2m                                   ●─dispatched─►●─sending
T=2m05s                                              ●─sent  ●─sent (ack)
T=2m08s                                                      ●─delivered
T=15m                                                        ●─read
T=1h          conversation──────────────────────────────────●─inbound
T=2d              ●─paid──────                              
                  
Click any event → side panel with payload_json + raw logs
```

### Acceptance
- [x] Endpoint `/api/v1/correlation/:id/timeline` retorna chronological lista com origem por system
- [x] Page renderiza ≤500ms para um message lifecycle típico (≤50 events)
- [x] Pipeboard webhook ingest endpoint protegido com HMAC
- [x] Tests: tracker append, ingest validation, timeline ordering, multi-source merge

---

## Phase 5.5: LGPD Compliance Suite

**Deps**: Phase 5 (correlation timeline alimenta audit export)
**Esforço**: 2-3 dias
**Issue**: #(criar)

### Goal
Suite formal de compliance LGPD pra viabilizar venda enterprise BR. Cobre: right-to-be-forgotten (RTBF), consent log com origem, retention policies por tenant, audit export assinado para evidência legal.

### Schema

```sql
CREATE TABLE IF NOT EXISTS consent_log (
  id TEXT PRIMARY KEY,
  recipient_phone TEXT NOT NULL,
  consent_type TEXT NOT NULL,            -- opt_in, opt_out, transactional_only, marketing
  source TEXT NOT NULL,                  -- "contrato Oralsin #1234", "campanha SMS X", "WA opt-in"
  source_ref TEXT,                       -- ID externo (contrato, campanha)
  collected_at TEXT NOT NULL,
  collected_by TEXT,                     -- operador que registrou OU system
  legal_basis TEXT NOT NULL,             -- art_7 (consentimento), art_11 (legítimo interesse), etc
  evidence_path TEXT,                    -- caminho do PDF de prova (contrato assinado, screenshot)
  revoked_at TEXT,
  revoked_reason TEXT,
  metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS rtbf_requests (
  id TEXT PRIMARY KEY,
  recipient_phone TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  requested_by TEXT NOT NULL,            -- operator OU "self_service"
  reason TEXT,
  legal_ref TEXT,                        -- LGPD art 18
  executed_at TEXT,
  affected_tables_json TEXT,             -- ["messages", "message_history", "contacts", "consent_log"]
  rows_tombstoned INTEGER,
  proof_hash TEXT,                       -- SHA-256 da execução para auditoria
  status TEXT NOT NULL                   -- pending, executed, rejected
);

CREATE TABLE IF NOT EXISTS retention_policies (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,                        -- null = global default
  table_name TEXT NOT NULL,              -- messages, message_history, message_ack_history, etc
  retention_days INTEGER NOT NULL,
  delete_strategy TEXT NOT NULL,         -- tombstone, hard_delete, encrypt_only
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_consent_phone ON consent_log(recipient_phone, collected_at);
CREATE INDEX IF NOT EXISTS idx_rtbf_phone ON rtbf_requests(recipient_phone);
```

### Files

```
CREATE:
  packages/core/src/lgpd/consent-registry.ts
  packages/core/src/lgpd/consent-registry.test.ts
  packages/core/src/lgpd/rtbf-executor.ts            (tombstone cross-tabela)
  packages/core/src/lgpd/rtbf-executor.test.ts
  packages/core/src/lgpd/retention-watcher.ts        (cron diário aplica policies)
  packages/core/src/lgpd/retention-watcher.test.ts
  packages/core/src/lgpd/audit-exporter.ts           (export HMAC-signed)
  packages/core/src/lgpd/audit-exporter.test.ts
  packages/core/src/api/lgpd.ts                      (REST: consent CRUD, RTBF execute, export)
  packages/ui/src/components/lgpd/consent-log.tsx
  packages/ui/src/components/lgpd/rtbf-console.tsx
  packages/ui/src/components/lgpd/retention-config.tsx

MODIFY:
  packages/core/src/queue/message-queue.ts           (block send se recipient com opt_out ativo)
  packages/core/src/api/contacts.ts                  (lookup consent_log no validate)
```

### Endpoints

```
POST   /api/v1/lgpd/consent                       (registra consentimento + evidence upload)
GET    /api/v1/lgpd/consent/:phone                (histórico de consentimento de um número)
PATCH  /api/v1/lgpd/consent/:id/revoke            (revoga)

POST   /api/v1/lgpd/forget                        (RTBF — body: { phone, reason })
                                                   → enfileira execução, retorna request_id
GET    /api/v1/lgpd/forget/:id                    (status)
POST   /api/v1/lgpd/forget/:id/execute            (operator confirma; tombstone cross-tabela)

GET    /api/v1/lgpd/policies                      (retention policies)
POST   /api/v1/lgpd/policies                      (set tenant policy)

GET    /api/v1/lgpd/audit-export?since=2026-01-01&until=2026-04-30
                                                   (NDJSON streaming, HMAC-signed manifest)
```

### RTBF Execution

Tombstone (não DELETE físico — preserva integridade audit) cross-tabela:
- `messages.text` → "[REDACTED]"
- `messages.recipient_phone` → SHA256(phone)[:8] + "_redacted"
- `message_history.from_number/to_number/text` → mesmo padrão
- `contacts` → tombstone row
- `correlation_events.payload_json` → strip recipient_phone field
- Insere `rtbf_requests` row com `proof_hash` (hash SHA-256 dos antes/depois para auditoria)

### Retention Watcher

Cron diário 03:00 lê `retention_policies`, aplica delete_strategy às tabelas vencidas. Telegram resume "Retention: 1234 rows tombstoned em N tabelas".

### Audit Export

Endpoint streaming NDJSON: cada linha um event do `correlation_events` no range. Manifest final inclui:
- `total_lines`, `start_at`, `end_at`, `tenant_id`
- `hmac_sha256` do conteúdo (key from env `DISPATCH_LGPD_EXPORT_HMAC_KEY`)
- Verificável offline para evidência judicial

### Acceptance
- [x] POST /lgpd/consent com evidence_path retorna 201 + audit log
- [x] POST /lgpd/forget enfileira request; execute tombstoneia em transação atômica cross-tabela
- [x] queue.dequeue bloqueia recipient com opt_out ativo (consent_log latest com revoked=null + type=opt_out)
- [x] Retention watcher honra policy por tenant
- [x] Audit export valida HMAC offline com `openssl` + key
- [x] Tests: RTBF idempotency, opt-out blocking, retention watcher dry-run vs apply, audit signature

---

## Phase 6 (OPCIONAL): Inbound-First Opt-In Funnel

**Deps**: Phases 1+2+4
**Esforço**: 7-10 dias

### Goal
Campanha começa com cliente clicando `wa.link/<slug>` (enviado via SMS, link em fatura, QR físico) → abre WhatsApp pré-preenchido com mensagem inicial → cliente dá send → Dispatch responde a uma conversa **iniciada pelo recipient** (drasticamente menos ban risk + prova-de-vida LGPD).

Transforma o pipeline. Marcado opcional pois vira novo produto.

### Files (resumido)

```
CREATE:
  packages/core/src/funnel/wa-link-shortener.ts        (gera slugs, redirects)
  packages/core/src/funnel/qr-generator.ts             (QR PNG/SVG)
  packages/core/src/funnel/inbound-matcher.ts          (matches webhook inbound → funnel_link)
  packages/core/src/api/funnel.ts                      (CRUD links, scan tracking, conversion)
  packages/ui/src/components/funnel-builder.tsx
  packages/ui/src/components/funnel-stats.tsx

DB:
  funnel_links     (id, slug, sender_assigned, message_template, expires_at, created_by, scans, conversions)
  funnel_scans     (id, link_id, scanned_at, ip_hash, ua_hash)
  funnel_matches   (id, link_id, recipient_phone, matched_message_id, matched_at)
```

### Acceptance
- [x] `GET /l/:slug` redireciona para wa.me URI
- [x] Webhook inbound do recipient com texto que match template_seed → link conversion++
- [x] Conversion rate report
- [x] Optional: QR generator endpoint retorna PNG/SVG

---

## Phase 7 (CROSS-CUTTING): Headless API Hardening

Threads através das phases 1-5. Não tem fase própria, é continuous.

### Items
- [ ] **OpenAPI spec auto-gerado** via `zod-to-openapi` (1-2h, antes de Phase 5) — `packages/core/src/api/openapi.ts` + serve em `/api/v1/openapi.json` e Swagger UI em `/docs`
- [ ] **POST/DELETE em `/sender-mapping`** (com Phase 3) — provisionamento programático
- [ ] **Generic outbound webhook subscriptions** (com Phase 5) — `/admin/subscriptions` (URL + secret + filter eventos)
- [ ] **SSE alternativa** `/api/v1/events/stream` (com Phase 2) — HTTP-only stream
- [ ] **NDJSON streaming** `/audit/messages/stream` (com Phase 5) — bulk export
- [ ] **Idempotency-Key header** em POST /messages (com Phase 1 prep)
- [ ] **Doc API-first** `docs/api/v1/*.md` (continuous)

---

## Cross-Cutting Concerns

| Concern | Onde aterrissa |
|---|---|
| LGPD: consent log + RTBF + retention | **Phase 5.5** (suite formal) |
| Templates server-side + linting | **Phase 1.5** (anti-ban concreto) |
| Bulk number provisioning (CSV) | **Phase 3** (wizard explícito) |
| Burst detector / fleet auto-pause | Phase 2 |
| Honeymoon protection | Phase 1 |
| Cohort analytics | Phase 2 dashboard |
| Cross-tenant recipient cooldown | Phase 4 |

---

## Dependency Graph

```
       ┌──── Phase 1 (Warmup) ────┐
       │                           ▼
       │                    Phase 1.5 (Templates)
       │                           ▼
       │                    Phase 2 (Quality)
       │                           ▼
       │                    Phase 4 (Router + Rotation)
       │                           ▼
       │                    Phase 5 (Correlation)
       │                           ▼
       │                    Phase 5.5 (LGPD)
       │                           ▼
       │                    Phase 6 (Funnel — OPT)
       │
       │                    
       └─── independent ───► Phase 3 (Chip Cost + Bulk Import) — paralelo
```

---

## Sprint Allocation

```
Semana 1-2:  Phase 1 (Warmup, 5-7d) + Phase 1.5 (Templates, 2d) sequenciais
Semana 2-3:  Phase 2 (Quality, 4-5d) + Phase 3 (Chip Cost + Bulk Import, 5-6d) em paralelo
Semana 3-4:  Phase 4 (Router + Fingerprint, 3-4d)
Semana 4:    Phase 5 (Correlation, 3-4d)
Semana 5:    Phase 5.5 (LGPD, 2-3d)
Semana 5-7:  Phase 6 (Funnel — OPCIONAL, 7-10d)
```

Cross-cutting Phase 7 (Headless) executa em paralelo embeded em cada phase.

---

## Rollout Strategy

- **Branch policy**: stay on `main`. Single feature commit per phase. `git tag phase-N-complete` após approve.
- **Schema migrations**: tudo `IF NOT EXISTS` + additive. Nunca destructive ALTER.
- **Feature flags**: `DISPATCH_WARMUP_ENABLED`, `DISPATCH_DDD_MATCH_ENABLED`, `DISPATCH_FINGERPRINT_ROTATION_ENABLED`, `DISPATCH_CORRELATION_INGEST_ENABLED`. Default safe.
- **Deploy per phase**: `git pull + pnpm install + pnpm build + systemctl restart dispatch-core` (script já existe).
- **Rollback**: revert single phase commit + feature flag off.
- **No big bang**: cada phase entra em prod no fim do sprint da phase, observação 48h antes da próxima.

---

## Success Metrics

| Métrica | Baseline | Target (90d pós Phase 4) |
|---|---|---|
| Ban rate (msgs banidas / msgs enviadas) | atual TBD | -50% |
| Survival rate de chip novo no D+30 | TBD | ≥80% |
| Fleet utilization (chips active / total) | TBD | ≥70% |
| Custo médio por mensagem entregue | TBD | trending ↓ MoM |
| Tempo de resposta a incidente (operator) | atual | -40% (timeline ajuda) |
| Cobertura LGPD audit (% chips com consent log) | 0% | 100% |

---

## Risk Register

| # | Risco | Severidade | Mitigação |
|---|---|---|---|
| R1 | Fingerprint rotation brick device prod | Alto | Sacrificial first; backup boot.img; safe-mode rollback documentado |
| R2 | Synthetic warmup detectado pelo WhatsApp | Médio | Variação heavy; opt-out por chip se ban; library com 200+ seeds |
| R3 | Carrier locks SIM em IMEI rotation | Médio | Cadência mínima 14d; whitelist carriers; abort em primeira tentativa malsucedida |
| R4 | Quality score formula precisa de tuning | Baixo | Land formula configurable + recalibrar a cada 30d com ack-rate calibrator existente |
| R5 | Chip Cost manager vira só replacement de planilha | Médio | Pareamento com auto-alerts (overdue, ROI baixo) e ROI dashboard from day 1 |
| R6 | Correlation ingest webhook DoS via Pipeboard | Baixo | Rate limit + HMAC + idempotency key |
| R7 | Inbound funnel low conversion | Médio | Build com metering; pilot 1 cliente antes de full rollout |
| R8 | Phase 3 + Phase 1 race condition (warmup state at insert vs chip cadastro) | Baixo | Transaction única; chip cadastro dispara warmup state explicitamente |

---

## Out-of-Scope (Parking Lot — não nesse plano)

- Stripe billing / SaaS multi-tenant subscription (clarificado pelo user)
- BSP integration / WABA oficial
- Compra automatizada de chip via API operadora
- ML-based ban prediction além de ack-rate
- Templates com vars + personalization linting (próximo plano)
- Reply intent classifier (LLM Haiku)
- A/B testing framework de templates

---

## Estimação Final

| Phase | Esforço | Sprint |
|---|---|---|
| Phase 1 — Warmup Orchestrator | 5-7d | Sem 1-2 |
| Phase 1.5 — Template Engine + Linter | 2d | Sem 2 |
| Phase 2 — Quality Dashboard | 4-5d | Sem 2-3 |
| Phase 3 — Chip Cost Manager + Bulk Import | 5-6d | Sem 2-3 (paralelo) |
| Phase 4 — DDD Router + Fingerprint | 3-4d | Sem 3-4 |
| Phase 5 — E2E Correlation | 3-4d | Sem 4 |
| Phase 5.5 — LGPD Compliance Suite | 2-3d | Sem 5 |
| Phase 6 — Inbound Funnel (OPT) | 7-10d | Sem 5-7 |
| Phase 7 — Headless threads | 0.5d/phase | continuous |

**Total core (Phases 1-5.5)**: ~24-32 dias úteis = ~5-6 semanas
**Com Phase 6 opcional**: +1.5-2 semanas = 7 semanas total
