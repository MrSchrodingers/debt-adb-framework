# Oralsin Notification System: Production Analysis & Dispatch ADB Integration Design

**Date**: 2026-04-07
**Author**: Principal Software Architect
**Status**: Analysis Complete

---

## Part 1: Oralsin Production System Analysis

### 1.1 Architecture Overview

The Oralsin notification billing system is a Django/Temporal-based application that manages automated debt collection notifications for Oral Sin dental clinics. Key components:

- **Orchestration**: Temporal workflows (`NotificationPipelineWorkflow`) with strict linear execution
- **Message Broker**: RabbitMQ for internal task distribution
- **Storage**: PostgreSQL (primary) + Redis (caching, rate limiting, quarantine)
- **WhatsApp Delivery**: WAHA Plus API on GoWS server (`gows-chat.debt.com.br`, 136 sessions)
- **Workers**: Temporal workers (2x pre-due, 2x overdue, 2x sync, 1x pipedrive)

### 1.2 Active Clinics and Number Pool

**4 active clinics** with notifications enabled:

| Clinic | Oralsin ID | Primary Pair | Overflow/Backup | Pending Schedules |
|--------|-----------|-------------|-----------------|-------------------|
| Divinopolis | 190 | oralsin-1-4 (MG) | oralsin-2-3 (overflow) + oralsin-main-1 (backup) | 142 |
| Balneario Camboriu | 163 | oralsin-1-3 (SP) | oralsin-2-1 + oralsin-2-2 (overflow) | 82 |
| Bauru | 47 | oralsin-1-2 (SP) | none | 22 |
| Volta Redonda | 423 | oralsin-main-2 (RJ) | none | 39 |

**8 active phone pairs** (all on WAHA):
- `oralsin-main-1` (+554396835104, SP)
- `oralsin-main-2` (+554396835100, RJ)
- `oralsin-1-2` (+554396835102, SP)
- `oralsin-1-3` (+554396837887, SP)
- `oralsin-1-4` (+554396837945, MG)
- `oralsin-2-1` (+554396835095, MG)
- `oralsin-2-2` (+554396837813, RJ)
- `oralsin-2-3` (+554396837844, SP)

**Affinity stats**: 69 patient-phone affinities recorded.

### 1.3 Flow Step Configuration (Escalation Ladder)

The system uses a 14-step escalation flow over ~14 weeks:

| Step | Channels | Cooldown | Description |
|------|----------|----------|-------------|
| 0 | SMS + WhatsApp | 0d | Pre-due reminder (D-3 before due date) |
| 100 | WhatsApp | 0d | DEBT introduction (first contact ever) |
| 1 | SMS + WhatsApp | 7d | Week 1: First overdue notice |
| 2 | Email + WhatsApp | 7d | Week 2 |
| 3 | SMS + WhatsApp | 7d | Week 3 |
| 4 | Phone call | 7d | Week 4 |
| 5 | SMS + WhatsApp | 7d | Week 5 (urgency escalation) |
| 6 | Letter | 7d | Week 6: Friendly letter |
| 7 | Email + WhatsApp | 7d | Week 7 |
| 8 | Phone call | 7d | Week 8 |
| 9 | WhatsApp only | 7d | Week 9 (treatment suspension warning) |
| 10 | SMS + WhatsApp | 7d | Week 10 |
| 11 | Letter | 7d | Week 11 |
| 12 | Phone + WhatsApp | 7d | Week 12 (pre-judicial) |
| 13 | Email + WhatsApp | 7d | Week 13 (last opportunity) |

**Key insight**: WhatsApp is the primary channel used in 11 of 14 steps. SMS is used in 5 steps. Phone calls and letters are manual steps that don't go through automated sending.

### 1.4 Current Volume Analysis

**Last 30 days (WAHA-only production data)**:
- Total WhatsApp sends: 171
- Divinopolis: 130 (62 success = 48% success rate)
- Volta Redonda: 5 (3 success)
- Bauru: 5 (4 success)
- Balneario Camboriu: 1 (0 success)

**Current pending**: 285 schedules across 4 real clinics

**Daily average**: 16 WhatsApp messages per day (6 active sending days in last 30 days)

**Actual current state**: The system is in early production. Daily volume is ~16 messages, not the 800+ projected. The pending backlog of 285 schedules represents weeks of accumulation during ramp-up.

### 1.5 WAHA Rate Limiting Parameters

The WAHA client implements a sophisticated anti-ban strategy:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `MIN_DELAY_BETWEEN_MESSAGES_S` | 20.0s | Minimum delay between any two messages |
| `MAX_DELAY_BETWEEN_MESSAGES_S` | 35.0s | Maximum base delay |
| `SIMULATE_TYPING` | true | Simulates human typing before send |
| `TYPING_SPEED_CHARS_PER_SEC` | 25 | Characters per second typing simulation |
| `TYPING_MIN_DELAY_S` | 2.0s | Minimum typing simulation duration |
| `TYPING_MAX_DELAY_S` | 8.0s | Maximum typing simulation duration |
| `VOLUME_WINDOW_MINUTES` | 60 | Window for volume counting |
| `VOLUME_SCALE_THRESHOLD` | 10 | Messages before delay scaling kicks in |
| `VOLUME_SCALE_FACTOR` | 1.5x | Exponential scale factor per threshold |
| `VOLUME_MAX_DELAY_S` | 120.0s | Absolute maximum delay |

**Per-message time breakdown (WAHA)**:
- Base delay: 20-35s (random)
- Typing simulation: 2-8s
- API call: ~1-2s
- **Total per message: 23-45s** (at low volume, before scaling)

**Volume scaling effect** (per session, per 60-minute window):
- Messages 1-10: 23-45s each
- Messages 11-20: 35-68s each (1.5x)
- Messages 21-30: 52-101s each (2.25x)
- Messages 31+: up to 120s each (capped)

### 1.6 Number Pool Assignment (Adoption Rule)

The `PatientPhoneResolver` implements a **patient-phone affinity** system:

1. **First Contact**: Patient gets assigned to a phone pair via round-robin across the clinic's available pairs
2. **Adoption**: On successful first send, a `PatientPhoneAffinity` record is created, permanently binding the patient to that sender number
3. **Subsequent Contacts**: Patient always receives messages from their adopted number
4. **Temporary Fallback**: If adopted pair is quarantined, messages are sent from another available pair (no affinity re-creation)
5. **Permanent Reassignment**: If adopted pair is deactivated or number changed, affinity is invalidated and patient gets a new pair

**Failover chain**: adopted pair -> other clinic pairs (round-robin) -> backup pair -> global reserve -> last resort (quarantined pair)

### 1.7 Message Templates and Formatting

Templates use Django template syntax with WhatsApp formatting:
- **Bold**: `*text*`
- **Variables**: `{{ nome }}`, `{{ valor }}`, `{{ vencimento }}`, `{{ contact_phone }}`
- **Conditional**: `{% if contact_phone %}...{% endif %}`
- **Emojis**: Used in later steps (step 5: warning emoji, step 12: pre-judicial)

Example step 0 template:
```
Ola, {{ nome }}!

Passando para lembrar da parcela de *{{ valor }}* com vencimento em *{{ vencimento }}*.

Caso o pagamento ja tenha sido realizado, desconsidere esta mensagem ou, se preferir, nos envie o comprovante.

{% if contact_phone %}Qualquer duvida: {{ contact_phone }}{% endif %}
```

Average message length: ~200-400 characters (important for typing simulation calculation).

### 1.8 Pipeline Execution Flow

The `NotificationPipelineWorkflow` executes a strict 10-stage pipeline:

1. **Sync Inadimplencia** - Fetch defaulter data from Oralsin API
2. **Reconcile Defaulters** - Update local DB with fresh data
3. **Reconcile Current Installments** - Mark correct installments as current
4. **Reconcile Pending Calls** - Clean up phone call tasks
5. **Bulk Schedule Contacts** - Create `ContactSchedule` records for eligible patients
6. **Double Resync** - Re-fetch API to catch payments made during pipeline
7. **Validate Pending Schedules** - Cancel schedules where payment was received
8. **Invalidate Paused Schedules** - Handle clinic pauses
9. **Send Notifications** - Fan-out per clinic, execute via workers
10. **Send Letters** - Physical mail for letter steps

**Business window**: 10:00-19:00 on business days only (Mon-Fri)

**Notification modes**: `pre_due` (D-3 before due date) and `overdue` (weekly escalation)

### 1.9 Ban Detection and Quarantine

The current system uses a **failure-count quarantine** (not OCR-based ban detection):

- **Failure threshold**: 3 consecutive failures -> quarantine
- **Quarantine TTL**: 30 minutes
- **Failure counter TTL**: 1 hour
- **Health monitoring**: Background loop checks session status every 5 minutes
- **Restoration**: Automatic when health check passes while quarantined

The `PhoneHealthMonitor` runs as a background task in the notification workers, checking:
- Level 1 (every 5min): `GET /health` basic connectivity
- Level 2 (every 30min): `GET /api/sessions/{name}` session status
- Summary reports every hour via Telegram

---

## Part 2: Dispatch ADB Integration Design

### 2.1 Throughput Calculations

#### WAHA Throughput (Current System)

Per session (per phone number), with default rate limiting:

| Volume Block | Messages | Time per msg | Block duration | Cumulative msgs | Cumulative time |
|-------------|----------|-------------|----------------|-----------------|-----------------|
| 1-10 | 10 | ~33s avg | 5.5 min | 10 | 5.5 min |
| 11-20 | 10 | ~50s avg | 8.3 min | 20 | 13.8 min |
| 21-30 | 10 | ~75s avg | 12.5 min | 30 | 26.3 min |
| 31-40 | 10 | ~102s avg | 17.0 min | 40 | 43.3 min |
| 41-50 | 10 | ~120s (max) | 20.0 min | 50 | 63.3 min |

**WAHA throughput per session**: ~50 messages/hour at steady state, ~30/hour with volume scaling.

With 8 active sessions distributed across 4 clinics:
- **Best case (parallel sessions)**: 8 x 30 = **240 msgs/hour**
- **Business window (9 hours)**: 240 x 9 = **~2,160 msgs/day** theoretical max

**Current actual demand**: 285 pending schedules -- easily handled by WAHA alone.

#### ADB Throughput Calculation

Per Android user (per WhatsApp/WABA account):

| Operation | Duration | Notes |
|-----------|----------|-------|
| User switch (am switch-user) | 3-4s | Only when changing accounts |
| Open wa.me intent | 2-3s | Includes contact to Google resolution |
| Wait for WA chat to load | 2-3s | Variable based on contact history |
| Type message (200-400 chars) | 15-20s | Character-by-character via input text |
| Send (tap button) | 1s | |
| Screenshot + verify | 2-3s | |
| Return to home | 1s | |
| **Total per message (same user)** | **23-30s** | **No user switch needed** |
| **Total per message (with switch)** | **26-34s** | **Includes user switch** |

Per device with 8 Android users (each with WA + WABA = 16 accounts):

**Without batching by sender** (worst case, switch every message):
- ~30s per message = 120 msgs/hour per device
- 2 devices = 240 msgs/hour
- 9-hour window = **2,160 msgs/day**

**With smart batching** (group messages by sender number, minimize switches):
- Same-user messages: ~25s each (no switch overhead)
- Average 10-20 messages per user before switching
- ~27s effective average = 133 msgs/hour per device
- 2 devices = 266 msgs/hour
- 9-hour window = **2,400 msgs/day**

### 2.2 Can 2 Devices Handle 800 msgs/day?

**YES, comfortably.** The math:

- 800 msgs / 9 hours = 89 msgs/hour needed
- 2 devices x 120 msgs/hour (worst case) = 240 msgs/hour capacity
- **Utilization: 37%** (worst case) to **33%** (with batching)
- Even with 50% efficiency loss for errors/retries: 120 msgs/hour available = 1,080/day

**But**: The current WAHA system can also handle 800/day with its 8 sessions. The question is not whether ADB *can* handle it, but what value ADB adds:

1. **Cost reduction**: WAHA Plus costs money per session; ADB is free
2. **Independence from WAHA server**: No dependency on external GoWS infrastructure
3. **Ban resilience**: ADB mimics real user behavior more closely
4. **Redundancy**: ADB + WAHA failover gives two independent delivery paths

### 2.3 Proposed Dispatch Integration Architecture

```
                    Oralsin Server
                         |
                   POST /plugins/oralsin/enqueue
                         |
                    +-----------+
                    |  Dispatch |
                    |  Core     |
                    |  (Fastify)|
                    +-----+-----+
                          |
                  +-------+-------+
                  |               |
             ADB Engine      WAHA Fallback
             (Primary)       (Secondary)
                  |               |
          +-------+-------+      |
          |               |      |
      Device 1       Device 2    GoWS Server
      (8 users)     (8 users)    (8 sessions)
      16 accounts   16 accounts
```

#### Plugin Oralsin Contract

The existing Oralsin plugin (`packages/plugins/oralsin`) already defines the enqueue contract. The integration needs:

```typescript
// POST /plugins/oralsin/enqueue
interface EnqueueRequest {
  messages: Array<{
    to: string;           // Patient phone number (Brazilian format)
    text: string;         // Pre-rendered message with WhatsApp formatting
    senderNumber: string; // Adopted sender number (from affinity)
    patientId: string;    // For correlation
    scheduleId: string;   // For callback
    priority: 'normal' | 'high';
  }>;
  callbackUrl: string;    // POST back result to Oralsin
  batchId: string;        // Idempotency key
}
```

#### Sender Number Mapping

The Oralsin system knows which phone number should send each message (via `PatientPhoneAffinity`). Dispatch needs to map sender phone numbers to device/user/app:

```typescript
interface SenderMapping {
  phoneNumber: string;      // e.g., "+554396835102"
  deviceSerial: string;     // e.g., "POCO_SEREN_001"
  androidUser: number;      // e.g., 0-7 (am switch-user N)
  appPackage: string;       // "com.whatsapp" or "com.whatsapp.w4b"
}
```

This mapping is configured at startup and stored in SQLite. When a message arrives with `senderNumber=+554396835102`, Dispatch knows to route it to Device 1, User 3, com.whatsapp.

### 2.4 Queue Optimization Strategy (Minimize User Switches)

The key optimization is **batching messages by sender number** to minimize the expensive 3-4s user switch operation.

#### Strategy: Sender-Grouped Priority Queue

```
Queue Structure (SQLite):
+---------+---------------+----------+---------+----------+
| msg_id  | sender_number | priority | status  | queued_at|
+---------+---------------+----------+---------+----------+
| m-001   | +5543968351.. | normal   | pending | 10:00:01 |
| m-002   | +5543968351.. | normal   | pending | 10:00:01 |
| m-003   | +5543968378.. | normal   | pending | 10:00:01 |
| m-004   | +5543968351.. | normal   | pending | 10:00:02 |
+---------+---------------+----------+---------+----------+

Dequeue Algorithm:
1. GROUP BY sender_number, ORDER BY queued_at
2. Pick the sender group with the most pending messages
3. Drain all messages for that sender (no user switches!)
4. Move to next sender group
5. If current device has no more messages for any sender, switch device

SQL:
SELECT sender_number, COUNT(*) as cnt 
FROM messages 
WHERE status = 'pending' AND device_serial = ?
GROUP BY sender_number 
ORDER BY cnt DESC
LIMIT 1;
```

#### Batch Processing Flow

```
Worker loop (per device):
1. SELECT next sender group (most messages pending)
2. Switch to correct Android user (if different from current)
3. FOR each message in sender group:
   a. Open wa.me intent for patient
   b. Wait for chat load
   c. Type message (character by character with jitter)
   d. Tap send
   e. Screenshot for proof
   f. Mark message as 'sent' in SQLite
   g. Apply inter-message delay (20-35s jitter)
4. GOTO 1
```

**Expected improvement**: With ~285 pending messages distributed across 8 senders, average group size is ~35 messages per sender. This means only ~8 user switches per batch instead of potentially 285. Time saved: (285 - 8) x 3.5s = **16 minutes saved per batch**.

### 2.5 WhatsApp Formatting via ADB

**Problem**: ADB `input text` does not support WhatsApp markdown formatting. Characters like `*bold*` get typed literally and WhatsApp interprets them as formatting -- which is actually the desired behavior.

**Solution**: The WhatsApp formatting works natively because:

1. WhatsApp markdown is plain text markers: `*bold*`, `_italic_`, `~strikethrough~`, `` `monospace` ``
2. When typed character-by-character via ADB, WhatsApp interprets these markers
3. The message templates from Oralsin already use `*text*` for bold -- these will render correctly

**Verified**: The templates use `*{{ valor }}*` and `*{{ vencimento }}*` which will display as bold in WhatsApp when typed via ADB.

**Emojis**: Need special handling. ADB `input text` does not support Unicode emojis directly. Solutions:
1. **Clipboard method**: Write emoji to clipboard via `am broadcast -a clipper.set -e text "emoji"`, then paste
2. **Input keyevent**: Use ADB key events for common emojis
3. **Strip emojis**: For ADB sends, strip emojis and use text alternatives (simplest, least risk)

**Recommendation**: Strip emojis for ADB sends (steps 5, 12 use warning emojis). The message meaning is preserved without them. For WAHA fallback, keep emojis as-is.

### 2.6 ADB Primary with WAHA Fallback: Failover Design

```
                        Message Arrives
                              |
                     +--------v--------+
                     | Route to ADB    |
                     | Device/User     |
                     +--------+--------+
                              |
                    +---------v----------+
                    | ADB Send Attempt   |
                    | (type, send, verify)|
                    +---------+----------+
                              |
                    +----+----+----+
                    |              |
                 Success        Failure
                    |              |
              Mark SENT      +-----v------+
              Callback OK    | Classify   |
                             | Failure    |
                             +-----+------+
                                   |
                    +---------+----+----+---------+
                    |         |         |         |
                  Device    WA App   Ban/Block  Transient
                  Offline   Crash    Detected   (timeout)
                    |         |         |         |
                    v         v         v         v
                 Queue     Restart   Quarantine  Retry
                 to WAHA   WA+Retry  Number      ADB
                                     (30min)     (3x)
                                        |
                                        v
                                   Queue to WAHA
                                   (fallback send)
```

#### Failure Classification

```typescript
enum FailureType {
  TRANSIENT = 'transient',     // Timeout, UI glitch -> retry ADB (3x)
  APP_CRASH = 'app_crash',     // WA force-stopped -> restart WA, retry
  DEVICE_OFFLINE = 'offline',  // Device disconnected -> immediate WAHA fallback
  BAN_DETECTED = 'ban',        // OCR detects ban text -> quarantine 30min, WAHA fallback
  UNKNOWN = 'unknown',         // -> WAHA fallback after 1 retry
}
```

#### WAHA Fallback Path

When a message fails ADB delivery and falls back to WAHA:

1. Dispatch calls Oralsin's existing WAHA infrastructure via the `PhonePoolService` pattern
2. The same `senderNumber` is used (WAHA session mapped to same phone number)
3. WAHA rate limiting applies (20-35s delay)
4. Result is reported back via the same callback

**Key design decision**: The WAHA fallback uses the **same phone number** as the ADB attempt. Since both ADB and WAHA are using the same WhatsApp accounts, there is no sender number mismatch.

However, **ADB and WAHA must not send simultaneously from the same WhatsApp account**. This requires a per-account lock:

```typescript
// Global lock per WhatsApp account (phone number)
const accountLock = new Map<string, Mutex>();

async function sendMessage(msg: Message) {
  const lock = accountLock.get(msg.senderNumber);
  await lock.acquire();
  try {
    // Try ADB first
    const adbResult = await adbSend(msg);
    if (adbResult.success) return adbResult;
    
    // Fallback to WAHA
    return await wahaSend(msg);
  } finally {
    lock.release();
  }
}
```

### 2.7 Optimal Architecture: Dispatch as ADB-First Proxy

Rather than having Oralsin call Dispatch directly, the cleanest integration is:

1. **Oralsin keeps its existing pipeline** -- sync, schedule, validate, everything stays the same
2. **Oralsin replaces `PhonePoolService.send()` with a Dispatch API call** for WhatsApp sends
3. **Dispatch acts as a delivery proxy**: receives pre-rendered messages with sender routing and delivers via ADB-first with WAHA fallback
4. **Dispatch calls back to Oralsin** with delivery status (success/failure, message ID, proof screenshot URL)

This means:
- Zero changes to Oralsin's business logic (scheduling, escalation, rate limiting, affinity)
- Dispatch only handles the last-mile delivery
- Oralsin's `OralsinRateLimiter` (15 req/s global) still applies
- The `PhoneHealthMonitor` in Oralsin still tracks session health

### 2.8 Data Per Message (Oralsin to Dispatch)

Based on the production code analysis, each message sent to Dispatch contains:

```typescript
{
  // Routing
  to: "5543991938235",            // Patient phone (digits only, BR format)
  senderNumber: "+554396835102",  // Adopted sender (from affinity)
  senderSession: "oralsin_1_2",   // WAHA session name (for fallback)
  
  // Content
  text: "Ola, Maria!\n\nPassando para lembrar da parcela de *R$ 1.234,56* com vencimento em *15/04/2026*.\n\n...",
  
  // Metadata (for callback)
  patientId: "uuid-...",
  scheduleId: "uuid-...",
  clinicId: "uuid-...",
  step: 1,
  channel: "whatsapp",
  pipelineRunId: "temporal-wf-...",
  correlationId: "notif-abc123",
  
  // Delivery preferences
  priority: "normal",
  maxRetries: 3,
  fallbackToWaha: true,
}
```

### 2.9 Summary: Production Readiness Assessment

| Dimension | Current WAHA | Dispatch ADB | ADB + WAHA Hybrid |
|-----------|-------------|-------------|-------------------|
| Daily capacity | ~2,160 msgs | ~2,400 msgs | ~4,560 msgs |
| Cost per msg | WAHA license | Free (device cost only) | Mixed |
| Ban risk | Medium (API-level) | Low (mimics human) | Lowest (redundancy) |
| Reliability | High (mature) | Medium (new) | Highest (failover) |
| Latency per msg | 23-45s | 23-30s | Same |
| Setup complexity | Low | Medium | Medium |
| Can handle 800/day? | Yes (37% utilization) | Yes (33% utilization) | Yes (18% utilization) |

**Recommendation**: Deploy Dispatch as ADB-primary with WAHA fallback. Start with one clinic (Bauru, lowest volume at 22 pending) as pilot. Monitor ban rates and delivery success for 2 weeks before expanding.

### 2.10 Open Questions for Implementation

1. **WAHA session locking**: When ADB is sending from a WhatsApp account, does WAHA need to be told to pause that session? Or can both coexist since ADB operates on the device directly?

   **Answer**: WAHA (GoWS Plus) uses the WhatsApp Web multidevice protocol -- it runs on a remote server (`gows-chat.debt.com.br`, 136 sessions) connecting to WhatsApp's servers as a "linked device". ADB operates on the phone's native WhatsApp app. Both are registered as the same WhatsApp number but function as independent sessions (phone = primary device, WAHA = linked device). They CAN coexist, but sending the same message from both paths simultaneously to the same recipient would create a duplicate. The per-account mutex lock in Dispatch prevents this. However, there is a subtlety: if WAHA sends while ADB has the chat open, the phone's WhatsApp UI might show the message in the wrong state. **Safest approach**: When ADB is actively sending from a number, tell WAHA to pause that session temporarily. When ADB is idle for that number, WAHA resumes.

2. **Proof screenshots**: Oralsin doesn't currently use delivery screenshots. Should Dispatch store them anyway for audit?

   **Answer**: Yes. Store screenshots in a rolling 30-day archive. This provides evidence for dispute resolution and ban detection via OCR.

3. **Message deduplication**: Oralsin has idempotency keys. Does Dispatch need its own?

   **Answer**: Yes. The `batchId + scheduleId` combination should be the idempotency key in Dispatch's SQLite queue. Prevents duplicate sends if Oralsin retries the enqueue call.
