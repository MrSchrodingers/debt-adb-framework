# Dispatch Side: Oralsin Plugin Enhancement Plan

> **Scope**: Changes to the Dispatch ADB Framework codebase (`/var/www/adb_tools`)
> **Spec**: `docs/research/oralsin-dispatch-full-spec.md` (complete integration spec)
> **Existing code**: `packages/core/src/plugins/oralsin-plugin.ts` (basic enqueue)
> **Date**: 2026-04-06
> **Status**: Ready for execution

---

## Context Recovery

On every new session, read these files first:
```
1. .dev-state/progress.md — current phase, blockers
2. plans/dispatch-oralsin-plugin.md — THIS FILE
3. docs/research/oralsin-dispatch-full-spec.md — full spec with contracts
4. docs/research/integration-contracts.md — standalone API contracts
5. packages/core/src/plugins/oralsin-plugin.ts — existing plugin
6. packages/core/src/plugins/types.ts — plugin type definitions
```

---

## Dependency Graph

```
DP-1 (Sender Mapping + Grouped Enqueue)
  ├── DP-2 (Receipt Tracking)
  │     └── DP-4 (Callback System Enhancement)
  ├── DP-3 (WAHA Fallback)
  │     └── DP-4 (Callback System Enhancement)
  └── DP-5 (Queue Optimization)

DP-4 (Callback System Enhancement)
  └── DP-6 (Headless Mode)

DP-5 (Queue Optimization)
  └── DP-6 (Headless Mode)

Critical Path: DP-1 → DP-2 → DP-4 → DP-6
Parallel Track: DP-1 → DP-3 → DP-4
                DP-1 → DP-5 → DP-6
```

---

## Architecture Rules

1. **Core remains agnostic** — zero Oralsin business logic in `packages/core/src/`. All Oralsin-specific logic lives in the plugin (`packages/core/src/plugins/oralsin-plugin.ts`).
2. **Plugin uses PluginContext API** — the plugin MUST NOT import core internals directly. It uses `ctx.enqueue()`, `ctx.on()`, `ctx.registerRoute()`, `ctx.logger`.
3. **Core provides generic capabilities** — sender mapping, grouped dequeue, WAHA fallback, receipt tracking are CORE features that any plugin can use.
4. **Plugin adds routing logic** — how Oralsin's `senders[]` array maps to Dispatch's sender mapping is plugin concern.
5. **Callback delivery is CORE** — already implemented in `packages/core/src/plugins/callback-delivery.ts`. Plugin just triggers it.

---

## Phase DP-1: Sender Mapping + Grouped Enqueue

**Depends on**: Dispatch Phases 1-7 APPROVED (already done)
**Estimate**: M (3-5 days)
**Branch**: `feature/dp1-sender-mapping`

### What to build

A `sender_mapping` table and API that maps phone numbers to device/profile/app tuples. The Oralsin plugin uses this to validate that `senders[]` phone numbers can actually be routed to physical devices.

### Separation of concerns

| Layer | Responsibility |
|-------|----------------|
| **Core** | `sender_mapping` table, CRUD API, lookup by phone number |
| **Core** | `enqueue()` accepts `senderNumber` and validates against mapping |
| **Plugin** | Translates Oralsin's `senders[]` array to primary `senderNumber` via mapping lookup |
| **Plugin** | Falls back through `senders[]` roles (primary → overflow → backup → reserve) |

### Files to create

| File | Purpose |
|------|---------|
| `packages/core/src/engine/sender-mapping.ts` | `SenderMapping` class: CRUD for sender_mapping table |
| `packages/core/src/engine/sender-mapping.test.ts` | Tests: CRUD, lookup, conflicts |
| `packages/core/src/api/sender-mapping.ts` | REST routes: GET/POST/PUT/DELETE `/api/v1/sender-mapping` |

### Files to modify

| File | Change |
|------|--------|
| `packages/core/src/server.ts` | Register sender-mapping API routes |
| `packages/core/src/queue/message-queue.ts` | Add `sender_number` column to messages table, index it |
| `packages/core/src/plugins/oralsin-plugin.ts` | Use sender mapping to resolve `senders[]` → `senderNumber` |
| `packages/core/src/plugins/types.ts` | Add `getSenderMapping(phone: string)` to `PluginContext` |

### Database migration

```sql
CREATE TABLE IF NOT EXISTS sender_mapping (
  id TEXT PRIMARY KEY,
  phone_number TEXT NOT NULL UNIQUE,
  device_serial TEXT NOT NULL,
  profile_id INTEGER NOT NULL DEFAULT 0,
  app_package TEXT NOT NULL DEFAULT 'com.whatsapp',
  waha_session TEXT,           -- WAHA session name for fallback
  waha_api_url TEXT,           -- WAHA API URL for this session
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_sender_mapping_device ON sender_mapping(device_serial);
CREATE INDEX idx_sender_mapping_active ON sender_mapping(active);

-- Add sender_number to messages table (migration)
ALTER TABLE messages ADD COLUMN sender_number TEXT;
CREATE INDEX idx_messages_sender_number ON messages(sender_number);
```

### Acceptance criteria

- [ ] `POST /api/v1/sender-mapping` creates a mapping (phone → device/profile/app)
- [ ] `GET /api/v1/sender-mapping` lists all mappings
- [ ] `GET /api/v1/sender-mapping/:phone` returns specific mapping
- [ ] `DELETE /api/v1/sender-mapping/:phone` removes mapping
- [ ] Oralsin plugin resolves `senders[0].phone` → sender mapping → `senderNumber` on enqueue
- [ ] If primary sender has no mapping, plugin falls back to overflow → backup → reserve
- [ ] If NO sender has a mapping, enqueue returns 422 with descriptive error
- [ ] `messages.sender_number` populated on every enqueue
- [ ] Tests: CRUD operations, fallback chain, missing mapping error

### Tests to write

```
describe('SenderMapping')
  it('creates a new mapping')
  it('rejects duplicate phone numbers')
  it('lists all active mappings')
  it('deactivates a mapping')
  it('returns null for unknown phone')

describe('OralsinPlugin.handleEnqueue — sender resolution')
  it('resolves primary sender when mapping exists')
  it('falls back to overflow when primary has no mapping')
  it('falls back to backup when overflow also missing')
  it('returns 422 when no sender can be resolved')
  it('populates sender_number on enqueued message')
```

### Rollback

Delete the `sender_mapping` table. Remove `sender_number` column from messages (or leave it — it is nullable and harmless).

---

## Phase DP-2: Receipt Tracking

**Depends on**: DP-1
**Estimate**: M (3-5 days)
**Branch**: `feature/dp2-receipt-tracking`

### What to build

After ADB sends a message, WAHA (as a linked device) sees the same outgoing message and receives ACK events. Dispatch needs to correlate ADB sends with WAHA ACK webhooks to provide delivery receipts.

### Separation of concerns

| Layer | Responsibility |
|-------|----------------|
| **Core** | `ReceiptTracker` class: register sent messages, correlate WAHA ACKs |
| **Core** | Fix ACK level mapping bug (currently `deliveredAt` at ACK >= 3, should be >= 2) |
| **Core** | Emit `message:delivered` and `message:read` events |
| **Plugin** | Listen to delivery events, trigger ACK callbacks to Oralsin |

### Files to create

| File | Purpose |
|------|---------|
| `packages/core/src/engine/receipt-tracker.ts` | Correlates ADB sends with WAHA ACKs |
| `packages/core/src/engine/receipt-tracker.test.ts` | Tests: correlation, timeout, edge cases |

### Files to modify

| File | Change |
|------|--------|
| `packages/core/src/waha/webhook-handler.ts` | Fix ACK bug: `deliveredAt` at ACK >= 2, `readAt` at ACK >= 3 |
| `packages/core/src/waha/webhook-handler.ts` | Call `ReceiptTracker.handleAck()` when ACK received |
| `packages/core/src/events/index.ts` | Add `message:delivered` and `message:read` events |
| `packages/core/src/plugins/oralsin-plugin.ts` | Subscribe to delivery events, build AckCallback, trigger delivery |

### Correlation algorithm

```
1. When ADB sends message to +5543991938235 from +554396837945:
   - ReceiptTracker.registerSent({messageId, toNumber: "5543991938235", senderNumber: "+554396837945", sentAt})
   - Store in Map with key = normalized(toNumber) + normalized(senderNumber)
   - TTL: 48 hours (matches Oralsin's response capture window)

2. When WAHA webhook fires message.any (outgoing, fromMe=true):
   - Normalize toNumber from WAHA c.us format (554391938235@c.us → 5543991938235)
   - Normalize senderNumber from WAHA session
   - Match by key + time window (±60 seconds)
   - Store waha_message_id → dispatch_message_id mapping

3. When WAHA webhook fires message.ack:
   - Lookup waha_message_id → dispatch_message_id
   - If match: emit message:delivered (ACK >= 2) or message:read (ACK >= 3)
   - Plugin forwards as AckCallback
```

### Phone number normalization (critical)

ADB uses 13-digit: `5543991938235`
WAHA uses 12-digit: `554391938235@c.us`

```typescript
// Core utility: normalize BR phone to 12-digit WAHA format
function normalizeBrPhoneForMatching(phone: string): string {
  const digits = phone.replace(/\D/g, '')
  // If 13 digits, starts with 55, 5th digit is 9: remove 5th digit
  if (digits.length === 13 && digits.startsWith('55') && digits[4] === '9') {
    return digits.slice(0, 4) + digits.slice(5)
  }
  return digits
}
```

### Acceptance criteria

- [ ] ACK level bug fixed: `deliveredAt` at ACK >= 2, `readAt` at ACK >= 3
- [ ] ADB-sent messages correlated with WAHA message.any within 60s window
- [ ] `waha_message_id` stored in messages table after correlation
- [ ] WAHA ACK level 2 → `message:delivered` event emitted
- [ ] WAHA ACK level 3 → `message:read` event emitted
- [ ] Plugin sends AckCallback to Oralsin on delivery/read events
- [ ] Phone normalization handles 13-digit → 12-digit conversion
- [ ] Correlation survives server restart (persisted in SQLite, not just in-memory)
- [ ] Tests: correlation match, time window expiry, phone normalization, ACK forwarding

### Tests to write

```
describe('ReceiptTracker')
  it('correlates ADB send with WAHA outgoing message within 60s')
  it('rejects correlation outside 60s window')
  it('handles 13-digit to 12-digit phone normalization')
  it('stores waha_message_id in messages table after correlation')
  it('does not double-correlate same WAHA message')

describe('ReceiptTracker ACK handling')
  it('emits message:delivered on ACK level 2')
  it('emits message:read on ACK level 3')
  it('ignores ACK for uncorrelated messages')
  it('handles ACK before correlation (late outgoing webhook)')

describe('WebhookHandler ACK bug fix')
  it('sets deliveredAt at ACK >= 2 (not >= 3)')
  it('sets readAt at ACK >= 3 (not >= 4)')
```

### Rollback

Remove ReceiptTracker. Revert ACK fix if needed (but the ACK fix is a bug fix, should stay). Plugin stops sending AckCallbacks.

---

## Phase DP-3: WAHA Fallback

**Depends on**: DP-1
**Estimate**: M (3-5 days)
**Branch**: `feature/dp3-waha-fallback`

### What to build

When ADB send fails after all retries, Dispatch falls back to WAHA API using the same sender number's WAHA session. Per-account mutex prevents simultaneous ADB+WAHA sends.

### Separation of concerns

| Layer | Responsibility |
|-------|----------------|
| **Core** | `WahaFallback` class: send via WAHA API using session credentials from sender_mapping |
| **Core** | Per-account mutex: acquire before ADB send, hold through fallback |
| **Core** | Failure classification: transient, app_crash, device_offline, ban_detected |
| **Plugin** | Provides WAHA session credentials via `senders[]` config stored in messages |

### Files to create

| File | Purpose |
|------|---------|
| `packages/core/src/engine/waha-fallback.ts` | WAHA API direct send with rate limiting |
| `packages/core/src/engine/waha-fallback.test.ts` | Tests: send, rate limit, error handling |
| `packages/core/src/engine/account-mutex.ts` | Per-phone-number mutex to prevent ADB+WAHA collision |
| `packages/core/src/engine/account-mutex.test.ts` | Tests: lock, release, timeout, contention |

### Files to modify

| File | Change |
|------|--------|
| `packages/core/src/engine/send-engine.ts` | Acquire account mutex before send, call WahaFallback on failure |
| `packages/core/src/engine/retry-manager.ts` | Add failure classification, WAHA fallback trigger |
| `packages/core/src/queue/message-queue.ts` | Add `senders_config` column (JSON) to store full senders array |
| `packages/core/src/plugins/types.ts` | Add `fallback_reason` to ResultCallback |

### Database migration

```sql
-- Add senders_config to messages (stores the full senders[] array from enqueue)
ALTER TABLE messages ADD COLUMN senders_config TEXT;

-- Add fallback tracking
ALTER TABLE messages ADD COLUMN fallback_used INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN fallback_provider TEXT;
```

### WAHA fallback flow

```
1. ADB send attempt fails
2. Classify failure:
   - TRANSIENT → retry ADB (up to max_retries)
   - APP_CRASH → force-stop WA, restart, retry ADB
   - DEVICE_OFFLINE → skip to WAHA fallback immediately
   - BAN_DETECTED → quarantine sender 30min, try next sender
   - UNKNOWN → 1 ADB retry, then WAHA fallback
3. All ADB retries exhausted → WAHA fallback:
   a. Parse senders_config from message
   b. Find WAHA session for current sender (waha_session from sender_mapping)
   c. Call WAHA API: POST /api/sendText with typing simulation
   d. Apply same rate limiting as Oralsin WAHA client (20-35s base, volume scaling)
4. If WAHA also fails → mark permanently_failed, send error callback
```

### Acceptance criteria

- [ ] Account mutex prevents simultaneous ADB+WAHA sends for same phone number
- [ ] ADB failure classified correctly (transient vs permanent)
- [ ] Transient failures retry ADB up to max_retries
- [ ] Device offline triggers immediate WAHA fallback (no ADB retry)
- [ ] Ban detected quarantines sender and tries next sender from `senders[]`
- [ ] WAHA fallback uses correct session credentials from sender_mapping
- [ ] WAHA fallback applies rate limiting (20-35s base delay, volume scaling)
- [ ] ResultCallback includes `fallback_reason` when WAHA used
- [ ] `messages.fallback_used` = 1 when WAHA delivered the message
- [ ] Tests: failure classification, mutex lock/release, WAHA send mock, fallback flow

### Tests to write

```
describe('AccountMutex')
  it('acquires lock for a phone number')
  it('blocks concurrent acquire for same number')
  it('allows concurrent acquire for different numbers')
  it('releases lock after use')
  it('times out after 60 seconds')

describe('WahaFallback')
  it('sends via WAHA API with correct session')
  it('applies rate limiting between sends')
  it('returns message_id from WAHA response')
  it('throws on WAHA API error')

describe('SendEngine with fallback')
  it('falls back to WAHA after 3 ADB failures')
  it('skips ADB retry on device_offline, goes straight to WAHA')
  it('quarantines sender on ban, tries next sender via ADB')
  it('marks permanently_failed when all senders and WAHA fail')
  it('sets fallback_used=1 and fallback_provider="waha" on WAHA success')
```

### Rollback

Remove WahaFallback. SendEngine reverts to ADB-only with retry. `senders_config` column stays (nullable, harmless).

---

## Phase DP-4: Callback System Enhancement

**Depends on**: DP-2, DP-3
**Estimate**: S (2-3 days)
**Branch**: `feature/dp4-callback-enhancement`

### What to build

Enhance the existing CallbackDelivery (`packages/core/src/plugins/callback-delivery.ts`) to handle all four callback types expected by Oralsin: result, ACK, response, and batch-result.

### Separation of concerns

| Layer | Responsibility |
|-------|----------------|
| **Core** | CallbackDelivery sends HMAC-signed POST to plugin webhook URL |
| **Core** | Failed callback persistence and retry |
| **Plugin** | Triggers callbacks at the right moments (send complete, ACK received, response captured) |

### Files to modify

| File | Change |
|------|--------|
| `packages/core/src/plugins/callback-delivery.ts` | Add batch result callback support |
| `packages/core/src/plugins/oralsin-plugin.ts` | Wire up all callback triggers |
| `packages/core/src/plugins/types.ts` | Ensure all callback types match spec |

### Plugin callback wiring

```typescript
// In OralsinPlugin.init():
ctx.on('message:sent', async (data) => {
  // Build ResultCallback with delivery info
  // Trigger ctx.sendResultCallback()
})

ctx.on('message:failed', async (data) => {
  // Build ResultCallback with error info
  // Include fallback_reason if applicable
  // Trigger ctx.sendResultCallback()
})

ctx.on('message:delivered', async (data) => {
  // Build AckCallback with level=2
  // Trigger ctx.sendAckCallback()
})

ctx.on('message:read', async (data) => {
  // Build AckCallback with level=3
  // Trigger ctx.sendAckCallback()
})

ctx.on('waha:message_received', async (data) => {
  // Check if incoming message matches a recently-sent plugin message
  // Build ResponseCallback
  // Trigger ctx.sendResponseCallback()
})
```

### Acceptance criteria

- [ ] Result callback sent on message:sent with delivery info (provider, elapsed_ms, sender used)
- [ ] Result callback sent on message:failed with error details and retryable flag
- [ ] ACK callback sent on message:delivered (level 2) and message:read (level 3)
- [ ] Response callback sent when patient replies to a recently-sent message
- [ ] All callbacks include `idempotency_key` for Oralsin correlation
- [ ] All callbacks include `context` passthrough from enqueue
- [ ] HMAC signature validated (existing implementation, just verify)
- [ ] Failed callbacks persisted and retryable (existing implementation)
- [ ] Tests: each callback type triggered correctly, HMAC signature, context passthrough

### Tests to write

```
describe('OralsinPlugin callback wiring')
  it('sends result callback on message:sent')
  it('sends result callback on message:failed with error details')
  it('sends ACK callback on message:delivered')
  it('sends ACK callback on message:read')
  it('sends response callback on patient reply')
  it('includes context passthrough in all callbacks')
  it('includes fallback_reason when WAHA was used')
```

### Rollback

Revert plugin event wiring. Core callback delivery is unchanged.

---

## Phase DP-5: Queue Optimization (Sender-Grouped Dequeue)

**Depends on**: DP-1
**Estimate**: M (3-5 days)
**Branch**: `feature/dp5-queue-optimization`

### What to build

Optimize the dequeue algorithm to group messages by sender number, minimizing expensive Android user switches (3-4s each).

### Separation of concerns

| Layer | Responsibility |
|-------|----------------|
| **Core** | Sender-grouped dequeue SQL, batch lock, priority override |
| **Core** | Worker loop: drain all messages for one sender before switching |
| **Plugin** | No changes needed — grouping is transparent to the plugin |

### Files to modify

| File | Change |
|------|--------|
| `packages/core/src/queue/message-queue.ts` | New `dequeueBySender()` method |
| `packages/core/src/engine/send-engine.ts` | Worker loop uses sender-grouped dequeue |
| `packages/core/src/engine/dispatcher.ts` | Select sender group with most pending messages |

### Dequeue algorithm

```sql
-- Step 1: High-priority messages always go first (regardless of sender grouping)
SELECT * FROM messages
WHERE status = 'queued' AND priority < 5
ORDER BY priority ASC, created_at ASC
LIMIT 1;

-- Step 2: If no high-priority, find sender group with most pending
SELECT sender_number, COUNT(*) as cnt
FROM messages
WHERE status = 'queued'
GROUP BY sender_number
ORDER BY cnt DESC
LIMIT 1;

-- Step 3: Lock a batch for that sender
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

### Worker loop change

```
Current:  dequeue(1) → send → dequeue(1) → send → ...
Proposed: dequeueBySender(50) → send all → dequeueBySender(50) → ...

Per batch:
1. Switch to correct Android user (if different from current)
2. FOR each message in batch:
   a. Send via ADB (wa.me intent → type → send)
   b. Apply inter-message jitter (20-35s)
   c. Mark sent
3. Move to next sender group
```

### Acceptance criteria

- [ ] High-priority messages (priority < 5) always dequeued first
- [ ] Normal messages dequeued by sender group (most messages first)
- [ ] Batch size configurable (default 50)
- [ ] Worker sends all messages for one sender before switching
- [ ] User switch only happens when sender changes (not per message)
- [ ] Stale lock cleanup still works with batch locks
- [ ] Tests: grouped dequeue SQL, priority override, batch locking

### Tests to write

```
describe('MessageQueue.dequeueBySender')
  it('returns messages grouped by sender with most pending')
  it('respects batch size limit')
  it('dequeues high-priority first regardless of sender group')
  it('locks all messages in batch atomically')
  it('stale lock cleanup handles batch-locked messages')

describe('SendEngine sender-grouped loop')
  it('processes all messages for one sender before switching')
  it('switches user only when sender changes')
  it('applies inter-message jitter within same sender batch')
```

### Rollback

Revert to single-message dequeue. Worker loop reverts to one-at-a-time.

---

## Phase DP-6: Headless Mode + systemd

**Depends on**: DP-4, DP-5
**Estimate**: M (3-5 days)
**Branch**: `feature/dp6-headless`

### What to build

Dispatch runs as a headless Node.js server (no Electron) with systemd service management. This is required for production deployment.

### Files to create

| File | Purpose |
|------|---------|
| `packages/core/src/cli.ts` | CLI entrypoint with arg parsing (--port, --db-path, etc.) |
| `deploy/dispatch.service` | systemd unit file |
| `deploy/dispatch.env.example` | Example environment file |
| `deploy/install.sh` | Install script (copies service file, enables, starts) |

### Files to modify

| File | Change |
|------|--------|
| `packages/core/src/main.ts` | Support both Electron-embedded and standalone modes |
| `packages/core/src/index.ts` | Export `startServer()` for programmatic use |
| `packages/core/package.json` | Add `bin` entry and `start:headless` script |

### systemd service

```ini
[Unit]
Description=Dispatch ADB Framework
After=network.target

[Service]
Type=simple
User=dispatch
WorkingDirectory=/opt/dispatch
ExecStart=/usr/bin/node packages/core/dist/cli.js
Restart=on-failure
RestartSec=10
EnvironmentFile=/opt/dispatch/.env
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

### Health endpoint enhancement

```
GET /healthz

Response:
{
  "status": "healthy",
  "uptime_seconds": 12345,
  "devices": { "online": 2, "total": 2 },
  "queue": { "pending": 42, "processing": 3, "failed_last_hour": 1 },
  "plugins": { "oralsin": "active" },
  "last_send_at": "2026-04-06T14:30:00.000Z"
}
```

### Acceptance criteria

- [ ] `node packages/core/dist/cli.js` starts Dispatch without Electron
- [ ] Environment-based configuration (PORT, DB_PATH, API_KEY, etc.)
- [ ] systemd service file installs and starts correctly
- [ ] Graceful shutdown on SIGTERM (drain queue, finish current send)
- [ ] `/healthz` returns comprehensive status for external monitoring
- [ ] Process restarts automatically on crash (systemd Restart=on-failure)
- [ ] Logs go to journald (structured JSON via pino)
- [ ] Tests: CLI arg parsing, graceful shutdown signal handling

### Tests to write

```
describe('CLI entrypoint')
  it('starts server on specified port')
  it('uses default port 7890 when not specified')
  it('reads configuration from environment variables')

describe('Graceful shutdown')
  it('drains queue on SIGTERM')
  it('finishes current send before exiting')
  it('exits within 10 seconds')
  it('closes SQLite connection cleanly')
```

### Rollback

Revert to Electron-only mode. Remove systemd files.

---

## Execution Order

```
Week 1:  DP-1 (Sender Mapping) — foundation for everything else
Week 2:  DP-2 (Receipt Tracking) + DP-5 (Queue Optimization) in parallel
Week 3:  DP-3 (WAHA Fallback) — can start once DP-1 done
Week 4:  DP-4 (Callback Enhancement) — needs DP-2 + DP-3
Week 5:  DP-6 (Headless Mode) — final phase, deploy to production
```

---

## Cross-Dependencies with Oralsin

| Dispatch Phase | Oralsin Dependency | Notes |
|----------------|-------------------|-------|
| DP-1 complete | Oralsin can start OP-1 (DispatchNotifier) | Oralsin needs enqueue API to exist |
| DP-4 complete | Oralsin can start OP-3 (Callback Webhook) | Oralsin needs callback format finalized |
| DP-6 complete | Oralsin can start OP-5 (Fallback Logic) | Oralsin needs Dispatch running in production |

---

## Test Phone Number

**ALL integration tests and E2E sends MUST target:**
```
TEST_PHONE_NUMBER=5543991938235
```
Never send to any other number during development.
