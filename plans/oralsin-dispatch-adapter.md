# Oralsin Side: Dispatch ADB Adapter Plan

> **Scope**: Changes to the Oralsin Django codebase (`/var/www/oralsim_gestao_inteligente`)
> **Server**: `178.156.197.144` (SSH: `ssh -i ~/.ssh/id_oralsinhml root@178.156.197.144`)
> **Spec**: `docs/research/oralsin-dispatch-full-spec.md` (in Dispatch repo)
> **Contracts**: `docs/research/integration-contracts.md` (in Dispatch repo)
> **Date**: 2026-04-06
> **Status**: Ready for execution

---

## Context Recovery

On every new session, read these files:
```
1. /var/www/adb_tools/plans/oralsin-dispatch-adapter.md — THIS FILE
2. /var/www/adb_tools/docs/research/oralsin-dispatch-full-spec.md — full spec
3. /var/www/adb_tools/docs/research/integration-contracts.md — API contracts
4. SSH to 178.156.197.144 and read:
   - src/notification_billing/adapters/notifiers/registry.py — notifier factory
   - src/notification_billing/adapters/notifiers/base.py — BaseNotifier abstract class
   - src/notification_billing/adapters/providers/waha/waha_notifier.py — WAHA adapter (pattern to follow)
   - src/notification_billing/adapters/providers/waha/client.py — WAHA API client
   - src/notification_billing/core/application/handlers/notification_handlers.py — send flow
   - src/notification_billing/core/application/services/phone_pool_service.py — phone pool
```

All paths below are relative to `/var/www/oralsim_gestao_inteligente/src/`.

---

## Dependency Graph

```
OP-1 (DispatchNotifier Adapter)
  ├── OP-2 (Sender-Grouped Batching)
  │     └── OP-5 (Fallback Logic)
  ├── OP-3 (Callback Webhook)
  │     └── OP-5 (Fallback Logic)
  └── OP-4 (Configuration + Feature Flags)
        └── OP-5 (Fallback Logic)

OP-5 (Fallback Logic)
  └── OP-6 (Monitoring + Alerts)

Critical Path: OP-1 → OP-2 → OP-5 → OP-6
Parallel: OP-1 → OP-3 (callback), OP-1 → OP-4 (config)
```

---

## Architecture Rules

1. **Follow existing adapter pattern** — the new adapter mirrors `WAHAWhatsapp` in structure: extends `BaseNotifier`, implements `send()`.
2. **Oralsin keeps ALL business logic** — scheduling, escalation, weekly limits, affinity, template rendering all stay in Oralsin. Dispatch is a dumb delivery proxy.
3. **Dispatch is async** — unlike WAHA which returns message_id synchronously, Dispatch returns a queue ID. Delivery confirmation comes via callback.
4. **Feature flag per clinic** — ability to route specific clinics to Dispatch while others stay on WAHA.
5. **Zero downtime rollback** — `DISPATCH_ENABLED=false` reverts all traffic to WAHA immediately.

---

## Phase OP-1: DispatchNotifier Adapter

**Depends on**: Dispatch Phase DP-1 complete (enqueue API must exist)
**Estimate**: M (3-5 days)
**Branch**: `feature/op1-dispatch-adapter`

### What to build

A new WhatsApp notifier that sends messages through the Dispatch ADB Framework instead of WAHA API directly.

### Files to create

```
notification_billing/adapters/providers/dispatch/
├── __init__.py
├── client.py           # DispatchAPIClient — HTTP client for Dispatch REST API
├── dispatch_notifier.py # DispatchWhatsapp(BaseNotifier) — adapter
└── types.py            # DTOs: DispatchEnqueueItem, DispatchEnqueueResponse
```

### File: `client.py`

```python
"""
HTTP client for Dispatch ADB Framework API.

Handles:
- Batch enqueue with HMAC-signed requests
- Health check polling
- Queue status retrieval
- Connection pooling and retry
"""
import hashlib
import hmac
import json
import time
from dataclasses import dataclass, field
from typing import Any

import httpx
import structlog

log = structlog.get_logger(__name__)

DISPATCH_CONNECT_TIMEOUT = 5.0
DISPATCH_READ_TIMEOUT = 30.0
DISPATCH_MAX_RETRIES = 3


@dataclass
class DispatchEnqueueItem:
    """Maps to Dispatch's enqueue request schema."""
    idempotency_key: str
    correlation_id: str
    patient_phone: str
    patient_name: str
    patient_id: str
    message_text: str
    template_id: str
    senders: list[dict]  # [{phone, session, pair, role}]
    context: dict = field(default_factory=dict)
    max_retries: int = 3
    priority: str = "normal"

    def to_dict(self) -> dict:
        return {
            "idempotency_key": self.idempotency_key,
            "correlation_id": self.correlation_id,
            "patient": {
                "phone": self.patient_phone,
                "name": self.patient_name,
                "patient_id": self.patient_id,
            },
            "message": {
                "text": self.message_text,
                "template_id": self.template_id,
            },
            "senders": self.senders,
            "context": self.context,
            "send_options": {
                "max_retries": self.max_retries,
                "priority": self.priority,
            },
        }


@dataclass
class DispatchEnqueueResult:
    """Response from Dispatch enqueue API."""
    success: bool
    enqueued: int = 0
    messages: list[dict] = field(default_factory=list)
    error: str = ""


class DispatchAPIClient:
    """Client for Dispatch ADB Framework REST API."""

    def __init__(self, api_url: str, api_key: str, hmac_secret: str):
        self._api_url = api_url.rstrip("/")
        self._api_key = api_key
        self._hmac_secret = hmac_secret
        self._client = httpx.Client(
            timeout=httpx.Timeout(DISPATCH_CONNECT_TIMEOUT, read=DISPATCH_READ_TIMEOUT),
            headers={
                "X-API-Key": api_key,
                "Content-Type": "application/json",
            },
        )

    def enqueue_batch(self, items: list[DispatchEnqueueItem]) -> DispatchEnqueueResult:
        """Enqueue a batch of messages to Dispatch."""
        payload = [item.to_dict() for item in items]
        body = json.dumps(payload)

        try:
            response = self._client.post(
                f"{self._api_url}/plugins/oralsin/enqueue",
                content=body,
            )

            if response.status_code == 201:
                data = response.json()
                return DispatchEnqueueResult(
                    success=True,
                    enqueued=data.get("enqueued", 0),
                    messages=data.get("messages", []),
                )
            elif response.status_code == 409:
                return DispatchEnqueueResult(
                    success=False,
                    error="duplicate_idempotency_key",
                )
            else:
                return DispatchEnqueueResult(
                    success=False,
                    error=f"HTTP {response.status_code}: {response.text[:200]}",
                )
        except Exception as e:
            log.error("dispatch.enqueue.failed", error=str(e))
            return DispatchEnqueueResult(success=False, error=str(e))

    def health(self) -> dict:
        """Check Dispatch server health."""
        try:
            response = self._client.get(f"{self._api_url}/healthz")
            return {"ok": response.is_success, "status": response.status_code}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def queue_stats(self) -> dict:
        """Get queue stats from Dispatch."""
        try:
            response = self._client.get(f"{self._api_url}/plugins/oralsin/queue")
            if response.is_success:
                return response.json()
            return {"error": f"HTTP {response.status_code}"}
        except Exception as e:
            return {"error": str(e)}
```

### File: `dispatch_notifier.py`

```python
"""
Dispatch ADB Framework adapter for WhatsApp notifications.

Follows the same BaseNotifier pattern as WAHAWhatsapp but:
- Sends to Dispatch API instead of WAHA directly
- Dispatch is ASYNC — returns queue ID, delivery confirmed via callback
- send() returns dict with dispatch_message_id (not WAHA message_id)
"""
import structlog

from notification_billing.adapters.notifiers.base import BaseNotifier
from notification_billing.core.application.dtos.whatsapp_notification_dto import (
    WhatsappNotificationDTO,
)
from .client import DispatchAPIClient, DispatchEnqueueItem

log = structlog.get_logger(__name__)


class DispatchWhatsapp(BaseNotifier):
    """Sends WhatsApp messages via Dispatch ADB Framework."""

    def __init__(self, api_url: str, api_key: str, hmac_secret: str):
        super().__init__("dispatch", "whatsapp")
        self._client = DispatchAPIClient(api_url, api_key, hmac_secret)
        log.info("dispatch.notifier.initialized", api_url=api_url)

    def send(self, notification: WhatsappNotificationDTO) -> dict | None:
        """
        Send WhatsApp notification via Dispatch.

        NOTE: Unlike WAHA, Dispatch is async. This returns a queue ID,
        not a delivery confirmation. Delivery status comes via callback.
        """
        # This single-message send is a thin wrapper around batch enqueue
        # For production use, prefer send_batch() to minimize HTTP calls
        item = DispatchEnqueueItem(
            idempotency_key=notification.options.get("idempotency_key", ""),
            correlation_id=notification.options.get("correlation_id", ""),
            patient_phone=notification.to,
            patient_name=notification.options.get("patient_name", ""),
            patient_id=notification.options.get("patient_id", ""),
            message_text=notification.message,
            template_id=notification.options.get("template_id", ""),
            senders=notification.options.get("senders", []),
            context=notification.options.get("context", {}),
            max_retries=notification.options.get("max_retries", 3),
            priority=notification.options.get("priority", "normal"),
        )

        result = self._client.enqueue_batch([item])

        if result.success and result.messages:
            msg = result.messages[0]
            log.info(
                "dispatch.send.enqueued",
                dispatch_id=msg.get("id"),
                idempotency_key=item.idempotency_key,
            )
            return {"message_id": msg.get("id"), "provider": "dispatch"}
        else:
            log.error(
                "dispatch.send.failed",
                error=result.error,
                idempotency_key=item.idempotency_key,
            )
            raise Exception(f"Dispatch enqueue failed: {result.error}")

    def send_batch(self, items: list[DispatchEnqueueItem]) -> dict:
        """Enqueue a batch of messages to Dispatch."""
        return self._client.enqueue_batch(items)

    def health(self) -> dict:
        """Check Dispatch server health."""
        return self._client.health()
```

### Files to modify

| File | Change |
|------|--------|
| `notification_billing/adapters/notifiers/registry.py` | Add `get_dispatch_notifier()` factory |

Add to `registry.py`:

```python
@lru_cache
def get_dispatch_notifier() -> BaseNotifier:
    """Returns Dispatch ADB Framework notifier if configured."""
    from notification_billing.adapters.providers.dispatch import DispatchWhatsapp
    return DispatchWhatsapp(
        api_url=os.getenv("DISPATCH_API_URL", ""),
        api_key=os.getenv("DISPATCH_API_KEY", ""),
        hmac_secret=os.getenv("DISPATCH_HMAC_SECRET", ""),
    )
```

### Acceptance criteria

- [ ] `DispatchAPIClient.enqueue_batch()` sends correctly formatted POST to Dispatch
- [ ] `DispatchWhatsapp.send()` implements `BaseNotifier` interface
- [ ] `DispatchWhatsapp.send_batch()` supports batch enqueue (multiple items)
- [ ] Error handling: connection timeout, HTTP errors, invalid response
- [ ] Registry factory `get_dispatch_notifier()` returns configured client
- [ ] Tests: mock Dispatch API, test enqueue request format, test error handling

### Tests to write

```python
class TestDispatchAPIClient:
    def test_enqueue_batch_success(self, httpx_mock):
        """Sends correct JSON payload, returns message IDs."""

    def test_enqueue_batch_duplicate(self, httpx_mock):
        """Returns error on 409 Conflict."""

    def test_enqueue_batch_connection_error(self):
        """Returns error result on connection failure."""

    def test_health_check(self, httpx_mock):
        """Returns ok=True when Dispatch is healthy."""

class TestDispatchWhatsapp:
    def test_send_single_message(self, httpx_mock):
        """Wraps single message in batch, returns dispatch_id."""

    def test_send_raises_on_failure(self, httpx_mock):
        """Raises Exception when Dispatch returns error."""
```

### Rollback

Remove `adapters/providers/dispatch/` directory. Remove `get_dispatch_notifier()` from registry.

---

## Phase OP-2: Sender-Grouped Batching

**Depends on**: OP-1
**Estimate**: S (2-3 days)
**Branch**: `feature/op2-sender-batching`

### What to build

Group pending messages by resolved sender phone number before sending to Dispatch. This optimizes Dispatch's queue by pre-organizing messages that share the same sender.

### Files to modify

| File | Change |
|------|--------|
| `notification_billing/core/application/handlers/notification_handlers.py` | Add `_send_batch_through_dispatch()` method |

### Implementation

In `RunAutomatedNotificationsHandler`, after resolving all pending schedules, group by sender and batch-enqueue:

```python
def _send_batch_through_dispatch(
    self,
    schedules: list[ContactSchedule],
    channel: str,
) -> dict[str, tuple[bool, str]]:
    """
    Group schedules by resolved sender number, batch-enqueue to Dispatch.

    Returns: dict of {schedule_id: (success, note)}
    """
    from collections import defaultdict

    # Step 1: Resolve phone pair for each schedule
    sender_groups: dict[str, list[tuple[ContactSchedule, str, str, list[dict]]]] = defaultdict(list)

    for schedule in schedules:
        try:
            pair = self._resolve_phone_pair_for_patient(schedule)
            phone_number = self._pick_patient_phone(schedule)
            content = self._render_message(schedule)
            senders = self._build_senders_for_patient(schedule)

            sender_groups[pair.waha_phone_number].append(
                (schedule, phone_number, content, senders)
            )
        except Exception as e:
            # Individual resolution failure — mark and continue
            logger.error("dispatch.resolve_failed", schedule=str(schedule.id), error=str(e))

    # Step 2: Batch enqueue per sender group
    results = {}
    dispatch = get_dispatch_notifier()

    for sender_phone, items in sender_groups.items():
        batch = []
        for schedule, phone_number, content, senders in items:
            batch.append(DispatchEnqueueItem(
                idempotency_key=f"{schedule.id}-{channel}",
                correlation_id=self._correlation_id,
                patient_phone=phone_number,
                patient_name=schedule.patient.name,
                patient_id=str(schedule.patient_id),
                message_text=content,
                template_id=f"step-{schedule.current_step}-{channel}",
                senders=senders,
                context={
                    "clinic_id": str(schedule.clinic_id),
                    "schedule_id": str(schedule.id),
                    "step": schedule.current_step,
                    "channel": channel,
                    "pipeline_run_id": self._pipeline_run_id,
                },
            ))

        try:
            result = dispatch.send_batch(batch)
            for item in items:
                schedule = item[0]
                results[str(schedule.id)] = (
                    result.success,
                    f"[dispatch/adb] enqueued batch={len(batch)}" if result.success
                    else f"[dispatch/adb] error={result.error}",
                )
        except Exception as e:
            for item in items:
                schedule = item[0]
                results[str(schedule.id)] = (False, f"[dispatch/adb] exception={e}")

    return results
```

### Helper: `_build_senders_for_patient`

```python
def _build_senders_for_patient(self, schedule: ContactSchedule) -> list[dict]:
    """
    Build senders[] array for Dispatch, ordered by role priority.
    Uses the patient's adopted pair + clinic's overflow/backup pairs.
    """
    senders = []

    # Primary: patient's adopted pair (or round-robin assigned)
    primary_pair = self._resolve_phone_pair_for_patient(schedule)
    senders.append({
        "phone": primary_pair.waha_phone_number,
        "session": primary_pair.waha_session_name.replace("-", "_"),
        "pair": primary_pair.name,
        "role": "primary",
    })

    # Overflow + backup: other pairs assigned to this clinic
    assignments = PhonePairAssignment.objects.filter(
        clinic_id=schedule.clinic_id,
        active=True,
    ).exclude(phone_pair_id=primary_pair.id).select_related("phone_pair").order_by("priority")

    for assignment in assignments:
        pair = assignment.phone_pair
        senders.append({
            "phone": pair.waha_phone_number,
            "session": pair.waha_session_name.replace("-", "_"),
            "pair": pair.name,
            "role": assignment.role,
        })

    return senders
```

### Acceptance criteria

- [ ] Messages grouped by resolved sender phone number before enqueue
- [ ] Each batch sent as single HTTP request to Dispatch
- [ ] Batch includes `senders[]` array with primary, overflow, backup roles
- [ ] Individual schedule resolution failures do not block the entire batch
- [ ] All items in batch share correct `context` metadata
- [ ] Tests: grouping logic, partial failure handling, senders array construction

### Tests to write

```python
class TestSenderGroupedBatching:
    def test_groups_by_sender_phone(self):
        """Schedules with same adopted pair are grouped together."""

    def test_different_senders_create_separate_batches(self):
        """Different pairs create separate batch requests."""

    def test_resolution_failure_skips_schedule(self):
        """Failed phone resolution does not block other schedules."""

    def test_senders_array_includes_all_clinic_pairs(self):
        """Senders includes primary + overflow + backup ordered by priority."""
```

### Rollback

Revert `notification_handlers.py` to use direct WAHA sends.

---

## Phase OP-3: Callback Webhook Endpoint

**Depends on**: OP-1
**Estimate**: M (3-5 days)
**Branch**: `feature/op3-callback-webhook`

### What to build

Django endpoint that receives delivery callbacks from Dispatch and updates `ContactHistory` accordingly.

### Files to create

```
plugins/django_interface/views/dispatch_callback_view.py
notification_billing/adapters/providers/dispatch/callback_handler.py
```

### File: `dispatch_callback_view.py`

```python
"""
Receives delivery callbacks from Dispatch ADB Framework.

Callback types:
- result: message sent or failed (immediate, after ADB/WAHA attempt)
- ack: delivery/read receipt (delayed, from WAHA webhook)
- response: patient replied (delayed, from WAHA webhook)

Security: HMAC SHA-256 signature validation.
Idempotency: Updates are idempotent (first-write-wins for delivered_at/read_at).
"""
import hashlib
import hmac
import json

import structlog
from django.conf import settings
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST

from notification_billing.adapters.providers.dispatch.callback_handler import (
    DispatchCallbackHandler,
)

log = structlog.get_logger(__name__)


def _verify_hmac(body: bytes, signature: str, secret: str) -> bool:
    """Verify HMAC SHA-256 signature."""
    expected = hmac.new(
        secret.encode(), body, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, signature)


@csrf_exempt
@require_POST
def dispatch_callback(request):
    """POST /api/v1/webhooks/dispatch/callback/"""
    # 1. Validate HMAC signature
    signature = request.headers.get("X-Dispatch-Signature", "")
    hmac_secret = getattr(settings, "DISPATCH_HMAC_SECRET", "")

    if hmac_secret and not _verify_hmac(request.body, signature, hmac_secret):
        log.warning("dispatch.callback.invalid_signature")
        return JsonResponse({"error": "Invalid signature"}, status=401)

    # 2. Parse payload
    try:
        payload = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({"error": "Invalid JSON"}, status=400)

    # 3. Route to handler
    handler = DispatchCallbackHandler()

    if "event" not in payload:
        # Result callback (sent/failed)
        handler.handle_result(payload)
    elif payload["event"] == "ack_update":
        handler.handle_ack(payload)
    elif payload["event"] == "patient_response":
        handler.handle_response(payload)
    else:
        log.warning("dispatch.callback.unknown_event", event=payload.get("event"))
        return JsonResponse({"error": "Unknown event type"}, status=400)

    return JsonResponse({"ok": True})
```

### File: `callback_handler.py`

```python
"""
Handles Dispatch callback payloads, updates ContactHistory.

Follows the same pattern as the existing WAHA webhook handler
in plugins/django_interface/views/waha_webhook_view.py.
"""
import structlog
from django.utils import timezone

from plugins.django_interface.models import ContactHistory

log = structlog.get_logger(__name__)


class DispatchCallbackHandler:
    """Processes Dispatch delivery callbacks."""

    def handle_result(self, payload: dict) -> None:
        """
        Handle result callback (message sent or failed).

        Maps to: ContactHistory.success, outcome, observation, external_message_id
        """
        idempotency_key = payload.get("idempotency_key", "")
        status = payload.get("status")  # "sent" or "failed"
        context = payload.get("context", {})
        schedule_id = context.get("schedule_id")

        if not schedule_id:
            log.warning("dispatch.callback.result.no_schedule_id", key=idempotency_key)
            return

        qs = ContactHistory.objects.filter(
            schedule_id=schedule_id,
            contact_type="whatsapp",
        )

        if status == "sent":
            delivery = payload.get("delivery", {})
            qs.filter(success__isnull=True).update(
                success=True,
                outcome="success",
                external_message_id=delivery.get("message_id", ""),
                sender_phone=delivery.get("sender_phone", ""),
                sender_provider="dispatch" if not delivery.get("used_fallback") else "dispatch+waha",
                duration_ms=delivery.get("elapsed_ms"),
                observation=f"[dispatch/{delivery.get('provider', 'adb')}] "
                           f"pair={delivery.get('pair_used', '')} "
                           f"fallback={delivery.get('used_fallback', False)}",
            )
            log.info("dispatch.callback.result.sent", schedule_id=schedule_id)

        elif status == "failed":
            error = payload.get("error", {})
            qs.filter(success__isnull=True).update(
                success=False,
                outcome="error",
                outcome_reason=error.get("code", "provider_error"),
                observation=f"[dispatch/failed] {error.get('message', '')[:200]}",
            )
            log.info("dispatch.callback.result.failed", schedule_id=schedule_id, error=error.get("code"))

    def handle_ack(self, payload: dict) -> None:
        """
        Handle ACK callback (delivery/read receipt).

        Maps to: ContactHistory.delivered_at, read_at
        Same idempotent logic as existing _update_contact_history_ack in WAHA handler.
        """
        idempotency_key = payload.get("idempotency_key", "")
        message_id = payload.get("message_id", "")
        ack = payload.get("ack", {})
        level = ack.get("level", 0)

        now = timezone.now()

        # Find by external_message_id (set during result callback)
        qs = ContactHistory.objects.filter(external_message_id=message_id)

        if level >= 2:
            qs.filter(delivered_at__isnull=True).update(delivered_at=now)
            log.info("dispatch.callback.ack.delivered", message_id=message_id, level=level)

        if level >= 3:
            qs.filter(read_at__isnull=True).update(read_at=now)
            log.info("dispatch.callback.ack.read", message_id=message_id, level=level)

    def handle_response(self, payload: dict) -> None:
        """
        Handle patient response callback.

        Maps to: ContactHistory.patient_response, response_received_at
        Same logic as existing _update_contact_history_response in WAHA handler.
        """
        message_id = payload.get("message_id", "")
        response = payload.get("response", {})
        body = response.get("body", "")
        received_at = response.get("received_at")

        qs = ContactHistory.objects.filter(external_message_id=message_id)
        history = qs.order_by("-sent_at").first()

        if not history:
            log.warning("dispatch.callback.response.no_history", message_id=message_id)
            return

        # Append to existing response (same logic as WAHA handler)
        existing = history.patient_response or ""
        timestamp = received_at or timezone.now().isoformat()
        new_response = f"{existing}\n[{timestamp}] {body}".strip() if existing else f"[{timestamp}] {body}"

        qs.filter(id=history.id).update(
            patient_response=new_response,
            response_received_at=timezone.now(),
        )
        log.info("dispatch.callback.response.saved", message_id=message_id)
```

### Files to modify

| File | Change |
|------|--------|
| `plugins/django_interface/urls.py` | Add callback URL route |

Add to `urls.py`:

```python
from .views.dispatch_callback_view import dispatch_callback

# In urlpatterns:
path("webhooks/dispatch/callback/", dispatch_callback, name="dispatch-callback"),
```

### Database migration

No new tables needed. Uses existing `ContactHistory` fields:
- `external_message_id` — already exists, stores Dispatch message ID
- `delivered_at`, `read_at` — already exist
- `patient_response`, `response_received_at` — already exist
- `sender_provider` — already exists, will be "dispatch" or "dispatch+waha"
- `sender_phone` — already exists

### Acceptance criteria

- [ ] `POST /api/v1/webhooks/dispatch/callback/` accepts result/ack/response callbacks
- [ ] HMAC SHA-256 signature validated (rejects invalid signatures)
- [ ] Result callback updates ContactHistory.success and observation
- [ ] ACK callback updates delivered_at (level >= 2) and read_at (level >= 3)
- [ ] Response callback appends to patient_response with timestamp
- [ ] All updates are idempotent (first-write-wins for delivered_at/read_at)
- [ ] Unknown event types return 400
- [ ] Tests: each callback type, HMAC validation, idempotent updates

### Tests to write

```python
class TestDispatchCallbackView:
    def test_result_callback_sent(self, client):
        """Updates ContactHistory with success=True and delivery info."""

    def test_result_callback_failed(self, client):
        """Updates ContactHistory with success=False and error details."""

    def test_ack_callback_delivered(self, client):
        """Sets delivered_at on ACK level 2."""

    def test_ack_callback_read(self, client):
        """Sets read_at on ACK level 3."""

    def test_ack_idempotent(self, client):
        """Second ACK does not overwrite first delivered_at."""

    def test_response_callback(self, client):
        """Appends patient reply to ContactHistory."""

    def test_hmac_validation_rejects_invalid(self, client):
        """Returns 401 on invalid HMAC signature."""

    def test_hmac_validation_skips_when_no_secret(self, client):
        """No validation when DISPATCH_HMAC_SECRET is empty."""
```

### Rollback

Remove the URL route and view file. No database changes to revert.

---

## Phase OP-4: Configuration + Feature Flags

**Depends on**: OP-1
**Estimate**: S (1-2 days)
**Branch**: `feature/op4-config`

### What to build

Environment variables, Django settings, and per-clinic feature flags for Dispatch routing.

### Files to modify

| File | Change |
|------|--------|
| `.env` (production) | Add DISPATCH_* variables |
| `config/settings.py` | Read DISPATCH_* from env |
| `notification_billing/adapters/notifiers/registry.py` | Route based on feature flag |

### Environment variables

```env
# Dispatch ADB Framework
DISPATCH_API_URL=https://dispatch-api.debt.com.br
DISPATCH_API_KEY=dispatch_oralsin_prod_key_2026
DISPATCH_HMAC_SECRET=shared_hmac_secret_32bytes_hex
DISPATCH_ENABLED=false                    # Global kill switch
DISPATCH_FALLBACK_TO_WAHA=true            # If Dispatch fails, fall back to WAHA
DISPATCH_CALLBACK_URL=https://gestao.debt.com.br/api/v1/webhooks/dispatch/callback/
DISPATCH_CLINIC_IDS=                      # Comma-separated clinic UUIDs (empty = all clinics)
```

### Per-clinic routing logic

```python
def _should_use_dispatch(clinic_id: str) -> bool:
    """
    Determine if this clinic should route WhatsApp through Dispatch.

    Priority:
    1. DISPATCH_ENABLED=false → always WAHA
    2. DISPATCH_CLINIC_IDS set → only listed clinics use Dispatch
    3. DISPATCH_CLINIC_IDS empty + DISPATCH_ENABLED=true → all clinics use Dispatch
    """
    if not getattr(settings, "DISPATCH_ENABLED", False):
        return False

    allowed_clinics = getattr(settings, "DISPATCH_CLINIC_IDS", "")
    if allowed_clinics:
        clinic_list = [c.strip() for c in allowed_clinics.split(",") if c.strip()]
        return str(clinic_id) in clinic_list

    return True  # DISPATCH_ENABLED=true and no clinic filter = all clinics
```

### Acceptance criteria

- [ ] `DISPATCH_ENABLED=false` routes all traffic to WAHA (no Dispatch calls)
- [ ] `DISPATCH_ENABLED=true` + `DISPATCH_CLINIC_IDS=<uuid>` routes only that clinic
- [ ] `DISPATCH_ENABLED=true` + `DISPATCH_CLINIC_IDS=` (empty) routes all clinics
- [ ] All env vars have sensible defaults (disabled by default)
- [ ] Tests: feature flag logic for each scenario

### Rollback

Set `DISPATCH_ENABLED=false` in `.env`. Restart workers. Immediate effect.

---

## Phase OP-5: Fallback Logic (Dispatch → WAHA)

**Depends on**: OP-2, OP-3, OP-4
**Estimate**: M (3-5 days)
**Branch**: `feature/op5-fallback`

### What to build

When Dispatch is unavailable or returns an error, fall back to direct WAHA sends. Handle the async nature of Dispatch (enqueue returns immediately, delivery status comes via callback).

### Files to modify

| File | Change |
|------|--------|
| `notification_billing/core/application/handlers/notification_handlers.py` | Modified `_send_through_notifier` |

### Integration in send flow

The key integration point is `_send_through_notifier()` in `RunAutomatedNotificationsHandler`:

```python
def _send_through_notifier(self, schedule, channel):
    """
    Send notification through the appropriate provider.

    For WhatsApp with Dispatch enabled:
    1. Try Dispatch enqueue (async — returns queue ID)
    2. Create write-ahead ContactHistory with outcome="pending"
    3. Actual delivery status comes via callback (OP-3)

    Fallback: If Dispatch enqueue fails, fall back to PhonePoolService (WAHA)
    """
    if channel == "whatsapp" and _should_use_dispatch(schedule.clinic_id):
        try:
            result = self._send_through_dispatch(schedule, channel)
            if result:
                return True, result

            # Dispatch enqueue failed — fall back to WAHA
            if getattr(settings, "DISPATCH_FALLBACK_TO_WAHA", True):
                logger.warning(
                    "dispatch.fallback_to_waha",
                    schedule=str(schedule.id),
                    reason="enqueue_failed",
                )
                return self._send_through_waha(schedule, channel)
            else:
                return False, "dispatch_enqueue_failed_no_fallback"
        except Exception as e:
            logger.error("dispatch.send_exception", error=str(e))
            if getattr(settings, "DISPATCH_FALLBACK_TO_WAHA", True):
                return self._send_through_waha(schedule, channel)
            raise

    # Default: WAHA direct
    return self._send_through_waha(schedule, channel)


def _send_through_dispatch(self, schedule, channel) -> str | None:
    """Enqueue single message to Dispatch. Returns note or None on failure."""
    dispatch = get_dispatch_notifier()
    phone_number = self._pick_patient_phone(schedule)
    content = self._render_message(schedule)
    senders = self._build_senders_for_patient(schedule)

    item = DispatchEnqueueItem(
        idempotency_key=f"{schedule.id}-{channel}",
        correlation_id=self._correlation_id,
        patient_phone=phone_number,
        patient_name=schedule.patient.name,
        patient_id=str(schedule.patient_id),
        message_text=content,
        template_id=f"step-{schedule.current_step}-{channel}",
        senders=senders,
        context={
            "clinic_id": str(schedule.clinic_id),
            "schedule_id": str(schedule.id),
            "step": schedule.current_step,
            "channel": channel,
            "pipeline_run_id": self._pipeline_run_id,
        },
    )

    result = dispatch.send_batch([item])
    if result.success:
        return f"[dispatch/adb] enqueued id={result.messages[0].get('id', '')}"
    return None


def _send_through_waha(self, schedule, channel) -> tuple[bool, str]:
    """Original WAHA send via PhonePoolService."""
    if self._phone_pool and channel == "whatsapp":
        pair = self._resolve_phone_pair_for_patient(schedule)
        phone_number = self._pick_patient_phone(schedule)
        content = self._render_message(schedule)
        context = SendContext.PRE_DUE if schedule.advance_flow else SendContext.OVERDUE
        result = self._phone_pool.send(pair, phone_number, content, context)
        note = f"[{result.pair_name}/{result.provider}] id={result.message_id}"
        return result.success, note
    else:
        notifier = get_notifier(channel)
        dto = WhatsappNotificationDTO(to=phone_number, message=content)
        notifier.send(dto)
        return True, "[waha/direct]"
```

### Write-ahead ContactHistory for Dispatch

Since Dispatch is async, create ContactHistory with `outcome="pending"` immediately:

```python
# When Dispatch enqueue succeeds:
ContactHistory.objects.create(
    schedule=schedule,
    patient=schedule.patient,
    clinic=schedule.clinic,
    contact_type="whatsapp",
    success=None,           # NULL until callback
    outcome="pending",
    outcome_reason="deferred",
    sender_provider="dispatch",
    observation=f"[dispatch] enqueued, awaiting callback",
    sent_at=timezone.now(),
    pipeline_run_id=self._pipeline_run_id,
    correlation_id=self._correlation_id,
)
```

The callback handler (OP-3) updates this record when delivery status arrives.

### Acceptance criteria

- [ ] Dispatch-enabled clinic routes WhatsApp through Dispatch
- [ ] Dispatch enqueue failure falls back to WAHA (when DISPATCH_FALLBACK_TO_WAHA=true)
- [ ] Dispatch connection timeout falls back to WAHA within 30 seconds
- [ ] Write-ahead ContactHistory created with outcome="pending" on Dispatch enqueue
- [ ] Callback updates write-ahead record with actual delivery status
- [ ] Weekly limit correctly consumed (reserve on enqueue, release on Dispatch failure)
- [ ] Mixed results: some schedules via Dispatch, some via WAHA in same batch
- [ ] Tests: Dispatch success path, fallback path, mixed results, timeout handling

### Tests to write

```python
class TestDispatchFallbackLogic:
    def test_dispatch_enabled_routes_through_dispatch(self, mock_dispatch):
        """WhatsApp messages go to Dispatch when enabled for clinic."""

    def test_dispatch_failure_falls_back_to_waha(self, mock_dispatch, mock_waha):
        """When Dispatch fails, message sent via WAHA."""

    def test_dispatch_timeout_falls_back_to_waha(self, mock_dispatch, mock_waha):
        """Connection timeout triggers WAHA fallback."""

    def test_dispatch_disabled_uses_waha_directly(self, mock_waha):
        """When DISPATCH_ENABLED=false, goes straight to WAHA."""

    def test_write_ahead_contact_history_created(self, mock_dispatch):
        """ContactHistory with outcome=pending created on enqueue."""

    def test_weekly_limit_released_on_dispatch_failure(self, mock_dispatch):
        """Redis DECR called when Dispatch enqueue fails."""
```

### Rollback

Set `DISPATCH_ENABLED=false`. All traffic reverts to WAHA immediately. Write-ahead ContactHistory records with outcome="pending" can be cleaned up manually if needed (or left as-is — they indicate the enqueue happened).

---

## Phase OP-6: Monitoring + Alerts

**Depends on**: OP-5
**Estimate**: S (2-3 days)
**Branch**: `feature/op6-monitoring`

### What to build

Monitoring for Dispatch health integrated into Oralsin's existing Telegram alert system.

### Files to create

```
notification_billing/core/application/services/dispatch_health_monitor.py
```

### Implementation

```python
"""
Monitors Dispatch ADB Framework health.

Integrates with existing PhoneHealthMonitor pattern:
- Periodic health checks (5-minute interval)
- Telegram alerts on failure
- Auto-recovery detection
"""
import structlog
from notification_billing.adapters.providers.dispatch.client import DispatchAPIClient

log = structlog.get_logger(__name__)


class DispatchHealthMonitor:
    """Monitors Dispatch server health and queue stats."""

    def __init__(self, client: DispatchAPIClient, alert_service):
        self._client = client
        self._alert = alert_service
        self._consecutive_failures = 0
        self._alert_sent = False

    def check(self) -> dict:
        """Run health check. Called every 5 minutes by worker background loop."""
        health = self._client.health()
        stats = self._client.queue_stats()

        if not health.get("ok"):
            self._consecutive_failures += 1
            if self._consecutive_failures >= 3 and not self._alert_sent:
                self._alert.send_telegram(
                    f"DISPATCH DOWN: {self._consecutive_failures} consecutive failures. "
                    f"Error: {health.get('error', 'unknown')}. "
                    f"All WhatsApp traffic falling back to WAHA."
                )
                self._alert_sent = True
            return {"status": "down", "failures": self._consecutive_failures}

        # Recovered
        if self._alert_sent:
            self._alert.send_telegram(
                f"DISPATCH RECOVERED after {self._consecutive_failures} failures."
            )
        self._consecutive_failures = 0
        self._alert_sent = False

        # Check queue health
        pending = stats.get("pending", 0)
        failed = stats.get("failed_last_hour", 0)

        if pending > 100:
            self._alert.send_telegram(
                f"DISPATCH QUEUE HIGH: {pending} pending messages. "
                f"Failed last hour: {failed}."
            )

        return {
            "status": "healthy",
            "pending": pending,
            "failed_last_hour": failed,
        }
```

### Files to modify

| File | Change |
|------|--------|
| `notification_billing/core/application/services/phone_health_monitor.py` | Add Dispatch health check to background loop |

### Acceptance criteria

- [ ] Dispatch health checked every 5 minutes
- [ ] Telegram alert after 3 consecutive failures
- [ ] Recovery alert when Dispatch comes back online
- [ ] Queue depth alert when pending > 100
- [ ] Failed message rate alert when failed_last_hour > 10
- [ ] Tests: health check mock, alert thresholds, recovery detection

### Rollback

Remove health monitor. Dispatch health is still visible via its own `/healthz` endpoint.

---

## Execution Order

```
Week 1:  OP-1 (Dispatch Adapter) — foundation
Week 2:  OP-3 (Callback Webhook) + OP-4 (Config) in parallel
Week 3:  OP-2 (Sender-Grouped Batching)
Week 4:  OP-5 (Fallback Logic) — integrates everything
Week 5:  OP-6 (Monitoring) — deploy to production pilot
```

---

## Pilot Deployment Plan

1. **Week 1**: Deploy Dispatch adapter with `DISPATCH_ENABLED=false`
2. **Week 2**: Enable for Bauru clinic only (`DISPATCH_CLINIC_IDS=<bauru-uuid>`) — lowest volume (22 pending)
3. **Week 3**: Monitor delivery rates, ban rates, callback latency for 1 week
4. **Week 4**: Enable for Volta Redonda (39 pending) if Bauru metrics are good
5. **Week 6**: Enable for all 4 clinics if metrics are stable
6. **Rollback at any point**: `DISPATCH_ENABLED=false` — immediate revert to WAHA

---

## Migration Checklist

Before enabling Dispatch for a clinic:
- [ ] Dispatch server running and `/healthz` returns healthy
- [ ] All 8 sender phone numbers configured in Dispatch `sender_mapping`
- [ ] Dispatch plugin oralsin `/status` returns `active`
- [ ] Callback webhook URL reachable from Dispatch server
- [ ] HMAC secret matches on both sides
- [ ] Test send via `POST /plugins/oralsin/enqueue` succeeds
- [ ] Telegram alerts configured for Dispatch health monitor
