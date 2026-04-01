# Phase 1 — Grill Review (Pre-completion)
## Date: 2026-04-01

## Grill Decisions

### 1. Worker Loop (BLOCKER RESOLVED)
**Decision**: Endpoint manual `POST /messages/:id/send` + auto-worker loop
- Auto-worker polls queue every 5s, dequeues and sends to first available device
- Manual endpoint allows UI/cURL to trigger send for specific message
- Both coexist — auto-worker handles normal flow, manual endpoint for operator control

### 2. Send Flow Resilience (BLOCKER RESOLVED)
**Decision**: Try-catch + failed status + retry via stale lock
- Each step in SendEngine wrapped in try-catch
- On failure: status → 'failed', emit 'message:failed' event, cleanup device state
- Stale lock cleanup (30s interval, 120s timeout) re-queues stuck messages
- ensureCleanState() called before AND after errors for device cleanup

### 3. Contact Deduplication (RESOLVED)
**Decision**: Create `contacts` table in SQLite now
- Before registering on device, check if phone number exists in contacts table
- If exists: skip device registration, proceed to send
- If not: register on device (Google account), save to contacts table
- Avoids duplicate contacts on Android device

### 4. Multi-Account (DEFERRED)
**Decision**: Single device, single WhatsApp (com.whatsapp) for Phase 1
- Multi-device routing: Phase 2
- Multi-profile (--user N): Phase 8
- WhatsApp Business support: not in scope (not configured on test device)

### 5. Race Conditions (CONFIRMED SAFE)
- BEGIN IMMEDIATE + WAL mode is correct for single-process
- Tested: concurrent dequeue doesn't duplicate
- Multi-process scenario deferred to Phase 8 (Docker)

### 6. Electron on Fedora (VERIFIED PARTIAL)
- Compiles and structure is correct
- Dev mode requires: pnpm dev:core + pnpm dev:ui + pnpm dev:electron
- Not launch-tested yet on Fedora — will verify during Phase Gate

### 7. Headless Mode (CONFIRMED WORKING)
- `pnpm dev:core` starts standalone on :7890
- Worker loop addition will make it fully functional
- No Electron dependency for headless operation
