# Phase 4 Grill — WAHA Listener Passivo

> **Date**: 2026-04-02
> **Status**: COMPLETE (17 decisions)
> **Interviewer**: Claude Opus 4.6
> **Decisions confirmed with**: Matheus (developer)

## Infrastructure Decisions

### 1. WAHA Server Location
**Decision**: Same server as Oralsin (`37.27.210.137`), shared WAHA Plus instance
**Rationale**: WAHA already running with 136 sessions. No need for separate instance.
**Implication**: Dispatch is a consumer of existing WAHA sessions, not a WAHA operator.

### 2. WAHA Version & Engine
**Decision**: WAHA Plus GoWS 2026.3.1
**Found via exploration**: Docker image `devlikeapro/waha-plus:gows`, with Redis 7 + Postgres 15 for session persistence.
**Implication**: GoWS engine (lightweight Go), HMAC webhooks, retry policies, session persistence all available.

### 3. Reverse Proxy
**Decision**: Traefik v2.11 (not Nginx as initially assumed)
**Found via exploration**: Docker Swarm stack with Traefik handling SSL termination.
**Domain**: `gows-chat.debt.com.br` for WAHA API.

### 4. Dispatch Public URL
**Decision**: Not available yet. Use ngrok for development/testing.
**Implication**: Webhook configuration on WAHA sessions deferred until domain ready.

## Session Management Decisions

### 5. Sessions Already Exist
**Decision**: Dispatch does NOT create WAHA sessions. All 136 sessions already exist and are paired.
**Rationale**: Sessions are managed by operations team. Dispatch is a consumer.
**Implication**: No QR code pairing flow needed for Phase 4. QR in dashboard deferred to Phase 6.

### 6. Webhook Addition Strategy
**Decision**: Dispatch adds its webhook URL as a SECOND webhook to existing sessions (via PUT /api/sessions/{name}).
**Rationale**: Oralsin webhooks (8 sessions) and n8n webhooks (19 sessions) stay untouched.
**Current webhooks**:
  - 8 sessions → `api.oralsin.debt.com.br/api/webhooks/waha-gows/oralsin`
  - 19 sessions → `debt.automatico.tecnoatende.com.br/webhook/WxMxH2E7c4Gv7L4g`
  - 109 sessions → global default (Oralsin)

### 7. Health Check Scope
**Decision**: Only monitor sessions matching ADB-managed phone numbers.
**Rationale**: Dispatch shouldn't monitor 136 sessions it doesn't control.
**Implementation**: Cross-reference `whatsapp_accounts.phone_number` with `session.me.id`.

### 8. Session Recovery
**Decision**: Auto-restart via `POST /api/sessions/{name}/restart`.
**Rationale**: WAHA Plus persists sessions, so restart reconnects automatically.
**Escalation**: If session status stays FAILED after restart → alert critical (needs manual re-pair).

## Webhook Processing Decisions

### 9. WAHA Events to Subscribe
**Decision**: `message.any` + `session.status` + `message.ack`
**Rationale**:
  - `message.any`: ALL messages including outgoing via multi-device sync (not just `message` which is incoming only)
  - `session.status`: For health monitoring and gap detection
  - `message.ack`: Delivery/read receipts for audit trail

### 10. Webhook Security
**Decision**: HMAC SHA-512 per-session
**Found in WAHA docs**: Header `X-Webhook-Hmac`, algorithm in `X-Webhook-Hmac-Algorithm`.
**Config**: Each session gets `"hmac": { "key": "<WAHA_WEBHOOK_HMAC_SECRET>" }`.

### 11. Webhook Retry
**Decision**: WAHA Plus built-in retry (exponential, 2s base, 10 attempts)
**Config**: `"retries": { "policy": "exponential", "delaySeconds": 2, "attempts": 10 }`

### 12. Backup Sync Strategy
**Decision**: Webhook primary + gap-fill on reconnect (NO periodic polling)
**Rationale**: WAHA `GET /api/messages` requires `chatId`, making session-wide polling impractical for 20+ sessions with thousands of chats.
**Gap-fill**: When `session.status` transitions from FAILED→WORKING, log warning about audit trail gap for the offline period.

## Data Decisions

### 13. Outgoing Message Dedup
**Decision**: Match by `to_number + timestamp ±30s window`
**Flow**:
  1. ADB send creates `message_history` record with `captured_via: 'adb_send'`
  2. WAHA webhook arrives with same `to_number` within 30s
  3. Update existing record: add `waha_message_id`, confirm delivery
  4. If no match: create new record (message not sent by Dispatch)

### 14. Media Handling
**Decision**: Download complete media via WAHA API, store in local filesystem
**Storage**: `data/media/{session}/{date}/{id}.{ext}`
**Interface**: `StorageAdapter` for future S3/MinIO migration
**Download**: Async (don't block webhook processing), background job

### 15. Message History Retention
**Decision**: 90 days
**Implementation**: Cron job deletes records + media files older than 90 days.
**Configurable**: `MESSAGE_HISTORY_RETENTION_DAYS=90` in .env.

### 16. Independence: WAHA Ban ≠ ADB Ban
**Decision**: Complete independence. WAHA session ban generates alert but does NOT pause ADB sending.
**Rationale**: WAHA is a linked device (web session). ADB is the physical phone. Different channels, different ban vectors.
**Alert**: `waha_session_banned` with severity `medium` (does not affect core sending capability).

### 17. Volume & Scale
**Decision**: Design for 20+ numbers, start with Oralsin 8 sessions
**Health check interval**: 60s per session
**Webhook processing**: Async, non-blocking, SQLite WAL for concurrent writes

## WAHA API Endpoints Used by Dispatch

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | /api/sessions | List all sessions (health check, discovery) |
| GET | /api/sessions/{name} | Session detail (status, config, me) |
| PUT | /api/sessions/{name} | Update session config (add webhook) |
| POST | /api/sessions/{name}/restart | Restart failed session |
| GET | /api/files/{mediaId} | Download media file |
| GET | /api/server/version | Verify WAHA connectivity |

## Webhook Payload Format (from WAHA docs)

```json
{
  "event": "message.any",
  "session": "oralsin_main_1",
  "me": {
    "id": "554396835104@c.us",
    "pushName": "Contato | Oralsin-Debt"
  },
  "payload": {
    "id": "true_554396835104@c.us_AAAAAAA",
    "timestamp": 1667561485,
    "from": "554396835104@c.us",
    "to": "5543991938235@c.us",
    "body": "Hello!",
    "hasMedia": false,
    "media": null,
    "replyTo": null
  },
  "engine": "GOWS",
  "environment": {
    "version": "2026.3.1",
    "engine": "GOWS",
    "tier": "PLUS"
  }
}
```

## Session Status Event Format

```json
{
  "event": "session.status",
  "session": "oralsin_main_1",
  "me": { "id": "554396835104@c.us", "pushName": "Contato | Oralsin-Debt" },
  "payload": {
    "status": "WORKING",
    "statuses": [
      { "status": "STOPPED", "timestamp": 1700000001000 },
      { "status": "STARTING", "timestamp": 1700000002000 },
      { "status": "WORKING", "timestamp": 1700000003000 }
    ]
  }
}
```

## Open Items
- **Dispatch domain**: Configure when infra is ready (ngrok for dev)
- **debt_plugin**: Future — configure webhooks for non-Oralsin sessions
- **S3 migration**: When MinIO/S3 infra available, swap StorageAdapter
