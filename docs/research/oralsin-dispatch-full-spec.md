# Oralsin-Dispatch Full Integration Specification

**Date**: 2026-04-06
**Author**: Principal Software Architect
**Status**: Complete Specification
**Sources**: Oralsin production server (178.156.197.144), Dispatch codebase (/var/www/adb_tools)

---

## Part 1: Oralsin Side — Current State

### 1.1 Relevant Django Models

#### ContactHistory (`contact_history` table)
The central delivery tracking model. Every notification attempt creates a record here.

```
ContactHistory
├── id: UUID (PK)
├── patient: FK → Patient
├── contract: FK → Contract (nullable)
├── clinic: FK → Clinic
├── notification_trigger: "automated" | "manual"
├── advance_flow: bool
├── contact_type: "sms" | "email" | "whatsapp"
├── sent_at: datetime (indexed)
├── duration_ms: int (nullable)
├── success: bool
├── outcome: "success" | "error" | "blocked" | "reconciled" | "warning" | "info" | "pending"
├── outcome_reason: str (nullable) — e.g. "weekly_limit", "provider_error", "deferred"
├── feedback_status: str (nullable)
├── observation: text (nullable)
├── message: FK → Message (nullable)
├── schedule: FK → ContactSchedule (nullable)
│
│   ── DELIVERY TRACKING ──
├── external_message_id: str (indexed) — WAHA message_id (e.g. "true_55...@c.us_3EB0...")
├── delivered_at: datetime (indexed) — set when ACK >= 2 (DEVICE)
├── read_at: datetime (indexed) — set when ACK >= 3 (READ)
├── message_text: text — full message copy for audit
│
│   ── RESPONSE TRACKING ──
├── patient_response: text — patient's reply text (appended with timestamps)
├── response_received_at: datetime (indexed) — when reply was captured
│
│   ── SENDER TRACKING ──
├── sender_phone: str (indexed) — sender number from phone pool
├── sender_provider: str — "waha", "waba", "bsp"
├── phone_pair: FK → PhonePair (nullable) — which PhonePair was used
│
│   ── TRACING ──
├── trace_id: str — OpenTelemetry trace ID
├── span_id: str
├── worker_hostname: str
├── worker_id: str
├── task_id: str — Celery/RabbitMQ task correlation
├── pipeline_run_id: str — Temporal workflow ID
├── correlation_id: str — unique per-notification correlation
│
│   ── AUDIT ──
├── lock_acquired_at: datetime
├── lock_released_at: datetime
├── lock_duration_ms: int
├── rate_limiter_wait_ms: int
├── tokens_acquired: int
├── validation_checks: JSON — {check_name: passed}
├── outcome_details: JSON — {http_status, provider_latency_ms, retry_count, error_code}
├── installment_snapshot: JSON
├── installment_snapshot_taken_at: datetime
├── created_at: datetime
└── updated_at: datetime

Constraint: UNIQUE(schedule, contact_type, advance_flow)
```

**Key insight**: `external_message_id` is the bridge between Oralsin and WAHA. When Dispatch sends via ADB, it must populate this field (or an equivalent correlation ID) so Oralsin can track delivery status.

#### ContactSchedule (`contact_schedules` table)
Represents a pending notification to be sent.

```
ContactSchedule
├── id: UUID (PK)
├── patient: FK → Patient
├── installment: FK → Installment (nullable)
├── contract: FK → Contract (nullable)
├── clinic: FK → Clinic
├── notification_trigger: "automated" | "manual"
├── advance_flow: bool
├── current_step: int — escalation step (0, 100, 1-13)
├── channel: str — "sms", "whatsapp", "email", "phonecall", "letter"
├── scheduled_date: datetime
├── status: "pending" | "approved" | "processing" | "rejected" | "cancelled_paid"
├── created_at: datetime
└── updated_at: datetime

Constraints:
  UNIQUE(patient, contract, current_step, channel, installment) WHERE status='pending'
  UNIQUE(patient, channel) WHERE status='pending' AND notification_trigger='automated'
```

#### PhonePair (number pool)
A pair of WhatsApp delivery channels.

```
PhonePair
├── id: UUID (PK)
├── name: str (unique) — e.g. "oralsin-1-4"
├── region: str — "SP", "MG", "RJ"
├── waha_session_name: str — WAHA session identifier
├── waha_phone_number: str — E.164 format (+554396837945)
├── waha_api_url: URL
├── waha_api_key: str
├── waba_phone_number_id: str (backup, optional)
├── waba_access_token: str (backup, optional)
├── waba_business_account_id: str
├── health_check_number: str
├── active: bool
├── created_at: datetime
└── updated_at: datetime
```

#### PhonePairAssignment (clinic-to-pair routing)

```
PhonePairAssignment
├── id: UUID (PK)
├── clinic: FK → CoveredClinic
├── phone_pair: FK → PhonePair
├── role: "primary" | "overflow" | "backup" | "reserve"
├── priority: int — lower = higher priority
├── active: bool
├── assigned_at: datetime
└── assigned_by: str — "manual", "rebalance_workflow", "failover_auto"

Constraint: UNIQUE(clinic, phone_pair)
```

#### PatientPhoneAffinity (patient-to-number binding)

```
PatientPhoneAffinity
├── id: UUID (PK)
├── patient: FK → Patient
├── clinic: FK → CoveredClinic
├── phone_pair: FK → PhonePair
├── phone_number: str — physical number at time of adoption
├── source: "history_migration" | "first_contact" | "reassigned_ban" | "manual"
├── created_at: datetime
└── updated_at: datetime

Constraint: UNIQUE(patient, clinic)
```

#### WahaMessage (WAHA webhook metrics)

```
WahaMessage
├── id: str (PK) — WAHA message ID
├── session_name: str
├── worker_id: str (nullable)
├── clinic: FK → Clinic (nullable)
├── chat_id: str
├── from_number: str (nullable)
├── to_number: str (nullable)
├── direction: "outbound" | "inbound"
├── status: "sent" | "delivered" | "read" | "failed" | "pending" | "error"
├── ack_code: int (nullable) — WAHA ACK level
├── sent_at: datetime (nullable)
├── delivered_at: datetime (nullable)
├── read_at: datetime (nullable)
├── failed_at: datetime (nullable)
├── body: text (nullable)
├── has_media: bool
├── media_type: str (nullable)
├── source: str — default "api"
├── metadata: JSON (nullable)
├── created_at: datetime
└── updated_at: datetime
```

#### WahaResponse (incoming replies)

```
WahaResponse
├── id: str (PK)
├── session_name: str
├── from_number: str
├── reply_to_message: FK → WahaMessage (nullable)
├── timestamp: datetime
├── body: text (nullable)
├── has_media: bool
└── created_at: datetime
```

#### Message (templates)

```
Message
├── id: UUID (PK)
├── type: str — "whatsapp", "sms", "email"
├── content: str — Django template syntax with WhatsApp formatting
├── step: int — flow step number
├── clinic_id: UUID (nullable) — clinic-specific override
├── is_default: bool
├── created_at: datetime
└── updated_at: datetime
```

#### FlowStepConfig (escalation ladder)

```
FlowStepConfig
├── id: UUID (PK)
├── step_number: int
├── channels: list[str] — e.g. ["sms", "whatsapp"]
├── cooldown_days: int (default 7)
├── active: bool
├── description: str (nullable)
├── created_at: datetime
└── updated_at: datetime
```

#### DeferredNotification (retry queue for transient failures)

```
DeferredNotification
├── id: UUID (PK)
├── schedule: FK → ContactSchedule
├── clinic: FK → Clinic
├── patient: FK → Patient
├── reason: str — "number_check_unavailable", etc.
├── status: "pending" | "retried" | "expired"
├── retry_count: int (default 0)
├── max_retries: int (default 3)
├── created_at: datetime
├── resolved_at: datetime (nullable)
└── last_error: text

Constraint: UNIQUE(schedule) WHERE status='pending'
```

### 1.2 WAHA Webhook Handling

**Endpoint**: `POST /api/v1/webhooks/waha-gows/oralsin/`

**Source file**: `src/plugins/django_interface/views/waha_webhook_view.py`

**Security**:
- HMAC SHA-512 or SHA-256 validation (optional — GoWS global webhook may not send HMAC)
- Payload sanitization
- Replay prevention
- Only processes `oralsin_*` sessions (prefix filter)

**Events processed**:

| Event | Handler | Action |
|-------|---------|--------|
| `message.any` | `metrics_repo.store_message_sent()` | Stores in `WahaMessage` table |
| `message.any` (incoming) | `_update_contact_history_response()` | Updates `ContactHistory.patient_response` |
| `message.ack` | `metrics_repo.update_message_status()` | Updates `WahaMessage.status/ack_code` |
| `message.ack` | `_update_contact_history_ack()` | Updates `ContactHistory.delivered_at/read_at` |
| `message` (incoming) | `metrics_repo.store_message_received()` | Stores in `WahaMessage` |
| `message` (incoming) | `_update_contact_history_response()` | Captures patient reply |
| `session.status` | `metrics_repo.update_session_status()` | Updates `WahaSessionStatus` |
| `engine.event` | (conditional) | Maps to session status if applicable |

#### ACK Level Tracking

WAHA ACK levels used by Oralsin:

| ACK Level | Name | Oralsin Action |
|-----------|------|----------------|
| -1 | ERROR | No action |
| 0 | PENDING | No action |
| 1 | SERVER | No action (message reached WA servers) |
| 2 | DEVICE | Set `ContactHistory.delivered_at` (first delivery wins) |
| 3 | READ | Set `ContactHistory.read_at` (first read wins) |
| 4 | PLAYED | Set `ContactHistory.read_at` (audio played) |

**ACK bridge code** (`_update_contact_history_ack`):
```python
# Looks up ContactHistory by external_message_id
qs = ContactHistory.objects.filter(external_message_id=msg_id)
if ack_level >= 2:
    qs.filter(delivered_at__isnull=True).update(delivered_at=now)
if ack_level >= 3:
    qs.filter(read_at__isnull=True).update(read_at=now)
```

#### Patient Response Capture

The `_update_contact_history_response` function:
1. Filters out outbound messages (`fromMe=True`)
2. Extracts phone digits from c.us format
3. Matches patient by last 8 digits via `PatientPhone` table
4. Updates the most recent `ContactHistory` (within 48h window) with:
   - `patient_response` — text + media indicators
   - `response_received_at` — timestamp
5. Appends to existing response if multiple replies

### 1.3 Notification Send Pipeline

**Source**: `src/notification_billing/core/application/handlers/notification_handlers.py`

#### Automated Flow (RunAutomatedNotificationsHandler)

```
1. Check: notifications_disabled? (ENV + DB toggle)
2. Check: clinic paused? (NotificationPauseRequest)
3. Check: business window? (10:00-19:00 Mon-Fri)
4. Load: PatientPhoneResolver + clinic pairs + affinity map
5. Triple resync: fetch fresh defaulter CPFs from Oralsin API
6. FOR each pending schedule group (patient/contract/step):
   a. Lock pessimistically (SELECT FOR UPDATE skip_locked)
   b. Validate: is_still_defaulter? (triple resync check)
   c. Write-ahead: create PENDING ContactHistory (crash recovery)
   d. Weekly limit check: Redis INCR atomic (1 msg/patient/channel/week)
   e. Resolve phone pair: PatientPhoneResolver → adopted pair or fallback
   f. Send: PhonePoolService.send() → WAHA API
   g. Update: ContactHistory with result, external_message_id, sender info
   h. Advance step if ALL blocking channels succeeded
7. Record deferrals for transient failures
```

#### _send_through_notifier (WhatsApp path)

When channel is "whatsapp", the flow is:

```
1. NotificationSenderService.send()
2. → get_notifier("whatsapp") → WAHAWhatsapp (or legacy DebtApp)
3. → WAHAWhatsapp.send(WhatsappNotificationDTO)
4. → WAHAAPI.send_text(number, text)
   a. _apply_rate_limit() — volume-scaled delay
   b. _simulate_typing_action() — startTyping/delay/stopTyping
   c. POST /api/sendText
5. Returns {message_id, elapsed_s}
```

**Key issue for Dispatch integration**: The current `NotificationSenderService.send()` calls `get_notifier("whatsapp")` which returns a single global WAHA notifier. This does NOT use the phone pool. The phone pool is used separately in `_send_through_notifier`:

```python
def _send_through_notifier(self, schedule, channel):
    # ... (resolves patient phone, template, etc.)
    if self._phone_pool and channel == "whatsapp":
        pair = self._resolve_phone_pair_for_patient(schedule)
        result = self._phone_pool.send(pair, phone_number, content, context)
        note = f"[{result.pair_name}/{result.provider}] id={result.message_id}"
        return result.success, note
    else:
        # Fallback to global notifier
        notifier = get_notifier(channel)
        notifier.send(WhatsappNotificationDTO(to=phone, message=content))
```

### 1.4 Phone Number Resolution (Adoption Rule)

**Source**: `src/notification_billing/core/application/services/patient_phone_resolver.py`

Resolution order:
1. **Check affinity**: `PatientPhoneAffinity` for patient+clinic
2. **If adopted pair exists and healthy**: Use it (is_adopted=True)
3. **If adopted pair quarantined**: Temporary fallback to other clinic pair (no affinity creation)
4. **If adopted pair deactivated/number changed**: Invalidate affinity, assign new pair
5. **If no affinity**: Round-robin via Redis INCR across available clinic pairs, create new affinity
6. **If all pairs quarantined**: Deferred (notification retried later)

Failover chain in `_load_phone_pair_for_clinic`:
```
primary/overflow pairs (round-robin) → backup pairs → global reserve → quarantined pair (last resort)
```

### 1.5 Rate Limiting Stack

#### Global Oralsin API Rate Limiter
**Source**: `src/notification_billing/core/application/services/oralsin_rate_limiter.py`
- Sliding window in Redis sorted set (Lua script)
- Default: 15 requests/second (configurable via `ORALSIN_RATE_LIMIT_PER_SECOND`)
- Max wait: 10 seconds
- Fail-open if Redis unavailable

#### Per-Session WAHA Rate Limiter
**Source**: `src/notification_billing/adapters/providers/waha/client.py`
- Per-number volume-scaled delays
- Base: 20-35s between messages (random)
- Volume scaling: 1.5x every 10 messages in 60-min window
- Max delay: 120s
- Pair rate limit: 6s between messages to same recipient
- Typing simulation: 2-8s based on message length (25 chars/sec)

#### Weekly Limit
**Source**: notification_handlers.py `_check_weekly_limit_with_lock()`
- 1 notification per patient per channel per ISO week
- Atomic Redis INCR with DB fallback
- Reserve/Confirm pattern: DECR on failure

### 1.6 Quarantine System

**Source**: `PhonePoolService._record_failure()` / `PhoneHealthMonitor`

- **Failure threshold**: 3 consecutive failures → quarantine
- **Quarantine TTL**: 30 minutes (Redis `SETEX`)
- **Failure counter TTL**: 1 hour
- **Health monitoring levels**:
  - Level 1 (5min): `GET /health` basic connectivity
  - Level 2 (30min): `GET /api/sessions/{name}` session status
  - Summary report every 1 hour via Telegram
- **Auto-restore**: If health check passes while quarantined, failures reset and quarantine key deleted
- **Leader election**: Redis `SET NX` with TTL — only one worker runs health checks

### 1.7 Template Rendering

**Source**: `src/notification_billing/core/utils/template_utils.py`

Uses Django's template engine:
```python
def render_message(template_str: str, context: dict) -> str:
    tpl = Template(template_str)
    ctx = Context(context)
    return tpl.render(ctx)
```

Context variables:
- `{{ nome }}` — sanitized patient name
- `{{ valor }}` — formatted currency (R$ 1.234,56)
- `{{ vencimento }}` — formatted date (DD/MM/YYYY)
- `{{ total_parcelas_em_atraso }}` — overdue installment count
- `{{ contact_phone }}` — clinic contact phone
- Conditional: `{% if contact_phone %}...{% endif %}`

Templates use WhatsApp markdown: `*bold*`, `_italic_`

### 1.8 Brazilian Phone Number Normalization

**Source**: `WAHAAPI._normalize_br_phone_for_waha()`

WhatsApp uses the OLD 8-digit format for Brazilian mobile numbers:
```
5543991938235 → 554391938235@c.us   (removes 9 after DDD)
554391938235  → 554391938235@c.us   (already correct)
+5543991938235 → 554391938235@c.us  (strips +)
```

Rule: If 13 digits, starts with "55", and 5th digit is "9", remove the 5th digit.

**This is critical for Dispatch**: ADB uses the full 13-digit number in wa.me URLs, but WAHA uses the 12-digit format. Dispatch must normalize consistently.

---

## Part 2: Dispatch Side — Required Adaptations

### 2.1 ADB Send Flow with Receipt Tracking

Current ADB send in Dispatch (`packages/core/src/engine/send-engine.ts`):

```
1. ensureCleanState() — BACK + HOME
2. ensureContact() — ACTION_INSERT if not in contacts table
3. am start -a VIEW -d "https://wa.me/{number}" -p com.whatsapp
4. Wait 4s for chat load
5. Type message char-by-char (gaussian delay ~80ms ± 30ms)
6. uiautomator dump → find send button → tap (or keyevent 66 fallback)
7. Wait 2s → screenshot for proof
8. Mark sent in SQLite queue
```

#### Receipt Detection via ADB (new capability needed)

**Sent confirmation**: After sending, screenshot + OCR/UIAutomator to verify:
- Single grey tick visible = message sent to server (ACK level 1)
- Single grey tick absent = send failed

**Delivered confirmation**: Not reliably detectable via ADB in real-time. Options:
- Poll chat UI for double grey tick (expensive, unreliable)
- Rely on WAHA webhook (message.ack level 2) since WAHA sees same account

**Read confirmation**: Same as delivered — blue ticks via WAHA webhook (ACK level 3).

**Recommended approach**: ADB provides "sent" confirmation only. WAHA provides delivered/read via existing webhook infrastructure. Since ADB and WAHA share the same WhatsApp account (ADB = phone device, WAHA = linked device), WAHA receives ACK events for messages sent via ADB.

### 2.2 Sender-Grouped Queue

Current Dispatch queue dequeues by `(status='queued', priority ASC, created_at ASC)`. For Oralsin integration, messages should be grouped by sender number to minimize Android user switches.

**Proposed dequeue algorithm**:
```sql
-- Step 1: Find the sender group with most pending messages
SELECT sender_number, COUNT(*) as cnt
FROM messages
WHERE status = 'queued'
GROUP BY sender_number
ORDER BY cnt DESC
LIMIT 1;

-- Step 2: Dequeue all messages for that sender
UPDATE messages
SET status = 'locked', locked_by = ?, locked_at = datetime('now')
WHERE id IN (
  SELECT id FROM messages
  WHERE status = 'queued' AND sender_number = ?
  ORDER BY priority ASC, created_at ASC
  LIMIT 50
)
RETURNING *;
```

### 2.3 WAHA Fallback Flow

When ADB send fails:
1. Classify failure: transient, app_crash, device_offline, ban_detected
2. For transient: retry ADB up to maxRetries
3. For device_offline or ban: route to WAHA via the same sender number
4. WAHA fallback uses Oralsin's existing WAHA infrastructure (same GoWS server)
5. Per-account mutex prevents simultaneous ADB+WAHA sends from same number

**Critical**: When Dispatch falls back to WAHA, it should call Oralsin's existing `PhonePoolService.send()` or directly call the GoWS WAHA API using the sender's session credentials.

### 2.4 Callback Format to Oralsin

Dispatch sends callbacks via HMAC-signed HTTP POST to Oralsin's webhook URL.

---

## Part 3: Integration Contract

### 3.1 Oralsin → Dispatch: Enqueue Messages

**Endpoint**: `POST /plugins/oralsin/enqueue`
**Auth**: API key in header (`X-API-Key`)

**Request body** (existing Dispatch contract, validated by Zod):
```json
[
  {
    "idempotency_key": "notif-<uuid>-step1-whatsapp",
    "correlation_id": "notif-abc123def456",
    "patient": {
      "phone": "5543991938235",
      "name": "Maria Silva",
      "patient_id": "uuid-patient-123"
    },
    "message": {
      "text": "Ola, Maria Silva!\n\nPassando para lembrar da parcela de *R$ 1.234,56* com vencimento em *15/04/2026*.\n\nCaso o pagamento ja tenha sido realizado, desconsidere esta mensagem ou nos envie o comprovante.\n\nQualquer duvida: (43) 3321-1234",
      "template_id": "step-1-whatsapp-clinic-190"
    },
    "senders": [
      {
        "phone": "+554396837945",
        "session": "oralsin_1_4",
        "pair": "oralsin-1-4",
        "role": "primary"
      },
      {
        "phone": "+554396837844",
        "session": "oralsin_2_3",
        "pair": "oralsin-2-3",
        "role": "overflow"
      },
      {
        "phone": "+554396835104",
        "session": "oralsin_main_1",
        "pair": "oralsin-main-1",
        "role": "backup"
      }
    ],
    "context": {
      "clinic_id": "uuid-clinic-190",
      "schedule_id": "uuid-schedule-xyz",
      "step": 1,
      "channel": "whatsapp",
      "pipeline_run_id": "temporal-wf-20260406-1200",
      "patient_cpf_last4": "3456"
    },
    "send_options": {
      "max_retries": 3,
      "priority": "normal"
    }
  }
]
```

**Response** (201 Created):
```json
{
  "enqueued": 1,
  "messages": [
    {
      "id": "dispatch-msg-abc123",
      "idempotency_key": "notif-<uuid>-step1-whatsapp",
      "status": "queued"
    }
  ]
}
```

**Response** (409 Conflict — duplicate):
```json
{
  "error": "Duplicate idempotency key"
}
```

**Idempotency**: `idempotency_key` is a UNIQUE constraint in Dispatch's SQLite. Oralsin generates this from `schedule_id + channel` combination.

### 3.2 Dispatch → Oralsin: Result Callback

**Endpoint**: Oralsin's webhook URL (configured per plugin in Dispatch)
**Auth**: HMAC SHA-256 signature in `X-Dispatch-Signature` header
**Delivery**: At-least-once, 3 retries with exponential backoff (0s, 5s, 15s)
**Dead letter**: `failed_callbacks` table in Dispatch SQLite for manual retry

#### Result Callback (message sent or failed)

```json
{
  "idempotency_key": "notif-<uuid>-step1-whatsapp",
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
  "context": {
    "clinic_id": "uuid-clinic-190",
    "schedule_id": "uuid-schedule-xyz",
    "step": 1,
    "channel": "whatsapp",
    "pipeline_run_id": "temporal-wf-20260406-1200"
  }
}
```

**Failure callback**:
```json
{
  "idempotency_key": "notif-<uuid>-step1-whatsapp",
  "correlation_id": "notif-abc123def456",
  "status": "failed",
  "sent_at": null,
  "delivery": null,
  "error": {
    "code": "BAN_DETECTED",
    "message": "WhatsApp account banned on device POCO_001",
    "details": {"device_serial": "9b01005930533036", "ocr_confidence": 0.82},
    "retryable": false,
    "retry_after_seconds": 1800
  },
  "fallback_reason": {
    "original_error": "ban_detected",
    "original_session": "oralsin_1_4",
    "quarantined": true
  },
  "context": {...}
}
```

#### ACK Callback (delivery receipt from WAHA)

When WAHA receives message.ack for a message sent via ADB, Dispatch forwards to Oralsin:

```json
{
  "idempotency_key": "notif-<uuid>-step1-whatsapp",
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

**Oralsin handling**: On receiving this callback, Oralsin should:
1. Look up `ContactHistory` by `idempotency_key` (mapped from `schedule_id + channel`)
2. Update `delivered_at` and/or `read_at` (same logic as existing `_update_contact_history_ack`)

#### Response Callback (patient replied)

When WAHA captures an incoming message from a patient who was recently contacted:

```json
{
  "idempotency_key": "notif-<uuid>-step1-whatsapp",
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

**Oralsin handling**: Update `ContactHistory.patient_response` and `response_received_at`.

### 3.3 Idempotency Guarantees

| Side | Mechanism | Key Format |
|------|-----------|------------|
| Oralsin → Dispatch enqueue | `idempotency_key` UNIQUE in SQLite | `{schedule_id}-{channel}` |
| Dispatch → Oralsin callback | At-least-once delivery | Oralsin must deduplicate by `idempotency_key` |
| ContactHistory creation | UNIQUE(schedule, contact_type, advance_flow) | DB constraint |
| Weekly limit | Redis INCR atomic per patient/channel/week | `weekly_limit:{patient_id}:{channel}:{year}:W{week}` |
| WAHA ACK updates | `filter(delivered_at__isnull=True).update()` | First-write-wins semantics |

### 3.4 Audit Trail

Every message is tracked end-to-end:

```
Oralsin Pipeline
├── ContactSchedule (status: pending → processing → approved/rejected)
├── ContactHistory (write-ahead: pending → sent/failed)
│   ├── external_message_id → links to WAHA/Dispatch message
│   ├── sender_phone, sender_provider, phone_pair
│   ├── pipeline_run_id, correlation_id
│   └── delivered_at, read_at, patient_response
│
Dispatch
├── messages table (status: queued → locked → sending → sent/failed)
│   ├── idempotency_key → correlates to Oralsin schedule
│   ├── sender_number, senders_config
│   ├── waha_message_id → populated when WAHA correlates
│   └── plugin_name="oralsin", correlation_id
├── message_history table (direction, from/to, captured_via)
└── failed_callbacks table (retry queue for webhook failures)
```

### 3.5 Error Handling and Retry Strategy

#### Dispatch-side retries
- **ADB transient failure**: Retry on same device up to `max_retries` (default 3)
- **ADB app crash**: Force-stop WhatsApp, restart, retry
- **ADB ban detected**: Quarantine sender number (30min), try next sender from `senders[]` array
- **Device offline**: Immediately try next sender, then fall back to WAHA
- **All senders exhausted**: Mark permanently_failed, callback with error

#### Oralsin-side handling of failures
- **Result callback `status=failed`**: Check `error.retryable`
  - If retryable: re-enqueue to Dispatch after `retry_after_seconds`
  - If not retryable: mark schedule as REJECTED, create ContactHistory with error
- **Callback delivery failure**: Dispatch stores in `failed_callbacks`, retries 3x with backoff
- **No callback received (timeout)**: Oralsin should poll `GET /plugins/oralsin/queue` for status

---

## Part 4: Deployment Architecture

### 4.1 Headless Server Deployment

Dispatch runs as a headless Node.js server (not Electron) on a dedicated machine with USB-connected Android devices.

```
┌─────────────────────────────────────────────────────────┐
│                    Dispatch Server                        │
│                                                           │
│  ┌───────────────────────────────────────────────┐       │
│  │  Fastify HTTP Server (:7890)                   │       │
│  │  ├── REST API (messages, devices, plugins)     │       │
│  │  ├── Socket.IO (real-time events)              │       │
│  │  └── Plugin routes (/plugins/oralsin/*)        │       │
│  └───────────────────────────────────────────────┘       │
│                                                           │
│  ┌─────────────┐  ┌─────────────┐  ┌──────────────┐     │
│  │ ADB Bridge  │  │ Send Engine │  │ WAHA Listener│     │
│  │ (adbkit)    │  │ (rate limit │  │ (webhooks)   │     │
│  │             │  │  + typing)  │  │              │     │
│  └──────┬──────┘  └──────┬──────┘  └──────────────┘     │
│         │                │                                │
│  ┌──────┴────────────────┴───────┐                       │
│  │  USB Hub (powered)             │                       │
│  │  ├── Device 1 (POCO)          │                       │
│  │  └── Device 2 (POCO)          │                       │
│  └────────────────────────────────┘                       │
│                                                           │
│  ┌──────────────────┐                                    │
│  │ SQLite (WAL mode) │ — messages, history, plugins, etc │
│  └──────────────────┘                                    │
└─────────────────────────────────────────────────────────┘
         │
         │ HTTPS (callbacks + webhooks)
         ▼
┌─────────────────────────────────────────────────────────┐
│              Oralsin Server (178.156.197.144)             │
│                                                           │
│  Django + Temporal + PostgreSQL + Redis + RabbitMQ        │
│  WAHA GoWS (37.27.210.137, 136 sessions)                │
└─────────────────────────────────────────────────────────┘
```

### 4.2 DNS Setup

| Domain | Points To | Purpose |
|--------|-----------|---------|
| `dispatch-api.debt.com.br` | Dispatch server IP | REST API + Plugin endpoints |
| `dispatch.debt.com.br` | Dispatch server IP | React dashboard (Vite build) |

Reverse proxy (Caddy or Nginx) on Dispatch server:
- `dispatch-api.debt.com.br` → `localhost:7890` (Fastify)
- `dispatch.debt.com.br` → `localhost:5173` (Vite dev) or static build

### 4.3 Server Requirements

- **OS**: Ubuntu 22.04+ or Fedora (for ADB tools)
- **Node.js**: 22 LTS
- **ADB**: Android platform-tools (latest)
- **USB**: Powered USB hub, 2+ USB ports
- **RAM**: 4GB minimum (Node.js + ADB overhead)
- **Storage**: 50GB (screenshots archive, SQLite, logs)
- **Network**: Public IP or port forwarding for webhooks from Oralsin

### 4.4 Running Alongside Oralsin

Dispatch and Oralsin run on **separate servers**. Communication is via HTTPS:

1. **Oralsin → Dispatch**: `POST https://dispatch-api.debt.com.br/plugins/oralsin/enqueue`
2. **Dispatch → Oralsin**: `POST https://gestao.debt.com.br/api/v1/dispatch/callback` (new endpoint)
3. **GoWS → Dispatch**: `POST https://dispatch-api.debt.com.br/api/v1/webhooks/waha` (existing WAHA listener)

### 4.5 Monitoring and Alerting

- **Dispatch dashboard**: React UI at `dispatch.debt.com.br` — device health, queue stats, audit log
- **pino logs**: JSON structured logging with rotation (50MB, 5 backups)
- **Health endpoint**: `GET /healthz` — device count, queue depth, last send timestamp
- **Plugin status**: `GET /plugins/oralsin/status` — plugin health
- **Queue stats**: `GET /plugins/oralsin/queue` — pending/processing/failed counts

---

## Part 5: Changes Required on Each Side

### 5.1 Oralsin Changes

#### New: DispatchNotifier adapter

Create `src/notification_billing/adapters/notifiers/whatsapp/dispatch.py`:

```python
class DispatchWhatsapp(BaseNotifier):
    """Adapter that routes WhatsApp sends through Dispatch ADB Framework."""

    def __init__(self, dispatch_api_url: str, dispatch_api_key: str):
        super().__init__("dispatch", "whatsapp")
        self._api_url = dispatch_api_url.rstrip("/")
        self._api_key = dispatch_api_key

    def send_batch(self, items: list[DispatchEnqueueItem]) -> dict:
        """Enqueue a batch of messages to Dispatch."""
        payload = [item.to_dict() for item in items]
        response = httpx.post(
            f"{self._api_url}/plugins/oralsin/enqueue",
            json=payload,
            headers={"X-API-Key": self._api_key},
            timeout=30,
        )
        response.raise_for_status()
        return response.json()
```

#### New: Callback webhook endpoint

Create `src/plugins/django_interface/views/dispatch_callback_view.py`:

```python
@csrf_exempt
def dispatch_callback(request):
    """Receives delivery callbacks from Dispatch ADB Framework."""
    # 1. Validate HMAC signature
    # 2. Parse payload (result / ack / response)
    # 3. Map idempotency_key → ContactHistory
    # 4. Update delivery status / patient response
```

URL: `path("webhooks/dispatch/callback/", dispatch_callback, name="dispatch-callback")`

#### Modified: Notification handler integration point

In `RunAutomatedNotificationsHandler._send_through_notifier()`, add Dispatch as a provider option:

```python
if provider == "dispatch" and self._dispatch_client:
    result = self._dispatch_client.send_batch([
        DispatchEnqueueItem(
            idempotency_key=f"{schedule.id}-{channel}",
            correlation_id=self._correlation_id,
            patient_phone=phone_number,
            patient_name=patient.name,
            patient_id=str(patient.id),
            message_text=content,
            senders=self._build_senders_for_patient(schedule),
            context={...},
        )
    ])
    # Dispatch is async — result callback comes later
    return True, f"[dispatch/adb] enqueued id={result['messages'][0]['id']}"
```

#### Modified: Sender-grouped batching

Instead of sending one message at a time to Dispatch, Oralsin should batch all pending messages per sender number:

```python
# Group schedules by resolved sender number
sender_groups = defaultdict(list)
for schedule in pending_schedules:
    pair = resolve_phone_pair(schedule)
    sender_groups[pair.waha_phone_number].append(schedule)

# Enqueue each group as a batch
for sender_phone, schedules in sender_groups.items():
    items = [build_enqueue_item(s, sender_phone) for s in schedules]
    dispatch_client.send_batch(items)
```

#### Modified: Config additions

```env
# .env additions
DISPATCH_API_URL=https://dispatch-api.debt.com.br
DISPATCH_API_KEY=<secure-random-key>
DISPATCH_HMAC_SECRET=<shared-hmac-secret>
DISPATCH_ENABLED=true
DISPATCH_FALLBACK_TO_WAHA=true  # if Dispatch down, use WAHA directly
```

### 5.2 Dispatch Changes

#### Enhanced: Oralsin plugin

The existing `OralsinPlugin` at `packages/core/src/plugins/oralsin-plugin.ts` needs:

1. **Receipt forwarding**: When `waha:message_ack` event fires for a plugin message, forward ACK callback to Oralsin
2. **Response forwarding**: When `waha:message_received` matches a recently-sent plugin message, forward response callback
3. **Sender-grouped dequeue**: New dequeue method that groups by sender_number
4. **WAHA fallback**: When ADB exhausts retries, call WAHA API directly using sender's session credentials from `senders_config`

#### New: Receipt tracking module

```typescript
// packages/core/src/engine/receipt-tracker.ts
export class ReceiptTracker {
  /**
   * After ADB send succeeds, register this message for ACK tracking.
   * When WAHA receives message.ack for the same chat, correlate and forward.
   */
  registerSentMessage(messageId: string, toNumber: string, senderNumber: string): void

  /**
   * Called by WebhookHandler when message.ack arrives.
   * Matches by toNumber + senderNumber + time window.
   */
  handleAck(wahaMessageId: string, ackLevel: number, toNumber: string): AckMatch | null
}
```

#### New: WAHA direct fallback

```typescript
// packages/core/src/engine/waha-fallback.ts
export class WahaFallback {
  /**
   * Send message via WAHA API directly (bypassing ADB).
   * Uses sender's session credentials from senders_config.
   */
  async send(message: Message, senderConfig: SenderConfig): Promise<SendResult>
}
```

#### Enhanced: Headless mode

- Remove Electron dependency for headless deployment
- CLI entrypoint: `node packages/core/dist/index.js`
- Environment-based configuration (no dispatch.config.json required)

---

## Part 6: Sender-Grouped Queue Design

### 6.1 Oralsin-Side Batching

When Oralsin's notification pipeline runs for a clinic:

```
1. Fetch all PENDING schedules for clinic (mode: pre_due or overdue)
2. For each schedule, resolve phone pair via PatientPhoneResolver
3. Group schedules by resolved sender phone number
4. For each sender group:
   a. Build batch of DispatchEnqueueItems
   b. POST /plugins/oralsin/enqueue (batch)
   c. All items share the same primary sender in senders[0]
5. Dispatch receives pre-grouped batches
```

**Why Oralsin groups**: Oralsin knows the patient-phone affinity. Dispatch does not. By grouping at the source, Dispatch receives messages already organized by sender.

### 6.2 Dispatch-Side Queue Organization

```
messages table (SQLite):
┌──────────┬─────────────────┬──────────┬─────────┬──────────┐
│ id       │ sender_number   │ priority │ status  │ created  │
├──────────┼─────────────────┼──────────┼─────────┼──────────┤
│ m-001    │ +554396837945   │ 5        │ queued  │ 10:00:01 │
│ m-002    │ +554396837945   │ 5        │ queued  │ 10:00:01 │
│ m-003    │ +554396837945   │ 5        │ queued  │ 10:00:02 │
│ m-004    │ +554396837844   │ 5        │ queued  │ 10:00:01 │
│ m-005    │ +554396837844   │ 5        │ queued  │ 10:00:02 │
│ m-006    │ +554396835104   │ 5        │ queued  │ 10:00:01 │
└──────────┴─────────────────┴──────────┴─────────┴──────────┘

Worker loop:
1. SELECT sender_number, COUNT(*) FROM messages WHERE status='queued'
   GROUP BY sender_number ORDER BY COUNT(*) DESC LIMIT 1
   → picks +554396837945 (3 messages)
2. Map +554396837945 → Device 1, Profile 3, com.whatsapp
3. Switch to correct Android user (if different from current)
4. Dequeue all 3 messages for +554396837945
5. Send each with inter-message jitter (20-35s)
6. Switch to +554396837844 (2 messages)
7. Continue until queue empty
```

### 6.3 Minimizing User Switches

Each sender phone number maps to a specific `(device, android_user, app_package)` tuple:

```typescript
// Configured at startup, stored in whatsapp_accounts table
const senderMap: Record<string, {deviceSerial: string, profileId: number, appPackage: string}> = {
  "+554396837945": { deviceSerial: "POCO_001", profileId: 0, appPackage: "com.whatsapp" },
  "+554396837844": { deviceSerial: "POCO_001", profileId: 0, appPackage: "com.whatsapp.w4b" },
  "+554396835104": { deviceSerial: "POCO_001", profileId: 10, appPackage: "com.whatsapp" },
  // ... etc
}
```

**User switch cost**: `am switch-user N` takes 3-4 seconds. By processing all messages for a sender before switching, we avoid switching for every message.

### 6.4 Priority Messages

High-priority messages (manual sends, urgent notifications) skip the sender-group queue:

```sql
-- Priority dequeue: high priority first, regardless of sender grouping
SELECT * FROM messages
WHERE status = 'queued' AND priority < 5
ORDER BY priority ASC, created_at ASC
LIMIT 1;
```

If a high-priority message is for a different sender than the currently active one, the switch happens immediately.

---

## Part 7: Receipt and Feedback Loop

### 7.1 ADB-Based Delivery Detection

#### Sent Confirmation (ACK level 1 equivalent)
After tapping the send button:
1. Wait 2-3 seconds
2. Take screenshot
3. Run `uiautomator dump` and check for:
   - Message bubble present with expected text (partial match)
   - Single tick icon visible (resource-id `com.whatsapp:id/status` or similar)
   - No error toast/banner
4. If verified: mark as `sent` in queue, emit `message:sent` event

#### Delivered Detection (ACK level 2)
Not reliably detectable via ADB. Requires:
- Navigating back to the chat
- Finding the specific message
- Checking for double tick icon
- This is too fragile and slow for production

**Recommendation**: Rely on WAHA webhook `message.ack` with `ack=2` (DEVICE).

#### Read Detection (ACK level 3)
Same limitation as delivered. Blue tick detection via OCR or UIAutomator is unreliable.

**Recommendation**: Rely on WAHA webhook `message.ack` with `ack=3` (READ).

#### Reply Detection
Two approaches:
1. **WAHA webhook**: `message` event with `fromMe=false` — already implemented in Dispatch's `WebhookHandler`
2. **ADB notification monitoring**: `dumpsys notification` — unreliable, too many false positives

**Recommendation**: WAHA webhook for reply capture.

### 7.2 WAHA-Based Delivery Tracking (Existing)

WAHA already handles all ACK events. Dispatch's `WebhookHandler` processes:

```typescript
// packages/core/src/waha/webhook-handler.ts
handleAck(payload): WebhookResult {
  // ack levels: -1=error, 0=pending, 1=server, 2=device, 3=read, 4=played
  this.emitter.emit('waha:message_ack', {
    wahaMessageId: ack.id,
    ackLevel,
    deliveredAt: ackLevel >= 3 ? timestamp : null,  // NOTE: bug — should be >= 2
    readAt: ackLevel >= 4 ? timestamp : null,        // NOTE: bug — should be >= 3
  })
}
```

**Bug in current code**: The existing Dispatch code sets `deliveredAt` at ACK >= 3 and `readAt` at ACK >= 4. It should be `deliveredAt` at ACK >= 2 and `readAt` at ACK >= 3, matching Oralsin's convention. This must be fixed.

### 7.3 Correlation: ADB Send → WAHA ACK

When Dispatch sends via ADB, WAHA (as a linked device on the same WhatsApp account) also sees the outgoing message and its ACK updates.

The correlation flow:

```
1. Dispatch sends message via ADB to +5543991938235
   - Records in message_history: {toNumber, captured_via: "adb_send", created_at}
   - Records in messages table: {status: "sent", to: "5543991938235"}

2. WAHA webhook fires message.any (outgoing, fromMe=true)
   - WebhookHandler.handleMessage() → findByDedup(toNumber, timestamp, 30s window)
   - Matches ADB send → updates message_history with waha_message_id
   - Updates messages table with waha_message_id (correlation fix from Phase 7)

3. WAHA webhook fires message.ack (level 2 = delivered)
   - WebhookHandler.handleAck() → emits waha:message_ack event
   - PluginEventBus dispatches to OralsinPlugin
   - CallbackDelivery sends AckCallback to Oralsin

4. Oralsin receives AckCallback
   - Maps idempotency_key → ContactHistory
   - Updates delivered_at
```

### 7.4 Unified Receipt Format

Both ADB and WAHA receipts are normalized into the same callback format for Oralsin:

```typescript
interface AckCallback {
  idempotency_key: string    // correlates to Oralsin schedule
  message_id: string          // Dispatch internal ID
  event: "ack_update"
  ack: {
    level: number             // 1=server, 2=device, 3=read, 4=played
    level_name: string        // human-readable
    delivered_at: string | null
    read_at: string | null
  }
}
```

For ADB-only sends (no WAHA correlation):
- `level=1` is set immediately after successful ADB send (message sent to WA servers)
- `level=2+` requires WAHA webhook correlation

### 7.5 How Oralsin Uses Feedback

1. **Step advancement**: `ContactSchedule` advances to next step only when ALL blocking channels (SMS, WhatsApp, Email) succeed
2. **Retry decisions**: If `error.retryable=true`, Oralsin can re-enqueue to Dispatch
3. **Weekly limit**: Successful send consumes the patient's weekly slot via Redis INCR
4. **Quarantine**: If sender number reports ban, Oralsin's `PatientPhoneResolver` marks affinity as invalid and reassigns
5. **Dashboard**: `ContactHistory.delivered_at` and `read_at` power delivery metrics in the Oralsin dashboard
6. **Patient response**: `patient_response` field enables operators to see replies in Chatwoot and the Oralsin admin panel

---

## Part 8: Optimization Strategies

### 8.1 Contact Addition Optimization

Current Dispatch behavior: `ensureContact()` calls `ACTION_INSERT` for every new phone number.

**Optimization**:
1. **Contacts table in SQLite**: Already exists (`contacts` table). Check before adding.
2. **Bulk pre-registration**: When a batch arrives from Oralsin, pre-register all contacts before sending. This avoids the 2-second delay per contact during send.
3. **Contact-to-Google sync**: Use `am start -a android.intent.action.INSERT` once per new number, then cache in SQLite. Contact persists across sends.
4. **wa.me resolution**: WhatsApp resolves contacts via `wa.me/{number}` URL. If contact is saved in Google Contacts, WhatsApp resolves faster (no "number not on WhatsApp" popup).

### 8.2 Template Pre-Rendering

Oralsin renders templates before sending to Dispatch:

```python
# Oralsin side — pre-render with Django template engine
content = render_message(msg.content, {
    "nome": sanitize_patient_name(patient.name),
    "valor": format_currency(installment.amount),
    "vencimento": installment.due_date.strftime("%d/%m/%Y"),
    "contact_phone": clinic_phone,
})

# Dispatch receives plain text — just types it
dispatch_client.send_batch([
    DispatchEnqueueItem(
        message_text=content,  # Already rendered, no template processing needed
        ...
    )
])
```

**Dispatch does not need Django or any template engine.** It receives ready-to-type text.

### 8.3 Parallel Device Utilization

With 2 devices, each with multiple Android profiles:

```
Device 1 (POCO Serenity)          Device 2 (POCO TBD)
├── Profile 0: +554396837945     ├── Profile 0: +554396835095
├── Profile 0: +554396837945(B)  ├── Profile 0: +554396835095(B)
├── Profile 10: +554396835104    ├── Profile 10: +554396837813
└── Profile 10: +554396835104(B) └── Profile 10: +554396837813(B)
```

Each device runs an independent worker. Workers select devices based on health score:

```typescript
// packages/core/src/engine/dispatcher.ts
function selectDevice(devices, healthMap, db): DeviceRecord | null {
  // Score = battery*0.3 + (100-temp)*0.3 + ram*0.2 + storage*0.2
  // Skip offline, banned, no-health devices
  // Return highest-scoring device
}
```

### 8.4 Health Monitoring

Dispatch monitors:
- **Battery**: Alert below 15%, critical below 5%
- **Temperature**: Alert above 40C
- **RAM**: Alert below 200MB available
- **Storage**: Alert below 2GB free
- **WiFi**: Alert if disconnected
- **WhatsApp running**: `pidof com.whatsapp` check
- **Screen state**: Ensure screen awake + unlocked before sends

### 8.5 Auto-Recovery Flows

| Condition | Detection | Recovery |
|-----------|-----------|----------|
| WA crash | `pidof com.whatsapp` returns empty | `am force-stop` + `am start` + retry |
| Screen off | `dumpsys power` check | `input keyevent KEYCODE_WAKEUP` + swipe unlock |
| UI stuck | UIAutomator dump timeout | BACK 3x + HOME + retry |
| Device disconnect | adbkit device tracking | Emit alert, route to other device |
| Ban detected | OCR on screenshot + behavioral probe | Quarantine 30min, fallback to WAHA |

### 8.6 Brazilian Phone Number Handling

**Critical normalization rules**:

| Format | ADB (wa.me URL) | WAHA (chatId) | Notes |
|--------|-----------------|---------------|-------|
| Input from Oralsin | 5543991938235 | N/A | 13 digits with 9th digit |
| wa.me URL | https://wa.me/5543991938235 | N/A | Full 13 digits work |
| WAHA chatId | N/A | 554391938235@c.us | 12 digits (9th removed) |
| Contact registration | 5543991938235 | N/A | Use full number |

Dispatch should:
1. Store the full 13-digit number as-is from Oralsin
2. Use the full 13-digit number for `wa.me` intents (WhatsApp handles the mapping)
3. When correlating with WAHA webhooks, normalize to 12 digits for matching

---

## Appendix A: Oralsin REST API Endpoints (Relevant to Dispatch)

### Existing Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/v1/healthz/` | Health check |
| POST | `/api/v1/notifications/run-automated/` | Trigger automated notifications |
| POST | `/api/v1/notifications/send-manual/` | Trigger manual notification |
| GET | `/api/v1/notifications/` | List notifications |
| GET | `/api/v1/notifications/metrics/` | Notification metrics |
| GET | `/api/v1/admin/phone-pairs/` | List phone pairs |
| GET | `/api/v1/admin/phone-pairs/dashboard/` | Phone pair dashboard |
| POST | `/api/v1/admin/phone-pairs/<id>/test-send/` | Test send from pair |
| POST | `/api/v1/admin/phone-pairs/<id>/quarantine/` | Quarantine a pair |
| GET | `/api/v1/waha-metrics/today/` | Today's WAHA metrics |
| POST | `/api/v1/webhooks/waha-gows/oralsin/` | WAHA webhook receiver |

### New Endpoints (to be created)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/v1/webhooks/dispatch/callback/` | Dispatch delivery callbacks |

## Appendix B: Dispatch REST API Endpoints (Relevant to Oralsin)

### Existing Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/plugins/oralsin/enqueue` | Enqueue messages (batch) |
| GET | `/plugins/oralsin/status` | Plugin status |
| GET | `/plugins/oralsin/queue` | Queue stats |
| GET | `/devices` | List connected devices |
| GET | `/healthz` | Health check |
| POST | `/api/v1/webhooks/waha` | WAHA webhook receiver |

## Appendix C: Environment Variables Reference

### Oralsin New Variables

```env
DISPATCH_API_URL=https://dispatch-api.debt.com.br
DISPATCH_API_KEY=dispatch_oralsin_prod_key_2026
DISPATCH_HMAC_SECRET=shared_hmac_secret_32bytes_hex
DISPATCH_ENABLED=true
DISPATCH_FALLBACK_TO_WAHA=true
DISPATCH_CALLBACK_URL=https://gestao.debt.com.br/api/v1/webhooks/dispatch/callback/
```

### Dispatch Variables

```env
# Server
PORT=7890
NODE_ENV=production
API_KEY=dispatch_oralsin_prod_key_2026

# Plugin: Oralsin
ORALSIN_WEBHOOK_URL=https://gestao.debt.com.br/api/v1/webhooks/dispatch/callback/
ORALSIN_HMAC_SECRET=shared_hmac_secret_32bytes_hex

# WAHA (for webhook reception + fallback)
WAHA_API_URL=https://gows-chat.debt.com.br
WAHA_API_KEY=<gows-api-key>
WAHA_WEBHOOK_HMAC_SECRET=<waha-hmac-secret>

# ADB
ADB_PATH=/usr/bin/adb

# Logging
LOG_LEVEL=info
LOG_ROTATION_SIZE=50MB
LOG_ROTATION_COUNT=5
```

## Appendix D: Migration Plan

### Phase 1: Pilot (Week 1-2)
- Deploy Dispatch headless on dedicated server
- Connect 1 device with 2 profiles (2 phone numbers)
- Route Bauru clinic (lowest volume: ~22 pending) to Dispatch
- Oralsin sends to Dispatch; fallback to WAHA if Dispatch unavailable
- Monitor: ban rate, delivery rate, callback latency

### Phase 2: Expand (Week 3-4)
- Add 2nd device
- Route Volta Redonda (39 pending) to Dispatch
- Enable receipt tracking (ACK callbacks)
- Dashboard monitoring live

### Phase 3: Full Production (Week 5-8)
- Route all 4 clinics to Dispatch
- WAHA becomes backup-only (fallback for ADB failures)
- 8 sender numbers across 2 devices
- Target: 800 messages/day capacity

### Rollback Plan
- Set `DISPATCH_ENABLED=false` in Oralsin `.env`
- All traffic reverts to WAHA immediately
- No data loss — ContactHistory is populated regardless of provider
