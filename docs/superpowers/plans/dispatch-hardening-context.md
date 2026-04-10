# Dispatch Hardening — Subagent Context

> Read this BEFORE implementing any task. This is the zero-context briefing.

## Project

**Dispatch ADB Framework** — sends WhatsApp messages via ADB automation on Android devices.
- **Monorepo:** Turborepo, packages/core (Node.js 22, TypeScript strict, Fastify, SQLite WAL), packages/ui (React 19, Vite, Tailwind)
- **Test runner:** Vitest, run with `npx turbo test --filter=@dispatch/core`
- **Current test count:** 444 tests, 40 files, all passing
- **Device:** POCO C71 (serial: 9b01005930533036340030832250ac), Android 15, rooted
- **Multi-user:** 4 Android users with WhatsApp registered:
  - User 0 (profile_id=0): +5543996835100
  - User 10 (profile_id=10): +5543996835095
  - User 11 (profile_id=11): +5543996837813
  - User 12 (profile_id=12): +5543996837844

## Critical Files

| File | Lines | What it does |
|------|-------|-------------|
| `packages/core/src/engine/send-engine.ts` | 177 | THE CRITICAL PATH — opens WhatsApp via wa.me, types char-by-char, taps send. Has bugs: user switch inside send(), no dialog detection, no screenshot persistence |
| `packages/core/src/server.ts` | 671 | Server + worker loop. Worker dequeues by sender, calls processMessage. User switch coordination missing |
| `packages/core/src/queue/message-queue.ts` | 406 | SQLite queue with dequeueBySender, contacts table, stale lock cleanup |
| `packages/core/src/plugins/oralsin-plugin.ts` | 167 | Oralsin plugin: enqueue validation, sender resolution |
| `packages/core/src/plugins/plugin-loader.ts` | 178 | Creates PluginContext, saves patient.name to contacts during enqueue |
| `packages/core/src/plugins/callback-delivery.ts` | 175 | HMAC-signed callbacks with 3 retries (0/5/15s). Persists failures |
| `packages/core/src/engine/sender-mapping.ts` | 175 | CRUD for sender_mapping table, resolveSenderChain() |
| `packages/core/src/api/plugin-oralsin.ts` | 328 | Monitoring endpoints: overview, messages, senders, callbacks |

## Database Tables (key ones)

```sql
-- messages: the queue
messages (id TEXT PK, to_number, body, idempotency_key UNIQUE, priority, sender_number,
  status TEXT ['queued','locked','sending','sent','failed','permanently_failed'],
  attempts, locked_by, locked_at, plugin_name, correlation_id, senders_config JSON,
  context JSON, waha_message_id, max_retries, fallback_used INT, fallback_provider,
  created_at, updated_at)
-- MISSING: screenshot_path TEXT

-- contacts: patient name registry
contacts (phone TEXT PK, name TEXT, registered_at TEXT)

-- sender_mapping: phone → device/profile
sender_mapping (id TEXT PK, phone_number TEXT UNIQUE, device_serial, profile_id INT,
  app_package, waha_session, waha_api_url, active INT, created_at, updated_at)

-- failed_callbacks: persisted failed webhook deliveries
failed_callbacks (id TEXT PK, plugin_name, message_id, callback_type, payload JSON,
  webhook_url, attempts INT, last_error, created_at, last_attempt_at)
```

## Send Flow (current, buggy)

```
1. worker dequeues batch via dequeueBySender()
2. for each message in batch:
   a. processMessage() resolves profileId from sender_mapping
   b. engine.send(message, serial, profileId):
      - am switch-user {profileId}  ← BUG: inside send, not batch level
      - ensureCleanState (BACK + HOME)
      - ensureContact (content provider insert)  ← BUG: name escaping
      - am start wa.me/{phone} -p com.whatsapp  ← BUG: no dialog check
      - type message char-by-char
      - tapSendButton (UIAutomator + fallback Enter)
      - screenshot (Buffer, not saved)  ← BUG: not persisted
```

## ADB Commands Reference

```bash
# Switch foreground user
adb shell am switch-user 10
# Check current user
adb shell am get-current-user
# Open WhatsApp chat
adb shell am start --user 10 -a android.intent.action.VIEW -d "https://wa.me/5543991938235" -p com.whatsapp
# UIAutomator dump
adb shell uiautomator dump /sdcard/ui.xml && adb shell cat /sdcard/ui.xml
# Create contact (NO dialog)
adb shell content insert --uri content://com.android.contacts/raw_contacts --bind account_type:n: --bind account_name:n:
# Screen state
adb shell dumpsys power | grep mScreenOn
# Screenshot
adb shell screencap -p /sdcard/shot.png && adb pull /sdcard/shot.png
```

## Testing

```bash
# Run all tests
npx turbo test --filter=@dispatch/core
# Run specific test
npx vitest run src/engine/send-engine.test.ts
# Start server
npx tsx packages/core/src/cli.ts
# Test endpoint
curl -H "X-API-Key: RNJ0gf-UfxEnddkFZh9_pzsIUn85YQ3wzs9lbHHotlQ" http://localhost:7890/healthz
```

## Conventions

- Files: kebab-case.ts
- Functions: camelCase
- Tests: colocated *.test.ts
- Commits: type(scope): message
- No `any`, strict TypeScript
- Zod for API input validation
- Every write operation idempotent
