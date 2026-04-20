# Plugin Hardening Sprint — Grill Decisions

> **Date**: 2026-04-13
> **Decisions**: 43
> **Status**: COMPLETE — all branches resolved, all 87 findings covered

## Decisions

| # | Decision | Findings | Rationale |
|---|----------|----------|-----------|
| 1 | Fix all 87 findings (hardening sprint completo) | All | Sistema em producao, rampando volume |
| 2 | Batches sequenciais por camada, commits atomicos | Exec | server.ts tocado por ~30 findings, paralelo causa conflito |
| 3 | DB/Schema first, revalidacao cascata | Ordering | Schema changes afetam camadas superiores |
| 4 | Recreate tables, DB limpo, sem migracao | DB | Apenas dados de teste internos, nao ha dados de producao |
| 5 | Contrato interno, nada eh breaking | Risk | Dispatch eh componente interno, controlamos ambos os lados |
| 6 | handle_result idempotente, P5 seguro | P5 | DispatchCallbackHandler faz lookup + update idempotente |
| 7 | Implementar `waiting_device` como status ativo | D1, R6 | Visibilidade quando devices offline, nao dead code |
| 8 | TTL adaptativo, default 24h, baseado em device uptime | R6 | Sem TTL fixo, adapta ao padrao de retorno |
| 9 | Recovery `sending`: 2x worst case = 300s (5min) | R1 | Per-op timeout 30s x 5 ops max = 150s, 2x = 300s |
| 10 | State machine enforced: `updateStatus(id, from, to)` | D2 | Transicoes invalidas como queued→sent bloqueadas |
| 11 | Novo callback type `interim_failure` (opcao C) | P5 | Visibilidade de falha ADB antes do fallback WAHA |
| 12 | Proteger `/metrics` com API key | S14 | Phone numbers em labels, endpoint nao deve ser publico |
| 13 | Webhook URL allowlist de dominios via env var | S6 | SSRF protection, suffix match |
| 14 | Wire `markSendActive`, SIGTERM espera 30s + flush | R5 | Drain mecanismo existe mas nunca wired |
| 15 | Backoff exponencial tick: 5s→10s→20s→40s→60s cap | R7 | Evita busy-loop quando todos senders capped |
| 16 | Failed callbacks: manter para auditoria, WHERE attempts<10 | R8, DB7 | Dados para compliance, scan otimizado |
| 17 | patientId/templateId merged no context JSON | P1 | Fire-and-forget mas auditavel via context field |
| 18 | Dedup window unificada 30s | P7 | Rate limiter 15-45s entre msgs garante sem false-positive |
| 19 | Sem purge messages/events. Indexes para performance | DB6 | Compliance: audit trail completo |
| 20 | Wire `onError` com log + metrica Prometheus | A3 | Plugin handler errors silenciados hoje |
| 21 | Backoff interval 5s base confirmado | R7 | Worker tick eh 5s (nao 2s como estimado) |
| 22 | Allowlist: suffix match, HTTPS-only prod, obrigatorio | S6 | `DISPATCH_WEBHOOK_ALLOWED_DOMAINS=debt.com.br` |
| 23 | 4+ novas metricas + atualizar dashboards Grafana | A4,A8,A10 | callbacks_total, plugin_errors, queue_depth_by_plugin, dedup_miss |
| 24 | Python handler first (`interim_failure`+`expired`), Dispatch second | Cross-repo | Deploy order: Python → Dispatch |
| 25 | Fail-closed auth: timingSafeEqual, all verbs, strip secrets | S1-S5 | Timing oracle + auth bypass + credential leak |
| 26 | Input schema: bodyLimit 1MB, text 4096, E.164 regex, batch 500, context 64KB, path allowlist, /healthz degradado | S7-S13 | DoS protection + input validation |
| 27 | AbortSignal.timeout(10s) todo outbound HTTP, configuravel via env | S15, R11 | Fetch sem timeout trava event loop |
| 28 | Phone numbers mantidos em labels Prometheus (endpoint protegido) | S14 | Operador precisa correlacionar sender com numero real |
| 29 | Batch partial-failure per-item. ON CONFLICT DO NOTHING. Blacklist skip | P8, R4 | Idempotencia + robustez de batch |
| 30 | Gerar dispatch_message_id no send. WAHA ID no AckCallback | P4 | Callback imediato com ID, WAHA ID async |
| 31 | maxRetries = total attempts. Fix off-by-one | P11 | `attempts >= maxRetries` nao `attempts + 1 < maxRetries` |
| 32 | Fixes fluxo: queued event, JSON.parse guard, fallback fields, waha query scope, sender resolution | P2,P3,P6,P9,P10 | 5 fixes diretos sem trade-off |
| 33 | Plugin lifecycle: error log, destroyAll safe, registry source of truth, upsert creds, webhook obrigatorio | R2,R3,R9,R10,R12 | 5 fixes lifecycle |
| 34 | Auditabilidade: stale lock log, requeue trace, callback body, retry error, labels, pino, timeline, dedup miss | A1-A13 | 9 fixes observabilidade |
| 35 | Data integrity: attempts real, sent_at column, atomic transaction, FK, typed enum | D3-D8 | 5 fixes integridade |
| 36 | DB hardening: busy_timeout 5000, branch query, WAL checkpoint 400, CHECK priority | DB1,DB4,DB5,DB8 | 4 fixes DB |
| 37 | Code quality: timer leak, paused senders, pluginName validation, non-destructive metadata | Q1-Q4 | 4 fixes qualidade |
| 38 | Testes junto com cada batch. E2E in-process prioridade #1 | T1-T14 | Testes nao sao batch separado |
| 39 | Sender phone normalizacao digits-only no receptor (Postel's Law) | Contract | Oralsin envia E.164 com +, Dispatch normaliza |
| 40 | 503 retryable com backoff inline [0, 1s, 2s, 4s] | Contract | Race condition resolve em <50ms, 503 era non-retryable |
| 41 | `interim_failure` com erro real + `failed_sender` + `next_sender` | Contract | Visibilidade completa da cadeia de fallback |
| 42 | `expired` callback + DeferredNotification fallback | Contract | TTL expira → callback imediato, detect_stuck como safety net |
| 43 | `fallback_reason.original_error` real (nao hardcoded) | Contract | Redundancia intencional com interim_failure |

## Cross-Repo Dependencies

### Python/Oralsin (BLOQUEANTE — deploy ANTES do Dispatch)

1. `dispatch_callback_view.py`: routing para `interim_failure` e `expired`
2. `DispatchCallbackHandler.handle_interim_failure()`:
   - Localizar ContactHistory por idempotency_key
   - NAO alterar outcome (manter PENDING)
   - Appendar ao outcome_details: timestamp, error code, error message, failed provider
   - Metrica: `dispatch_interim_failure_total{error_code}`
   - Alerta Telegram se `error.code == "ban_detected"`
3. `DispatchCallbackHandler.handle_expired()`:
   - ContactHistory: outcome=ERROR, outcome_reason="ttl_expired"
   - Schedule: PROCESSING → REJECTED
   - Avaliar fallback WAHA: DISPATCH_FALLBACK_TO_WAHA + janela horario comercial
   - Se OK: DeferredNotification reason="dispatch_ttl_expired"
   - Alerta Telegram: WARN se 1 schedule, CRIT se >5 expirados/hora

### Contract Summary

#### Callback Types (5 total)

| Type | Event Field | When | Oralsin Action |
|------|------------|------|----------------|
| result | null | Send complete (success/fail) | Update ContactHistory outcome |
| ack_update | "ack_update" | WAHA delivery/read receipt | Update delivered_at/read_at |
| patient_response | "patient_response" | Patient replies | Store in ContactHistory |
| interim_failure | "interim_failure" | ADB failed, before fallback | Log attempt, alert on ban |
| expired | "expired" | TTL expired, no device available | REJECTED + fallback WAHA |

#### `interim_failure` Payload
```json
{
  "event": "interim_failure",
  "idempotency_key": "sched-123-whatsapp",
  "correlation_id": "notif-abc",
  "status": "interim_failed",
  "error": {
    "code": "ban_detected|device_offline|typing_timeout|...",
    "message": "Human-readable detail",
    "retryable": true
  },
  "failed_sender": { "phone": "+554396835095", "session": "oralsin_2_1", "pair": "oralsin-2-1" },
  "next_sender": { "phone": "+554396837813", "session": "oralsin_2_2", "pair": "oralsin-2-2", "role": "overflow" },
  "attempt": 1,
  "context": { "schedule_id": 123, "clinic_id": 5, "..." }
}
```

#### `expired` Payload
```json
{
  "event": "expired",
  "idempotency_key": "sched-123-whatsapp",
  "correlation_id": "notif-abc",
  "status": "expired",
  "error": {
    "code": "ttl_expired",
    "message": "No device available for 24h, message expired",
    "retryable": false
  },
  "context": { "schedule_id": 123, "clinic_id": 5, "..." }
}
```

#### `fallback_reason` (in result callback when used_fallback=true)
```json
{
  "original_error": "ban_detected",
  "original_message": "WhatsApp session banned on device oralsin-2-1",
  "original_session": "oralsin_2_1",
  "quarantined": true
}
```

## Phone Format Contract

| Field | Oralsin Sends | Dispatch Stores | Dispatch Lookup |
|-------|--------------|-----------------|-----------------|
| patient.phone | "5543991938235" (13 digits, no +) | verbatim in messages.to | normalized to digits in send-engine |
| senders[].phone | "+554396837945" (E.164 with +) | digits-only in sender_mapping | digits-only (Postel's Law) |
| callback.delivery.sender_phone | — | messages.sender_number | from resolved mapping |
