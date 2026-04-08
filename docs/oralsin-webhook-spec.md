# Dispatch ADB Framework — Oralsin Webhook Specification

> **Version**: 2.0 (post-hardening)
> **Date**: 2026-04-08
> **Protocol**: HTTPS POST com HMAC SHA-256

---

## Visao Geral

O Dispatch envia callbacks via webhook para o Oralsin em 4 situacoes:

| Tipo | Evento | Quando |
|------|--------|--------|
| `result` | Mensagem enviada ou falhada | Imediatamente apos envio ADB ou fallback WAHA |
| `ack` | Entrega confirmada ou lida | Quando WAHA recebe ACK do WhatsApp (segundos a minutos) |
| `response` | Paciente respondeu | Quando WAHA captura mensagem incoming do paciente |

---

## Autenticacao

Cada webhook inclui header HMAC:

```
X-Dispatch-Signature: <hex SHA-256 do body com HMAC secret>
```

**Verificacao no Oralsin (Python)**:

```python
import hmac, hashlib

def verify_dispatch_signature(body: bytes, signature: str, secret: str) -> bool:
    expected = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)
```

---

## Callback: Result (message:sent / message:failed)

Enviado imediatamente apos envio ou falha.

### Payload — Sucesso (`status=sent`)

```json
{
  "idempotency_key": "oralsin-sched-abc123",
  "correlation_id": "pipeline-run-1",
  "status": "sent",
  "sent_at": "2026-04-08T13:33:00.000Z",
  "delivery": {
    "message_id": null,
    "provider": "adb",
    "sender_phone": "+5543996835100",
    "sender_session": "oralsin_2_main",
    "pair_used": "POCO-user0",
    "used_fallback": false,
    "elapsed_ms": 25739,
    "device_serial": "9b01005930533036340030832250ac",
    "profile_id": 0,
    "char_count": 142,
    "contact_registered": true,
    "screenshot_url": "/api/v1/messages/ASX3cZuc76EPre2fhBlIm/screenshot",
    "dialogs_dismissed": 0,
    "user_switched": false
  },
  "error": null,
  "context": {
    "clinic_id": "uuid-1",
    "schedule_id": "uuid-2",
    "mode": "overdue"
  }
}
```

### Payload — Falha (`status=failed`)

```json
{
  "idempotency_key": "oralsin-sched-abc123",
  "correlation_id": "pipeline-run-1",
  "status": "failed",
  "sent_at": null,
  "delivery": null,
  "error": {
    "code": "send_failed",
    "message": "Chat input not ready after dialog detection retries",
    "retryable": true
  },
  "context": {
    "clinic_id": "uuid-1",
    "schedule_id": "uuid-2",
    "mode": "overdue"
  }
}
```

### Payload — Sucesso via Fallback WAHA

Quando ADB falha e WAHA fallback envia com sucesso:

```json
{
  "idempotency_key": "oralsin-sched-abc123",
  "status": "sent",
  "sent_at": "2026-04-08T13:33:05.000Z",
  "delivery": {
    "message_id": "true_553788165296@c.us_3EB04863460F86E8B5FC44",
    "provider": "waha",
    "sender_phone": "+5543996835100",
    "sender_session": "oralsin_2_main",
    "pair_used": "POCO-user0",
    "used_fallback": true,
    "elapsed_ms": 0,
    "device_serial": "9b01005930533036340030832250ac",
    "profile_id": 0,
    "char_count": 142,
    "contact_registered": false,
    "screenshot_url": null,
    "dialogs_dismissed": 0,
    "user_switched": false
  },
  "error": null,
  "fallback_reason": {
    "original_error": "adb_failed",
    "original_session": "oralsin_2_main",
    "quarantined": false
  },
  "context": { "mode": "overdue" }
}
```

---

## Campos `delivery` — Referencia Completa

| Campo | Tipo | Descricao |
|-------|------|-----------|
| `message_id` | `string\|null` | ID WAHA da mensagem. `null` para provider=adb (preenchido assincronamente via ACK). Para provider=waha, contem o ID real. |
| `provider` | `"adb"\|"waha"` | Qual canal enviou. `adb` = digitacao humana simulada no device Android. `waha` = API WAHA (fallback). |
| `sender_phone` | `string` | Numero que enviou (ex: `+5543996835100`). |
| `sender_session` | `string` | Nome da sessao WAHA associada (ex: `oralsin_2_main`). |
| `pair_used` | `string` | Par Oralsin usado (ex: `POCO-user0`). |
| `used_fallback` | `boolean` | `true` se ADB falhou e WAHA enviou como fallback. |
| `elapsed_ms` | `number` | Tempo total do envio em ms. ADB: ~25-38s. WAHA fallback: 0 (async). |
| `device_serial` | `string` | Serial do device Android que processou (ex: `9b01005930533036340030832250ac`). |
| `profile_id` | `number` | ID do profile Android que enviou (0, 10, 11, 12). Cada profile tem um WhatsApp registrado. |
| `char_count` | `number` | Quantidade de caracteres digitados via ADB. |
| `contact_registered` | `boolean` | `true` se um contato NOVO foi criado no Android neste envio. `false` se ja existia. |
| `screenshot_url` | `string\|null` | URL relativa para o screenshot pos-envio. `GET {dispatch_url}{screenshot_url}`. `null` se nao disponivel. |
| `dialogs_dismissed` | `number` | Quantos dialogs do WhatsApp foram fechados automaticamente antes de digitar (ex: "Enviar para", "Continuar"). |
| `user_switched` | `boolean` | `true` se o worker precisou trocar de usuario Android antes deste envio. |

---

## Callback: ACK (delivery receipt)

Enviado quando WAHA recebe confirmacao de entrega ou leitura do WhatsApp.

### Payload — Entregue (ACK 2)

```json
{
  "idempotency_key": "oralsin-sched-abc123",
  "message_id": "ASX3cZuc76EPre2fhBlIm",
  "event": "ack_update",
  "ack": {
    "level": 2,
    "level_name": "device",
    "delivered_at": "2026-04-08T13:33:15.000Z",
    "read_at": null
  }
}
```

### Payload — Lido (ACK 3)

```json
{
  "idempotency_key": "oralsin-sched-abc123",
  "message_id": "ASX3cZuc76EPre2fhBlIm",
  "event": "ack_update",
  "ack": {
    "level": 3,
    "level_name": "read",
    "delivered_at": "2026-04-08T13:33:15.000Z",
    "read_at": "2026-04-08T14:15:22.000Z"
  }
}
```

### Niveis ACK

| Level | Nome | Descricao |
|-------|------|-----------|
| 1 | `server` | Mensagem chegou ao servidor WhatsApp |
| 2 | `device` | Entregue no dispositivo do paciente |
| 3 | `read` | Lida pelo paciente |

---

## Callback: Response (patient reply)

Enviado quando o paciente responde a mensagem de cobranca.

```json
{
  "idempotency_key": "oralsin-sched-abc123",
  "message_id": "ASX3cZuc76EPre2fhBlIm",
  "event": "patient_response",
  "response": {
    "body": "Vou pagar semana que vem",
    "received_at": "2026-04-08T16:32:00.000Z",
    "from_number": "5543991938235",
    "has_media": false
  }
}
```

---

## Retry Policy

| Parametro | Valor |
|-----------|-------|
| Tentativas iniciais | 4 |
| Backoff | `[0s, 5s, 30s, 120s]` |
| Worker periodico | A cada 60s retenta failed callbacks |
| Max tentativas totais | 10 |
| Persistencia | Callbacks falhados salvos em `failed_callbacks` table |

**Expectativa do Oralsin**: Retornar HTTP 200 para confirmar recebimento. Qualquer outro status ou timeout causa retry.

---

## Enqueue — Request (Oralsin -> Dispatch)

### Endpoint

```
POST /api/v1/plugins/oralsin/enqueue
X-API-Key: <api_key>
Content-Type: application/json
```

### Payload (batch)

```json
[
  {
    "idempotency_key": "oralsin-sched-abc123",
    "correlation_id": "pipeline-run-1",
    "patient": {
      "phone": "5543991938235",
      "name": "Matheus Amaral Parra Munhoz",
      "patient_id": "uuid-patient-1"
    },
    "message": {
      "text": "Ola Matheus, sua parcela de R$ 150,00 vence amanha. Evite juros!"
    },
    "senders": [
      {
        "phone": "+5543996835100",
        "session": "oralsin_2_main",
        "pair": "POCO-user0",
        "role": "primary"
      },
      {
        "phone": "+5543996835095",
        "session": "oralsin_2_1",
        "pair": "POCO-user10",
        "role": "backup"
      }
    ],
    "context": {
      "clinic_id": "uuid-clinic",
      "schedule_id": "uuid-schedule",
      "mode": "overdue",
      "flow_step": 13
    },
    "send_options": {
      "max_retries": 3,
      "priority": "normal"
    }
  }
]
```

### Response

```json
{
  "enqueued": 1,
  "messages": [
    {
      "id": "ASX3cZuc76EPre2fhBlIm",
      "idempotency_key": "oralsin-sched-abc123",
      "status": "queued"
    }
  ]
}
```

### Campos do Enqueue

| Campo | Obrigatorio | Descricao |
|-------|-------------|-----------|
| `idempotency_key` | Sim | Chave unica. Duplicatas retornam 409. |
| `correlation_id` | Nao | ID de correlacao do pipeline Oralsin. Devolvido no callback. |
| `patient.phone` | Sim | Numero do paciente (apenas digitos, 10-15 chars). |
| `patient.name` | Sim | Nome completo. Usado para registrar contato no Android. |
| `patient.patient_id` | Nao | ID interno do paciente no Oralsin. |
| `message.text` | Sim | Texto da mensagem a enviar. |
| `senders[]` | Sim (min 1) | Lista ordenada de senders. Dispatch tenta o primeiro que tem mapping. |
| `senders[].phone` | Sim | Numero do sender (com +55). |
| `senders[].session` | Sim | Nome da sessao WAHA. |
| `senders[].pair` | Sim | Nome do par Oralsin. |
| `senders[].role` | Sim | `primary`, `backup`, `overflow`, ou `reserve`. |
| `context` | Nao | JSON opaco. Devolvido intacto em todos os callbacks. **Use para `mode`**. |
| `send_options.max_retries` | Nao | Max tentativas (1-10, default 3). |
| `send_options.priority` | Nao | `normal` (default) ou `high`. High pula a fila. |

---

## Campo `context` — Recomendacao para `mode`

O Oralsin pode enviar o modo do pipeline (`pre_due` ou `overdue`) via context. O Dispatch devolve `context` intacto em todos os callbacks, sem nenhuma mudanca necessaria no Dispatch.

```json
{
  "context": {
    "mode": "overdue",
    "clinic_id": "uuid",
    "schedule_id": "uuid"
  }
}
```

---

## Sender Mapping Configurado

| Sender Phone | Profile ID | Sessao | Status |
|---|---|---|---|
| +5543996835100 | 0 | oralsin_2_main | Ativo |
| +5543996835095 | 10 | oralsin_2_1 | Ativo |
| +5543996837813 | 11 | oralsin_2_2 | Ativo |
| +5543996837844 | 12 | oralsin_2_3 | Ativo |

---

## Endpoints de Monitoramento

| Endpoint | Descricao |
|----------|-----------|
| `GET /healthz` | Health check com devices online, queue stats, failed_callbacks count |
| `GET /api/v1/monitoring/oralsin/overview` | KPIs do dia: total, sent, failed, pending, delivered, read, latencia |
| `GET /api/v1/monitoring/oralsin/messages?status=&limit=&offset=` | Lista paginada de mensagens com filtro por status |
| `GET /api/v1/monitoring/oralsin/senders` | Stats por sender: total, sent, failed, latencia |
| `GET /api/v1/monitoring/oralsin/callbacks` | Log de callbacks falhados |
| `GET /api/v1/messages/:id/screenshot` | Screenshot PNG do envio |
| `GET /api/v1/plugins/oralsin/status` | Status do plugin |
| `GET /api/v1/plugins/oralsin/queue` | Stats da fila (pending, processing, failed) |

Todos os endpoints requerem header `X-API-Key`.

---

## Codigos de Erro Comuns

| Codigo | Descricao | Retryable |
|--------|-----------|-----------|
| `send_failed` | Falha generica no envio ADB | Sim |
| `Chat input not ready` | WhatsApp nao carregou o chat | Sim |
| `Screen not ready` | Tela do device desligada/trancada | Sim |
| `Invalid phone number` | Numero invalido (nao numerico) | Nao |
| `all_providers_unavailable` | ADB + WAHA falharam | Depende |

---

## Changelog — O que mudou no hardening

### Bugs corrigidos
1. **User switch por mensagem** -> Agora por batch (1 switch por sender, nao por msg)
2. **Dialogs do WhatsApp bloqueiam envio** -> Deteccao automatica + dismissal
3. **Nomes com espaco/acento truncados** -> Escaping com single-quote
4. **Tela desligada causa falha** -> Wake + unlock proativo antes de cada envio
5. **UIAutomator falha apos user switch** -> Retry automatico em "null root node"
6. **WhatsApp "Activity not started"** -> force-stop antes de cada envio

### Novos campos de auditoria
7 novos campos em `delivery`: `device_serial`, `profile_id`, `char_count`, `contact_registered`, `screenshot_url`, `dialogs_dismissed`, `user_switched`

### Screenshot audit trail
- Screenshot salvo em disco apos cada envio
- Acessivel via `GET /api/v1/messages/:id/screenshot`
- Visivel na UI no expanded row de cada mensagem

### Callback reliability
- 4 tentativas (era 3) com backoff `[0s, 5s, 30s, 120s]` (era `[0s, 5s, 15s]`)
- Worker periodico (60s) retenta callbacks falhados ate 10x
- `/healthz` inclui `failed_callbacks` count

### E2E validado
- 4 senders, 4 profiles Android, 4 mensagens enviadas com sucesso
- Screenshots salvos para todas as mensagens
- User switching automatico entre profiles 0, 10, 11, 12
