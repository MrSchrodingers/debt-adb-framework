# Phase 7 Grill — Plugin System + Plugin Oralsin

> **Data**: 2026-04-02
> **Status**: COMPLETE (18 decisões)
> **Participantes**: Claude Opus 4.6 + Matheus

## Decisões Confirmadas

### 1. Modelo de Plugin — Hub-Spoke
Plugin = adaptador de contrato in-process. Módulo TypeScript em `packages/plugins/oralsin/`.
O core é o Hub (plataforma ADB), plugins são Spokes (aplicações que consomem o core).
Plugins contêm regras de negócio específicas para estruturar o contrato entre app externa e core.

### 2. API do Core para Plugins — PluginContext Restrito
```typescript
interface PluginContext {
  enqueue(msgs: EnqueueParams[]): Message[]  // bulk insert
  getMessageStatus(id: string): Message
  getQueueStats(pluginName: string): QueueStats
  on(event: string, handler: Function)
  registerRoute(method, path, handler)
  logger: Logger  // com correlationId
}
```
Plugin NÃO acessa: ADB, SQLite direto, SendEngine, DeviceManager.

### 3. Fallback de Canal — Fora do Escopo
Fallback ADB → WAHA API → SMS é regra de negócio da Oralsin, não do Dispatch.
O Dispatch só faz envio via ADB. Se falhar, reporta falha no callback.
A Oralsin decide se tenta outro canal.

### 4. Fallback de Remetente — Core Gerencia
Request inclui `senders[]` ordenado por role (primary, backup, overflow).
O core tenta em ordem. Se sender está banido (Phase 3 ban detection), pula pro próximo.
Callback informa qual sender foi usado (`pair_used`, `used_fallback`).

```json
"senders": [
  {"phone": "5537999001122", "session": "oralsin-1-4", "pair": "MG-Guaxupé", "role": "primary"},
  {"phone": "5537999003344", "session": "oralsin-1-5", "pair": "MG-Backup", "role": "backup"},
  {"phone": "5537999005566", "session": "oralsin-2-1", "pair": "MG-Overflow", "role": "overflow"}
]
```

### 5. Contratos — 4 Tipos com JSON Definido

#### Request (Oralsin → Core) — POST /api/v1/plugins/oralsin/enqueue
```json
{
  "idempotency_key": "oralsin-sched-b0c388f0-2026-04-02",
  "correlation_id": "pipeline-run-abc123",
  "patient": {
    "phone": "5543919382350",
    "name": "LEVI CORNELIO MARTINS",
    "patient_id": "227b781f-c6d2-44c7-8047-d960e11c373e"
  },
  "message": {
    "text": "Olá LEVI, sua parcela de R$ 169,67...",
    "template_id": "overdue_reminder_v2"
  },
  "senders": [
    {"phone": "5537999001122", "session": "oralsin-1-4", "pair": "MG-Guaxupé", "role": "primary"},
    {"phone": "5537999003344", "session": "oralsin-1-5", "pair": "MG-Backup", "role": "backup"}
  ],
  "context": {
    "clinic_id": "uuid-da-clinica",
    "schedule_id": "b0c388f0-...",
    "channel": "whatsapp",
    "notification_trigger": "automated",
    "flow_step": 13,
    "overdue_days": 331,
    "installment_amount": 169.67
  },
  "send_options": {
    "max_retries": 5,
    "priority": "high"
  }
}
```

#### Callback Resultado (Core → Oralsin) — Sucesso
```json
{
  "idempotency_key": "oralsin-sched-b0c388f0-2026-04-02",
  "correlation_id": "pipeline-run-abc123",
  "status": "sent",
  "sent_at": "2026-04-02T15:48:57.354Z",
  "delivery": {
    "message_id": "true_553788165296@c.us_3EB04863460F86E8B5FC44",
    "provider": "adb",
    "sender_phone": "5537999001122",
    "sender_session": "oralsin-1-4",
    "pair_used": "MG-Guaxupé",
    "used_fallback": false,
    "elapsed_ms": 29739
  },
  "error": null,
  "context": { "...pass-through..." }
}
```

#### Callback Resultado (Core → Oralsin) — Falha com Fallback
```json
{
  "idempotency_key": "oralsin-sched-b0c388f0-2026-04-02",
  "correlation_id": "pipeline-run-abc123",
  "status": "sent",
  "sent_at": "2026-04-02T15:49:12.100Z",
  "delivery": {
    "message_id": "true_553799033440@c.us_3EB099887766",
    "provider": "adb",
    "sender_phone": "5537999003344",
    "sender_session": "oralsin-1-5",
    "pair_used": "MG-Backup",
    "used_fallback": true,
    "elapsed_ms": 31200
  },
  "error": null,
  "fallback_reason": {
    "original_error": "ban_detected",
    "original_session": "oralsin-1-4",
    "quarantined": true
  },
  "context": { "...pass-through..." }
}
```

#### Callback Resultado (Core → Oralsin) — Falha Total
```json
{
  "idempotency_key": "oralsin-sched-b0c388f0-2026-04-02",
  "correlation_id": "pipeline-run-abc123",
  "status": "failed",
  "sent_at": null,
  "delivery": null,
  "error": {
    "code": "all_providers_unavailable",
    "message": "Primary banned, fallback quarantined",
    "details": {
      "primary": { "session": "oralsin-1-4", "error": "ban_detected" },
      "fallback": { "session": "oralsin-1-5", "error": "quarantine_active" }
    },
    "retryable": true,
    "retry_after_seconds": 1800
  },
  "context": { "...pass-through..." }
}
```

#### ACK Webhook (Core → Oralsin)
```json
{
  "idempotency_key": "oralsin-sched-b0c388f0-2026-04-02",
  "message_id": "true_553788165296@c.us_3EB04863460F86E8B5FC44",
  "event": "ack_update",
  "ack": {
    "level": 3,
    "level_name": "read",
    "delivered_at": "2026-04-02T15:49:00.007Z",
    "read_at": "2026-04-02T16:15:22.000Z"
  }
}
```

#### Response Webhook (Core → Oralsin)
```json
{
  "idempotency_key": "oralsin-sched-b0c388f0-2026-04-02",
  "message_id": "true_553788165296@c.us_3EB04863460F86E8B5FC44",
  "event": "patient_response",
  "response": {
    "body": "Vou pagar semana que vem",
    "received_at": "2026-04-02T16:32:00.000Z",
    "from_number": "5543919382350",
    "has_media": false
  }
}
```

### 6. Batch Enqueue
POST /enqueue aceita array de mensagens. Bulk insert em 1 transação SQLite.
Sem rate limit na ingestão (Oralsin controla). Rate limit no processamento (Phase 3).

Volume esperado:
- Hoje: ~137 msgs/dia, gotejamento a batch pequeno
- Futuro próximo (94 clínicas): ~680 msgs/dia, ~340 por batch
- Crescimento (200+ clínicas): ~1400 msgs/dia, ~700 por batch

### 7. Autenticação — API Key + HMAC
- Oralsin → Core: header `X-API-Key` (env var `PLUGIN_ORALSIN_API_KEY`)
- Core → Oralsin: HMAC SHA-256 no body do callback (env var `PLUGIN_ORALSIN_HMAC_SECRET`)
- Credenciais via environment variables para Phase 7 (encryption em Phase 8)

### 8. Plugin Init Falha — Core Continua
Se plugin falha no init(): core inicia normalmente, plugin marcado status `error`.
Loga o erro, operador monitora via alertas. Sem retry automático no boot.

### 9. Plugin Runtime Falha — Log e Continua
Handlers em try-catch isolado com 5s timeout. Erro no plugin NÃO afeta core.
Sem circuit breaker — loga errors, operador resolve manualmente.

### 10. Eventos Enriquecidos
Enriquecer DispatchEventMap com dados completos:
- `message:sent` → adicionar: idempotency_key, sender_phone, sender_session, pair_used, plugin_name
- `message:failed` → adicionar: idempotency_key, error details, plugin_name
- Novos eventos: `message:ack`, `message:response` (vindos do WAHA)

### 11. Roteamento de Callbacks — plugin_name
Campo `plugin_name` na tabela `messages`. Mensagens sem plugin_name = envio manual, sem callback.
Core busca webhook_url no registry de plugins.

### 12. Rotas do Plugin Oralsin
| Rota | Método | Propósito |
|------|--------|-----------|
| /enqueue | POST | Batch de mensagens |
| /status | GET | Healthcheck do plugin |
| /queue | GET | Stats da fila (pending, processing, failed_last_hour, oldest_pending_age_seconds) |

Admin API: GET/PATCH/DELETE em `/api/v1/admin/plugins/` + POST rotate-key.

### 13. Registro de Plugins — Código + Upsert
Plugin declara name, version, events, webhookUrl no código.
Core faz INSERT OR REPLACE na tabela `plugins` no boot.
Operador pode override via PATCH /api/v1/admin/plugins/:name (disable eventos, mudar URL).

### 14. Descoberta — Config Explícita
`dispatch.config.json`:
```json
{ "plugins": ["oralsin"] }
```
Core faz `import("../plugins/oralsin/index.js")` no boot.

### 15. Correlação ACK/Resposta — Fix 3 Gaps
**Gap 1**: Após engine.send() → insert message_history com capturedVia='adb_send' e message_id
**Gap 2**: WAHA webhook dedup encontra registro → updateWithWahaId()
**Gap 3**: Novo campo `waha_message_id` na tabela messages (copiado do history no dedup)

Cadeia: messages.id → history.message_id → history.waha_message_id → messages.waha_message_id
ACK chega → busca messages por waha_message_id → encontra plugin_name → callback

### 16. Context — Pass-through Opaco
Campo JSON na tabela messages. Core não interpreta. Devolvido intacto no callback.
Oralsin usa para correlacionar com schedule/pipeline.

### 17. Send Options — Global + Override
Defaults globais em config. Plugin pode override por mensagem:
- `max_retries` — aceita override (urgente = mais tentativas)
- `priority` — aceita override ("high" sobe na fila)
- `typing_simulation`, `delay_ms`, `timeout_seconds` — core controla, ignora override

### 18. Credenciais — Environment Variables
```
PLUGIN_ORALSIN_API_KEY=<shared secret>
PLUGIN_ORALSIN_HMAC_SECRET=<hmac signing key>
```
Plugin lê do env no init(). Encryption at rest em Phase 8.

## Escopo Removido (vs CLAUDE.md original)
- ~~DispatchNotifier(BaseNotifier) na Oralsin~~ — código Python, outro repo
- ~~Fallback chain: ADB → WAHA API → SMS~~ — regra de negócio da Oralsin
- ~~FlowStepConfig channel="adb"~~ — config da Oralsin
- ~~INTEGRATION TEST fluxo completo Oralsin → Dispatch~~ — depende do DispatchNotifier

## E2E Revisado
- Plugin carregado no boot via config
- POST /api/v1/plugins/oralsin/enqueue com batch mock
- Core processa, envia via ADB para 5543991938235
- Callback disparado para mock server local
- ACK callback após WAHA capturar outgoing
