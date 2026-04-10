# Dispatch ADB Framework — Hardening & Refinement Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan. Each task dispatches a fresh subagent. Supplemental context in `docs/superpowers/plans/dispatch-hardening-context.md`.

**Goal:** Fix all critical E2E issues, add resilience, screenshot audit trail, improve UI monitoring, and validate the complete Oralsin integration pipeline locally before re-engaging external testing.

**Architecture:** Fix the send engine's multi-user switching, add dialog detection, screenshot persistence, callback reliability, pre-send health checks, and comprehensive E2E validation.

**Tech Stack:** Node.js 22, TypeScript, Fastify, better-sqlite3, Vitest, React 19, Tailwind, Recharts

---

## Dependency Graph

```
T1 (Worker Loop Refactor) ──┐
                             ├──► T4 (Screenshot Audit) ──┐
T2 (Dialog Detection)  ─────┤                             ├──► T7 (E2E Local Test)
                             ├──► T5 (Callback Retry)     │
T3 (Contact Escaping)  ─────┘                             │
                                                          │
T6 (Pre-Send Health)  ───────────────────────────────────►┘
```

**Execution Order:**
- Phase A (parallel): T1 + T2 + T3 (independent fixes)
- Phase B (parallel after A): T4 + T5 (depend on stable send engine)
- Phase C (after A): T6 (depends on stable send)
- Phase D (gate, after ALL): T7 (E2E validation — blocks external testing)

---

## Task 1: Worker Loop — User Switch at Batch Level (CRITICAL)

**Problem:** `am switch-user` is called INSIDE `send()` for every message. User switch takes 3-5s, resets foreground, can cut messages mid-typing. Multiple redundant switches per batch.

**Files:**
- Modify: `packages/core/src/engine/send-engine.ts`
- Modify: `packages/core/src/server.ts` (worker loop)
- Create: `packages/core/src/engine/send-engine.test.ts`

**Changes:**

1. **Remove user switching from send-engine.ts:**
   - Delete lines 32-35 (the `am switch-user` + 3s delay inside `send()`)
   - Keep `profileId` parameter on `send()` for the `--user` flag on `am start`
   - `send()` should NEVER call `am switch-user`

2. **Add user switching to server.ts worker loop (batch level):**
   - Track `let currentForegroundUser = 0` at module scope
   - In the worker interval, AFTER dequeueBySender returns the batch:
     - Resolve `profileId` from `senderMapping.getByPhone(batch[0].senderNumber)`
     - If `profileId !== currentForegroundUser`:
       - `adb.shell(serial, 'am switch-user ${profileId}')`
       - Poll `adb.shell(serial, 'am get-current-user')` every 1s until it returns profileId (max 10s)
       - Wait 2s for UI stabilization
       - Update `currentForegroundUser = profileId`
     - Process ALL messages in batch with `processMessage(message, serial)` — NO user switch inside

3. **Write tests for send-engine:**
   - Test that `send()` does NOT call `am switch-user`
   - Test that `send()` uses `--user {profileId}` in the `am start` intent
   - Mock `adb.shell()` and verify exact commands called

**Acceptance Criteria:**
- [ ] `send-engine.ts` has NO `am switch-user` calls
- [ ] Worker loop switches user once before batch, polls confirmation
- [ ] Tests verify command sequence
- [ ] Run `npm test` — all pass

---

## Task 2: Dialog Detection & Dismissal (CRITICAL)

**Problem:** WhatsApp shows popups ("Enviar para", "Continuar no WhatsApp") that block the send flow. SendEngine goes straight to typing after opening wa.me, without checking if the chat loaded.

**Files:**
- Modify: `packages/core/src/engine/send-engine.ts`

**Changes:**

1. **After `am start wa.me` + 4s delay, add dialog detection:**
   ```
   UIAutomator dump → parse XML → check for known patterns:
   - "Enviar para" / "Abrir com" → tap "WhatsApp" option + "Sempre"
   - "Continuar no WhatsApp" → tap "Continuar"
   - "Permitir" (notification permission) → tap "Permitir"
   ```

2. **Verify chat input is ready:**
   ```
   UIAutomator dump → look for:
   - resource-id="com.whatsapp:id/entry" (text input field)
   - OR resource-id="com.whatsapp:id/text_entry_view"
   If not found after 3 retries (1s each), fail message as transient
   ```

3. **Extract into helper method: `waitForChatReady(deviceSerial, maxRetries=3)`**

**Acceptance Criteria:**
- [ ] After opening wa.me, UIAutomator checks for dialogs
- [ ] Known dialogs are dismissed automatically
- [ ] Chat input field existence verified before typing
- [ ] Timeout after 3 retries → fail message as transient
- [ ] Tests with mock UIAutomator XML responses

---

## Task 3: Contact Name Escaping (IMPORTANT)

**Problem:** `content insert --bind data1:s:"Matheus Amaral Parra Munhoz"` — spaces/accents in names get stripped by ADB shell.

**Files:**
- Modify: `packages/core/src/engine/send-engine.ts` (ensureContact)
- Create: `packages/core/src/engine/contact-utils.ts` (escaping helper)
- Create: `packages/core/src/engine/contact-utils.test.ts`

**Changes:**

1. **Create `escapeForAdbContent(value: string): string` helper:**
   - Replace spaces with `%20` or use single-quote wrapping
   - Test approach: `adb shell content insert --bind data1:s:'Matheus Amaral Parra Munhoz'`
   - Also handle: accents (João), apostrophes (O'Brien), special chars

2. **Update ensureContact to use the escaping helper**

3. **Add contact UPDATE when name changes:**
   - If contact exists in Android (phone_lookup found) but name in DB differs, update the name

4. **Write tests:**
   - Test escaping with spaces, accents, apostrophes
   - Test on actual device with `adb shell` command

**Acceptance Criteria:**
- [ ] "Matheus Amaral Parra Munhoz" creates correctly as full name
- [ ] "João da Silva" handles accents
- [ ] Tests verify escaping logic
- [ ] Tested on physical device before declaring done

---

## Task 4: Screenshot Audit Trail (IMPORTANT)

**Problem:** Screenshots taken after send but never persisted. No visual proof in audit log.

**Files:**
- Modify: `packages/core/src/engine/send-engine.ts`
- Modify: `packages/core/src/queue/message-queue.ts`
- Modify: `packages/core/src/queue/types.ts`
- Create: `packages/core/src/api/screenshots.ts`
- Modify: `packages/core/src/server.ts`
- Modify: `packages/core/src/api/index.ts`
- Modify: `packages/ui/src/components/oralsin-messages.tsx`

**Changes:**

1. **DB:** Add `screenshot_path TEXT` column to messages table (ALTER TABLE migration)

2. **Send Engine:** After screenshot, save to `reports/sends/{messageId}.png`:
   ```typescript
   import { writeFile, mkdir } from 'node:fs/promises'
   const dir = 'reports/sends'
   await mkdir(dir, { recursive: true })
   await writeFile(`${dir}/${message.id}.png`, screenshot)
   queue.updateScreenshotPath(message.id, `${dir}/${message.id}.png`)
   ```

3. **API:** `GET /api/v1/messages/:id/screenshot` → serve the PNG file (static file serve)

4. **UI:** In oralsin-messages expanded row, show screenshot thumbnail:
   ```tsx
   <img src={`${CORE_URL}/api/v1/messages/${msg.id}/screenshot`} className="rounded max-h-48" />
   ```

5. **Monitoring endpoint** update to include screenshotPath in messages response

**Acceptance Criteria:**
- [ ] Screenshot saved to disk after every successful send
- [ ] screenshot_path column populated in messages table
- [ ] API serves screenshot as PNG
- [ ] UI shows screenshot in expanded message row
- [ ] Tests verify file is written

---

## Task 5: Callback Reliability (IMPORTANT)

**Problem:** Only 3 retries with short window (0/5/15s). No automatic retry of failed callbacks.

**Files:**
- Modify: `packages/core/src/plugins/callback-delivery.ts`
- Modify: `packages/core/src/server.ts`
- Modify: `packages/core/src/plugins/callback-delivery.test.ts`

**Changes:**

1. **Increase retry strategy:**
   - MAX_RETRIES: 4 (was 3)
   - BACKOFF_DELAYS_MS: [0, 5_000, 30_000, 120_000] (was [0, 5_000, 15_000])

2. **Add periodic retry worker in server.ts:**
   ```typescript
   const callbackRetryInterval = setInterval(async () => {
     const failed = callbackDelivery.listFailedCallbacks()
     for (const cb of failed) {
       if (cb.attempts < 10) {
         await callbackDelivery.retryFailedCallback(cb.id)
       }
     }
   }, 60_000) // every 60s
   ```

3. **Add failed_callbacks count to /healthz:**
   ```typescript
   failed_callbacks: callbackDelivery.listFailedCallbacks().length
   ```

4. **Update tests**

**Acceptance Criteria:**
- [ ] 4 retry attempts with exponential backoff
- [ ] Periodic retry worker (60s) retries failed callbacks
- [ ] /healthz includes failed_callbacks count
- [ ] Tests verify new retry pattern

---

## Task 6: Pre-Send Health Check (IMPORTANT)

**Problem:** Screen may be off/locked, WhatsApp may have crashed. SendEngine proceeds blindly.

**Files:**
- Modify: `packages/core/src/engine/send-engine.ts`

**Changes:**

1. **Add `ensureScreenReady(deviceSerial)` before send:**
   ```
   - dumpsys power | grep "mScreenOn=true" → if false, KEYCODE_WAKEUP
   - dumpsys window | grep "mDreamingLockscreen" → if locked, swipe to unlock
   - Wait 1s after any recovery action
   ```

2. **Add after user switch (in worker loop):**
   ```
   - am get-current-user → verify matches expected profile
   - dumpsys activity activities | grep mResumedActivity → verify WhatsApp or launcher
   ```

3. **Max 2 recovery attempts, then fail as transient**

**Acceptance Criteria:**
- [ ] Screen wake + unlock before send
- [ ] Verified on physical device
- [ ] Recovery logged for audit

---

## Task 7: E2E Local Validation (GATE)

**Problem:** Previous tests were never validated locally before involving Oralsin.

**This task MUST pass before ANY bilateral testing.**

**Steps:**

1. **Start Dispatch server**
2. **Enqueue 4 messages via curl, each with a different sender:**
   - Sender 1: +5543996835100 (profile 0)
   - Sender 2: +5543996835095 (profile 10)
   - Sender 3: +5543996837813 (profile 11)
   - Sender 4: +5543996837844 (profile 12)
3. **Verify for EACH message:**
   - [ ] User switched to correct profile before send
   - [ ] Contact created with full patient name (multi-word, with spaces)
   - [ ] Message typed completely (no truncation)
   - [ ] Message sent successfully (status=sent in DB)
   - [ ] Screenshot saved to reports/sends/
   - [ ] Screenshot shows complete message in WhatsApp
   - [ ] Callback delivered to Oralsin webhook (or failed_callbacks logged)
   - [ ] No WhatsApp popups blocked the flow
4. **Verify UI:**
   - [ ] Plugins tab shows all 4 messages with correct status
   - [ ] Senders tab shows all 4 senders with send counts
   - [ ] Overview shows correct KPIs
   - [ ] Screenshot visible in expanded message row
5. **Save proof screenshots and document results**

**Acceptance Criteria:**
- [ ] 4/4 messages sent from correct WhatsApp accounts
- [ ] 4/4 contacts created with full names
- [ ] 4/4 screenshots saved and accessible
- [ ] 0 unexpected popups
- [ ] Callbacks delivered (or properly retried)
- [ ] UI reflects all data correctly

---

## Rules

1. **NEVER declare a task done without testing on the physical device**
2. **Every code change requires a test run (`npm test`)**
3. **Every send-engine change requires a real ADB send test**
4. **Screenshot proof required for E2E claims**
5. **Code review after each task (spec compliance + quality)**
