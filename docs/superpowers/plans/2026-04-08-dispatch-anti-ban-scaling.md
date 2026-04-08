# Dispatch Anti-Ban & Scaling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement anti-ban fingerprint diversification, Play Integrity hardening, configurable rate limits, and WABA sender expansion to safely scale Dispatch ADB from 200 to 2000+ msgs/day on a single POCO C71.

**Architecture:** Three layers — (1) SendStrategy diversifies HOW chats are opened to break the `click_to_chat_link` monoculture, (2) RateLimitGuard enforces per-sender daily caps and Reachout Timelock delays as configurable policy, (3) root hiding stack hardens the device against Play Integrity checks. WABA accounts double sender count from 4 to 8.

**Tech Stack:** Node.js 22, TypeScript strict, Vitest, better-sqlite3 WAL, adbkit, Magisk 28.1

**Trade-off aceito pelo stakeholder:** O limite de 50 msgs/dia/numero eh inviavel para o volume necessario. O sistema implementara limites configuráveis com defaults agressivos (150/dia/sender) e monitoramento de restricoes para ajuste dinamico. O risco de ban eh aceito como trade-off de negocio.

---

## Dependency Graph

```
T1 (SendStrategy) ──────┐
                         ├──► T5 (E2E Validation)
T2 (RateLimitGuard) ─────┤
                         │
T3 (Root Hiding) ────────┤
                         │
T4 (WABA Senders) ───────┘
                         
T6 (Monitoring + Auto-Quarantine) ──► after T5
```

**Execution:**
- Phase A (parallel): T1 + T2 + T3 (independent code changes)
- Phase B (parallel after T1): T4 (needs SendStrategy for app_package routing)
- Phase C (gate): T5 (E2E validation — blocks production)
- Phase D (after T5): T6 (monitoring polish)

---

## Reference: Key Research Findings

| Finding | Source | Impact on Plan |
|---------|--------|---------------|
| `entryPointSource=click_to_chat_link` logged 29x/day | Device log analysis | T1: diversify chat open method |
| Reachout Timelock = 60s default for new contacts | Baileys #2441 | T2: configurable first-contact delay |
| Play Integrity: bootloader=orange, DenyList empty | Device analysis | T3: root hiding stack |
| 15-20 msgs/day to unsaved contacts = progressive ban | Baileys #1983 | T2: per-sender daily cap |
| 200-300 msgs/day for 3 years without ban (saved contacts) | whatsapp-web.js #3250 | Saved contacts dramatically reduce risk |
| BizIntegritySignalsStore called 28x/day | Device log | T3: Play Integrity must pass |
| wa.me?text= is official WhatsApp API | WhatsApp FAQ | T1: keep as primary method |
| WABA (com.whatsapp.w4b) is separate package | Android package system | T4: double sender capacity |

**Full research docs:**
- `docs/dispatch-complete-security-audit.md` — 8 fingerprints, evidence, mitigations
- `docs/research-ban-risk-reality.md` — device forensics + 83 web sources
- `docs/research-consolidated-findings.md` — 4 agents synthesis
- `docs/research-test-results.md` — 16 hardware tests

---

## File Structure

```
packages/core/src/
├── engine/
│   ├── send-strategy.ts        ← NEW: chat open method selector (wa.me / search / chat list)
│   ├── send-strategy.test.ts   ← NEW: tests for strategy distribution + each method
│   ├── send-engine.ts          ← MODIFY: use SendStrategy instead of hardcoded wa.me
│   └── send-engine.test.ts     ← MODIFY: test strategy integration
├── config/
│   ├── rate-limits.ts          ← NEW: per-sender daily cap + Reachout Timelock logic
│   └── rate-limits.test.ts     ← NEW: tests for limits
├── queue/
│   └── message-queue.ts        ← MODIFY: add sender daily count query
├── server.ts                   ← MODIFY: wire RateLimitGuard into worker loop
└── adb/
    └── adb-bridge.ts           ← MODIFY: add app_package param for WABA support
```

---

## Task 1: SendStrategy — Diversify Chat Open Method

**Problem:** 100% of messages use `wa.me?text=` deep link, producing `entryPointSource=click_to_chat_link` for every message. This is anomalous — real users open chats from the conversation list, search, and links in varying proportions.

**Solution:** `SendStrategy` selects the chat opening method per message based on configurable weights. Three methods: wa.me pre-fill (fast), search-based (types number in search), chat-list (scrolls to recent contact).

**Files:**
- Create: `packages/core/src/engine/send-strategy.ts`
- Create: `packages/core/src/engine/send-strategy.test.ts`
- Modify: `packages/core/src/engine/send-engine.ts`
- Modify: `packages/core/src/engine/send-engine.test.ts`
- Modify: `packages/core/src/engine/index.ts`

### Step 1: Create SendStrategy with weighted random selection

- [ ] **1.1 Write send-strategy.test.ts**

```typescript
// packages/core/src/engine/send-strategy.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SendStrategy, type ChatOpenMethod } from './send-strategy.js'

describe('SendStrategy', () => {
  describe('selectMethod', () => {
    it('returns a valid ChatOpenMethod', () => {
      const strategy = new SendStrategy()
      const method = strategy.selectMethod()
      expect(['prefill', 'search', 'typing']).toContain(method)
    })

    it('respects weight distribution over 1000 samples', () => {
      const strategy = new SendStrategy({ prefillWeight: 50, searchWeight: 30, typingWeight: 20 })
      const counts: Record<string, number> = { prefill: 0, search: 0, typing: 0 }
      for (let i = 0; i < 1000; i++) {
        counts[strategy.selectMethod()]++
      }
      // Allow 10% tolerance
      expect(counts.prefill).toBeGreaterThan(400)
      expect(counts.prefill).toBeLessThan(600)
      expect(counts.search).toBeGreaterThan(200)
      expect(counts.search).toBeLessThan(400)
      expect(counts.typing).toBeGreaterThan(100)
      expect(counts.typing).toBeLessThan(300)
    })

    it('returns prefill when weights are 100/0/0', () => {
      const strategy = new SendStrategy({ prefillWeight: 100, searchWeight: 0, typingWeight: 0 })
      for (let i = 0; i < 100; i++) {
        expect(strategy.selectMethod()).toBe('prefill')
      }
    })
  })

  describe('generateTypingIndicator', () => {
    it('returns true for typing and search methods', () => {
      const strategy = new SendStrategy()
      expect(strategy.generatesTypingIndicator('typing')).toBe(true)
      expect(strategy.generatesTypingIndicator('search')).toBe(true)
      expect(strategy.generatesTypingIndicator('prefill')).toBe(false)
    })
  })
})
```

- [ ] **1.2 Run test to verify it fails**

```bash
npx vitest run packages/core/src/engine/send-strategy.test.ts
# Expected: FAIL — module not found
```

- [ ] **1.3 Implement SendStrategy**

```typescript
// packages/core/src/engine/send-strategy.ts

export type ChatOpenMethod = 'prefill' | 'search' | 'typing'

export interface SendStrategyConfig {
  /** Weight for wa.me?text= pre-fill (fast, no typing indicator). Default: 50 */
  prefillWeight: number
  /** Weight for search-based open (types number in WA search bar). Default: 30 */
  searchWeight: number
  /** Weight for typing-based open (wa.me without text, types message). Default: 20 */
  typingWeight: number
}

const DEFAULT_CONFIG: SendStrategyConfig = {
  prefillWeight: 50,
  searchWeight: 30,
  typingWeight: 20,
}

export class SendStrategy {
  private config: SendStrategyConfig

  constructor(config?: Partial<SendStrategyConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Select chat open method based on weighted random distribution.
   * Diversifies entryPointSource to avoid 100% click_to_chat_link anomaly.
   */
  selectMethod(): ChatOpenMethod {
    const { prefillWeight, searchWeight, typingWeight } = this.config
    const total = prefillWeight + searchWeight + typingWeight
    const roll = Math.random() * total

    if (roll < prefillWeight) return 'prefill'
    if (roll < prefillWeight + searchWeight) return 'search'
    return 'typing'
  }

  /** Whether the method generates a "typing..." indicator for the recipient */
  generatesTypingIndicator(method: ChatOpenMethod): boolean {
    return method !== 'prefill'
  }
}
```

- [ ] **1.4 Run tests — should pass**

```bash
npx vitest run packages/core/src/engine/send-strategy.test.ts
# Expected: 3 tests PASS
```

- [ ] **1.5 Export from engine/index.ts**

Add to `packages/core/src/engine/index.ts`:
```typescript
export { SendStrategy } from './send-strategy.js'
export type { ChatOpenMethod, SendStrategyConfig } from './send-strategy.js'
```

- [ ] **1.6 Commit**

```bash
git add packages/core/src/engine/send-strategy.ts packages/core/src/engine/send-strategy.test.ts packages/core/src/engine/index.ts
git commit -m "feat(engine): SendStrategy — weighted random chat open method selection"
```

### Step 2: Implement search-based and typing-based chat open in SendEngine

- [ ] **2.1 Add openViaSearch and openViaTyping methods to SendEngine**

Add to `packages/core/src/engine/send-engine.ts` (before `tapSendButton`):

```typescript
/**
 * Open chat via WhatsApp search bar — generates entryPointSource=search.
 * Types the phone number in the search field, taps the result.
 */
private async openViaSearch(deviceSerial: string, phone: string, body: string): Promise<void> {
  // Open WhatsApp home (already open for non-first in batch)
  // Tap search icon (magnifying glass)
  await this.adb.shell(deviceSerial, 'input tap 624 172')
  await this.delay(1000)

  // Type phone number in search field
  const last4 = phone.slice(-4)
  await this.adb.shell(deviceSerial, `input text '${last4}'`)
  await this.delay(1500)

  // Tap first search result
  await this.adb.shell(deviceSerial, 'input tap 360 350')
  await this.delay(2000)

  // Now in chat — type the message (generates typing indicator)
  await this.typeMessage(deviceSerial, body)
}

/**
 * Open chat via wa.me WITHOUT text pre-fill, then type manually.
 * Generates entryPointSource=click_to_chat_link BUT with typing indicator.
 */
private async openViaTyping(deviceSerial: string, phone: string, body: string): Promise<void> {
  await this.adb.shell(
    deviceSerial,
    `am start -a android.intent.action.VIEW -d "https://wa.me/${phone}" -p com.whatsapp`,
  )
  await this.delay(2000)
  await this.waitForChatReady(deviceSerial)
  await this.typeMessage(deviceSerial, body)
}
```

- [ ] **2.2 Modify send() to use SendStrategy**

Replace the current chat opening block in `send()` (lines 56-76) with strategy-based selection:

```typescript
// Select chat opening method (diversifies entryPointSource fingerprint)
const method = this.strategy.selectMethod()

if (method === 'prefill') {
  // wa.me?text= pre-fill (fast, no typing indicator)
  const encodedBody = encodeURIComponent(message.body)
  const deepLink = `https://wa.me/${phoneDigits}?text=${encodedBody}`
  const usePreFill = deepLink.length < 2000

  await this.adb.shell(
    deviceSerial,
    `am start -a android.intent.action.VIEW -d "${usePreFill ? deepLink : `https://wa.me/${phoneDigits}`}" -p com.whatsapp`,
  )
  await this.delay(isFirstInBatch ? 4000 : 2000)
  dialogsDismissed = await this.waitForChatReady(deviceSerial)
  if (!usePreFill) {
    await this.typeMessage(deviceSerial, message.body)
  }
} else if (method === 'search') {
  // Search-based open (entryPointSource=search, typing indicator=yes)
  if (isFirstInBatch) {
    await this.adb.shell(deviceSerial, 'am start -n com.whatsapp/com.whatsapp.HomeActivity')
    await this.delay(3000)
  }
  await this.openViaSearch(deviceSerial, phoneDigits, message.body)
} else {
  // Typing-based open (entryPointSource=click_to_chat, typing indicator=yes)
  await this.openViaTyping(deviceSerial, phoneDigits, message.body)
}
```

- [ ] **2.3 Add strategy to SendEngine constructor**

```typescript
import { SendStrategy } from './send-strategy.js'

export class SendEngine {
  private processing = false
  private strategy: SendStrategy

  constructor(
    private adb: AdbBridge,
    private queue: MessageQueue,
    private emitter: DispatchEmitter,
    strategy?: SendStrategy,
  ) {
    this.strategy = strategy ?? new SendStrategy()
  }
```

- [ ] **2.4 Update send-engine.test.ts stubs for strategy**

In `beforeEach`, construct engine with a deterministic strategy:

```typescript
import { SendStrategy } from './send-strategy.js'

// Force prefill for deterministic tests
const strategy = new SendStrategy({ prefillWeight: 100, searchWeight: 0, typingWeight: 0 })
engine = new SendEngine(mockAdb, queue, emitter, strategy)
```

- [ ] **2.5 Run all tests**

```bash
npx turbo test --filter=@dispatch/core
# Expected: all pass (462+)
```

- [ ] **2.6 Commit**

```bash
git add packages/core/src/engine/send-engine.ts packages/core/src/engine/send-engine.test.ts
git commit -m "feat(engine): integrate SendStrategy — diversify entryPointSource fingerprint

50% wa.me?text= pre-fill (fast, official API)
30% search-based (types number in WA search, generates typing indicator)
20% typing-based (wa.me + manual typing, generates typing indicator)

Configurable via SendStrategy weights. Reduces click_to_chat_link monoculture."
```

---

## Task 2: RateLimitGuard — Per-Sender Daily Cap + Reachout Delay

**Problem:** No per-sender daily limit exists. The Reachout Timelock (60s for new contacts) is not respected. Volume must be configurable, not hardcoded.

**Solution:** `RateLimitGuard` checks daily send count per sender before dequeue, and returns the appropriate inter-message delay based on whether the recipient is a first-contact or recurring.

**Files:**
- Create: `packages/core/src/config/rate-limits.ts`
- Create: `packages/core/src/config/rate-limits.test.ts`
- Modify: `packages/core/src/queue/message-queue.ts` (add daily count query)
- Modify: `packages/core/src/server.ts` (wire guard into worker loop)

### Step 1: Daily send count query

- [ ] **1.1 Add getSenderDailyCount to MessageQueue**

Add to `packages/core/src/queue/message-queue.ts`:

```typescript
getSenderDailyCount(senderNumber: string): number {
  const row = this.db.prepare(`
    SELECT COUNT(*) as cnt FROM messages
    WHERE sender_number = ? AND status = 'sent'
      AND created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', 'start of day')
  `).get(senderNumber) as { cnt: number }
  return row.cnt
}

isFirstContactWith(toNumber: string, senderNumber: string): boolean {
  const row = this.db.prepare(`
    SELECT 1 FROM messages
    WHERE to_number = ? AND sender_number = ? AND status = 'sent'
    LIMIT 1
  `).get(toNumber, senderNumber)
  return row === undefined
}
```

- [ ] **1.2 Commit**

```bash
git add packages/core/src/queue/message-queue.ts
git commit -m "feat(queue): add getSenderDailyCount + isFirstContactWith queries"
```

### Step 2: RateLimitGuard

- [ ] **2.1 Write rate-limits.test.ts**

```typescript
// packages/core/src/config/rate-limits.test.ts
import { describe, it, expect } from 'vitest'
import { RateLimitGuard } from './rate-limits.js'

describe('RateLimitGuard', () => {
  it('allows send when under daily cap', () => {
    const guard = new RateLimitGuard({ maxPerSenderPerDay: 150 })
    expect(guard.canSend(100)).toBe(true)
  })

  it('blocks send when at daily cap', () => {
    const guard = new RateLimitGuard({ maxPerSenderPerDay: 150 })
    expect(guard.canSend(150)).toBe(false)
  })

  it('returns reachout delay for first contact', () => {
    const guard = new RateLimitGuard({ firstContactDelayMs: 45_000 })
    expect(guard.getInterMessageDelay(true)).toBeGreaterThanOrEqual(45_000)
  })

  it('returns normal delay for recurring contact', () => {
    const guard = new RateLimitGuard({ recurringContactDelayMs: 15_000 })
    const delay = guard.getInterMessageDelay(false)
    expect(delay).toBeGreaterThanOrEqual(15_000)
    expect(delay).toBeLessThanOrEqual(25_000) // with jitter
  })

  it('reads from env vars', () => {
    const guard = RateLimitGuard.fromEnv({
      MAX_PER_SENDER_PER_DAY: '200',
      FIRST_CONTACT_DELAY_MS: '60000',
      RECURRING_CONTACT_DELAY_MS: '10000',
    })
    expect(guard.canSend(199)).toBe(true)
    expect(guard.canSend(200)).toBe(false)
  })
})
```

- [ ] **2.2 Run test to verify it fails**

```bash
npx vitest run packages/core/src/config/rate-limits.test.ts
# Expected: FAIL — module not found
```

- [ ] **2.3 Implement RateLimitGuard**

```typescript
// packages/core/src/config/rate-limits.ts

export interface RateLimitConfig {
  /** Max messages per sender per day. Default: 150 */
  maxPerSenderPerDay: number
  /** Delay (ms) before sending to a first-time contact. Default: 45000 (45s) */
  firstContactDelayMs: number
  /** Delay (ms) between recurring contact messages. Default: 15000 (15s) */
  recurringContactDelayMs: number
  /** Jitter range (0-1) applied to delays. Default: 0.3 (±30%) */
  jitterRange: number
}

const DEFAULTS: RateLimitConfig = {
  maxPerSenderPerDay: 150,
  firstContactDelayMs: 45_000,
  recurringContactDelayMs: 15_000,
  jitterRange: 0.3,
}

export class RateLimitGuard {
  private config: RateLimitConfig

  constructor(config?: Partial<RateLimitConfig>) {
    this.config = { ...DEFAULTS, ...config }
  }

  static fromEnv(env: Record<string, string | undefined>): RateLimitGuard {
    return new RateLimitGuard({
      maxPerSenderPerDay: Number(env.MAX_PER_SENDER_PER_DAY) || DEFAULTS.maxPerSenderPerDay,
      firstContactDelayMs: Number(env.FIRST_CONTACT_DELAY_MS) || DEFAULTS.firstContactDelayMs,
      recurringContactDelayMs: Number(env.RECURRING_CONTACT_DELAY_MS) || DEFAULTS.recurringContactDelayMs,
      jitterRange: Number(env.RATE_LIMIT_JITTER) || DEFAULTS.jitterRange,
    })
  }

  canSend(currentDailyCount: number): boolean {
    return currentDailyCount < this.config.maxPerSenderPerDay
  }

  getInterMessageDelay(isFirstContact: boolean): number {
    const base = isFirstContact
      ? this.config.firstContactDelayMs
      : this.config.recurringContactDelayMs

    const jitter = base * this.config.jitterRange * (Math.random() * 2 - 1)
    return Math.round(Math.max(5_000, base + jitter))
  }

  get maxPerSenderPerDay(): number {
    return this.config.maxPerSenderPerDay
  }
}
```

- [ ] **2.4 Run tests — should pass**

```bash
npx vitest run packages/core/src/config/rate-limits.test.ts
# Expected: 5 tests PASS
```

- [ ] **2.5 Wire into worker loop in server.ts**

Replace the fixed `interMessageDelayMs` block (lines 667-683) with:

```typescript
// Rate limit guard (configurable per-sender caps + reachout delay)
const rateLimitGuard = RateLimitGuard.fromEnv(process.env as Record<string, string>)

// In worker loop, before processing batch:
const dailyCount = queue.getSenderDailyCount(senderNumber ?? '')
if (!rateLimitGuard.canSend(dailyCount)) {
  server.log.warn({ senderNumber, dailyCount, max: rateLimitGuard.maxPerSenderPerDay }, 'Worker: sender daily limit reached, skipping batch')
  // Requeue without incrementing attempts
  for (const msg of batch) {
    queue.updateStatus(msg.id, 'queued')
  }
  return
}

// In the message loop, replace fixed jitter with rate-limit-aware delay:
if (i < batch.length - 1) {
  const isFirstContact = queue.isFirstContactWith(batch[i + 1].to, senderNumber ?? '')
  const delayMs = rateLimitGuard.getInterMessageDelay(isFirstContact)
  server.log.info({ delayMs, isFirstContact, remaining: batch.length - i - 1 }, 'Worker: rate-limited delay')
  await new Promise(r => setTimeout(r, delayMs))
}
```

- [ ] **2.6 Run all tests**

```bash
npx turbo test --filter=@dispatch/core
# Expected: all pass
```

- [ ] **2.7 Commit**

```bash
git add packages/core/src/config/rate-limits.ts packages/core/src/config/rate-limits.test.ts packages/core/src/queue/message-queue.ts packages/core/src/server.ts
git commit -m "feat(config): RateLimitGuard — per-sender daily cap + reachout delay

Configurable via env vars:
  MAX_PER_SENDER_PER_DAY=150 (default)
  FIRST_CONTACT_DELAY_MS=45000 (new contacts: 45s)
  RECURRING_CONTACT_DELAY_MS=15000 (recurring: 15s)
  RATE_LIMIT_JITTER=0.3 (±30%)

Worker skips batch if sender at daily limit. Inter-message delay
varies based on whether recipient is first-contact or recurring."
```

---

## Task 3: Root Hiding Stack (Device Configuration)

**Problem:** POCO C71 has `verifiedbootstate=orange`, `device_state=unlocked`, WhatsApp NOT in Magisk DenyList. Play Integrity fails BASIC level. WhatsApp's `IntegrityManagerFactory` is called on every session.

**Files:** No code changes. Device configuration only.

- [ ] **3.1 Configure Magisk DenyList**

```bash
SERIAL=9b01005930533036340030832250ac
adb -s $SERIAL shell "su -c 'magisk --denylist add com.whatsapp'"
adb -s $SERIAL shell "su -c 'magisk --denylist add com.whatsapp.w4b'"
adb -s $SERIAL shell "su -c 'magisk --denylist add com.google.android.gms'"
adb -s $SERIAL shell "su -c 'magisk --denylist ls'" | grep -E "whatsapp|gms"
# Expected: 3 entries
```

- [ ] **3.2 Install PlayIntegrityFork module**

Download from https://github.com/osm0sis/PlayIntegrityFork/releases (v16+).

```bash
# Push and install via Magisk
adb -s $SERIAL push PlayIntegrityFork-v16.zip /sdcard/
adb -s $SERIAL shell "su -c 'magisk --install-module /sdcard/PlayIntegrityFork-v16.zip'"
# Reboot required
adb -s $SERIAL reboot
# Wait for device
adb -s $SERIAL wait-for-device
sleep 30
```

- [ ] **3.3 Install BootloaderSpoofer module**

```bash
adb -s $SERIAL push BootloaderSpoofer.zip /sdcard/
adb -s $SERIAL shell "su -c 'magisk --install-module /sdcard/BootloaderSpoofer.zip'"
adb -s $SERIAL reboot
adb -s $SERIAL wait-for-device
sleep 30
```

- [ ] **3.4 Install Zygisk-Assistant**

```bash
adb -s $SERIAL push Zygisk-Assistant.zip /sdcard/
adb -s $SERIAL shell "su -c 'magisk --install-module /sdcard/Zygisk-Assistant.zip'"
adb -s $SERIAL reboot
adb -s $SERIAL wait-for-device
sleep 30
```

- [ ] **3.5 Verify Play Integrity**

Install SPIC (Simple Play Integrity Checker) from Play Store or APK:
```bash
adb -s $SERIAL install SPIC.apk
adb -s $SERIAL shell "am start -n com.henrikherzig.playintegritychecker/.MainActivity"
# Check: BASIC integrity should show ✓
```

- [ ] **3.6 Verify WhatsApp not seeing root**

```bash
# WhatsApp should not see Magisk in /proc/self/maps
adb -s $SERIAL shell "su -c 'magisk --denylist ls'" | grep whatsapp
# Expected: com.whatsapp listed

# Verify DenyList is active
adb -s $SERIAL shell "su -c 'getprop ro.boot.verifiedbootstate'"
# Should still show orange (module spoofs at framework level, not prop)
```

- [ ] **3.7 Document in .dev-state/progress.md**

```markdown
## Root Hiding Stack
- Magisk 28.1 + Zygisk enabled
- DenyList: com.whatsapp, com.whatsapp.w4b, com.google.android.gms
- PlayIntegrityFork v16 installed
- BootloaderSpoofer installed
- Zygisk-Assistant installed
- SPIC verification: BASIC ✓ / DEVICE ✓ / STRONG ✗
```

---

## Task 4: WABA Sender Expansion (4 → 8 senders)

**Problem:** Only 4 WhatsApp accounts (com.whatsapp) are configured. Each Android profile also has WhatsApp Business (com.whatsapp.w4b) installed but not registered. Doubling senders from 4 to 8 halves per-sender volume.

**Files:**
- Modify: `packages/core/src/engine/send-engine.ts` (app_package in am start)
- Modify: `packages/core/src/engine/sender-mapping.ts` (use app_package field)
- Modify: `packages/core/src/server.ts` (pass app_package to send)

### Step 1: Use app_package from sender_mapping

- [ ] **1.1 Modify am start to use configurable package**

In `send-engine.ts`, the `am start` commands hardcode `-p com.whatsapp`. Change to accept `appPackage` parameter:

```typescript
async send(message: Message, deviceSerial: string, isFirstInBatch = true, appPackage = 'com.whatsapp'): Promise<SendResult> {
  // ... existing code ...

  // Use appPackage instead of hardcoded com.whatsapp
  await this.adb.shell(
    deviceSerial,
    `am start -a android.intent.action.VIEW -d "${deepLink}" -p ${appPackage}`,
  )
```

Also update `ensureCleanState` to stop the correct package:

```typescript
private async ensureCleanState(deviceSerial: string, appPackage = 'com.whatsapp'): Promise<void> {
  await this.adb.shell(deviceSerial, `am force-stop ${appPackage} && sleep 0.2 && input keyevent 3`)
  await this.delay(300)
}
```

- [ ] **1.2 Wire app_package through processMessage and worker loop**

In `server.ts`, resolve `app_package` from sender_mapping and pass to engine.send():

```typescript
const appPackage = senderProfile?.app_package ?? 'com.whatsapp'
// ...
await engine.send(message, deviceSerial, i === 0, appPackage)
```

- [ ] **1.3 Register WABA senders**

```bash
# Add 4 WABA sender mappings (after registering WhatsApp Business on each profile)
curl -X POST http://localhost:7890/api/v1/sender-mapping \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -d '{"phoneNumber":"+5543996835100","deviceSerial":"9b01005930533036340030832250ac","profileId":0,"appPackage":"com.whatsapp.w4b","wahaSession":"oralsin_2_waba_0"}'

# Repeat for profiles 10, 11, 12 with WABA numbers
```

- [ ] **1.4 Run all tests**

```bash
npx turbo test --filter=@dispatch/core
# Expected: all pass
```

- [ ] **1.5 Commit**

```bash
git add packages/core/src/engine/send-engine.ts packages/core/src/server.ts
git commit -m "feat(engine): WABA support — configurable app_package in send flow

Send engine accepts appPackage param (default: com.whatsapp).
Worker resolves from sender_mapping.app_package.
Enables com.whatsapp.w4b (WhatsApp Business) senders.
4 WA + 4 WABA = 8 senders, halving per-sender volume."
```

---

## Task 5: E2E Validation (GATE)

**Problem:** All changes must be validated on the physical device before production.

**This task MUST pass before enabling overdue_only for any clinic.**

- [ ] **5.1 Start server and verify health**

```bash
npx tsx packages/core/src/cli.ts &
sleep 3
curl -s -H "X-API-Key: $API_KEY" http://localhost:7890/healthz
# Verify: status=healthy, oralsin=active, devices=1
```

- [ ] **5.2 Send 4 messages — verify strategy diversification**

Enqueue 4 messages and monitor the WhatsApp log for `entryPointSource`:

```bash
# After sending 4 messages:
adb shell "su -c 'grep entryPointSource /data/data/com.whatsapp/files/Logs/whatsapp.log'" | \
  grep -oP 'entryPointSource=\w+' | sort | uniq -c
# Expected: NOT 100% click_to_chat_link — should see search or other sources
```

- [ ] **5.3 Verify rate limit guard**

```bash
# Check that daily count is tracked
curl -s -H "X-API-Key: $API_KEY" http://localhost:7890/healthz
# Verify: queue stats reflect sent messages
```

- [ ] **5.4 Verify Play Integrity (if T3 completed)**

```bash
adb shell "su -c 'magisk --denylist ls'" | grep whatsapp
# Expected: com.whatsapp listed
```

- [ ] **5.5 Screenshot proof**

```bash
ls -la reports/sends/*.png | tail -4
# Verify: screenshots exist for the 4 test messages
```

- [ ] **5.6 Commit E2E results**

```bash
git commit --allow-empty -m "gate(e2e): anti-ban validation passed — strategy diversification + rate limits confirmed"
```

---

## Task 6: Monitoring + Auto-Quarantine

**Problem:** If a sender gets temporarily restricted, the system should detect and quarantine that sender automatically.

**Files:**
- Create: `packages/core/src/engine/sender-health.ts`
- Create: `packages/core/src/engine/sender-health.test.ts`
- Modify: `packages/core/src/server.ts` (wire into worker loop)

### Step 1: Sender health tracker

- [ ] **1.1 Write sender-health.test.ts**

```typescript
// packages/core/src/engine/sender-health.test.ts
import { describe, it, expect } from 'vitest'
import { SenderHealth } from './sender-health.js'

describe('SenderHealth', () => {
  it('quarantines sender after N consecutive failures', () => {
    const health = new SenderHealth({ quarantineAfterFailures: 3 })
    health.recordFailure('+5543996835100')
    health.recordFailure('+5543996835100')
    expect(health.isQuarantined('+5543996835100')).toBe(false)
    health.recordFailure('+5543996835100')
    expect(health.isQuarantined('+5543996835100')).toBe(true)
  })

  it('resets failure count on success', () => {
    const health = new SenderHealth({ quarantineAfterFailures: 3 })
    health.recordFailure('+5543996835100')
    health.recordFailure('+5543996835100')
    health.recordSuccess('+5543996835100')
    health.recordFailure('+5543996835100')
    expect(health.isQuarantined('+5543996835100')).toBe(false)
  })

  it('auto-releases quarantine after cooldown', () => {
    const health = new SenderHealth({ quarantineAfterFailures: 1, quarantineDurationMs: 100 })
    health.recordFailure('+5543996835100')
    expect(health.isQuarantined('+5543996835100')).toBe(true)
    // After cooldown
    return new Promise<void>(resolve => {
      setTimeout(() => {
        expect(health.isQuarantined('+5543996835100')).toBe(false)
        resolve()
      }, 150)
    })
  })
})
```

- [ ] **1.2 Implement SenderHealth**

```typescript
// packages/core/src/engine/sender-health.ts

export interface SenderHealthConfig {
  quarantineAfterFailures: number
  quarantineDurationMs: number
}

const DEFAULTS: SenderHealthConfig = {
  quarantineAfterFailures: 3,
  quarantineDurationMs: 3_600_000, // 1 hour
}

export class SenderHealth {
  private failures = new Map<string, number>()
  private quarantinedUntil = new Map<string, number>()
  private config: SenderHealthConfig

  constructor(config?: Partial<SenderHealthConfig>) {
    this.config = { ...DEFAULTS, ...config }
  }

  recordSuccess(sender: string): void {
    this.failures.delete(sender)
  }

  recordFailure(sender: string): void {
    const count = (this.failures.get(sender) ?? 0) + 1
    this.failures.set(sender, count)
    if (count >= this.config.quarantineAfterFailures) {
      this.quarantinedUntil.set(sender, Date.now() + this.config.quarantineDurationMs)
    }
  }

  isQuarantined(sender: string): boolean {
    const until = this.quarantinedUntil.get(sender)
    if (!until) return false
    if (Date.now() > until) {
      this.quarantinedUntil.delete(sender)
      this.failures.delete(sender)
      return false
    }
    return true
  }
}
```

- [ ] **1.3 Wire into worker loop**

In `server.ts`, check `senderHealth.isQuarantined(senderNumber)` before processing batch:

```typescript
const senderHealth = new SenderHealth()

// In worker loop, after resolving senderNumber:
if (senderNumber && senderHealth.isQuarantined(senderNumber)) {
  server.log.warn({ senderNumber }, 'Worker: sender quarantined, skipping batch')
  for (const msg of batch) {
    queue.updateStatus(msg.id, 'queued') // requeue without retry increment
  }
  return
}

// After successful processMessage:
if (senderNumber) senderHealth.recordSuccess(senderNumber)

// In processMessage catch (permanently_failed):
if (message.senderNumber) senderHealth.recordFailure(message.senderNumber)
```

- [ ] **1.4 Run all tests**

```bash
npx turbo test --filter=@dispatch/core
# Expected: all pass
```

- [ ] **1.5 Commit**

```bash
git add packages/core/src/engine/sender-health.ts packages/core/src/engine/sender-health.test.ts packages/core/src/server.ts
git commit -m "feat(engine): SenderHealth — auto-quarantine after N consecutive failures

3 consecutive send failures quarantines sender for 1 hour.
Success resets counter. Worker skips quarantined senders.
Configurable: quarantineAfterFailures, quarantineDurationMs."
```

---

## Acceptance Criteria Summary

| Criteria | Task | Metric |
|----------|------|--------|
| entryPointSource NOT 100% click_to_chat | T1 | WhatsApp log shows mixed sources |
| Per-sender daily cap enforced | T2 | Worker skips batch at limit |
| First-contact delay ≥ 45s | T2 | Log shows isFirstContact=true delays |
| Play Integrity BASIC passes | T3 | SPIC app shows ✓ |
| WhatsApp in Magisk DenyList | T3 | `magisk --denylist ls` confirms |
| WABA senders functional | T4 | Messages sent via com.whatsapp.w4b |
| 8 senders active | T4 | sender_mapping has 8 active entries |
| E2E 4+ messages sent successfully | T5 | Screenshots + sent status |
| Auto-quarantine on failure | T6 | Log shows quarantine after 3 failures |
| All tests pass | ALL | `npx turbo test` = 470+ pass |

---

## Env Vars Reference (new)

```bash
# Rate limiting (add to .env)
MAX_PER_SENDER_PER_DAY=150        # Hard cap per sender per day
FIRST_CONTACT_DELAY_MS=45000      # Delay before sending to new contact (ms)
RECURRING_CONTACT_DELAY_MS=15000  # Delay between recurring contacts (ms)
RATE_LIMIT_JITTER=0.3             # ±30% random jitter on delays

# Strategy weights (add to .env)
SEND_STRATEGY_PREFILL_WEIGHT=50   # % of messages using wa.me?text= pre-fill
SEND_STRATEGY_SEARCH_WEIGHT=30    # % using search-based open
SEND_STRATEGY_TYPING_WEIGHT=20    # % using typing-based open
```

---

## Throughput Projection After Implementation

```
Current: 4 senders × 190 msgs/h = 760 msgs/h (19s/msg average)

After T1 (strategy diversification):
  50% prefill (19s) + 30% search (25s) + 20% typing (30s) = 22.5s avg
  4 senders × 160 msgs/h = 640 msgs/h

After T2 (rate limit guard, 15-45s delays):
  First contacts (50%): 45s avg
  Recurring (50%): 15s avg  
  Weighted: ~30s/msg
  4 senders × 120 msgs/h = 480 msgs/h

After T4 (8 senders):
  8 senders × 120 msgs/h = 960 msgs/h
  1000 msgs in ~63 min
  2000 msgs in ~126 min (2h06)

Trade-off: throughput drops from 760 to 960 (net gain from more senders),
but ban risk drops dramatically from the anti-fingerprint measures.
```
