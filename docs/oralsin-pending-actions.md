# Oralsin — Pending Actions

> **Status:** snapshot 2026-04-28
> **Lado:** Oralsin Python (debt-collection-v2 / NotificationBilling client)
> **Contraparte Dispatch:** `https://dispatch.tail106aa2.ts.net` — endpoints prontos e ativos.

Este documento lista TUDO que Oralsin (lado Python/Hetzner) precisa fazer para fechar o circuito Dispatch. Os endpoints e features listados abaixo já estão **deployados e ativos** na Dispatch (Kali) — basta o cliente Python implementar.

---

## 1 — Assinatura HMAC outbound (P0, segurança)

### O quê
Toda chamada do Python para `POST /api/v1/plugins/oralsin/enqueue` deve incluir o header `X-Dispatch-Signature` com HMAC-SHA256 do corpo.

### Por quê
- Dispatch tem o flag `PLUGIN_ORALSIN_HMAC_REQUIRED` (default `false` por compat). Quando ativado, requests sem assinatura são **rejeitadas com 401**.
- Hoje só X-API-Key autentica. HMAC garante integridade do corpo + impede replay.

### Como implementar (Python)

```python
import hmac, hashlib, json, requests

PLUGIN_ORALSIN_API_KEY    = os.environ['PLUGIN_ORALSIN_API_KEY']
PLUGIN_ORALSIN_HMAC_SECRET = os.environ['PLUGIN_ORALSIN_HMAC_SECRET']
DISPATCH_URL              = 'https://dispatch.tail106aa2.ts.net'

def post_to_dispatch(payload: dict | list) -> requests.Response:
    body = json.dumps(payload, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
    sig  = 'sha256=' + hmac.new(
        PLUGIN_ORALSIN_HMAC_SECRET.encode('utf-8'),
        body,
        hashlib.sha256,
    ).hexdigest()
    return requests.post(
        f'{DISPATCH_URL}/api/v1/plugins/oralsin/enqueue',
        data=body,
        headers={
            'Content-Type':         'application/json',
            'X-API-Key':            PLUGIN_ORALSIN_API_KEY,
            'X-Dispatch-Signature': sig,
        },
        timeout=30,
    )
```

**Pontos críticos:**
- `body` deve ser exatamente os bytes enviados — `json.dumps(separators=(',', ':'))` evita whitespace que muda o hash.
- O secret é o mesmo já configurado no Dispatch via `pluginRegistry.register({ hmacSecret })` — Oralsin precisa pegar o valor dessa coluna do banco Dispatch (ou via `GET /api/v1/admin/plugins/oralsin` com Bearer admin).
- O prefixo `sha256=` é obrigatório (formato `X-Dispatch-Signature: sha256=<hex>`).

### Smoke test
```bash
PLUGIN_ORALSIN_HMAC_REQUIRED=true  # no .env do Dispatch
# Restart dispatch-core (NOPASSWD), depois:
curl -X POST -H "X-API-Key: $KEY" -d '{...}' https://dispatch.tail106aa2.ts.net/api/v1/plugins/oralsin/enqueue
# Esperado: 401 Unauthorized (sem signature) — prova que a checagem está ativa.
```

---

## 2 — Handlers de callback (P0, contrato)

Dispatch dispara 5 tipos de callback via `POST` ao `PLUGIN_ORALSIN_WEBHOOK_URL` configurado. Oralsin precisa implementar todos:

### 2.1 — `result` (Send complete)
**Já implementado?** Verificar. Indica que a mensagem foi enviada (sucesso) ou falhou definitivamente.

```json
POST /api/webhooks/dispatch/
{
  "type": "result",
  "message_id": "abc",
  "idempotency_key": "sched-123-whatsapp",
  "correlation_id": "notif-abc",
  "status": "sent" | "failed",
  "provider": "adb" | "waha",
  "sender_phone": "554396837945",
  "device_serial": "9b01...",
  "elapsed_ms": 4823,
  "error": "..."
}
```

### 2.2 — `ack` (Delivery + read tracking)
WhatsApp confirmação de entregue/lido.

```json
{
  "type": "ack",
  "message_id": "abc",
  "ack_level": 2 | 3 | 4,
  "ack_level_name": "delivered" | "read" | "played",
  "delivered_at": "2026-04-28T...",
  "read_at": "2026-04-28T..."
}
```

### 2.3 — `response` (Inbound message — patient replied)
Quando o paciente RESPONDE no WhatsApp, Dispatch captura via WAHA listener e encaminha.

```json
{
  "type": "response",
  "from_number": "5543991938235",
  "to_number": "554396837945",
  "text": "Confirmo presença!",
  "received_at": "2026-04-28T...",
  "in_reply_to_message_id": "abc"
}
```

### 2.4 — `interim_failure` (Retry-still-trying signal)
Falhou uma tentativa mas Dispatch ainda vai retentar. Use para UX (mostrar "tentando novamente").

```json
{
  "type": "interim_failure",
  "message_id": "abc",
  "attempt": 2,
  "max_retries": 3,
  "error": "Timeout ADB",
  "next_retry_at": "..."
}
```

### 2.5 — `expired` (Send window closed)
Mensagem foi expirada porque caiu fora da janela configurada (`SEND_WINDOW_*`) e ultrapassou TTL.

```json
{
  "type": "expired",
  "message_id": "abc",
  "reason": "outside_window",
  "expired_at": "..."
}
```

### 2.6 — `number_invalid` (Recipient não está no WhatsApp)
Pre-check ou send-failure detectou que o telefone não tem conta WhatsApp. Adicionado ao blacklist automaticamente.

```json
{
  "type": "number_invalid",
  "phone": "5599999999999",
  "source": "send_failure" | "adb_probe" | "cache",
  "confidence": 0.95,
  "detected_at": "..."
}
```

### Verificação de assinatura inbound (segurança ↔)

Toda callback POST do Dispatch carrega `X-Dispatch-Signature: sha256=<hex>`. Oralsin DEVE verificar:

```python
def verify_signature(body_bytes: bytes, signature_header: str, secret: str) -> bool:
    if not signature_header.startswith('sha256='):
        return False
    expected = hmac.new(secret.encode(), body_bytes, hashlib.sha256).hexdigest()
    return hmac.compare_digest(signature_header[7:], expected)
```

Reject `401` se inválido. Specificação completa em `docs/oralsin-webhook-spec.md` (já no repo Dispatch).

---

## 3 — Idempotência inbound (P0, robustez)

### O quê
Dispatch usa **at-least-once delivery** para callbacks. Mesma `message_id + type` pode chegar 2× (rede flap, retry após 5xx). Oralsin precisa deduplicar.

### Como
Tabela `dispatch_callbacks_seen(message_id TEXT, callback_type TEXT, received_at TIMESTAMP, PRIMARY KEY(message_id, callback_type))`. Insert IGNORE; se já existe, retornar 200 OK sem processar.

```python
@app.post('/api/webhooks/dispatch/')
def webhook(request):
    payload = json.loads(request.body)
    key = (payload['message_id'], payload['type'])
    try:
        DispatchCallbackSeen.objects.create(message_id=payload['message_id'], callback_type=payload['type'])
    except IntegrityError:
        return Response(status=200)  # Already processed — ack OK
    # ... processar ...
```

---

## 4 — Honor `Retry-After` em backpressure 429 (P1, eficiência)

### O quê
Dispatch retorna `429 Too Many Requests` com header `Retry-After: 30` quando a queue passa de `DISPATCH_QUEUE_DEPTH_LIMIT` (default 1000 pendentes).

### Como
```python
def post_with_backoff(payload):
    for attempt in range(5):
        r = post_to_dispatch(payload)
        if r.status_code != 429:
            return r
        wait = int(r.headers.get('Retry-After', '30'))
        time.sleep(wait + random.uniform(0, 5))  # jitter
    raise BackpressureError('Dispatch queue overloaded after 5 attempts')
```

---

## 5 — Honor 422 banned-numbers (P1, dado limpo)

### O quê
Quando todos os items do batch são telefones banidos, Dispatch retorna `422` com:
```json
{ "error": "All recipients are banned", "rejected": [{ "index": 0, "phone": "...", "reason": "..." }] }
```

### Como
- Não retentar numbers em `rejected` — eles são definitivamente inválidos.
- Adicionar à blacklist local Oralsin (Patient.do_not_contact = True).
- Se request misto (alguns banidos + alguns válidos), Dispatch retorna `201` com `rejected[]` populated; processar `enqueued[]` normalmente.

---

## 6 — Atualizar pre-register de contatos (P2)

### O quê
Endpoint `POST /api/v1/plugins/oralsin/contacts/pre-register` registra contatos no Android antes de enviar mensagem (contact aging — reduz risco de ban).

### Como
Antes de enfileirar uma mensagem para paciente novo, Oralsin pode chamar:
```json
POST /api/v1/plugins/oralsin/contacts/pre-register
[
  { "patient_phone": "5543991938235", "patient_name": "Maria", "sender_phone": "554396837945" },
  ...
]
```
Max 500 items por batch. Idempotente (já-registrado = no-op).

**Quando usar:** patient.first_message_at IS NULL (primeira mensagem nunca enviada). Pular para repeat-contacts.

---

## 7 — Polling do `/status` para health do plugin (P2, observability)

### O quê
`GET /api/v1/plugins/oralsin/status` retorna stats agregadas do plugin (sent today, failed, queue depth, callback stats).

### Como
Cron Oralsin a cada 5min:
```python
r = requests.get(f'{DISPATCH_URL}/api/v1/plugins/oralsin/status', headers={'X-API-Key': KEY})
stats = r.json()
# stats.totalToday, sentToday, failedToday, pendingNow, deliveredToday, readToday
# avgLatencyMs, fallbackRate, failedCallbacks, hourly[]
log_to_grafana(stats)
```

Use para detectar queue saturada antes de continuar enfileirando.

---

## 8 — Deploy do client com timing-test (P3, qualidade)

Antes de Oralsin trocar para HMAC-required em prod, rodar:

1. **HMAC dry-run**: enviar 100 messages com signature válida, verificar 100% 201.
2. **HMAC negative**: enviar com signature errada → esperar 401.
3. **429 backoff**: forçar queue cheia (set `DISPATCH_QUEUE_DEPTH_LIMIT=10` temporariamente), enviar 50 mensagens, validar que cliente espera Retry-After e completa todas.
4. **422 banned**: enviar phone do blacklist, validar handling.
5. **Replay-safe callbacks**: simular dispatch enviando mesmo callback 2× → validar que Oralsin processa 1× (idempotência).

---

## 9 — Coordenação flip de `PLUGIN_ORALSIN_HMAC_REQUIRED=true` (P0 final)

Sequência:

1. Oralsin Python implementa items 1-3 acima.
2. Oralsin deploya em prod com HMAC opcional (envia signature mas Dispatch ainda aceita sem).
3. Smoke test: 100% das requests Oralsin chegam com signature válida (logs Dispatch).
4. **Coordenar janela**: marcar horário de troca.
5. SSH dispatch e flip:
   ```bash
   ssh adb@dispatch 'cd /var/www/debt-adb-framework && sed -i "s/^# PLUGIN_ORALSIN_HMAC_REQUIRED=false/PLUGIN_ORALSIN_HMAC_REQUIRED=true/" packages/core/.env && sudo systemctl kill --signal=SIGHUP dispatch-core'
   ```
   (SIGHUP hot-reload aplica sem restart — Phase 6.3.)
6. Monitor 30min: 0 401 nos logs Oralsin → flip estável.

---

## 10 — Resumo de variáveis Python

```env
# Dispatch endpoint
DISPATCH_URL=https://dispatch.tail106aa2.ts.net

# Auth
PLUGIN_ORALSIN_API_KEY=<copiar do banco Dispatch via /api/v1/admin/plugins/oralsin>
PLUGIN_ORALSIN_HMAC_SECRET=<copiar do banco Dispatch via /api/v1/admin/plugins/oralsin>

# Webhook (lado Oralsin recebe)
ORALSIN_WEBHOOK_PATH=/api/webhooks/dispatch/
ORALSIN_WEBHOOK_HMAC_SECRET=<mesmo PLUGIN_ORALSIN_HMAC_SECRET>
```

---

## 11 — Alertas no Telegram (já configurado lado Dispatch)

Dispatch envia alertas formatados ao Telegram tópico 396 nos seguintes eventos:

- 🚨 **circuit:opened** — device parou de receber sends por falhas consecutivas
- ⚠️ **number:invalid** — telefone confirmado fora do WhatsApp
- ⚠️ **high failure rate** — >100 falhas/hora
- 🚨 **ban prediction triggered** — Frida hooks detectaram pré-ban (research, Phase 12)
- ✅ **config:reloaded** — SIGHUP aplicou nova config

Oralsin não precisa fazer nada aqui — só observar o tópico.

---

## Quick checklist (P0 mínimo para fechar circuito)

- [ ] **#1** HMAC outbound: `X-Dispatch-Signature: sha256=<hex>` em todo POST /enqueue
- [ ] **#2** Handler dos 5 callback types (result, ack, response, interim_failure, expired) + verify HMAC inbound
- [ ] **#3** Tabela de idempotência inbound (`dispatch_callbacks_seen`)
- [ ] **#9** Coordenar flip `PLUGIN_ORALSIN_HMAC_REQUIRED=true`

P1 (próximo sprint):
- [ ] **#4** Honor 429 + Retry-After
- [ ] **#5** Honor 422 banned-numbers
- [ ] **#7** Poll /status para health

P2/P3 (opcional):
- [ ] **#6** Pre-register contatos para contact-aging
- [ ] **#8** Test suite client-side
