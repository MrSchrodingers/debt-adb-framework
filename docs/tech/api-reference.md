# API Reference — Dispatch ADB Framework

> Base URL: `http://localhost:7890`
> Auth: `X-API-Key` header (quando implementado — ver B1)
> Content-Type: `application/json`

## Health

### GET /api/v1/health
**Auth**: Publico
```json
// Response 200
{ "status": "ok", "timestamp": "2026-04-06T12:00:00.000Z" }
```

## Messages

### POST /api/v1/messages
Enfileira uma mensagem para envio via ADB.
```json
// Request
{ "to": "5543991938235", "body": "Hello", "idempotencyKey": "ui-123", "priority": 5, "senderNumber": "5537999001122" }
// Response 201
{ "id": "abc123", "to": "5543991938235", "body": "Hello", "status": "queued", ... }
// Response 409
{ "error": "Duplicate idempotency key" }
```

### GET /api/v1/messages
Lista mensagens. Query params: `?status=queued&limit=50`
```json
// Response 200
[{ "id": "abc123", "to": "5543991938235", "body": "Hello", "status": "sent", "pluginName": "oralsin", ... }]
```

### GET /api/v1/messages/:id
```json
// Response 200
{ "id": "abc123", "to": "5543991938235", "status": "sent", ... }
```

### POST /api/v1/messages/:id/send
Dispara envio manual (worker must be idle).
```json
// Response 200
{ "id": "abc123", "status": "sent" }
// Response 409
{ "error": "Worker is currently sending" }
```

## Devices

### GET /api/v1/devices
```json
[{ "serial": "9b0100...", "type": "device", "brand": "POCO", "model": "25028PC03G" }]
```

### GET /api/v1/devices/:serial
Device detail com health.

### POST /api/v1/devices/:serial/screenshot
**Response**: `image/png` binary

### GET /api/v1/devices/:serial/screen
Live screen como base64.
```json
{ "image": "data:image/png;base64,..." }
```

### POST /api/v1/devices/:serial/shell
Executa comando ADB.
```json
// Request
{ "command": "getprop ro.build.version.release" }
// Response 200
{ "command": "getprop ...", "output": "15" }
```

### GET /api/v1/devices/:serial/info
Info detalhada do dispositivo.
```json
{ "brand": "POCO", "release": "15", "sdk": "35", "ip": "10.1.1.176", "waVersion": "2.26.11.73", "waRunning": "running", ... }
```

### POST /api/v1/devices/:serial/keep-awake
Desabilita lock screen e timeout.
```json
{ "serial": "9b0100...", "applied": { "screen_timeout": "ok", "stay_awake_usb": "ok", ... } }
```

## Monitor

### GET /api/v1/monitor/devices
Devices com status e ultimo health.
```json
[{ "serial": "9b0100...", "brand": "POCO", "status": "online", "lastSeenAt": "..." }]
```

### GET /api/v1/monitor/devices/:serial
Device + health history + WA accounts + alerts.
```json
{ "serial": "...", "accounts": [...], "health": [...], "alerts": [...] }
```

### GET /api/v1/monitor/devices/:serial/health?hours=24
Health snapshots (default 24h).

### GET /api/v1/monitor/devices/:serial/accounts
WhatsApp accounts no device.

### POST /api/v1/monitor/devices/:serial/reboot
Reboot via ADB. Requer confirmacao na UI.

### POST /api/v1/monitor/devices/:serial/restart-whatsapp
Force-stop + restart WhatsApp.

### GET /api/v1/monitor/alerts?serial=X&active=true
Alertas filtrados por device e status.

## Sessions (WAHA + Chatwoot)

### GET /api/v1/sessions
Lista todas as sessoes WAHA enriquecidas com managed status e Chatwoot inbox.
**Requer**: `WAHA_API_URL` + `WAHA_API_KEY` configurados.
```json
[{ "sessionName": "oralsin_1_4", "wahaStatus": "WORKING", "phoneNumber": "554396837945", "managed": false, "chatwootInboxId": 177 }]
```

### POST /api/v1/sessions/managed
Marcar sessoes como managed (bulk).
```json
// Request
{ "sessionNames": ["oralsin_1_4", "oralsin_2_1"] }
```

### DELETE /api/v1/sessions/managed/:name
Desmarcar sessao.

### POST /api/v1/sessions/:name/inbox
Criar ou vincular inbox Chatwoot. Verifica duplicatas antes de criar.

### GET /api/v1/sessions/:name/qr
QR code para parear sessao (so funciona se status = SCAN_QR_CODE).

## WAHA Webhooks

### POST /api/v1/webhooks/waha
**Auth**: HMAC SHA-512 (header `X-Webhook-Hmac-Sha512`)
Recebe eventos: `message.any`, `session.status`, `message.ack`

## Plugins Admin

### GET /api/v1/admin/plugins
### GET /api/v1/admin/plugins/:name
### PATCH /api/v1/admin/plugins/:name
```json
{ "enabled": true, "webhookUrl": "https://...", "events": ["message:sent"] }
```
### DELETE /api/v1/admin/plugins/:name
### POST /api/v1/admin/plugins/:name/rotate-key
```json
{ "api_key": "new-generated-key" }
```

## Plugin Routes (Oralsin)

### POST /api/v1/plugins/oralsin/enqueue
**Auth**: `X-API-Key` header (plugin-specific key)
Aceita item unico ou array.
```json
// Request (batch)
[{
  "idempotency_key": "oralsin-sched-abc",
  "patient": { "phone": "5543991938235", "name": "LEVI" },
  "message": { "text": "Sua parcela venceu." },
  "senders": [{ "phone": "5537999001122", "session": "oralsin-1-4", "pair": "MG-Guaxupe", "role": "primary" }],
  "context": { "clinic_id": "uuid", "schedule_id": "uuid" },
  "send_options": { "max_retries": 5, "priority": "high" }
}]
// Response 201
{ "enqueued": 1, "messages": [{ "id": "abc", "idempotency_key": "oralsin-sched-abc", "status": "queued" }] }
```

### GET /api/v1/plugins/oralsin/status
```json
{ "plugin": "oralsin", "version": "1.0.0", "status": "active", "events": ["message:sent", "message:failed"] }
```

### GET /api/v1/plugins/oralsin/queue
```json
{ "pending": 12, "processing": 3, "failed_last_hour": 1, "oldest_pending_age_seconds": 45 }
```

## Socket.IO Events

Conectar: `io("http://localhost:7890")`

| Event | Payload | Quando |
|-------|---------|--------|
| message:queued | `{ id, to, priority }` | Mensagem enfileirada |
| message:sending | `{ id, deviceSerial }` | Worker pegou mensagem |
| message:sent | `{ id, sentAt, durationMs }` | Envio concluido |
| message:failed | `{ id, error }` | Envio falhou |
| device:connected | `{ serial, brand?, model? }` | Device USB detectado |
| device:disconnected | `{ serial }` | Device desconectado |
| device:health | `{ serial, batteryPercent, temperatureCelsius, ramAvailableMb, storageFreeBytes }` | Health poll (30s) |
| alert:new | `{ id, deviceSerial, severity, type, message }` | Novo alerta |
| waha:message_received | `{ sessionName, fromNumber, toNumber, historyId }` | Msg recebida via WAHA |
| waha:message_sent | `{ sessionName, fromNumber, toNumber, historyId, deduplicated }` | Msg enviada capturada |
| waha:session_status | `{ sessionName, status, phoneNumber? }` | Sessao mudou status |
| waha:message_ack | `{ wahaMessageId, ackLevel, ackLevelName, deliveredAt, readAt }` | ACK (entregue/lido) |
