# Dispatch Operational Hardening v2 — Design Spec

> **Author:** Matheus Munhoz + Claude Opus 4.6
> **Date:** 2026-04-08
> **Status:** APPROVED
> **Scope:** 5 phases, 20 tasks — observability, resilience, optimization, features
> **Prerequisite:** Anti-Ban & Scaling branch (`feat/anti-ban-scaling`) merged

---

## 1. Problem Statement

The DEBT ADB Framework (Dispatch) has completed all 8 development phases and the anti-ban scaling
initiative. The system sends WhatsApp messages via ADB automation on rooted Android devices. It works,
but it operates blind — the operator cannot see what's happening inside the pipeline, cannot
auto-regulate volume based on risk signals, and cannot visualize system health without reading logs.

**Six axes of improvement identified:**

1. **Observability** — No structured metrics, no Prometheus, no Grafana. The only signal is JSON logs.
2. **Auditability** — No trace of which strategy was used per message, no audit log for config changes.
3. **Resilience** — SenderHealth is volatile (lost on restart), no send window, no sender warmup.
4. **Optimization** — Screenshots consume 10GB/month, contact lookups are O(N) per message.
5. **Features** — No media sending, no opt-out detection, no pause/resume per sender.
6. **Architecture** — server.ts is 841 lines with 25 responsibilities. Dead code from Phase 3 persists.

---

## 2. Architecture — Layered Approach

Each phase builds on the previous. Instrumenting a messy system is waste — clean the foundation first,
then instrument, then build intelligence on the data, then visualize, then optimize.

### Phase Dependency Graph

```
Phase 1 (Foundation) ──────────────────┐
    │                                   │
    ├──► Phase 2 (Instrumentation) ────┤
    │         │                         │
    │         ├──► Phase 3 (Operational Intelligence)
    │         │         │
    │         └──► Phase 4 (Visual Observability)
    │                   │
    └──► Phase 5 (Optimization + Features) ◄── Phase 3
```

**Rule:** Each phase starts only after the previous is APPROVED.
Phase 5 depends on Phase 3 (uses warmup and send window internally).

### Phase Summary

| Phase | Name | Tasks | Delivery |
|-------|------|-------|----------|
| 1 | Foundation | 5 | Clean worker, validated config, persisted state, no dead code |
| 2 | Instrumentation | 4 | Per-message trace, audit log, Prometheus metrics, enriched events |
| 3 | Operational Intelligence | 4 | Send window, sender warmup, pause/resume, circuit breaker |
| 4 | Visual Observability | 3 | Sender dashboard, metrics + Grafana embed, toast alerts |
| 5 | Optimization + Features | 4 | Screenshot management, contact cache, opt-out detection, media |

**Total: 20 tasks, 5 phases.**

---

## 3. Current System Inventory

### Codebase Metrics

| Metric | Value |
|--------|-------|
| Total implementation LOC | ~9,618 |
| server.ts LOC | 841 |
| Test files | 45 |
| Test cases | 485 |
| SQLite tables | 12 |
| API endpoints | 58 |
| Event types | 14 |
| Environment variables | 17+ |
| Test coverage (files) | 70% (38/54 implementation files) |

### Module Map

```
packages/core/src/
├── server.ts              (841 LOC — orchestration, routes, worker, WAHA, plugins)
├── adb/                   (88 LOC — adbkit wrapper)
├── api/                   (2,453 LOC — 12 route handler files, 58 endpoints)
├── engine/                (1,615 LOC — send pipeline, rate limiting, retry, health)
├── queue/                 (502 LOC — SQLite message queue with lock management)
├── monitor/               (634 LOC — device discovery, health, alerts, WA accounts)
├── waha/                  (705 LOC — webhook handler, session manager, history)
├── chatwoot/              (391 LOC — CRM integration, inbox automation)
├── plugins/               (1,000 LOC — registry, loader, event bus, callbacks)
├── config/                (194 LOC — logger, graceful shutdown, rate limits)
├── events/                (36 LOC — typed EventEmitter)
└── http-utils.ts          (14 LOC — shared HTTP utilities)
```

### Database Schema (12 tables)

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| messages | Core send queue | id, to_number, status, sender_number, strategy, attempts |
| contacts | Device contact cache | phone, name |
| alerts | Health/ban alerts | device_serial, severity, type, resolved |
| pending_correlations | ADB→WAHA receipt matching | message_id, waha_message_id |
| devices | Discovered devices | serial, brand, model, status |
| health_snapshots | Time-series device health | serial, battery, temp, ram, storage |
| whatsapp_accounts | WA accounts per profile | device_serial, profile_id, phone_number |
| sender_mapping | Phone→device routing | phone_number, device_serial, profile_id, app_package |
| message_history | WAHA dedup + history | message_id, direction, from/to, waha_message_id |
| managed_sessions | WAHA↔Chatwoot pairing | session_name, chatwoot_inbox_id |
| plugins | Plugin config | name, webhook_url, api_key, hmac_secret, events |
| failed_callbacks | Callback retry queue | plugin_name, message_id, attempts, last_error |

---

## 4. Phase 1: Foundation

**Objective:** Clean the base before instrumenting. Without this, instrumentation builds on sand.

**Rationale:** server.ts has 841 lines with 25 mixed responsibilities. SenderHealth lives in memory
(loses state on restart). 17 env vars with no validation — server starts silently with wrong defaults.
Legacy dispatcher code never called. Each new feature adds debt without this cleanup.

### T1.1: Extract WorkerOrchestrator from server.ts

**Problem:** The worker loop (lines 612-741) contains rate limiting, quarantine check, user switch,
batch processing, delay logic, WAHA fallback, health tracking — all in a closure inside `setInterval`.
Impossible to unit test.

**Solution:** Extract to `packages/core/src/engine/worker-orchestrator.ts`:

```
WorkerOrchestrator
├── tick()                    → called every 5s by setInterval
├── selectDeviceAndDequeue()  → device selection + dequeueBySender
├── checkGates()              → rate limit cap + quarantine + capped cooldown
├── switchProfile()           → am switch-user with polling
├── processBatch()            → loop with processMessage + delay
└── recordHealth()            → success/failure → SenderHealth
```

server.ts keeps ~15 lines for the worker:
```typescript
const orchestrator = new WorkerOrchestrator({ queue, engine, senderMapping, ... })
const workerInterval = setInterval(() => orchestrator.tick(), 5_000)
```

Also extract `processMessage` (lines 557-610) into the orchestrator.

**Result:** server.ts drops from 841 → ~550 lines. WorkerOrchestrator: ~300 lines, testable.

### T1.2: Config Validation at Startup (fail-fast)

**Problem:** If `DISPATCH_API_KEY` is undefined, server starts without authentication (returns 401
for everything). If `WAHA_API_URL` is wrong, fails silently on webhooks.

**Solution:** `packages/core/src/config/config-schema.ts` with Zod:

```typescript
const DispatchConfigSchema = z.object({
  port: z.coerce.number().default(7890),
  apiKey: z.string().min(1, 'DISPATCH_API_KEY is required'),
  dbPath: z.string().default('dispatch.db'),
  wahaApiUrl: z.string().url().optional(),
  // ... all 17+ env vars with types, defaults, and error messages
})
```

Also generate `.env.example` with all variables documented.

### T1.3: Persist SenderHealth in SQLite

**Problem:** Restart = lose quarantine = re-try sender that was banned = re-ban.

**Solution:** Table `sender_health`:

```sql
CREATE TABLE sender_health (
  sender_number TEXT PRIMARY KEY,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  quarantined_until TEXT,
  last_failure_at TEXT,
  last_success_at TEXT,
  total_failures INTEGER NOT NULL DEFAULT 0,
  total_successes INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
```

SenderHealth class reads/writes DB instead of in-memory Maps. Hot path stays fast
(SQLite WAL, single row PK lookup).

Bonus: `total_failures` and `total_successes` give historical data for metrics (Phase 2).

### T1.4: Clean Dead Code and Consolidate Rate Limiters

**Problem:** `Dispatcher.selectSender()` (engine/dispatcher.ts) never called — residue from
Temporal.io architecture. Two modules named "rate limit" confuse developers.

**Solution:**
- Remove `Dispatcher` class (keep `selectDevice()` and `computeHealthScore()` as standalone functions)
- Rename `engine/rate-limiter.ts` → `engine/pair-rate-limiter.ts`
- Update imports and barrel exports
- Remove dead types from `engine/types.ts` (`SendPhase`, `RateLimitStore`, `SenderState`)

### T1.5: WorkerOrchestrator Integration Tests

**Problem:** server.ts has 1 test. The worker loop — the system's heart — has zero coverage.

**Solution:** `worker-orchestrator.test.ts` with scenarios:
- Worker dequeue + send + success → status=sent
- Worker with sender at daily cap → requeue without attempts++
- Worker with sender quarantined → skip batch
- Worker with device offline → skip without crash
- Worker with capped cooldown → silent skip within 60s
- Worker with user switch failure → requeue batch
- processMessage ADB fail → WAHA fallback → success
- processMessage ADB+WAHA fail → permanently_failed + senderHealth.recordFailure

**Target:** ≥15 tests covering the 8 branches of the worker loop.

### Phase 1 Internal Dependencies

```
T1.4 (cleanup) ──► T1.1 (refactor worker) ──► T1.5 (tests)
                                    │
T1.2 (config) ─────────────────────►│
T1.3 (persist health) ─────────────►│
```

---

## 5. Phase 2: Instrumentation

**Objective:** Make the system observable. Without structured data, it's impossible to know if
anti-ban features work or to detect degradation before it becomes an incident.

**Theory:** Observability rests on 3 pillars — **metrics** (aggregated counters/gauges/histograms),
**traces** (events per request), and **logs** (already have via pino JSON). Phase 2 adds the two
missing pillars. Model inspired by OpenTelemetry without importing the library — the system is
small enough for manual instrumentation with prom-client.

### T2.1: End-to-End Message Trace (message_events)

**Problem:** A message enters POST /messages and exits via WhatsApp. If it failed, the only data
is `status=failed` + a JSON log lost among thousands. No way to reconstruct: which strategy?
How much delay? How many dialogs? Was the contact new? How long did each step take?

**Solution:** Table `message_events` with append-only events per message:

```sql
CREATE TABLE message_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL REFERENCES messages(id),
  event TEXT NOT NULL,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_message_events_msg ON message_events(message_id);
```

**Instrumentation points in SendEngine:**

| Step | Event | Metadata |
|------|-------|----------|
| send() start | strategy_selected | {method, app_package} |
| ensureScreenReady() | screen_ready | {wake_sent: true} |
| ensureCleanState() | clean_state | {force_stopped: app_package} |
| ensureContact() | contact_resolved | {registered: bool, name} |
| Chat opened | chat_opened | {method, dialog_count} |
| typeMessage() / prefill | message_composed | {typed: bool, prefill: bool, body_length} |
| tapSendButton() | send_tapped | {} |
| Screenshot saved | screenshot_saved | {path, size_bytes} |
| Worker delay | inter_message_delay | {delay_ms, is_first_contact} |

**Implementation:** SendEngine receives an optional `EventRecorder` in constructor. The recorder
does INSERT into the table. If not provided (tests), it's a no-op. ~5-8 inserts per message,
all within the same WAL transaction — impact < 1ms.

**API:** `GET /api/v1/messages/:id/trace` returns the ordered event array.

### T2.2: Operational Audit Log

**Problem:** Sender mapping created, plugin disabled, API key rotated — none leave a trace.
If something changes and the system starts failing, no way to correlate.

**Solution:** Table `audit_log`:

```sql
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL DEFAULT 'api',
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  before_state TEXT,
  after_state TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_audit_log_resource ON audit_log(resource_type, resource_id);
CREATE INDEX idx_audit_log_time ON audit_log(created_at);
```

**Instrumentation points:** Intercept in API routes:
- POST/PUT/DELETE /sender-mapping → log before/after
- PATCH /admin/plugins/:name → log enable/disable
- POST /admin/plugins/:name/rotate-key → log rotation (without logging the key)
- POST /devices/:serial/reboot → log destructive action
- POST /devices/:serial/restart-whatsapp → log destructive action

**API:** `GET /api/v1/audit` with filters by resource_type, action, date_range. Paginated.

### T2.3: Prometheus Metrics (prom-client)

**Problem:** Without aggregated metrics, the operator needs to count log lines to know throughput,
latency, failure rate. Grafana without Prometheus doesn't work.

**Solution:** Endpoint `GET /metrics` using prom-client:

**Counters (monotonic):**
- `dispatch_messages_sent_total` labels: sender, method, app_package
- `dispatch_messages_failed_total` labels: sender, error_type
- `dispatch_messages_queued_total` labels: plugin
- `dispatch_quarantine_events_total` labels: sender

**Histograms (distribution):**
- `dispatch_send_duration_seconds` labels: method, buckets: [5,10,15,20,30,45,60]
- `dispatch_inter_message_delay_seconds` labels: is_first_contact

**Gauges (instantaneous):**
- `dispatch_queue_depth`
- `dispatch_sender_daily_count` labels: sender
- `dispatch_devices_online`
- `dispatch_sender_quarantined` labels: sender

**Dependency:** prom-client (npm, 0 deps, 50KB).

### T2.4: Event Enrichment

**Problem:** The `message:sent` event doesn't include which strategy was used, which app_package,
or the delay applied. Events are the base for Socket.IO (UI) and plugins (callbacks) — without
rich data, consumers are blind.

**Solution:** Enrich existing event payloads:

```typescript
// message:sent — add:
{ strategyMethod, appPackage, isFirstContact, interMessageDelayMs }

// message:failed — add:
{ attempts, wasQuarantined, lastStrategyMethod }

// New events:
'sender:quarantined' → { sender, failureCount, quarantinedUntil }
'sender:released'    → { sender, quarantineDurationActualMs }
```

### Phase 2 Internal Dependencies

```
T2.1 (message trace) ───────────────────┐
                                         ├──► T2.4 (event enrichment)
T2.2 (audit log) ───────────────────────►│
T2.3 (Prometheus metrics) ──────────────►│
```

T2.1, T2.2, T2.3 are independent (parallelizable). T2.4 depends on all three.

---

## 6. Phase 3: Operational Intelligence

**Objective:** Use instrumentation data (Phase 2) to make automatic decisions that reduce ban risk
and operational burden. System moves from reactive to proactive.

**Theory:** The main WhatsApp ban vectors are: anomalous volume at atypical hours, new sender with
high volume from day 1, and sender with consecutive failures that keeps trying. Each task in this
phase eliminates one of these vectors.

### T3.1: Send Window — Business Hours Only

**Problem:** Worker processes 24/7. Sending 150 messages at 3 AM is the most obvious automation
signal. Real humans send between ~7h and ~21h.

**Solution:** `packages/core/src/engine/send-window.ts`:

```typescript
export class SendWindow {
  isOpen(): boolean
  nextOpenAt(): Date
  msUntilOpen(): number
}
```

**Integration:** First check in WorkerOrchestrator.tick(). If closed, log once per minute
and return without dequeue.

**Env vars:** SEND_WINDOW_START=7, SEND_WINDOW_END=21, SEND_WINDOW_DAYS=1,2,3,4,5,
SEND_WINDOW_UTC_OFFSET=-3

**Edge case:** Messages queued outside window stay `queued` until window opens. Not discarded.

### T3.2: Sender Warmup — Progressive Volume

**Problem:** New sender can send 150 msgs/day on day 1. For WhatsApp, an account that never sent
messages suddenly sending 150 in 8 hours is a strong anomaly.

**Solution:** Table `sender_warmup` with progressive tiers:

| Tier | Days since activation | Daily cap | Delay between msgs |
|------|----------------------|-----------|-------------------|
| 1 | 0-2 | 20 | 60s (first-contact: 90s) |
| 2 | 3-6 | 50 | 45s (first-contact: 60s) |
| 3 | 7-13 | 100 | 30s (first-contact: 45s) |
| 4 | 14+ | 150 (normal cap) | 15s (first-contact: 45s) |

**Integration:** RateLimitGuard.canSend() consults the sender's tier. Warmup does NOT replace
the guard — it adjusts maxPerSenderPerDay based on tier. Composition, not substitution.

**Override:** POST /api/v1/senders/:phone/skip-warmup for migrated senders with history.

### T3.3: Pause/Resume Sender via API

**Problem:** Operator notices a sender with strange behavior. Today the only option is deactivating
the sender_mapping entirely (active=0). No temporary pause that preserves config.

**Solution:** Add `paused`, `paused_at`, `paused_reason` fields to sender_mapping.

**API:**
- POST /api/v1/senders/:phone/pause { reason }
- POST /api/v1/senders/:phone/resume
- GET /api/v1/senders/status → all senders with dailyCount, tier, paused, quarantined

**Integration:** WorkerOrchestrator checks senderProfile.paused after resolving profile.

### T3.4: Device Circuit Breaker

**Problem:** If device disconnects during a batch of 50 messages, each message tries ADB
individually, fails, tries WAHA fallback. 50 unnecessary failure cycles when the cause is
one — device offline.

**Solution:** `packages/core/src/engine/device-circuit-breaker.ts`:

```typescript
export class DeviceCircuitBreaker {
  // closed → normal | open → fail-fast | half-open → probe
  recordSuccess(): void
  recordFailure(): void
  canExecute(): boolean
  getState(): 'closed' | 'open' | 'half-open'
}
```

**Parameters:** failureThreshold=3, resetTimeoutMs=30000, halfOpenMaxCalls=1

**Difference from SenderHealth:** SenderHealth is per sender (WhatsApp account). CircuitBreaker
is per device (hardware). A device can have 4 senders — if device is down, all stop.

### Phase 3 Internal Dependencies

```
T3.1 (send window) ──────────────────┐
T3.2 (sender warmup) ────────────────┤  All independent, parallelizable
T3.3 (pause/resume) ─────────────────┤  All depend on F1 + F2
T3.4 (circuit breaker) ──────────────┘
```

---

## 7. Phase 4: Visual Observability

**Objective:** Transform raw data from Phases 2-3 into visual dashboards embedded in the React UI.
Operator opens Dispatch and sees everything — no terminal, curl, or log reading needed.

**Architecture Decision: Hybrid approach.**
- **Native dashboards** (Recharts) for day-to-day operations: sender status, queue, devices
- **Grafana embed** (optional iframe) for deep analysis: historical trends, correlations
- System works 100% without Grafana. Grafana is optional upgrade for advanced analysis.

### T4.1: Sender Dashboard — Complete Operational View

New page `/senders` with SenderGrid component. One card per sender showing:
- Daily progress bar (87/150 today)
- Warmup tier and status (active/paused/quarantined)
- Strategy mix (52% prefill / 28% search / 20% typing)
- Last 5 message results
- Action buttons: Pause, View trace, Skip warmup

**Backend:** GET /api/v1/senders/status (from T3.3) returns consolidated array.
**Real-time:** Socket.IO events update cards without polling.

### T4.2: Metrics Dashboard — Recharts + Grafana Embed

Redesigned `/metrics` page with two tabs:

**Tab "Overview" (Recharts native):**
- Throughput chart (msgs/hour, last 24h)
- Counter cards (sent, failed, quarantines)
- Latency percentiles (p50/p90/p99)
- Strategy distribution pie chart

**Tab "Grafana" (iframe embed — optional):**
- iframe to Grafana kiosk mode at configurable URL
- Provisioned dashboards exported via GET /api/v1/grafana/dashboards
- docker-compose.yml with Prometheus + Grafana for easy setup

**Provisioned Grafana dashboards:**
1. Dispatch Overview — throughput, latency, success rate, queue depth
2. Sender Health — daily count per sender, quarantine events, warmup progression
3. Anti-Ban Fingerprint — strategy distribution, delay distribution
4. Device Health — battery, temp, RAM, storage trends

### T4.3: Visual Alerts + Toast Notifications

Toast notifications for critical events:

| Event | Toast | Severity |
|-------|-------|----------|
| sender:quarantined | "Sender quarantined — 3 consecutive failures" | warning |
| sender:released | "Sender released from quarantine" | info |
| sender:paused | "Sender paused by operator" | info |
| device:disconnected | "Device disconnected" | error |
| device:circuit_open | "Circuit breaker open — 3 failures" | error |
| Send window closed | "Send window closed (21:00). Next: 07:00" | info |
| Sender hit cap | "Sender hit 150/150 today" | warning |

Persistent header indicators: devices online, senders paused, quarantines active, queue depth,
send window status.

**Implementation:** useDispatchStatus() hook via Socket.IO + React context.

### Phase 4 Internal Dependencies

```
T4.1 (sender dashboard) ──────► T3.3 (sender status API) + T2.3 (Prometheus)
T4.2 (metrics dashboard) ─────► T2.1 (message trace) + T2.3 (Prometheus)
T4.3 (visual alerts) ─────────► T2.4 (event enrichment) + F3 (new events)
```

T4.1, T4.2, T4.3 are independent (parallelizable).

---

## 8. Phase 5: Optimization + Features

**Objective:** With clean foundation (F1), flowing data (F2), automatic decisions (F3), and
visualization (F4), now optimize performance and add features needed for real production scale.

### T5.1: Screenshot Management — Sampling, Compression, Retention

**Problem:** 280KB PNG per message × 1,200 msgs/day = 336MB/day = 10GB/month.

**Solution:** ScreenshotPolicy with three changes:

1. **Sampling:** mode='sampled', sampleRate=0.2 (20% of successes, 100% of failures)
2. **Compression:** PNG→JPEG via sharp (quality 60): 280KB → 35KB (87% reduction)
3. **Retention:** Delete files > 7 days via hourly cleanup job

**Impact:** 336MB/day → 10MB/day (97% reduction)

**Env vars:** SCREENSHOT_MODE, SCREENSHOT_SAMPLE_RATE, SCREENSHOT_FORMAT,
SCREENSHOT_JPEG_QUALITY, SCREENSHOT_RETENTION_DAYS

### T5.2: Contact Cache — Eliminate Repeated ADB Lookups

**Problem:** ensureContact() makes 1-2 ADB calls per message. Batch of 50 = 50 lookups even
for already-verified contacts. ~100ms × 50 = 5s wasted.

**Solution:** ContactCache with in-memory Map + TTL (1 hour default):

```typescript
export class ContactCache {
  isVerified(phone: string): boolean
  markVerified(phone: string): void
}
```

**Impact:** Batch of 50 to same contact: 1 ADB call instead of 50 = 4.9s saved.
Frequent contacts (Oralsin sends to same patients monthly): ~70% cache hit rate.

### T5.3: Response Detection + Automatic Blacklist

**Problem:** System sends and forgets. If recipient replies "PARE" (stop), "Não quero mais"
(don't want anymore), system continues sending in next campaigns. Complaints → ban.

**Solution:** Two components:

**OptOutDetector:** Regex patterns for Portuguese opt-out phrases:
- pare, parar, stop, cancelar
- remove, remova, tirar
- não quero, não envie, não mande
- bloquear, denunciar, reportar

**Blacklist table + integration:**

```sql
CREATE TABLE blacklist (
  phone_number TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  detected_message TEXT,
  detected_pattern TEXT,
  source_session TEXT,
  created_at TEXT NOT NULL
);
```

**Flow:** WAHA incoming → OptOutDetector → if matched: INSERT blacklist + emit contact:opted_out
**Gate:** MessageQueue.enqueue() checks blacklist before insert.
**API:** GET/POST/DELETE /api/v1/blacklist for management.

**Limitation:** Heuristic detector — false positives possible. Blacklist is reversible via API.

### T5.4: Media Sending — Images and PDFs via ADB

**Problem:** Oralsin wants to send payment slips (PDF) and QR codes (images). System only
supports text today.

**Solution:** Share Intent via ADB:

```typescript
await adb.push(deviceSerial, localPath, '/sdcard/Download/dispatch-media.jpg')
await adb.shell(deviceSerial,
  `am start -a android.intent.action.SEND -t image/jpeg ` +
  `--eu android.intent.extra.STREAM file:///sdcard/Download/dispatch-media.jpg ` +
  `-p ${appPackage}`)
```

**Schema expansion:**
```typescript
interface EnqueueParams {
  mediaUrl?: string       // URL to download file
  mediaType?: 'image/jpeg' | 'image/png' | 'application/pdf'
  mediaCaption?: string   // text accompanying the media
}
```

**Flow:** Worker downloads mediaUrl → adb push → am start ACTION_SEND → waitForChatReady → send

**Limitations:** No video support (different upload wait). Max 16MB (WhatsApp limit).
Share intent may trigger app chooser (handled by existing dismissDialogs).

### Phase 5 Internal Dependencies

```
T5.1 (screenshots) ──────────────┐
T5.2 (contact cache) ────────────┤  All independent, parallelizable
T5.3 (opt-out / blacklist) ──────┤  All depend on F1 + F2
T5.4 (media sending) ────────────┘
```

---

## 9. New Database Tables (Summary)

Phase 2-5 add 4 new tables to the existing 12:

| Table | Phase | Purpose |
|-------|-------|---------|
| message_events | F2 (T2.1) | Per-message trace events |
| audit_log | F2 (T2.2) | Operational change tracking |
| sender_warmup | F3 (T3.2) | Progressive volume tiers |
| blacklist | F5 (T5.3) | Opt-out recipients |

Modified tables:
- sender_mapping: +paused, +paused_at, +paused_reason (T3.3)
- sender_health: new table replacing in-memory Maps (T1.3)

---

## 10. New Environment Variables (Summary)

Phase 1-5 add ~12 new env vars to the existing 17+:

```bash
# Phase 1 — all existing vars get Zod validation + .env.example

# Phase 3 — Send Window
SEND_WINDOW_START=7
SEND_WINDOW_END=21
SEND_WINDOW_DAYS=1,2,3,4,5
SEND_WINDOW_UTC_OFFSET=-3

# Phase 4 — Grafana (optional)
VITE_GRAFANA_URL=http://localhost:3000

# Phase 5 — Screenshots
SCREENSHOT_MODE=sampled
SCREENSHOT_SAMPLE_RATE=0.2
SCREENSHOT_FORMAT=jpeg
SCREENSHOT_JPEG_QUALITY=60
SCREENSHOT_RETENTION_DAYS=7
```

---

## 11. New API Endpoints (Summary)

| Endpoint | Phase | Purpose |
|----------|-------|---------|
| GET /api/v1/messages/:id/trace | F2 | Message event timeline |
| GET /api/v1/audit | F2 | Operational audit log |
| GET /metrics | F2 | Prometheus metrics (OpenMetrics format) |
| GET /api/v1/senders/status | F3 | All senders with daily count, tier, status |
| POST /api/v1/senders/:phone/pause | F3 | Pause sender |
| POST /api/v1/senders/:phone/resume | F3 | Resume sender |
| POST /api/v1/senders/:phone/skip-warmup | F3 | Skip warmup to tier 4 |
| GET /api/v1/grafana/dashboards | F4 | Export provisioned Grafana dashboards |
| GET /api/v1/metrics/latency-percentiles | F4 | p50/p90/p99 from message_events |
| GET /api/v1/blacklist | F5 | List blacklisted recipients |
| POST /api/v1/blacklist | F5 | Manually blacklist recipient |
| DELETE /api/v1/blacklist/:phone | F5 | Remove from blacklist |

---

## 12. New npm Dependencies

| Package | Phase | Purpose | Size |
|---------|-------|---------|------|
| prom-client | F2 | Prometheus metrics | ~50KB, 0 deps |
| sharp | F5 | JPEG compression for screenshots | ~7MB (native, optional) |

---

## 13. Complete Task Reference

| Phase | Task | Name | Internal Deps | Phase Deps |
|-------|------|------|---------------|------------|
| F1 | T1.1 | Extract WorkerOrchestrator | T1.4 | — |
| F1 | T1.2 | Config validation (Zod) + .env.example | — | — |
| F1 | T1.3 | Persist SenderHealth in SQLite | — | — |
| F1 | T1.4 | Clean dead code + rename rate limiters | — | — |
| F1 | T1.5 | WorkerOrchestrator integration tests | T1.1 | — |
| F2 | T2.1 | Message trace (message_events) | — | F1 |
| F2 | T2.2 | Audit log | — | F1 |
| F2 | T2.3 | Prometheus metrics (prom-client) | — | F1 |
| F2 | T2.4 | Event enrichment | T2.1-2.3 | F1 |
| F3 | T3.1 | Send Window (business hours) | — | F2 |
| F3 | T3.2 | Sender Warmup (progressive volume) | — | F2 |
| F3 | T3.3 | Pause/Resume sender | — | F2 |
| F3 | T3.4 | Device Circuit Breaker | — | F2 |
| F4 | T4.1 | Sender Dashboard (React/Recharts) | — | T3.3 |
| F4 | T4.2 | Metrics Dashboard + Grafana embed | — | T2.1, T2.3 |
| F4 | T4.3 | Visual alerts + toast notifications | — | T2.4, F3 |
| F5 | T5.1 | Screenshot management | — | F1, F2 |
| F5 | T5.2 | Contact cache (in-memory TTL) | — | F1 |
| F5 | T5.3 | Response detection + blacklist | — | F2 |
| F5 | T5.4 | Media sending (images/PDFs via ADB) | — | F1 |
