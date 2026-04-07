# Oralsin-Dispatch Integration: API Contracts

> **Date**: 2026-04-06
> **Status**: Finalized — use as source of truth for both implementations
> **Audience**: Anyone implementing either side without reading the full spec

---

## 1. Authentication

All requests between Oralsin and Dispatch use API key authentication:

| Direction | Header | Value |
|-----------|--------|-------|
| Oralsin → Dispatch | `X-API-Key` | Shared API key (env: `DISPATCH_API_KEY`) |
| Dispatch → Oralsin | `X-Dispatch-Signature` | HMAC SHA-256 of request body |

### HMAC Signing Specification

**Algorithm**: HMAC SHA-256
**Key**: Shared secret (env: `DISPATCH_HMAC_SECRET` on Dispatch, same value on Oralsin)
**Input**: Raw JSON request body (UTF-8 bytes)
**Output**: Lowercase hex digest

```
signature = HMAC-SHA256(secret, request_body_bytes).hex()
```

**Verification (Python)**:
```python
import hashlib, hmac

def verify_signature(body: bytes, signature: str, secret: str) -> bool:
    expected = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)
```

**Generation (TypeScript)**:
```typescript
import { createHmac } from 'node:crypto'

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex')
}
```

---

## 2. Enqueue Messages (Oralsin → Dispatch)

### Endpoint

```
POST /plugins/oralsin/enqueue
Host: dispatch-api.debt.com.br
Content-Type: application/json
X-API-Key: <api-key>
```

### Request Body

Accepts a single item or an array:

```json
[
  {
    "idempotency_key": "string (required, unique)",
    "correlation_id": "string (optional)",
    "patient": {
      "phone": "string (required, 10+ digits, BR format)",
      "name": "string (required)",
      "patient_id": "string (optional, UUID)"
    },
    "message": {
      "text": "string (required, pre-rendered message with WhatsApp formatting)",
      "template_id": "string (optional, for audit)"
    },
    "senders": [
      {
        "phone": "string (required, E.164 format e.g. +554396837945)",
        "session": "string (required, WAHA session name e.g. oralsin_1_4)",
        "pair": "string (required, pair name e.g. oralsin-1-4)",
        "role": "primary | overflow | backup | reserve"
      }
    ],
    "context": {
      "clinic_id": "string (UUID)",
      "schedule_id": "string (UUID)",
      "step": "integer (0-13, 100)",
      "channel": "whatsapp",
      "pipeline_run_id": "string",
      "patient_cpf_last4": "string (optional, 4 digits)"
    },
    "send_options": {
      "max_retries": "integer (1-10, default 3)",
      "priority": "normal | high"
    }
  }
]
```

### Field Descriptions

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `idempotency_key` | string | YES | Unique key per message. Format: `{schedule_id}-{channel}`. UNIQUE constraint in Dispatch. |
| `correlation_id` | string | NO | Oralsin's internal correlation ID for tracing. Passed back in callbacks. |
| `patient.phone` | string | YES | Patient phone number in Brazilian format (13 digits: `5543991938235`). |
| `patient.name` | string | YES | Patient name for contact registration on the device. |
| `patient.patient_id` | string | NO | Oralsin patient UUID for correlation. |
| `message.text` | string | YES | Pre-rendered message. WhatsApp formatting (`*bold*`, `_italic_`) works. Emojis stripped for ADB. |
| `message.template_id` | string | NO | Reference to Oralsin template for audit trail. |
| `senders` | array | YES | Ordered list of sender phone numbers, from preferred to last resort. Min 1 item. |
| `senders[].phone` | string | YES | Sender phone number in E.164 format (e.g., `+554396837945`). |
| `senders[].session` | string | YES | WAHA session name for this number (used for WAHA fallback). |
| `senders[].pair` | string | YES | Phone pair name from Oralsin (for audit). |
| `senders[].role` | string | YES | `primary` = patient's adopted sender. Others are fallbacks. |
| `context` | object | NO | Opaque metadata passed through to callbacks. Not processed by Dispatch. |
| `send_options.max_retries` | int | NO | ADB retry count before WAHA fallback. Default 3. |
| `send_options.priority` | string | NO | `high` = skip sender-grouped queue, send immediately. Default `normal`. |

### Response: 201 Created

```json
{
  "enqueued": 3,
  "messages": [
    {
      "id": "dispatch-msg-abc123",
      "idempotency_key": "uuid-schedule-1-whatsapp",
      "status": "queued"
    },
    {
      "id": "dispatch-msg-def456",
      "idempotency_key": "uuid-schedule-2-whatsapp",
      "status": "queued"
    },
    {
      "id": "dispatch-msg-ghi789",
      "idempotency_key": "uuid-schedule-3-whatsapp",
      "status": "queued"
    }
  ]
}
```

### Response: 409 Conflict (duplicate)

```json
{
  "error": "Duplicate idempotency key"
}
```

### Response: 400 Bad Request

```json
{
  "error": "Validation failed",
  "details": [
    {
      "code": "too_small",
      "minimum": 1,
      "type": "array",
      "path": ["senders"],
      "message": "Array must contain at least 1 element(s)"
    }
  ]
}
```

### Response: 422 Unprocessable Entity

```json
{
  "error": "No sender mapping found for any sender phone number",
  "details": {
    "attempted_senders": ["+554396837945", "+554396837844"],
    "suggestion": "Configure sender mapping via POST /api/v1/sender-mapping"
  }
}
```

---

## 3. Result Callback (Dispatch → Oralsin)

Sent when a message is delivered or permanently fails.

### Endpoint

```
POST /api/v1/webhooks/dispatch/callback/
Host: gestao.debt.com.br
Content-Type: application/json
X-Dispatch-Signature: <hmac-sha256-hex>
```

### Payload: Sent Successfully

```json
{
  "idempotency_key": "uuid-schedule-1-whatsapp",
  "correlation_id": "notif-abc123def456",
  "status": "sent",
  "sent_at": "2026-04-06T14:30:00.000Z",
  "delivery": {
    "message_id": "dispatch-msg-abc123",
    "provider": "adb",
    "sender_phone": "+554396837945",
    "sender_session": "oralsin_1_4",
    "pair_used": "oralsin-1-4",
    "used_fallback": false,
    "elapsed_ms": 28500
  },
  "error": null,
  "fallback_reason": null,
  "context": {
    "clinic_id": "uuid-clinic-190",
    "schedule_id": "uuid-schedule-xyz",
    "step": 1,
    "channel": "whatsapp",
    "pipeline_run_id": "temporal-wf-20260406-1200"
  }
}
```

### Payload: Sent via WAHA Fallback

```json
{
  "idempotency_key": "uuid-schedule-1-whatsapp",
  "correlation_id": "notif-abc123def456",
  "status": "sent",
  "sent_at": "2026-04-06T14:30:45.000Z",
  "delivery": {
    "message_id": "dispatch-msg-abc123",
    "provider": "waha",
    "sender_phone": "+554396837945",
    "sender_session": "oralsin_1_4",
    "pair_used": "oralsin-1-4",
    "used_fallback": true,
    "elapsed_ms": 35200
  },
  "error": null,
  "fallback_reason": {
    "original_error": "device_offline",
    "original_session": "oralsin_1_4",
    "quarantined": false
  },
  "context": { "..." : "..." }
}
```

### Payload: Permanently Failed

```json
{
  "idempotency_key": "uuid-schedule-1-whatsapp",
  "correlation_id": "notif-abc123def456",
  "status": "failed",
  "sent_at": null,
  "delivery": null,
  "error": {
    "code": "BAN_DETECTED",
    "message": "WhatsApp account banned on device POCO_001",
    "details": {
      "device_serial": "9b01005930533036",
      "ocr_confidence": 0.82,
      "adb_attempts": 3,
      "waha_attempted": true
    },
    "retryable": false,
    "retry_after_seconds": 1800
  },
  "fallback_reason": {
    "original_error": "ban_detected",
    "original_session": "oralsin_1_4",
    "quarantined": true
  },
  "context": { "..." : "..." }
}
```

### Field Descriptions

| Field | Type | Description |
|-------|------|-------------|
| `idempotency_key` | string | Same key from enqueue request. Use to correlate with ContactHistory. |
| `correlation_id` | string | Same ID from enqueue. Oralsin's internal tracing ID. |
| `status` | "sent" \| "failed" | Final delivery status. |
| `sent_at` | ISO-8601 \| null | When message was actually sent (null if failed). |
| `delivery.message_id` | string | Dispatch internal message ID. Store as `external_message_id`. |
| `delivery.provider` | "adb" \| "waha" | Which provider delivered the message. |
| `delivery.sender_phone` | string | Which sender number was actually used. |
| `delivery.sender_session` | string | WAHA session name of the sender. |
| `delivery.pair_used` | string | Oralsin phone pair name. |
| `delivery.used_fallback` | boolean | True if WAHA was used instead of ADB. |
| `delivery.elapsed_ms` | integer | Total time from dequeue to send complete. |
| `error.code` | string | Machine-readable error code. See Error Codes below. |
| `error.message` | string | Human-readable error description. |
| `error.retryable` | boolean | Whether Oralsin should re-enqueue this message. |
| `error.retry_after_seconds` | integer | Minimum wait before re-enqueue (only if retryable). |
| `fallback_reason` | object \| null | Present when WAHA fallback was attempted. |
| `context` | object | Passthrough from enqueue — same object, untouched. |

---

## 4. ACK Callback (Dispatch → Oralsin)

Sent when WAHA receives delivery/read receipts for a message originally sent via ADB.

### Endpoint

Same as result callback: `POST /api/v1/webhooks/dispatch/callback/`

### Payload

```json
{
  "idempotency_key": "uuid-schedule-1-whatsapp",
  "message_id": "dispatch-msg-abc123",
  "event": "ack_update",
  "ack": {
    "level": 3,
    "level_name": "read",
    "delivered_at": "2026-04-06T14:30:05.000Z",
    "read_at": "2026-04-06T14:35:12.000Z"
  }
}
```

### ACK Levels

| Level | Name | Oralsin Action |
|-------|------|----------------|
| 1 | server | Message reached WhatsApp servers. No action needed. |
| 2 | device | Message delivered to recipient's device. Set `ContactHistory.delivered_at`. |
| 3 | read | Message read by recipient. Set `ContactHistory.read_at`. |
| 4 | played | Audio message played. Set `ContactHistory.read_at` (same as level 3). |

### Field Descriptions

| Field | Type | Description |
|-------|------|-------------|
| `idempotency_key` | string | Same key from enqueue. |
| `message_id` | string | Dispatch internal message ID (same as `delivery.message_id` from result callback). |
| `event` | "ack_update" | Discriminator for event type. |
| `ack.level` | integer | WAHA ACK level (1-4). |
| `ack.level_name` | string | Human-readable: "server", "device", "read", "played". |
| `ack.delivered_at` | ISO-8601 \| null | Timestamp of first delivery (ACK >= 2). |
| `ack.read_at` | ISO-8601 \| null | Timestamp of first read (ACK >= 3). |

### Oralsin handling

```python
# Lookup ContactHistory by external_message_id (set in result callback)
qs = ContactHistory.objects.filter(external_message_id=message_id)

if ack_level >= 2:
    qs.filter(delivered_at__isnull=True).update(delivered_at=now)  # first-write-wins
if ack_level >= 3:
    qs.filter(read_at__isnull=True).update(read_at=now)  # first-write-wins
```

---

## 5. Response Callback (Dispatch → Oralsin)

Sent when a patient replies to a message that was sent via Dispatch.

### Endpoint

Same as result callback: `POST /api/v1/webhooks/dispatch/callback/`

### Payload

```json
{
  "idempotency_key": "uuid-schedule-1-whatsapp",
  "message_id": "dispatch-msg-abc123",
  "event": "patient_response",
  "response": {
    "body": "Ja realizei o pagamento ontem",
    "received_at": "2026-04-06T15:10:00.000Z",
    "from_number": "5543991938235",
    "has_media": false
  }
}
```

### Field Descriptions

| Field | Type | Description |
|-------|------|-------------|
| `event` | "patient_response" | Discriminator for event type. |
| `response.body` | string | Patient's reply text. May include media indicators. |
| `response.received_at` | ISO-8601 | When the reply was captured by WAHA. |
| `response.from_number` | string | Patient's phone number (13-digit BR format). |
| `response.has_media` | boolean | True if reply includes image/video/audio/document. |

### Oralsin handling

```python
# Same logic as existing _update_contact_history_response in WAHA webhook
history = ContactHistory.objects.filter(
    external_message_id=message_id
).order_by("-sent_at").first()

if history:
    existing = history.patient_response or ""
    new_text = f"[{received_at}] {body}"
    history.patient_response = f"{existing}\n{new_text}".strip() if existing else new_text
    history.response_received_at = now
    history.save(update_fields=["patient_response", "response_received_at"])
```

---

## 6. Error Codes

Error codes used in result callback `error.code`:

| Code | Retryable | Description | Suggested Action |
|------|-----------|-------------|------------------|
| `TRANSIENT_FAILURE` | YES | Temporary ADB failure (timeout, UI glitch) | Re-enqueue after `retry_after_seconds` |
| `APP_CRASH` | YES | WhatsApp crashed during send | Re-enqueue after 60s |
| `DEVICE_OFFLINE` | YES | Android device disconnected | Re-enqueue after 300s |
| `BAN_DETECTED` | NO | WhatsApp account banned (OCR confirmed) | Do NOT re-enqueue. Quarantine sender in Oralsin. |
| `ALL_SENDERS_EXHAUSTED` | NO | All senders in `senders[]` failed | Mark schedule as REJECTED in Oralsin. |
| `QUEUE_FULL` | YES | Dispatch queue exceeds capacity | Re-enqueue after 600s |
| `INVALID_NUMBER` | NO | Patient number not on WhatsApp | Mark schedule as REJECTED with reason. |
| `WAHA_FALLBACK_FAILED` | YES | Both ADB and WAHA failed | Re-enqueue after `retry_after_seconds` |
| `DUPLICATE_ENQUEUE` | NO | Idempotency key already exists | Ignore — message already in queue. |

---

## 7. Retry Behavior

### Dispatch-side retries (transparent to Oralsin)

| Failure Type | Action | Max Attempts |
|-------------|--------|-------------|
| ADB transient | Retry on same device | `max_retries` (default 3) |
| ADB app crash | Force-stop WA + restart + retry | 2 |
| ADB ban | Quarantine sender, try next from `senders[]` | 1 per sender |
| All ADB senders failed | WAHA fallback | 1 |

### Oralsin-side retries (after callback)

| Callback Status | Oralsin Action |
|----------------|----------------|
| `status=sent` | Mark ContactHistory as success. Consume weekly limit. |
| `status=failed`, `retryable=true` | Wait `retry_after_seconds`, then re-enqueue to Dispatch |
| `status=failed`, `retryable=false` | Mark schedule as REJECTED. Create ContactHistory with error. |
| No callback after 10 minutes | Poll `GET /plugins/oralsin/queue` for status |

### Callback delivery retries (Dispatch → Oralsin)

| Attempt | Delay | Total elapsed |
|---------|-------|---------------|
| 1 | Immediate | 0s |
| 2 | 5 seconds | 5s |
| 3 | 15 seconds | 20s |
| Failed | Stored in `failed_callbacks` table | Manual retry via API |

---

## 8. Idempotency Key Format

### Generation (Oralsin side)

```python
idempotency_key = f"{schedule.id}-{channel}"
# Example: "a1b2c3d4-e5f6-7890-abcd-ef1234567890-whatsapp"
```

### Guarantees

| Operation | Idempotency Mechanism |
|-----------|----------------------|
| Enqueue (Oralsin → Dispatch) | `idempotency_key` UNIQUE constraint in SQLite. 409 on duplicate. |
| Callback (Dispatch → Oralsin) | At-least-once delivery. Oralsin must handle duplicate callbacks. |
| ContactHistory creation | `UNIQUE(schedule, contact_type, advance_flow)` in PostgreSQL. |
| Weekly limit | Atomic Redis INCR per patient/channel/week. Reserve/confirm pattern. |
| ACK updates | `filter(delivered_at__isnull=True).update()` — first-write-wins. |

---

## 9. Sender Mapping CRUD (Dispatch API)

### Create Mapping

```
POST /api/v1/sender-mapping
Content-Type: application/json
X-API-Key: <api-key>
```

```json
{
  "phone_number": "+554396837945",
  "device_serial": "9b01005930533036",
  "profile_id": 0,
  "app_package": "com.whatsapp",
  "waha_session": "oralsin_1_4",
  "waha_api_url": "https://gows-chat.debt.com.br"
}
```

Response: 201 Created
```json
{
  "id": "mapping-abc123",
  "phone_number": "+554396837945",
  "device_serial": "9b01005930533036",
  "profile_id": 0,
  "app_package": "com.whatsapp",
  "waha_session": "oralsin_1_4",
  "waha_api_url": "https://gows-chat.debt.com.br",
  "active": true,
  "created_at": "2026-04-06T10:00:00.000Z"
}
```

### List Mappings

```
GET /api/v1/sender-mapping
X-API-Key: <api-key>
```

Response: 200 OK
```json
{
  "mappings": [
    {
      "phone_number": "+554396837945",
      "device_serial": "9b01005930533036",
      "profile_id": 0,
      "app_package": "com.whatsapp",
      "waha_session": "oralsin_1_4",
      "active": true
    },
    {
      "phone_number": "+554396837844",
      "device_serial": "9b01005930533036",
      "profile_id": 0,
      "app_package": "com.whatsapp.w4b",
      "waha_session": "oralsin_2_3",
      "active": true
    }
  ]
}
```

### Get Single Mapping

```
GET /api/v1/sender-mapping/:phone
X-API-Key: <api-key>
```

Response: 200 OK (single mapping object) or 404 Not Found.

### Update Mapping

```
PUT /api/v1/sender-mapping/:phone
Content-Type: application/json
X-API-Key: <api-key>
```

```json
{
  "device_serial": "NEW_DEVICE_001",
  "profile_id": 10,
  "active": true
}
```

Response: 200 OK (updated mapping object).

### Delete Mapping

```
DELETE /api/v1/sender-mapping/:phone
X-API-Key: <api-key>
```

Response: 204 No Content.

---

## 10. Status and Queue Endpoints (Dispatch API)

### Plugin Status

```
GET /plugins/oralsin/status
X-API-Key: <api-key>
```

Response:
```json
{
  "plugin": "oralsin",
  "version": "1.0.0",
  "status": "active",
  "events": ["message:sent", "message:failed"]
}
```

### Queue Stats

```
GET /plugins/oralsin/queue
X-API-Key: <api-key>
```

Response:
```json
{
  "pending": 42,
  "processing": 3,
  "failed_last_hour": 1,
  "oldest_pending_age_seconds": 120
}
```

### Health Check

```
GET /healthz
```

Response:
```json
{
  "status": "healthy",
  "uptime_seconds": 12345,
  "devices": { "online": 2, "total": 2 },
  "queue": { "pending": 42, "processing": 3, "failed_last_hour": 1 },
  "plugins": { "oralsin": "active" },
  "last_send_at": "2026-04-06T14:30:00.000Z"
}
```

---

## 11. Phone Number Formats

Brazilian phone number handling is critical for correlation between ADB and WAHA.

| Context | Format | Example | Digits |
|---------|--------|---------|--------|
| Oralsin → Dispatch (patient.phone) | Full 13-digit | `5543991938235` | 13 |
| Oralsin → Dispatch (senders[].phone) | E.164 | `+554396837945` | 13 (with +) |
| ADB wa.me URL | Full 13-digit | `https://wa.me/5543991938235` | 13 |
| WAHA chatId | 12-digit + @c.us | `554391938235@c.us` | 12 |
| WAHA webhook from_number | 12-digit + @c.us | `554391938235@c.us` | 12 |

### Normalization Rule (Brazilian mobile)

If number has 13 digits, starts with `55`, and 5th digit is `9`: remove the 5th digit.

```
5543991938235 → 554391938235 (WAHA format)
```

**Dispatch stores the full 13-digit number and normalizes only when correlating with WAHA.**

---

## 12. Environment Variables Reference

### Oralsin (`.env`)

```env
DISPATCH_API_URL=https://dispatch-api.debt.com.br
DISPATCH_API_KEY=dispatch_oralsin_prod_key_2026
DISPATCH_HMAC_SECRET=shared_hmac_secret_32bytes_hex
DISPATCH_ENABLED=false
DISPATCH_FALLBACK_TO_WAHA=true
DISPATCH_CALLBACK_URL=https://gestao.debt.com.br/api/v1/webhooks/dispatch/callback/
DISPATCH_CLINIC_IDS=                      # empty = all clinics when enabled
```

### Dispatch (`.env`)

```env
PORT=7890
NODE_ENV=production
API_KEY=dispatch_oralsin_prod_key_2026
ORALSIN_WEBHOOK_URL=https://gestao.debt.com.br/api/v1/webhooks/dispatch/callback/
ORALSIN_HMAC_SECRET=shared_hmac_secret_32bytes_hex
WAHA_API_URL=https://gows-chat.debt.com.br
WAHA_API_KEY=<gows-api-key>
```
