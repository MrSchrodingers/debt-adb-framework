# Phase 9 Grill — Contact Registry & Hygiene Pipeline

> **Status**: COMPLETE
> **Date**: 2026-04-17
> **Decisions**: 12
> **Next**: TDD Fase 9.1 (schema + ContactRegistry + br-phone-resolver + backfill)

## Context

Feature nova proposta pelo usuário: pre-check de números WhatsApp, persistente e auditável,
consumível pelo SendEngine (pre-check inline) e por plugin futuro `adb-debt` (batch hygiene
via HUB-2.0 com integração Pipedrive).

Objetivo: base de dados de números não-elegíveis, nunca efêmera, com audit trail completo e
risco de ban mínimo (ADB UIAutomator probe como primário, WAHA como secundário).

## Decisions

### D1 — Semântica de `exists=false`
**Decisão**: Permanente. `recheck_due_at=NULL` para inválidos. Sem auto-recheck — apenas manual
via admin (com `reason` obrigatória).
**Motivo**: HUB-2.0 marca número como `BLOCKED` no DB origem, Pipedrive fecha Activity em
definitivo. Zero custo de re-check, audit trail preservado.

### D2 — Autoridade entre fontes
**Decisão**: Ranking `ADB > WAHA > cache > syntactic`. Em conflito, ADB vence.
**Motivo**: ADB é ground truth do device que realmente vai enviar. Zero custo WAHA extra no
conflito, realístico.

### D3 — Backfill inicial
**Decisão**: One-shot migration a partir de `messages.status='sent'`. Source=`send_success_backfill`,
confidence=0.9. Cria uma linha em `wa_contact_checks` por número com evidência
`{migration, inferred_from: {message_id, sent_at}}`.
**Motivo**: Registry útil dia 1, HUB-2.0 vê valor imediato sem aquecer cache.

### D4 — Granularidade de callback
**Decisão**: Per-item durante processamento + agregado final. HUB-2.0 idempotente por `check_id`.
**Motivo**: Real-time auditável + reconciliação resiliente. HUB pode atualizar DB incrementalmente
(UPDATE deal WHERE id=external_id) e finalizar com Pipedrive Activity batch.

### D5 — Contenção de recursos SendEngine vs HygieneJobRunner
**Decisão**: Janela horária dedicada (default `22:00-07:00`). Hygiene pausa device quando envio
entra. Fora da janela, hygiene não inicia jobs novos.
**Motivo**: Zero impacto no horário comercial do Oralsin, SLA previsível (~24h/batch 10k).

### D6 — Ativação do pre-check
**Decisão**: L1 cache lookup sempre ativo (zero custo). L2 (WAHA) / L3 (ADB probe) opt-in por
plugin ou per-message via flag `pre_check`.
**Motivo**: Rollout incremental, zero risco para Oralsin em produção.

### D7 — LGPD
**Decisão**: Payload de job hygiene exige `lawful_basis` (enum), `purpose` (string max 500),
`data_controller` (CNPJ ou ID). Validado Zod, armazenado em `hygiene_jobs`, ecoado no callback.
**Motivo**: Defensável em ANPD com evidência em quem executou.

### D8 — Dígito 9 BR
**Decisão**: DDD-aware. DDDs `[11-19, 21, 22, 24, 27, 28]` testam 1 variante (com 9). Demais DDDs
testam ADB primeiro; se inconclusive, WAHA desempata. Segundo probe ADB só se WAHA indisponível.
**Motivo**: 1 probe na maioria dos casos; WAHA resolve canon `chatId` sem 2º probe ADB.

### D9 — Idempotência de jobs
**Decisão**: `UNIQUE(plugin_name, external_ref)`. Re-submit retorna job original com
`deduplicated:true`. Items diferentes → 409 conflict com diff.
**Motivo**: Retry-safe para HUB-2.0, comportamento claro.

### D10 — Probe inconclusivo / erro
**Decisão**: 3 retries exponenciais (5s/20s/80s). Se todos falharem, `hygiene_job_items.status='error'`.
`wa_contacts` NÃO é atualizado (preserva estado anterior). Callback `hygiene_item_error` com
contagem de tentativas.
**Motivo**: Error ≠ not_exists. HUB-2.0 decide re-submeter ou escalar sem contaminar registry.

### D11 — Retenção
**Decisão**: `wa_contact_checks` perpétua. Cron trimestral move registros com >1 ano para DB
archive (`data/archive/contact_checks_YYYY-Q.db`). UI consulta hot table; auditoria ANPD busca
em ambas.
**Motivo**: Hot table leve (~10GB cap), auditoria total preservada.

### D12 — UI prioritário
**Decisão**: Auditoria por número (timeline append-only com evidência crua expandível) é a
primeira vista a construir. Registro de contatos e Jobs Manager vêm em seguida.
**Motivo**: Prova visual de que o sistema é auditável. Demo confirmado em localhost:5174
(aba "Contatos").

## Open Points (non-blocking, defaults accepted for MVP)

- **Rate profiles**: `conservative` 10/min device, `default` 20/min, `aggressive` 40/min;
  WAHA 5/10/15 por sessão. Revisáveis após primeiro batch real em produção.
- **Manual recheck authority**: admin via UI + plugin autorizado via API `POST /contacts/:phone/recheck`
  (requer `reason` textual). Auditado em `wa_contact_checks`.
- **Pipedrive**: fora do escopo do Dispatch — apenas HUB-2.0 consome callback e orquestra.

## Table naming (collision resolved)

Tabela `contacts` existente (ADB contact aging, `{phone, name, registered_at}`) permanece.
Novas tabelas:
- `wa_contacts` — registry de existência WhatsApp
- `wa_contact_checks` — log append-only de verificações
- `hygiene_jobs` — batches (Fase 9.2)
- `hygiene_job_items` — itens (Fase 9.2)
