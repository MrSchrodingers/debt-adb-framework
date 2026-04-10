# Send Engine Robustness — Post-Mortem & Fix Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix all critical issues found during E2E testing with Oralsin — multi-user switching, message truncation, contact creation, screenshot audit, and callback reliability.

**Post-Mortem Date:** 2026-04-07
**Severity:** BLOCKING — integration unusable until fixed

---

## Problems Found

### P1: Messages cut mid-send during user switch (CRITICAL)
`am switch-user` interrupts the active WhatsApp session. The SendEngine types message char-by-char, and the user switch kills the foreground app mid-typing. Result: partial messages sent (e.g., "ralsin-2-3 (User 12). *Matheus" instead of the full text).

**Root cause:** `am switch-user` is called INSIDE `send()`, between `ensureCleanState` and `am start wa.me`. The user switch takes 3-5 seconds and resets the foreground, but the previous WhatsApp instance may still be in focus briefly, receiving partial keystrokes.

**Fix:** User switch must happen BEFORE any send attempt, and the system must wait for the new user's home screen to stabilize before opening WhatsApp. The worker loop should:
1. Group messages by sender (already done by dequeueBySender)
2. Switch user ONCE before the batch
3. Wait for user to be fully in foreground (poll `am get-current-user`)
4. Send all messages for that sender
5. Only switch when sender changes

### P2: Contact name truncated (IMPORTANT)
`content insert` with `--bind data1:s:"Matheus Amaral Parra Munhoz"` — the quotes may not protect spaces in all ADB versions. Some names showed as just "Matheus" or "Matheus Mun...".

**Root cause:** Shell escaping in `adb shell content insert --bind data1:s:"name with spaces"` — the outer quotes may be stripped by the ADB shell layer.

**Fix:** Escape the name properly: replace spaces with `\\ ` or use single quotes inside double quotes, or use a hex-encoded approach. Test with multi-word names before deploying.

### P3: No screenshot proof in audit (IMPORTANT)
The audit log shows message status but no visual proof that the message was actually delivered. In production, we need screenshot evidence after each send.

**Root cause:** The SendEngine takes a screenshot after send (`this.adb.screenshot()`) but it's only returned as a Buffer — never persisted to disk or associated with the message in the database.

**Fix:** Save screenshot to `reports/sends/{messageId}.png`, add `screenshot_path` column to messages table, expose via API for the UI to display inline.

### P4: WhatsApp popup not handled (IMPORTANT)
A WhatsApp "Enviar para" popup appeared when opening wa.me on certain users, blocking the send flow. The SendEngine doesn't check for or dismiss unexpected dialogs.

**Root cause:** WhatsApp shows confirmation dialogs on first wa.me open for some users. The SendEngine assumes wa.me always opens directly to the chat input.

**Fix:** After `am start wa.me`, dump UIAutomator and check for known dialog patterns ("Enviar para", "Continuar no WhatsApp", "Abrir com"). Dismiss them before proceeding to type.

### P5: Callbacks failing (IMPORTANT)
10 failed callbacks — mix of "fetch failed" (network) and "HTTP 500" (Oralsin server error). The callback delivery retries 3 times but then gives up.

**Root cause:** Multiple issues:
- "fetch failed": ngrok tunnel may have been down temporarily
- "HTTP 500": Oralsin bug or schema mismatch
- No monitoring/alerting when callbacks fail

**Fix:** Add exponential backoff with longer retry window (not just 0/5s/15s). Add a callback retry worker that periodically retries failed callbacks. Surface failed callback count prominently in the Oralsin monitoring UI.

### P6: Message not sent from correct WhatsApp account (CRITICAL)
Even with `am switch-user`, the WhatsApp that opens may not be the one registered to the sender's phone number. Each Android user has its own WhatsApp instance with its own registration. The `am switch-user` switches the foreground user, but if the WhatsApp on that user crashed or wasn't fully initialized, it may not open correctly.

**Root cause:** The SendEngine doesn't verify which WhatsApp account is active after switching. It assumes `am switch-user N` + `am start --user N ... -p com.whatsapp` will always open the correct WhatsApp.

**Fix:** After switching user, verify the WhatsApp is responding (e.g., `am start --user N com.whatsapp/.HomeActivity` and check it resolves). Add a pre-send health check per user.

---

## Architecture: Correct Multi-User Send Flow

```
Worker Loop (every 5s):
  1. dequeueBySender() → get batch for top sender group
  2. Resolve sender → profile_id from sender_mapping
  3. If profile_id != current foreground user:
     a. ensureCleanState() on current user (BACK + HOME)
     b. am switch-user {profile_id}
     c. Wait until am get-current-user == profile_id (poll, max 10s)
     d. Wait 2s for UI to stabilize
  4. For each message in batch:
     a. ensureContact() via content provider
     b. Open wa.me chat
     c. Wait for chat to load (UIAutomator check for input field)
     d. Type message
     e. Tap send
     f. Take screenshot → save to reports/
     g. Update message status
  5. After batch complete, ensureCleanState()
```

**Key principle:** Switch user OUTSIDE the send loop. Never switch mid-batch.

---

## Task 1: Refactor Worker Loop — User Switch Before Batch

**Files:**
- Modify: `packages/core/src/server.ts` (worker loop)
- Modify: `packages/core/src/engine/send-engine.ts` (remove switch-user from send)

**Steps:**
- [ ] Remove `am switch-user` from `send-engine.ts` — the engine should NOT switch users
- [ ] In server.ts worker loop (`processMessage` helper), move user switch logic to the batch level:
  - Track `currentForegroundUser` (default: 0)
  - Before processing a batch, check if sender's profile != currentForegroundUser
  - If different: switch user, poll `am get-current-user` until confirmed, wait 2s
  - Update `currentForegroundUser`
- [ ] Keep `--user {profileId}` flag on `am start` intent (redundant safety)
- [ ] Test: enqueue 2 messages with different senders, verify user switches once between batches
- [ ] Commit

---

## Task 2: Fix Message Typing — Ensure Clean Chat State

**Files:**
- Modify: `packages/core/src/engine/send-engine.ts`

**Steps:**
- [ ] After `am start wa.me`, add UIAutomator check:
  - Dump UI, check for known popups/dialogs
  - Dismiss "Enviar para", "Continuar", "Abrir com" if present
  - Verify chat input field exists (`com.whatsapp:id/entry` or similar)
  - Only proceed to type after input field confirmed
- [ ] Add timeout: if chat doesn't load in 10s, mark message as failed (transient)
- [ ] Test: verify message types correctly after user switch
- [ ] Commit

---

## Task 3: Fix Contact Creation — Name Escaping

**Files:**
- Modify: `packages/core/src/engine/send-engine.ts` (ensureContact)

**Steps:**
- [ ] Fix name escaping in `content insert` command:
  - Replace `"${name}"` with proper shell escaping
  - Test with: "Matheus Amaral Parra Munhoz" (spaces), "João da Silva" (accent+spaces), "Maria O'Brien" (apostrophe)
- [ ] Add contact name UPDATE if contact exists but name changed (patient name may be updated)
- [ ] Test: create contact with multi-word name, verify full name shows in WhatsApp
- [ ] Commit

---

## Task 4: Screenshot Audit Trail

**Files:**
- Modify: `packages/core/src/engine/send-engine.ts`
- Modify: `packages/core/src/queue/message-queue.ts` (add screenshot_path column)
- Modify: `packages/core/src/queue/types.ts` (Message interface)
- Create: `packages/core/src/api/screenshots.ts` (serve screenshot files)
- Modify: `packages/ui/src/components/oralsin-messages.tsx` (show screenshot in expanded row)

**Steps:**
- [ ] Add `screenshot_path TEXT` column to messages table
- [ ] After successful send, save screenshot to `reports/sends/{messageId}.png`
- [ ] Update message with screenshot_path
- [ ] Add `GET /api/v1/messages/:id/screenshot` endpoint that serves the PNG file
- [ ] In oralsin-messages UI, show screenshot thumbnail in expanded row
- [ ] Test: send message, verify screenshot saved and visible in UI
- [ ] Commit

---

## Task 5: Callback Reliability

**Files:**
- Modify: `packages/core/src/plugins/callback-delivery.ts`
- Modify: `packages/core/src/server.ts` (add retry worker)

**Steps:**
- [ ] Increase retry window: 0s, 5s, 30s, 120s (4 attempts instead of 3)
- [ ] Add periodic retry worker (every 60s) that retries failed callbacks older than 5 minutes
- [ ] Add max_attempts limit (10) — after 10 attempts, mark as permanently_failed
- [ ] Surface failed callback count in /healthz endpoint
- [ ] Test: simulate callback failure, verify retry worker picks it up
- [ ] Commit

---

## Task 6: Pre-Send Health Check

**Files:**
- Modify: `packages/core/src/engine/send-engine.ts`

**Steps:**
- [ ] Before typing message, verify:
  - Screen is on (`dumpsys power | grep mScreenOn`)
  - Screen is unlocked
  - WhatsApp is in foreground (`dumpsys activity activities | grep mResumedActivity`)
- [ ] If any check fails, attempt recovery:
  - Screen off → `input keyevent KEYCODE_WAKEUP`
  - Screen locked → swipe unlock
  - WhatsApp not in foreground → retry `am start`
- [ ] After 2 recovery attempts, fail message as transient
- [ ] Test: verify send works after screen went off
- [ ] Commit

---

## Task 7: End-to-End Validation Test

**Steps:**
- [ ] Write integration test script that:
  1. Enqueues 4 messages, each with a different sender
  2. Verifies user switches happen correctly
  3. Verifies all 4 messages sent from correct WhatsApp accounts
  4. Verifies screenshots saved for all 4
  5. Verifies contacts created with full names
  6. Verifies callbacks delivered (or retried)
- [ ] Run the test LOCALLY before involving Oralsin
- [ ] Document results with screenshots
- [ ] Only after local validation passes, re-engage Oralsin for bilateral test
- [ ] Commit

---

## Execution Order

```
Task 1 (user switch) → Task 2 (chat state) → Task 3 (contacts) → VALIDATE LOCALLY
Task 4 (screenshots) → Task 5 (callbacks) → Task 6 (health check) → Task 7 (E2E)
```

Tasks 1-3 are BLOCKING — must be fixed before any more Oralsin tests.
Tasks 4-6 are IMPORTANT — improve reliability and auditability.
Task 7 is the gate — no bilateral test until this passes locally.

---

## Rules for Testing

1. **NEVER declare something works without testing it yourself first**
2. **Test with the exact same flow the Oralsin uses** — multi-sender, real patient names
3. **Screenshot every step** — before send, after send, after user switch
4. **Verify the message arrived correctly** on the target phone before declaring success
5. **Check callbacks actually delivered** — don't just check they were "sent"
