# Plugin Hardening Sprint — Execution Plan

> **Date**: 2026-04-13
> **Scope**: 87 findings + 43 grill decisions — full hardening of plugin system
> **Strategy**: Sequential batches by layer, DB first, commits atomics
> **Context Recovery**: This plan is self-contained for zero-context execution after `/clear`
> **Grill**: 43 decisions documented in `.dev-state/plugin-hardening-grill.md`
> **Branch**: `hardening/plugin-system`

## Pre-Execution Checklist

```bash
# 1. Read this plan
cat plans/plugin-hardening-sprint.md

# 2. Read grill decisions
cat .dev-state/plugin-hardening-grill.md

# 3. Verify tests pass
cd /var/www/adb_tools && pnpm test

# 4. Create branch
git checkout -b hardening/plugin-system

# 5. Clean DB (recreate tables — grill decision #4)
rm -f packages/core/dispatch.db packages/core/dispatch.db-wal packages/core/dispatch.db-shm
```

## Dependency Graph

```
Batch 1 (DB/Schema)
  │
  ├──► Batch 2 (State Machine + Queue)
  │       │
  │       ├──► Batch 3 (Plugin Core)
  │       │       │
  │       │       ├──► Batch 4 (Callback System)
  │       │       │       │
  │       │       │       ├──► Batch 5 (Oralsin Plugin Contract)
  │       │       │       │       │
  │       │       │       │       ├──► Batch 6 (Server Integration)
  │       │       │       │       │       │
  │       │       │       │       │       ├──► Batch 7 (Observability + Metrics)
  │       │       │       │       │       │       │
  │       │       │       │       │       │       ├──► Batch 8 (Resilience + Recovery)
  │       │       │       │       │       │       │       │
  │       │       │       │       │       │       │       └──► Batch 9 (Tests)
  │       │       │       │       │       │       │               │
  │       │       │       │       │       │       │               └──► Batch 10 (Grafana + Docs)
```

---

## Batch 1: DB Schema & Configuration Hardening

**Commit**: `fix(db): schema hardening — busy_timeout, indexes, timestamps, constraints`
**Findings**: DB1, DB2, DB3, DB4, DB5, DB8, DB9, D4, D6, D7
**Decisions**: #3, #4, #19, #35, #36

### Files to Modify

#### `packages/core/src/queue/message-queue.ts` (522 lines)

**DB1** — Add `PRAGMA busy_timeout = 5000` after WAL mode (line ~26):
```typescript
db.pragma('journal_mode = WAL')
db.pragma('busy_timeout = 5000')
```

**DB2** — Add index on `messages(plugin_name, status, created_at)` in `initialize()`:
```sql
CREATE INDEX IF NOT EXISTS idx_messages_plugin_name ON messages(plugin_name, status, created_at)
```

**DB5** — Add WAL checkpoint config:
```typescript
db.pragma('wal_autocheckpoint = 400')
```

**DB8** — Add CHECK constraint on priority in CREATE TABLE:
```sql
priority INTEGER NOT NULL DEFAULT 5 CHECK (priority BETWEEN 1 AND 10)
```

**D4** — Add `sent_at` column to messages CREATE TABLE:
```sql
sent_at TEXT DEFAULT NULL
```
Update `updateStatus` to set `sent_at` when transitioning to `sent`:
```typescript
if (to === 'sent') {
  // also set sent_at
}
```

**DB4** — Rewrite `getQueueStats` to branch instead of `IS NULL OR`:
```typescript
getQueueStats(pluginName?: string) {
  const baseWhere = pluginName ? 'WHERE plugin_name = ?' : ''
  const binds = pluginName ? [pluginName] : []
  // single query with FILTER and dynamic WHERE
}
```

#### `packages/core/src/plugins/plugin-registry.ts` (160 lines)

**D7** — Replace all `datetime('now')` with `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` in:
- `plugins` table DDL (created_at, updated_at defaults)
- `failed_callbacks` table DDL (created_at, last_attempt_at defaults)
- All UPDATE statements

**DB3** — Add composite index on `failed_callbacks`:
```sql
CREATE INDEX IF NOT EXISTS idx_failed_callbacks_retry ON failed_callbacks(attempts, created_at)
```

**D6** — Enable foreign keys and add FK constraints:
```typescript
db.pragma('foreign_keys = ON')
```
Add to `messages` CREATE TABLE:
```sql
plugin_name TEXT REFERENCES plugins(name) ON DELETE SET NULL
```
Add to `failed_callbacks` CREATE TABLE:
```sql
plugin_name TEXT NOT NULL REFERENCES plugins(name) ON DELETE CASCADE
```

**DB9** — Fix `pending_correlations` timestamps in `receipt-tracker.ts`:
Replace `datetime('now')` with `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`.

#### `packages/core/src/engine/receipt-tracker.ts` (175 lines)

**DB9** — Normalize timestamps to ISO 8601 with milliseconds.

#### `packages/core/src/config/config-schema.ts` (184 lines)

**DB5** — Add WAL checkpoint to hourly cleanup in server.ts (this is a server.ts change but schema-related).

### Acceptance Criteria
- [ ] `PRAGMA busy_timeout` returns 5000
- [ ] `PRAGMA foreign_keys` returns 1
- [ ] Index `idx_messages_plugin_name` exists
- [ ] Index `idx_failed_callbacks_retry` exists
- [ ] `messages.sent_at` column exists
- [ ] `messages.priority` has CHECK constraint
- [ ] All timestamps use ISO 8601 with milliseconds
- [ ] Tests pass after schema changes

---

## Batch 2: State Machine & Queue Integrity

**Commit**: `fix(queue): enforced state machine, waiting_device, TTL, batch partial-failure`
**Findings**: D1, D2, D3, D5, D8, R4, R6, P8, P11
**Decisions**: #7, #8, #9, #10, #29, #31, #35

### Files to Modify

#### `packages/core/src/queue/types.ts` (67 lines)

**D1/D2** — Define valid state transitions as a const map:
```typescript
export const VALID_TRANSITIONS: Record<MessageStatus, MessageStatus[]> = {
  queued: ['locked', 'waiting_device', 'permanently_failed'],
  locked: ['sending', 'queued'],
  sending: ['sent', 'failed', 'queued'],
  sent: [],
  failed: ['queued', 'permanently_failed'],
  permanently_failed: ['queued'],  // manual retry only
  waiting_device: ['queued', 'permanently_failed'],
}
```

**D8** — Export `PluginStatus` type for use in plugin-registry.

#### `packages/core/src/queue/message-queue.ts` (522 lines)

**D2** — Enforce state machine in `updateStatus(id, from, to)`:
```typescript
updateStatus(id: string, from: MessageStatus, to: MessageStatus): void {
  if (!VALID_TRANSITIONS[from]?.includes(to)) {
    throw new Error(`Invalid transition: ${from} → ${to}`)
  }
  // UPDATE ... WHERE id = ? AND status = ? (CAS)
}
```
All callers must pass `from` status.

**R4/P8** — Rewrite `enqueueBatch` with partial-failure semantics:
- `ON CONFLICT(idempotency_key) DO NOTHING`
- Blacklisted numbers: skip per-item, add to `skipped[]`
- Return `{ enqueued: Message[], skipped: SkippedItem[], duplicated: string[] }`
- Transaction wraps all inserts (including `saveContact` — fix D5)

**D5** — Move `saveContact` inside the `enqueueBatch` transaction.

**P11** — Fix maxRetries semantics: `attempts >= maxRetries` (not `attempts + 1 < maxRetries`).

**D3** — When transitioning to `permanently_failed`, set `attempts` to the real value:
```typescript
// In requeueForRetry or updateStatus to permanently_failed:
db.prepare('UPDATE messages SET status = ?, attempts = ? ...').run('permanently_failed', actualAttempts)
```

**R6** — Add `waiting_device` transition logic:
- New method: `transitionToWaitingDevice()` — moves `queued` messages to `waiting_device` when no devices online
- New method: `transitionFromWaitingDevice()` — moves `waiting_device` back to `queued` when device comes online
- TTL check: messages in `waiting_device` older than threshold → `permanently_failed`

**D4** — Populate `sent_at` in the state machine when `to === 'sent'`.

#### `packages/core/src/engine/worker-orchestrator.ts` (340 lines)

**P11** — Update retry check to `message.attempts >= message.maxRetries`.

**D2** — Update all `updateStatus` calls to pass `from` parameter.

**D3** — Ensure `permanently_failed` path sets real `attempts` count.

### Acceptance Criteria
- [ ] `updateStatus(id, 'queued', 'sent')` throws (invalid transition)
- [ ] `updateStatus(id, 'sending', 'sent')` succeeds
- [ ] Batch with 1 blacklisted + 2 valid: 2 enqueued, 1 skipped
- [ ] Batch with 1 duplicate idempotency_key: DO NOTHING, no rollback
- [ ] `maxRetries=3` produces exactly 3 send attempts
- [ ] `permanently_failed` messages have correct `attempts` count
- [ ] `waiting_device` → `queued` transition works when device comes online
- [ ] `saveContact` + `enqueueBatch` are atomic (single transaction)
- [ ] Tests pass

---

## Batch 3: Plugin Core Modules

**Commit**: `fix(plugins): lifecycle errors, registry sync, typed status, timer leak`
**Findings**: R2, R3, R9, R10, D8, Q1, Q3, A3
**Decisions**: #20, #33, #37

### Files to Modify

#### `packages/core/src/plugins/plugin-loader.ts` (196 lines)

**R2** — Plugin init error: log + re-throw:
```typescript
} catch (err) {
  this.registry.setPluginStatus(plugin.name, 'error')
  this.logger.error({ err, plugin: plugin.name }, 'Plugin init failed')
  throw err
}
```

**R3** — `destroyAll` with try/catch per-plugin:
```typescript
async destroyAll(): Promise<void> {
  for (const [name, plugin] of this.loadedPlugins) {
    try {
      await plugin.destroy()
      this.loadedPlugins.delete(name)
    } catch (err) {
      this.logger.warn({ err, plugin: name }, 'Plugin destroy failed')
    }
  }
}
```

**Q3** — Validate `pluginName` against registry at load time:
```typescript
const registered = this.registry.getPlugin(plugin.name)
if (!registered) throw new Error(`Plugin ${plugin.name} not registered`)
```

#### `packages/core/src/plugins/plugin-event-bus.ts` (87 lines)

**R9** — Remove `pluginEnabled` map. Use registry as source of truth:
```typescript
// In dispatchToPlugins:
const pluginRecord = this.registry.getPlugin(pluginName)
if (!pluginRecord || pluginRecord.enabled !== 1) return
```

**Q1** — Fix timer leak in `executeWithTimeout`:
```typescript
let timeoutHandle: ReturnType<typeof setTimeout>
const timeout = new Promise<never>((_, reject) => {
  timeoutHandle = setTimeout(() => reject(...), HANDLER_TIMEOUT_MS)
})
try {
  await Promise.race([result, timeout])
} finally {
  clearTimeout(timeoutHandle!)
}
```

**A3** — Wire `onError` (this is wired in server.ts but the handler must exist):
Ensure `onError` callback interface is properly typed.

#### `packages/core/src/plugins/plugin-registry.ts` (160 lines)

**D8** — Type `setPluginStatus` parameter:
```typescript
import type { PluginStatus } from './types.js'
setPluginStatus(name: string, status: PluginStatus): void {
```

**R10** — Upsert includes `api_key` and `hmac_secret`:
```sql
ON CONFLICT(name) DO UPDATE SET
  version = excluded.version,
  webhook_url = excluded.webhook_url,
  api_key = excluded.api_key,
  hmac_secret = excluded.hmac_secret,
  events = excluded.events,
  updated_at = strftime(...)
```

### Acceptance Criteria
- [ ] Plugin init failure: logged at error level, status set to 'error', caller gets exception
- [ ] `destroyAll` with 2 plugins (first throws): second still destroyed
- [ ] Disabling plugin via admin API stops event dispatch (registry checked live)
- [ ] `setPluginStatus('oralsin', 'invalid' as any)` — TypeScript compile error
- [ ] Timer leak test: no pending timers after handler resolves
- [ ] API key/HMAC secret updated on restart when env var changes
- [ ] Tests pass

---

## Batch 4: Callback System

**Commit**: `fix(callbacks): 503 retry, HMAC hardening, fetch timeout, error capture, interim_failure + expired types`
**Findings**: S5, S15, R11, A5, A6, Q5, P5
**Decisions**: #11, #27, #40, #41, #42, #43

### Files to Modify

#### `packages/core/src/plugins/types.ts` (205 lines)

**Decision #11/#42** — Extend `CallbackType`:
```typescript
export type CallbackType = 'result' | 'ack' | 'response' | 'interim_failure' | 'expired'
```

Add `InterimFailureCallback` and `ExpiredCallback` interfaces:
```typescript
export interface InterimFailureCallback {
  event: 'interim_failure'
  idempotency_key: string
  correlation_id?: string
  status: 'interim_failed'
  error: { code: string; message: string; retryable: boolean }
  failed_sender: { phone: string; session: string; pair: string } | null
  next_sender: { phone: string; session: string; pair: string; role: string } | null
  attempt: number
  context?: Record<string, unknown>
}

export interface ExpiredCallback {
  event: 'expired'
  idempotency_key: string
  correlation_id?: string
  status: 'expired'
  error: { code: 'ttl_expired'; message: string; retryable: false }
  context?: Record<string, unknown>
}
```

Update `FallbackReason` to include real error:
```typescript
export interface FallbackReason {
  original_error: string      // real engine error code, not hardcoded
  original_message?: string   // human-readable detail
  original_session: string
  quarantined: boolean        // real quarantine state
}
```

#### `packages/core/src/plugins/callback-delivery.ts` (181 lines)

**Decision #40** — 503 is retryable with short backoff:
```typescript
// Remove the 503 break
// Change backoff for 503:
const BACKOFF_503_MS = [0, 1_000, 2_000, 4_000] as const
// In the retry loop:
if (response.status === 503) {
  // use 503-specific backoff, continue retrying
}
```

**S5** — HMAC empty secret = throw at plugin load (not at sign time):
```typescript
private sign(body: string, secret: string): string {
  // secret emptiness is caught at boot via config-schema superRefine
  return createHmac('sha256', secret).update(body).digest('hex')
}
```

**S15/R11** — AbortSignal on all fetch calls:
```typescript
const controller = new AbortController()
const timeoutMs = parseInt(process.env.DISPATCH_HTTP_TIMEOUT_MS ?? '10000')
const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
try {
  const response = await fetch(url, { ...options, signal: controller.signal })
} finally {
  clearTimeout(timeoutId)
}
```

**A5** — Capture response body in `last_error`:
```typescript
const bodyText = await response.text().catch(() => '')
lastError = `HTTP ${response.status}: ${bodyText.slice(0, 500)}`
```

**A6/Q5** — Update `last_error` on every retry:
```sql
UPDATE failed_callbacks SET attempts = attempts + 1, last_attempt_at = ..., last_error = ? WHERE id = ?
```

Add methods: `sendInterimFailureCallback()`, `sendExpiredCallback()`.

### Acceptance Criteria
- [ ] 503 response: retried 4 times with [0, 1s, 2s, 4s] backoff
- [ ] 400 response: breaks after 1 attempt (non-retryable)
- [ ] 500 response: retried 4 times with standard backoff
- [ ] Empty HMAC secret: server fails to boot
- [ ] Fetch timeout: aborts after 10s (or configured value)
- [ ] `failed_callbacks.last_error` contains response body on failure
- [ ] `retryFailedCallback` updates `last_error` each attempt
- [ ] `interim_failure` callback type works end-to-end
- [ ] `expired` callback type works end-to-end
- [ ] Tests pass (T3, T9, T12 covered here)

---

## Batch 5: Oralsin Plugin Contract

**Commit**: `fix(oralsin): input validation, phone normalization, context merge, sender resolution`
**Findings**: S9, S10, S11, S12, P1, P10, Q2
**Decisions**: #17, #26, #29, #37, #39

### Files to Modify

#### `packages/core/src/plugins/oralsin-plugin.ts` (223 lines)

**S11** — Phone fields E.164 regex:
```typescript
const phoneSchema = z.string().regex(/^\+?\d{10,15}$/, 'Must be 10-15 digits, optional + prefix')
```
Apply to `senderSchema.phone`, `patientSchema.phone`.

**S10** — `message.text` max length:
```typescript
text: z.string().min(1).max(4096)
```

**S12** — Batch max:
```typescript
z.array(enqueueItemSchema).min(1).max(500)
```

**S9** — Context max size:
```typescript
context: z.record(z.unknown()).optional().superRefine((val, ctx) => {
  if (val && JSON.stringify(val).length > 65536) {
    ctx.addIssue({ code: 'custom', message: 'context exceeds 64KB' })
  }
})
```

#### `packages/core/src/plugins/plugin-loader.ts` (196 lines)

**P1/Decision #17** — Merge `patientId` and `templateId` into context:
```typescript
const mergedContext = {
  ...m.context,
  ...(m.patient.patientId ? { patient_id: m.patient.patientId } : {}),
  ...(m.message.templateId ? { template_id: m.message.templateId } : {}),
}
// store JSON.stringify(mergedContext) in context column
```

**P10** — Remove `senders[0]?.phone` fallback. Always use `resolveSenderChain`:
```typescript
// REMOVE: m.resolvedSenderPhone ?? m.senders[0]?.phone ?? null
// REPLACE: m.resolvedSenderPhone ?? null
// If null, the item was already rejected by oralsin-plugin.ts
```

#### `packages/core/src/engine/sender-mapping.ts` (207 lines)

**Decision #39** — Normalize phone to digits-only in both create and lookup:
```typescript
private normalizePhone(phone: string): string {
  return phone.replace(/\D/g, '')
}

create(params: CreateSenderMappingParams): SenderMappingRecord {
  const normalized = this.normalizePhone(params.phoneNumber)
  // INSERT with normalized
}

getByPhone(phoneNumber: string): SenderMappingRecord | null {
  const normalized = this.normalizePhone(phoneNumber)
  // SELECT with normalized
}
```

**Q2** — `resolveSenderChain` filters paused senders:
```typescript
resolveSenderChain(senders: SenderConfig[]): ResolvedSender | null {
  for (const sender of senders) {
    const record = this.getByPhone(sender.phone)
    if (record && record.paused === 0) {
      return { mapping: record, sender }
    }
  }
  return null
}
```

### Acceptance Criteria
- [ ] Phone "+554396837945" and "554396837945" both resolve to same sender_mapping row
- [ ] `message.text` > 4096 chars: 400 error
- [ ] Batch > 500 items: 400 error
- [ ] Context > 64KB: 400 error
- [ ] `patientId` and `templateId` appear in stored `context` JSON
- [ ] Paused sender skipped, next sender in chain used
- [ ] `senders[0]?.phone` fallback removed — no unresolved phone reaches DB
- [ ] Tests pass (T5, T6 covered here)

---

## Batch 6: Server Integration

**Commit**: `fix(server): auth hardening, plugin route security, config validation, callback wiring`
**Findings**: S1, S2, S3, S4, S7, S8, S13, P2, P3, P6, P9, R12, A11, D43
**Decisions**: #22, #25, #26, #32, #43

### Files to Modify

#### `packages/core/src/server.ts` (824 lines)

**S1/S2** — Plugin route auth: `timingSafeEqual`, all HTTP methods:
```typescript
import { timingSafeEqual } from 'node:crypto'

server[method](fullPath, async (req, reply) => {
  if (apiKey) {
    const providedKey = (req.headers as Record<string, string>)['x-api-key'] ?? ''
    if (providedKey.length !== apiKey.length ||
        !timingSafeEqual(Buffer.from(providedKey), Buffer.from(apiKey))) {
      return reply.status(401).send({ error: 'Invalid API key' })
    }
  }
  return route.handler(req, reply)
})
```

**S4** — Strip secrets from admin GET responses:
```typescript
const sanitize = (p: PluginRecord) => {
  const { api_key, hmac_secret, ...safe } = p
  return safe
}
```

**S7** — Validate plugin route paths:
```typescript
if (!/^\/[a-zA-Z0-9/_-]*$/.test(route.path)) {
  throw new Error(`Plugin ${route.pluginName}: invalid route path: ${route.path}`)
}
```

**S8** — Fastify body limit:
```typescript
const server = Fastify({ logger: loggerConfig, bodyLimit: 1_048_576 })
```

**S13** — `/healthz` degraded without API key:
```typescript
// If no valid API key provided, return minimal response
return reply.send({ status: 'ok' })
// With API key: return full topology
```

**A11** — Fix pino logger child:
```typescript
const pinoLogger = {
  child: (bindings: Record<string, unknown>) => server.log.child(bindings)
}
```

**P2** — Emit `message:queued` from plugin enqueue path:
```typescript
// After enqueueBatch returns, for each message:
emitter.emit('message:queued', { id: msg.id, pluginName: msg.pluginName })
```

**P3** — Guard `JSON.parse(msg.context)`:
```typescript
let parsedContext: Record<string, unknown> | undefined
try {
  parsedContext = msg.context ? JSON.parse(msg.context) : undefined
} catch (err) {
  server.log.error({ err, messageId: msg.id }, 'Malformed context JSON')
  parsedContext = undefined
}
```

**P6** — WAHA fallback `message:sent` includes all fields (in worker-orchestrator.ts):
```typescript
emitter.emit('message:sent', {
  id: message.id,
  sentAt: new Date().toISOString(),
  durationMs: elapsed,
  deviceSerial,
  contactRegistered: false,
  dialogsDismissed: 0,
  strategyMethod: 'waha_fallback',
  appPackage: message.appPackage ?? 'com.whatsapp',
  senderNumber: message.senderNumber,
})
```

**P9** — Scope `waha:message_received` query:
```typescript
const incomingHistory = messageHistory.query({
  fromNumber: data.fromNumber,
  toNumber: data.toNumber,
  direction: 'incoming',
  limit: 1,
})
if (!incomingHistory.length || !incomingHistory[0].text) return
```

**Decision #43** — `fallback_reason` with real error (requires storing error in sendMetadata or DB):
```typescript
// In worker-orchestrator processMessage catch:
const errorCode = classifyError(err) // 'ban_detected', 'device_offline', 'typing_timeout', etc.
orchestrator.storeFallbackError(message.id, errorCode, err.message)

// In server.ts callback builder:
fallback_reason: msg.fallbackUsed ? {
  original_error: orchestrator.getFallbackError(data.id)?.code ?? 'adb_failed',
  original_message: orchestrator.getFallbackError(data.id)?.message,
  original_session: senderSession,
  quarantined: senderHealth.isQuarantined(msg.senderNumber),
} : undefined
```

**R12** — Webhook URL mandatory check moved to config-schema (handled in Batch 6 config).

#### `packages/core/src/config/config-schema.ts` (184 lines)

**S3/R12/Decision #22** — Add conditional required fields in `superRefine`:
```typescript
const plugins = data.DISPATCH_PLUGINS?.split(',').map(s => s.trim()).filter(Boolean) ?? []
if (plugins.includes('oralsin')) {
  if (!data.PLUGIN_ORALSIN_API_KEY) ctx.addIssue({ ... })
  if (!data.PLUGIN_ORALSIN_HMAC_SECRET) ctx.addIssue({ ... })
  if (!data.PLUGIN_ORALSIN_WEBHOOK_URL) ctx.addIssue({ ... })
}
if (plugins.length > 0 && !data.DISPATCH_WEBHOOK_ALLOWED_DOMAINS) {
  ctx.addIssue({ message: 'DISPATCH_WEBHOOK_ALLOWED_DOMAINS required when plugins enabled' })
}
```

Add new env vars:
```typescript
DISPATCH_WEBHOOK_ALLOWED_DOMAINS: z.string().optional(),
DISPATCH_HTTP_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(10000),
```

**Decision #22** — Webhook URL allowlist validation utility:
```typescript
function validateWebhookUrl(url: string, allowedDomains: string[], isProd: boolean): boolean {
  const parsed = new URL(url)
  if (isProd && parsed.protocol !== 'https:') return false
  return allowedDomains.some(domain => parsed.hostname.endsWith(domain))
}
```

#### `packages/core/src/api/api-auth.ts` (37 lines)

**S13/Decision #12** — Remove `/metrics` from `PUBLIC_ROUTES`:
```typescript
const PUBLIC_ROUTES = [
  '/api/v1/health',
  // '/metrics' removed — now requires API key
]
```

#### `packages/core/src/engine/worker-orchestrator.ts` (340 lines)

**P6** — Populate all fields in WAHA fallback emit (see above).

**D2** — Update all `updateStatus` calls to pass `from` parameter.

### Acceptance Criteria
- [ ] GET plugin route requires API key
- [ ] Admin GET does not expose `api_key` or `hmac_secret`
- [ ] Body > 1MB: 413 error
- [ ] Plugin route with path `/../admin`: rejected at registration
- [ ] `/healthz` without API key: returns only `{ status: "ok" }`
- [ ] `/metrics` without API key: 401
- [ ] Missing `PLUGIN_ORALSIN_API_KEY` with `DISPATCH_PLUGINS=oralsin`: boot fails
- [ ] `message:queued` event fires for plugin enqueue
- [ ] Malformed context JSON: logged, callback sent with undefined context
- [ ] WAHA fallback callback has `senderNumber`, `strategyMethod: 'waha_fallback'`
- [ ] `fallback_reason.original_error` contains real engine error
- [ ] Tests pass

---

## Batch 7: Observability & Metrics

**Commit**: `feat(metrics): plugin metrics, callback counters, queue depth per-plugin, dashboards`
**Findings**: A4, A7, A8, A9, A10, A12, A13
**Decisions**: #20, #23, #34

### Files to Modify

#### `packages/core/src/config/metrics.ts` (88 lines)

Add 4+ new metrics:
```typescript
// Callback delivery
export const callbacksTotal = new Counter({
  name: 'dispatch_callbacks_total',
  help: 'Total callbacks sent',
  labelNames: ['plugin', 'type', 'status'],  // type: result/ack/interim_failure/expired, status: success/failed
})

// Plugin errors
export const pluginErrorsTotal = new Counter({
  name: 'dispatch_plugin_errors_total',
  help: 'Plugin handler errors',
  labelNames: ['plugin', 'event'],
})

// Queue depth per plugin
export const queueDepthByPlugin = new Gauge({
  name: 'dispatch_queue_depth_by_plugin',
  help: 'Queue depth per plugin',
  labelNames: ['plugin', 'status'],
})

// WAHA dedup misses
export const wahaDedupmissTotal = new Counter({
  name: 'dispatch_waha_dedup_miss_total',
  help: 'WAHA dedup window misses',
})
```

**A7** — Fix `messagesQueuedTotal` label:
```typescript
// In server.ts message:queued listener:
messagesQueuedTotal.inc({ plugin: data.pluginName ?? 'direct' })
```

**A9** — Fix exhausted threshold:
```typescript
// In server.ts message:failed listener:
const isExhausted = data.attempts >= (msg?.maxRetries ?? 3)
messagesFailedTotal.inc({ sender: data.senderNumber ?? 'unknown', error_type: isExhausted ? 'exhausted' : 'transient' })
```

#### `packages/core/src/server.ts` (824 lines)

**A3/Decision #20** — Wire `pluginEventBus.onError()`:
```typescript
pluginEventBus.onError((pluginName, event, error) => {
  server.log.error({ plugin: pluginName, event, err: error }, 'Plugin handler error')
  pluginErrorsTotal.inc({ plugin: pluginName, event })
})
```

**A4** — Log + metric on callback success:
```typescript
// In callback-delivery.ts after successful delivery:
callbacksTotal.inc({ plugin: pluginName, type: callbackType, status: 'success' })
```

**A13** — WAHA dedup miss signal:
```typescript
// In webhook-handler.ts when findByDedup returns null for outgoing:
server.log.warn({ toNumber, wahaTimestamp }, 'WAHA dedup window miss — no matching ADB send')
wahaDedupmissTotal.inc()
```

#### `packages/core/src/api/audit.ts` (348 lines)

**A12** — Document event-sourcing contract: every status transition must write a `message_events` row. Add missing events for `cleanStaleLocks` and requeue paths.

#### `packages/core/src/waha/webhook-handler.ts` (154 lines)

**A13** — Log warning on dedup miss.
**P7/Decision #18** — Unify dedup window to 30s.

#### Grafana Dashboards

Update 4 dashboard JSON files in `monitoring/grafana/dashboards/`:
- `dispatch-overview.json`: Add callback success/failure panels, queue depth per plugin
- `sender-health.json`: Add plugin error rate panel
- Add `dispatch_waha_dedup_miss_total` to anti-ban dashboard

### Acceptance Criteria
- [ ] `dispatch_callbacks_total{plugin="oralsin",type="result",status="success"}` increments on callback delivery
- [ ] `dispatch_plugin_errors_total{plugin="oralsin",event="message:sent"}` increments on handler error
- [ ] `dispatch_queue_depth_by_plugin{plugin="oralsin",status="queued"}` reflects actual queue state
- [ ] `dispatch_waha_dedup_miss_total` increments on window miss
- [ ] `messagesQueuedTotal` uses actual plugin name
- [ ] Exhausted threshold matches `message.maxRetries`
- [ ] Grafana dashboards updated with new panels
- [ ] Tests pass

---

## Batch 8: Resilience & Recovery

**Commit**: `fix(resilience): sending recovery, graceful shutdown, backoff, TTL, interim_failure wiring`
**Findings**: R1, R5, R7, A1, A2, P5
**Decisions**: #8, #9, #14, #15, #21, #41, #42

### Files to Modify

#### `packages/core/src/queue/message-queue.ts` (522 lines)

**R1/Decision #9** — Extend `cleanStaleLocks` to recover `sending`:
```typescript
// Recover locked > 120s
// Recover sending > 300s (2x worst case send timeout)
cleanStaleLocks(): number {
  const lockedCount = db.prepare(`
    UPDATE messages SET status = 'queued', locked_by = NULL, locked_at = NULL, updated_at = ...
    WHERE status = 'locked' AND locked_at < datetime('now', '-120 seconds')
  `).run().changes

  const sendingCount = db.prepare(`
    UPDATE messages SET status = 'queued', locked_by = NULL, locked_at = NULL, updated_at = ...
    WHERE status = 'sending' AND updated_at < datetime('now', '-300 seconds')
  `).run().changes

  return lockedCount + sendingCount
}
```

**A1** — Log stale lock recovery + write `message_events`:
```typescript
if (count > 0) {
  logger.info({ event: 'stale_recovery', lockedCount, sendingCount }, 'Recovered stale messages')
  // Write message_events for each recovered message
}
```

#### `packages/core/src/engine/worker-orchestrator.ts` (340 lines)

**R7/Decision #15** — Backoff exponencial no tick:
```typescript
private tickBackoff = 5_000 // base 5s
private readonly MAX_BACKOFF = 60_000

tick(): void {
  // ... existing logic
  if (sentCount === 0) {
    this.tickBackoff = Math.min(this.tickBackoff * 2, this.MAX_BACKOFF)
  } else {
    this.tickBackoff = 5_000 // reset on success
  }
}

getTickInterval(): number { return this.tickBackoff }
```
Server.ts: use dynamic interval instead of fixed 5000ms.

**A2** — User-switch requeue writes `message_events`:
```typescript
// When requeuing due to device switch failure:
for (const msg of batch) {
  this.recorder?.record(msg.id, 'requeue_device_switch', { reason: 'switchToUser failed' })
  queue.updateStatus(msg.id, 'locked', 'queued')
}
```

**Decision #41** — `interim_failure` callback wiring:
```typescript
// In processMessage catch (ADB failed, before WAHA fallback):
const errorCode = classifyError(err)
callbackDelivery.sendInterimFailureCallback(msg.pluginName, msg.id, {
  idempotency_key: msg.idempotencyKey,
  correlation_id: msg.correlationId,
  error: { code: errorCode, message: err.message, retryable: true },
  failed_sender: { phone: msg.senderNumber, session: senderSession, pair: pairUsed },
  next_sender: nextSenderInChain ?? null,
  attempt: msg.attempts + 1,
  context: msg.context ? JSON.parse(msg.context) : undefined,
})
```

**Decision #42** — `expired` callback wiring (in TTL check):
```typescript
// When waiting_device → permanently_failed due to TTL:
callbackDelivery.sendExpiredCallback(msg.pluginName, msg.id, {
  idempotency_key: msg.idempotencyKey,
  correlation_id: msg.correlationId,
  error: { code: 'ttl_expired', message: `No device available for ${ttlHours}h`, retryable: false },
  context: msg.context ? JSON.parse(msg.context) : undefined,
})
```

#### `packages/core/src/config/graceful-shutdown.ts` (99 lines)

**R5/Decision #14** — Wire `markSendActive`:
```typescript
// In worker-orchestrator processMessage:
const sendPromise = engine.send(deviceSerial, message, appPackage)
gracefulShutdown.markSendActive(sendPromise)
await sendPromise
```

#### `packages/core/src/server.ts` (824 lines)

**R7** — Dynamic tick interval:
```typescript
// Replace fixed setInterval with dynamic:
const scheduleTick = () => {
  setTimeout(async () => {
    await orchestrator.tick()
    if (!shuttingDown) scheduleTick()
  }, orchestrator.getTickInterval())
}
scheduleTick()
```

**Decision #8** — TTL check in hourly cleanup:
```typescript
// In the hourly cleanup interval:
const expired = queue.expireWaitingDeviceMessages(ttlMs)
for (const msg of expired) {
  emitter.emit('message:expired', { id: msg.id, ... })
}
```

### Acceptance Criteria
- [ ] Message stuck in `sending` for 6 min: recovered to `queued`
- [ ] Message stuck in `locked` for 3 min: recovered to `queued`
- [ ] Stale recovery: logged with count and message IDs
- [ ] Stale recovery: `message_events` row written per message
- [ ] SIGTERM during active send: waits up to 30s for completion
- [ ] All senders capped: tick backs off to 60s max
- [ ] First successful send: tick resets to 5s
- [ ] Device switch requeue: `message_events` row with `requeue_device_switch`
- [ ] `interim_failure` callback sent before WAHA fallback
- [ ] `expired` callback sent when TTL expires
- [ ] `waiting_device` messages transition to `permanently_failed` after TTL
- [ ] Tests pass

---

## Batch 9: Test Suite

**Commit**: `test(plugins): E2E flow, route coverage, HMAC verification, edge cases`
**Findings**: T1-T14
**Decision**: #38

### Test Files to Create/Modify

#### T1 — E2E Integration Test (HIGHEST PRIORITY)
**File**: `packages/core/src/plugins/plugin-e2e.test.ts` (NEW)

Test the complete loop with mocked ADB:
```
enqueue → dequeueBySender → engine.send (mocked) → message:sent
→ PluginEventBus → CallbackDelivery → HTTP POST (mocked)
```
Verify: callback payload contains all expected fields, HMAC is correct.

#### T2 — Route Coverage
**File**: `packages/core/src/plugins/oralsin-routes.test.ts` (NEW)

- `POST /contacts/pre-register`: valid payload, invalid payload, ctx=null
- `GET /status`: returns plugin name, version, events
- `GET /queue`: returns stats, ctx=null returns 503

#### T3 — HMAC Verification
**File**: Update `callback-delivery.test.ts`

Verify exact HMAC value:
```typescript
const expected = createHmac('sha256', secret).update(body).digest('hex')
expect(headers['X-Dispatch-Signature']).toBe(expected)
```

#### T4 — 409 Duplicate at Oralsin Route Layer
**File**: Update `oralsin-sender-resolution.test.ts`
```typescript
it('returns 409 when idempotency key already exists')
```

#### T5 — Partial Batch (Mixed Resolve/Reject)
```typescript
it('partial batch: enqueues resolvable, rejects unresolvable, returns 201 with rejected_details')
```

#### T6 — `destroyAll` with Multiple Plugins
**File**: Update `plugin-loader.test.ts`
```typescript
it('destroyAll calls destroy on all plugins even if first throws')
```

#### T7 — `getMessageStatus`
```typescript
it('getMessageStatus returns null for unknown id')
it('getMessageStatus returns PluginMessage shape for known id')
```

#### T8 — Post-Destroy Dispatch
**File**: Update `plugin-event-bus.test.ts`
```typescript
it('does not dispatch events after destroy()')
```

#### T9 — Callback 4xx/503 Short-Circuit
**File**: Update `callback-delivery.test.ts`
```typescript
it('stops retrying on 400 after first attempt')
it('retries on 503 with short backoff [0, 1s, 2s, 4s]')
it('retries all 4 times on 500')
```

#### T10 — `getPluginByApiKey` with Disabled Plugin
**File**: Update `plugin-registry.test.ts`
```typescript
it('getPluginByApiKey returns null for disabled plugin')
```

#### T11 — `updatePlugin` Dual Fields
```typescript
it('updatePlugin with both webhookUrl and events simultaneously')
```

#### T12 — `retryFailedCallback` Failure Path
```typescript
it('increments attempts and updates last_error on failed retry')
```

#### T13/T14 — Timer Fixes
**File**: Update `plugin-event-bus.test.ts`
- Use `vi.useFakeTimers()` for timeout test
- Move `vi.useRealTimers()` to `afterEach`

### Acceptance Criteria
- [ ] E2E test covers: enqueue → send → callback → HMAC verified
- [ ] All 3 public Oralsin routes have tests
- [ ] HMAC value verified cryptographically (not just existence)
- [ ] 409 tested at route layer
- [ ] Partial batch tested with mixed resolve/reject
- [ ] `destroyAll` resilience tested
- [ ] Post-destroy silence tested
- [ ] 4xx/503/5xx callback behaviors tested individually
- [ ] All timer tests use fake timers
- [ ] Full test suite passes: `pnpm test`

---

## Batch 10: Grafana Dashboards & Documentation

**Commit**: `docs(hardening): dashboards, cross-repo contract, grill decisions`
**Decisions**: #23, #24

### Files to Create/Modify

#### Grafana Dashboards
- `monitoring/grafana/dashboards/dispatch-overview.json` — add callback panels, per-plugin depth
- `monitoring/grafana/dashboards/sender-health.json` — add plugin error panel
- `monitoring/grafana/dashboards/anti-ban-fingerprint.json` — add dedup miss panel

#### Prometheus Config
- `monitoring/prometheus/prometheus.yml` — add `authorization` header for `/metrics` scrape:
```yaml
scrape_configs:
  - job_name: 'dispatch'
    static_configs:
      - targets: ['host.docker.internal:7890']
    authorization:
      type: 'ApiKey'
      credentials: '${DISPATCH_API_KEY}'
    metrics_path: '/metrics'
```

#### Cross-Repo Contract Document
- `docs/contract-dispatch-oralsin.md` (NEW) — Document:
  - Enqueue request schema
  - All 5 callback types: `result`, `ack`, `patient_response`, `interim_failure`, `expired`
  - Phone format rules
  - Sender resolution logic
  - 503/retry semantics
  - HMAC verification instructions
  - `fallback_reason` with real error codes

#### Python-Side Changes Document
- `docs/cross-repo/oralsin-callback-handler-changes.md` (NEW) — Document:
  - `handle_interim_failure(payload)` — implementation spec
  - `handle_expired(payload)` — implementation spec
  - `dispatch_callback_view.py` routing changes
  - Prometheus metric additions

#### Update `.dev-state/progress.md`

### Acceptance Criteria
- [ ] All Grafana dashboards load without errors
- [ ] Prometheus scrapes with API key successfully
- [ ] Contract document covers all 5 callback types
- [ ] Python-side changes documented with code examples
- [ ] `.dev-state/progress.md` updated

---

## Post-Execution Verification

After all 10 batches:

```bash
# 1. Full test suite
pnpm test

# 2. Server starts with all env vars
DISPATCH_PLUGINS=oralsin \
PLUGIN_ORALSIN_API_KEY=test-key \
PLUGIN_ORALSIN_HMAC_SECRET=test-secret \
PLUGIN_ORALSIN_WEBHOOK_URL=https://api.oralsin.debt.com.br/api/v1/webhooks/dispatch/callback/ \
DISPATCH_WEBHOOK_ALLOWED_DOMAINS=debt.com.br \
DISPATCH_API_KEY=admin-key \
pnpm --filter @dispatch/core start

# 3. Server FAILS to start without required vars
DISPATCH_PLUGINS=oralsin pnpm --filter @dispatch/core start
# Expected: Error — PLUGIN_ORALSIN_API_KEY required

# 4. Verify schema
sqlite3 dispatch.db ".schema messages"    # sent_at column, CHECK, FK
sqlite3 dispatch.db ".schema plugins"     # ISO timestamps
sqlite3 dispatch.db ".indexes messages"   # idx_messages_plugin_name

# 5. E2E test send (if device available)
curl -X POST http://localhost:7890/api/v1/plugins/oralsin/enqueue \
  -H "X-API-Key: test-key" \
  -H "Content-Type: application/json" \
  -d '{"idempotency_key":"hardening-test-1","patient":{"phone":"5543991938235","name":"Test"},"message":{"text":"Hardening sprint complete"},"senders":[{"phone":"+554396837945","session":"oralsin_1_4","pair":"oralsin-1-4","role":"primary"}]}'
```

---

## Cross-Repo Dependency (BLOQUEANTE para deploy)

Before deploying Dispatch with these changes, the Python/Oralsin side must:

1. **Add `handle_interim_failure`** in `DispatchCallbackHandler`
2. **Add `handle_expired`** in `DispatchCallbackHandler`
3. **Update `dispatch_callback_view.py`** routing for new event types
4. **Deploy Python changes first** (Decision #24)
5. **Then deploy Dispatch**

---

## Summary

| Batch | Scope | Findings | Est. Files |
|-------|-------|----------|------------|
| 1 | DB Schema & Config | 10 | 4 |
| 2 | State Machine & Queue | 9 | 3 |
| 3 | Plugin Core | 8 | 3 |
| 4 | Callback System | 7 | 2 |
| 5 | Oralsin Contract | 7 | 3 |
| 6 | Server Integration | 14 | 5 |
| 7 | Observability & Metrics | 7 | 5+ |
| 8 | Resilience & Recovery | 6 | 4 |
| 9 | Tests | 14 | 8+ |
| 10 | Dashboards & Docs | — | 6+ |
| **Total** | | **82 unique** | |

> 5 findings (Q5=A6 duplicate, DB6/DB7 resolved by decisions, S14 label kept) are resolved within other batches.
