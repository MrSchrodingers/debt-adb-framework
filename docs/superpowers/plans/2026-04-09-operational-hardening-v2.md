# Dispatch Operational Hardening v2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform Dispatch from a working-but-blind message sender into an observable, self-regulating, production-grade system across 5 layered phases: foundation cleanup, instrumentation, operational intelligence, visual observability, and optimization/features.

**Architecture:** Layered approach where each phase builds on the previous. Phase 1 cleans the codebase (extract WorkerOrchestrator, validate config, persist state). Phase 2 adds instrumentation (message trace, audit log, Prometheus). Phase 3 adds self-regulation (send window, warmup, circuit breaker). Phase 4 visualizes everything (Recharts dashboards, Grafana embed). Phase 5 optimizes and adds features (screenshot management, media sending, opt-out detection).

**Tech Stack:** Node.js 22, TypeScript strict, Vitest, better-sqlite3 WAL, prom-client, sharp (optional), Recharts, Socket.IO

**Spec:** `docs/superpowers/specs/2026-04-08-operational-hardening-v2-design.md`

---

## Dependency Graph

```
Phase 1 (Foundation) ───────────────────┐
    │                                    │
    ├───► Phase 2 (Instrumentation) ────┤
    │         │                          │
    │         ├───► Phase 3 (Operational Intelligence)
    │         │         │
    │         └───► Phase 4 (Visual Observability)
    │                   │
    └───► Phase 5 (Optimization + Features) ◄── Phase 3
```

## File Structure

### New files (Phase 1)
```
packages/core/src/
├── engine/
│   ├── worker-orchestrator.ts          ← NEW: extracted worker loop logic
│   ├── worker-orchestrator.test.ts     ← NEW: integration tests for worker
│   ├── pair-rate-limiter.ts            ← RENAME from rate-limiter.ts
│   └── pair-rate-limiter.test.ts       ← RENAME from rate-limiter.test.ts
├── config/
│   ├── config-schema.ts                ← NEW: Zod validation for all env vars
│   └── config-schema.test.ts           ← NEW: tests for config validation
└── .env.example                        ← NEW: documented env var template
```

### New files (Phase 2)
```
packages/core/src/
├── engine/
│   └── event-recorder.ts              ← NEW: message_events trace recorder
├── api/
│   └── trace.ts                       ← NEW: message trace endpoint
├── config/
│   └── metrics.ts                     ← NEW: Prometheus registry and metrics
└── middleware/
    └── audit-middleware.ts             ← NEW: audit log interceptor
```

### New files (Phase 3)
```
packages/core/src/
├── engine/
│   ├── send-window.ts                 ← NEW: business hours gate
│   ├── send-window.test.ts
│   ├── sender-warmup.ts               ← NEW: progressive volume tiers
│   ├── sender-warmup.test.ts
│   ├── device-circuit-breaker.ts      ← NEW: device failure circuit breaker
│   └── device-circuit-breaker.test.ts
└── api/
    └── senders.ts                     ← NEW: pause/resume/status endpoints
```

### New files (Phase 4)
```
packages/ui/src/
├── components/
│   ├── sender-dashboard.tsx           ← NEW: sender grid with status cards
│   ├── metrics-dashboard.tsx          ← NEW: Recharts metrics overview
│   ├── grafana-embed.tsx              ← NEW: optional Grafana iframe
│   └── toast-alerts.tsx               ← NEW: real-time toast notifications
├── hooks/
│   └── use-dispatch-status.ts         ← NEW: Socket.IO status hook
└── pages/
    └── senders.tsx                    ← NEW: /senders page
```

### New files (Phase 5)
```
packages/core/src/
├── config/
│   ├── screenshot-policy.ts           ← NEW: sampling/compression/retention
│   └── screenshot-policy.test.ts
├── engine/
│   ├── contact-cache.ts               ← NEW: in-memory TTL contact cache
│   ├── contact-cache.test.ts
│   ├── opt-out-detector.ts            ← NEW: regex-based opt-out detection
│   └── opt-out-detector.test.ts
└── api/
    └── blacklist.ts                   ← NEW: blacklist CRUD endpoints
```

---

## Phase 1: Foundation

### Task 1.4: Clean Dead Code + Rename Rate Limiters

**Why first:** Cleanup before refactor avoids moving dead code into new files.

**Files:**
- Modify: `packages/core/src/engine/dispatcher.ts`
- Rename: `packages/core/src/engine/rate-limiter.ts` to `packages/core/src/engine/pair-rate-limiter.ts`
- Rename: `packages/core/src/engine/rate-limiter.test.ts` to `packages/core/src/engine/pair-rate-limiter.test.ts`
- Modify: `packages/core/src/engine/types.ts`
- Modify: `packages/core/src/engine/index.ts`

- [ ] **1.4.1 Remove Dispatcher class from dispatcher.ts**

Keep only `computeHealthScore()` and `selectDevice()` as standalone functions. Remove the `Dispatcher` class entirely (contains unused `selectSender()`, `getNextDispatchTime()`, `isAllBanned()`). The file should export only `DispatchDecision` type and the two functions.

- [ ] **1.4.2 Remove dead types from types.ts**

Remove `SendPhase`, `SenderState`, and `RateLimitStore` from `packages/core/src/engine/types.ts`. Keep all other types (`RateLimitConfig`, `RetryConfig`, `BanDetectionConfig`, `CanSendResult`, `OcrAnalysis`, `BehavioralProbeResult`, `BanCountdown`, `CrashDetection`, `RecoveryResult`, and DEFAULT constants).

- [ ] **1.4.3 Rename rate-limiter.ts to pair-rate-limiter.ts**

```bash
git mv packages/core/src/engine/rate-limiter.ts packages/core/src/engine/pair-rate-limiter.ts
git mv packages/core/src/engine/rate-limiter.test.ts packages/core/src/engine/pair-rate-limiter.test.ts
```

Rename the class inside: `RateLimiter` to `PairRateLimiter`. Update the test import and describe block accordingly.

- [ ] **1.4.4 Update barrel exports in engine/index.ts**

Remove: `Dispatcher`, `RateLimiter`, `SendPhase`, `RateLimitStore`, `SenderState` exports.
Add: `PairRateLimiter` export.
Keep: `selectDevice`, `computeHealthScore`, `DispatchDecision`.

- [ ] **1.4.5 Verify no broken imports**

Search for any remaining imports of `Dispatcher` or `RateLimiter` (the old name) across the codebase and fix them.

- [ ] **1.4.6 Run all tests**

```bash
cd packages/core && npx vitest run
# Expected: 485+ tests pass
```

- [ ] **1.4.7 Commit**

```bash
git commit -m "refactor(engine): remove Dispatcher class, rename RateLimiter to PairRateLimiter

Removed dead Dispatcher class (selectSender, getNextDispatchTime, isAllBanned).
Kept standalone selectDevice() and computeHealthScore().
Renamed rate-limiter.ts to pair-rate-limiter.ts to distinguish from RateLimitGuard.
Removed dead types: SendPhase, SenderState, RateLimitStore."
```

---

### Task 1.2: Config Validation (Zod) + .env.example

**Files:**
- Create: `packages/core/src/config/config-schema.ts`
- Create: `packages/core/src/config/config-schema.test.ts`
- Create: `packages/core/.env.example`
- Modify: `packages/core/src/config/index.ts`
- Modify: `packages/core/src/server.ts`

- [ ] **1.2.1 Write config-schema.test.ts**

Tests for `parseConfig()`:
- Parses minimal valid config (only DISPATCH_API_KEY) with all defaults
- Throws if DISPATCH_API_KEY missing
- Throws if DISPATCH_API_KEY empty string
- Coerces PORT string to number
- Validates WAHA_API_URL as URL when provided
- Rejects invalid WAHA_API_URL
- Parses send window config (start, end, days, offset)
- Parses screenshot config (mode, sample_rate, format, retention)

- [ ] **1.2.2 Run test to verify it fails**

```bash
npx vitest run packages/core/src/config/config-schema.test.ts
# Expected: FAIL (module not found)
```

- [ ] **1.2.3 Implement config-schema.ts**

`parseConfig(env)` maps SCREAMING_SNAKE env var names to camelCase config properties via Zod schema. All 30+ env vars with types, ranges, defaults, and error messages. Uses `z.coerce.number()` for numeric strings, `z.string().url()` for URLs, `z.enum()` for constrained values.

Key: `DISPATCH_API_KEY` is `z.string().min(1)` (required, no default). Everything else has safe defaults.

- [ ] **1.2.4 Run tests**

```bash
npx vitest run packages/core/src/config/config-schema.test.ts
# Expected: 8+ tests PASS
```

- [ ] **1.2.5 Create .env.example**

Document every env var with sections (Core, WAHA, Chatwoot, Rate Limiting, Strategy Weights, Quarantine, Send Window, Screenshots, Logging, Plugins) and inline comments.

- [ ] **1.2.6 Add exports to config/index.ts**

Export `parseConfig` and `DispatchConfig` type.

- [ ] **1.2.7 Wire into server.ts startup**

Call `parseConfig(process.env)` at the top of `createServer()`. On invalid config, server crashes with descriptive Zod error. The config object is available throughout server initialization but the full migration of individual `process.env` reads is incremental.

- [ ] **1.2.8 Run all tests and commit**

```bash
cd packages/core && npx vitest run
git commit -m "feat(config): Zod config validation + .env.example"
```

---

### Task 1.3: Persist SenderHealth in SQLite

**Files:**
- Modify: `packages/core/src/engine/sender-health.ts`
- Modify: `packages/core/src/engine/sender-health.test.ts`
- Modify: `packages/core/src/queue/message-queue.ts`
- Modify: `packages/core/src/server.ts`

- [ ] **1.3.1 Add sender_health table to MessageQueue.initialize()**

```sql
CREATE TABLE IF NOT EXISTS sender_health (
  sender_number TEXT PRIMARY KEY,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  quarantined_until TEXT,
  last_failure_at TEXT,
  last_success_at TEXT,
  total_failures INTEGER NOT NULL DEFAULT 0,
  total_successes INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
```

- [ ] **1.3.2 Rewrite SenderHealth to use SQLite**

Constructor changes from `new SenderHealth(config?)` to `new SenderHealth(db, config?)`. Methods use SQL UPSERT (`INSERT ... ON CONFLICT DO UPDATE`) instead of Map operations. Add `getStatus(sender)` method returning `{ consecutiveFailures, quarantinedUntil, totalFailures, totalSuccesses }`.

- [ ] **1.3.3 Update sender-health.test.ts**

Replace in-memory tests with SQLite-backed tests. Each test creates an in-memory DB + calls `queue.initialize()`. Add new test: "persists across instances" (create two SenderHealth on same DB, verify quarantine visible from second instance).

- [ ] **1.3.4 Update constructor call in server.ts**

Change `new SenderHealth({...})` to `new SenderHealth(db, {...})`.

- [ ] **1.3.5 Run all tests and commit**

```bash
cd packages/core && npx vitest run
git commit -m "feat(engine): persist SenderHealth in SQLite

Quarantine state survives server restart. Added getStatus() for monitoring.
total_failures/total_successes track historical data for metrics."
```

---

### Task 1.1: Extract WorkerOrchestrator from server.ts

**Files:**
- Create: `packages/core/src/engine/worker-orchestrator.ts`
- Modify: `packages/core/src/engine/index.ts`
- Modify: `packages/core/src/server.ts`

- [ ] **1.1.1 Create WorkerOrchestrator class**

Extract from server.ts lines ~552-741 into `packages/core/src/engine/worker-orchestrator.ts`:

```
WorkerOrchestrator
├── constructor(deps: WorkerOrchestratorDeps)
├── tick()                    → main loop body (was setInterval callback)
├── processMessage()          → ADB send + WAHA fallback (was closure)
├── switchToUser()            → am switch-user with polling (was closure)
├── cleanupMetadata()         → remove old sendMetadata entries
├── getSendMetadata(id)       → for plugin callback enrichment
└── isRunning                 → guard against concurrent ticks
```

`WorkerOrchestratorDeps` interface takes all injected dependencies: db, queue, engine, adb, emitter, senderMapping, senderHealth, rateLimitGuard, receiptTracker, accountMutex, wahaFallback, messageHistory, deviceManager, logger.

- [ ] **1.1.2 Add export to engine/index.ts**

Export `WorkerOrchestrator` and `WorkerOrchestratorDeps` type.

- [ ] **1.1.3 Replace worker loop in server.ts**

Replace the entire processMessage closure, switchToUser closure, cappedSendersCooldown Map, currentForegroundUser, workerRunning boolean, and worker setInterval with:

```typescript
const orchestrator = new WorkerOrchestrator({
  db, queue, engine, adb, emitter, senderMapping, senderHealth,
  rateLimitGuard, receiptTracker, accountMutex, wahaFallback,
  messageHistory, deviceManager, logger: server.log,
})
const workerInterval = setInterval(() => orchestrator.tick(), 5_000)
const metadataCleanupInterval = setInterval(() => orchestrator.cleanupMetadata(), 60_000)
```

Replace `sendMetadata.get()` references with `orchestrator.getSendMetadata()`.

- [ ] **1.1.4 Run all tests and commit**

```bash
cd packages/core && npx vitest run
git commit -m "refactor(engine): extract WorkerOrchestrator from server.ts

Moved processMessage, switchToUser, worker loop, rate limit gating,
quarantine check, and send metadata into WorkerOrchestrator class.
server.ts reduced by ~200 lines. Worker is now independently testable."
```

---

### Task 1.5: WorkerOrchestrator Integration Tests

**Files:**
- Create: `packages/core/src/engine/worker-orchestrator.test.ts`

- [ ] **1.5.1 Write WorkerOrchestrator tests**

7 test scenarios covering all branches:

1. **processes message successfully** — enqueue msg, tick(), verify status=sent
2. **skips batch when sender at daily cap** — RateLimitGuard with maxPerSenderPerDay=0, verify requeued
3. **skips batch when sender quarantined** — recordFailure 3x, verify requeued
4. **skips when no device online** — empty device list, verify no crash
5. **records senderHealth success on send** — verify totalSuccesses incremented
6. **records senderHealth failure when ADB+WAHA fail** — mock ADB reject, verify totalFailures incremented
7. **suppresses log spam for capped sender** — two ticks within 60s, verify warn() called only once

Each test creates an in-memory DB, mocks ADB (stubShell for UIAutomator/contacts/power), injects deterministic SendStrategy (prefillWeight:100), and mocks delay to skip waits.

- [ ] **1.5.2 Run tests**

```bash
npx vitest run packages/core/src/engine/worker-orchestrator.test.ts
# Expected: 7 tests PASS
```

- [ ] **1.5.3 Run full suite and commit**

```bash
cd packages/core && npx vitest run
git commit -m "test(engine): WorkerOrchestrator integration tests (7 scenarios)

Covers: successful send, daily cap skip, quarantine skip, no device,
health recording (success + failure), capped sender cooldown."
```

---

## Phase 2: Instrumentation

> Detail plan for Phase 2 will be written after Phase 1 is APPROVED, following the same step-by-step format.

**Tasks:**
- T2.1: Message trace (`message_events` table + `EventRecorder` + `GET /messages/:id/trace`)
- T2.2: Audit log (`audit_log` table + middleware + `GET /audit`)
- T2.3: Prometheus metrics (`prom-client` + `config/metrics.ts` + `GET /metrics`)
- T2.4: Event enrichment (rich payloads on message:sent/failed + new sender:quarantined/released)

---

## Phase 3: Operational Intelligence

> Detail plan after Phase 2 APPROVED.

**Tasks:**
- T3.1: SendWindow (business hours gate in WorkerOrchestrator.tick())
- T3.2: SenderWarmup (progressive tiers, integrates with RateLimitGuard)
- T3.3: Pause/Resume sender (`POST /senders/:phone/pause|resume` + `GET /senders/status`)
- T3.4: DeviceCircuitBreaker (fail-fast on device disconnect)

---

## Phase 4: Visual Observability

> Detail plan after Phase 3 APPROVED.

**Tasks:**
- T4.1: Sender Dashboard (SenderGrid React component + `/senders` page)
- T4.2: Metrics Dashboard (Recharts + Grafana iframe embed + docker-compose)
- T4.3: Visual alerts + toast notifications (useDispatchStatus hook)

---

## Phase 5: Optimization + Features

> Detail plan after Phase 4 APPROVED.

**Tasks:**
- T5.1: Screenshot management (ScreenshotPolicy: sampling + JPEG compression + retention)
- T5.2: Contact cache (ContactCache with in-memory TTL Map)
- T5.3: Response detection + blacklist (OptOutDetector + blacklist table + enqueue gate)
- T5.4: Media sending (share intent via ADB for images/PDFs)

---

## Acceptance Criteria Summary

| Phase | Criteria | Metric |
|-------|----------|--------|
| F1 | server.ts < 600 LOC | `wc -l server.ts` |
| F1 | Config crashes on missing API key | Start without DISPATCH_API_KEY = crash |
| F1 | SenderHealth survives restart | Quarantine persists across restart |
| F1 | No dead Dispatcher class | `grep -r "Dispatcher" src/` = 0 matches |
| F1 | WorkerOrchestrator has 7+ tests | `npx vitest run worker-orchestrator` |
| F2 | Message trace available | `GET /messages/:id/trace` returns events |
| F2 | Prometheus metrics exposed | `GET /metrics` returns OpenMetrics text |
| F2 | Audit log tracks changes | Sender mapping CRUD generates entries |
| F3 | Worker sleeps outside window | Messages at 3 AM stay queued until 7 AM |
| F3 | Warmup limits new senders | Tier 1 sender capped at 20/day |
| F3 | Pause/resume works | `POST /senders/:phone/pause` skips sender |
| F3 | Circuit breaker opens | 3 ADB failures = skip batch for 30s |
| F4 | Sender dashboard shows status | `/senders` page renders sender cards |
| F4 | Grafana embed optional | Works without VITE_GRAFANA_URL |
| F4 | Toast on quarantine | UI shows toast when sender quarantined |
| F5 | Screenshots 97% smaller | 336MB/day to 10MB/day |
| F5 | Contact cache reduces ADB calls | Repeated contacts hit cache |
| F5 | Opt-out detected and blocked | "PARE" reply = blacklisted |
| F5 | Media sending works | Image sent via share intent |
