# Dispatch ↔ Oralsin Contract

> **Version**: 2.0 (Hardening Sprint)
> **Date**: 2026-04-13
> **Status**: Active — Python side must deploy `interim_failure`/`expired` handlers before Dispatch

## Enqueue Request

`POST /api/v1/plugins/oralsin/enqueue`

**Headers**:
- `X-API-Key: <PLUGIN_ORALSIN_API_KEY>` (required)
- `Content-Type: application/json`

**Body**: Single item or array (max 500 items)

```json
{
  "idempotency_key": "sched-123-whatsapp",
  "correlation_id": "notif-abc",
  "patient": {
    "phone": "5543991938235",
    "name": "Maria Silva",
    "patient_id": "uuid-1"
  },
  "message": {
    "text": "Lembrete de consulta...",
    "template_id": "overdue_reminder_v2"
  },
  "senders": [
    { "phone": "+554396837945", "session": "oralsin_1_4", "pair": "oralsin-1-4", "role": "primary" },
    { "phone": "+554396837813", "session": "oralsin_2_2", "pair": "oralsin-2-2", "role": "overflow" }
  ],
  "context": { "schedule_id": 123, "clinic_id": 5 },
  "send_options": { "max_retries": 3, "priority": "normal" }
}
```

**Validation**:
- `patient.phone`, `senders[].phone`: E.164 regex `/^\+?\d{10,15}$/`
- `message.text`: max 4096 chars
- Batch: max 500 items
- `context`: max 64KB JSON
- `send_options.priority`: `"normal"` | `"high"`
- `send_options.max_retries`: 1-10

**Phone Normalization** (Postel's Law):
- `+554396837945` and `554396837945` resolve to same sender_mapping row
- Dispatch normalizes to digits-only on receipt

**Partial Failure**: Blacklisted/duplicate items are skipped per-item (no rollback).

## Callback Types (5 total)

All callbacks are `POST` to `PLUGIN_ORALSIN_WEBHOOK_URL` with:
- `Content-Type: application/json`
- `X-Dispatch-Signature: <HMAC-SHA256 of body>`

### 1. `result` — Send complete

```json
{
  "idempotency_key": "sched-123-whatsapp",
  "correlation_id": "notif-abc",
  "status": "sent",
  "sent_at": "2026-04-13T15:00:00.123Z",
  "delivery": {
    "message_id": "waha-msg-id",
    "provider": "adb",
    "sender_phone": "554396837945",
    "sender_session": "oralsin_1_4",
    "pair_used": "oralsin-1-4",
    "used_fallback": false,
    "elapsed_ms": 12500,
    "device_serial": "9b01005930533036340030832250ac",
    "profile_id": 0,
    "char_count": 142,
    "contact_registered": true,
    "screenshot_url": "/api/v1/messages/abc123/screenshot",
    "dialogs_dismissed": 1,
    "user_switched": false
  },
  "error": null,
  "context": { "schedule_id": 123, "clinic_id": 5, "patient_id": "uuid-1", "template_id": "overdue_reminder_v2" }
}
```

### 2. `ack_update` — Delivery/read receipt

```json
{
  "idempotency_key": "sched-123-whatsapp",
  "message_id": "waha-msg-id",
  "event": "ack_update",
  "ack": { "level": 3, "level_name": "read", "delivered_at": "...", "read_at": "..." }
}
```

### 3. `patient_response` — Patient replies

```json
{
  "idempotency_key": "sched-123-whatsapp",
  "message_id": "waha-msg-id",
  "event": "patient_response",
  "response": { "body": "ok confirmado", "received_at": "...", "from_number": "5543991938235", "has_media": false }
}
```

### 4. `interim_failure` — ADB failed, before fallback

```json
{
  "event": "interim_failure",
  "idempotency_key": "sched-123-whatsapp",
  "correlation_id": "notif-abc",
  "status": "interim_failed",
  "error": { "code": "ban_detected", "message": "WhatsApp session banned", "retryable": true },
  "failed_sender": { "phone": "+554396835095", "session": "oralsin_2_1", "pair": "oralsin-2-1" },
  "next_sender": { "phone": "+554396837813", "session": "oralsin_2_2", "pair": "oralsin-2-2", "role": "overflow" },
  "attempt": 1,
  "context": { "schedule_id": 123, "clinic_id": 5 }
}
```

### 5. `expired` — TTL expired

```json
{
  "event": "expired",
  "idempotency_key": "sched-123-whatsapp",
  "correlation_id": "notif-abc",
  "status": "expired",
  "error": { "code": "ttl_expired", "message": "No device available for 24h", "retryable": false },
  "context": { "schedule_id": 123, "clinic_id": 5 }
}
```

## HMAC Verification

```python
import hmac, hashlib

def verify_dispatch_signature(body_bytes: bytes, secret: str, signature: str) -> bool:
    expected = hmac.new(secret.encode(), body_bytes, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)
```

## 503 Retry Semantics

Dispatch retries 503 responses with short backoff: [0, 1s, 2s, 4s].
Other 5xx: standard backoff [0, 5s, 30s, 120s].
4xx: non-retryable (breaks immediately).

## `fallback_reason` (in result callback when `used_fallback=true`)

```json
{
  "original_error": "ban_detected",
  "original_message": "WhatsApp session banned on device oralsin-2-1",
  "original_session": "oralsin_2_1",
  "quarantined": true
}
```
