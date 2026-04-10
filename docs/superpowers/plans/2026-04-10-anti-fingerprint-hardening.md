# Anti-Fingerprint Hardening Plan — Dispatch Send Engine

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate the 4 highest-risk WhatsApp automation fingerprints from the Dispatch send engine, making the system resistant to server-side behavioral ML detection and client-side input analysis.

**Risk Assessment (from docs/research/whatsapp-anti-detection-fingerprints.md):**
- Layer 1 (Server-Side ML): 75%+ of bans — typing indicator absence, wa.me pattern, contact→send timing
- Layer 2 (Client Integrity): Play Integrity, root detection — mitigated by Magisk stack
- Layer 3 (Input Detection): POLICY_FLAG_INJECTED, IME bypass — lowest weight but fixable

**Branch:** `feat/anti-ban-scaling`
**Baseline:** 705 tests, commit `aab96bc4`

---

## Dependency Graph

```
P0-A (UIAutomator bounds) ──────────────┐
    │                                    │
    ├───► P0-B (Strategy weights)        │
    │         │                          │
    │         └───► P1-B (UHID proto)    │
    │                                    │
P1-A (SharedPrefs fallback) ────────────┤  Independent
                                         │
P2-A (Sendevent batch taps) ────────────┤  Independent, after P0-A
                                         │
P2-B (Contact aging) ──────────────────►│  Independent, needs Oralsin coordination
                                         │
P3-A (Sysfs thermal) ──────────────────►│  Independent
P3-B (WA update control) ─────────────►│  Independent, operational
```

## File Structure

### Modified files
```
packages/core/src/engine/
├── send-engine.ts              ← P0-A: replace all hardcoded coords with UIAutomator bounds
├── send-strategy.ts            ← P0-B: adjust default weights
├── send-strategy.test.ts       ← P0-B: update weight tests
├── send-engine.test.ts         ← P0-A: update mocks for new UI-based methods
└── worker-orchestrator.ts      ← P2-A: optional sendevent tap method

packages/core/src/monitor/
└── wa-account-mapper.ts        ← P1-A: add root SharedPrefs fallback

packages/core/src/server.ts     ← P3-B: pm disable on device connect
```

### New files (P1-B: UHID — if prototype succeeds)
```
scripts/
└── uhid-keyboard.c             ← Minimal UHID creator (compile for ARM)

packages/core/src/engine/
├── uhid-keyboard.ts            ← UHID keyboard manager (create, type, destroy)
└── uhid-keyboard.test.ts       ← Tests
```

---

## P0-A: Eliminate Hardcoded Coordinates — UIAutomator Bounds

**Why first:** Blocks multi-device/multi-model AND blocks P0-B (search method needs dynamic coords).

**Files:**
- Modify: `packages/core/src/engine/send-engine.ts`
- Modify: `packages/core/src/engine/send-engine.test.ts`

### Current hardcoded coordinates (POCO C71 720x1600 specific):

```typescript
// send-engine.ts — openViaSearch()
await this.adb.shell(deviceSerial, 'input tap 624 172')   // search icon
await this.adb.shell(deviceSerial, 'input tap 360 350')   // first result
```

### Target: UIAutomator bounds extraction (like dismissDialogs already does)

- [ ] **P0-A.1 Create `findElementBounds()` helper in send-engine.ts**

```typescript
private async findElementBounds(
  deviceSerial: string,
  matcher: { resourceId?: string; text?: RegExp; contentDesc?: RegExp }
): Promise<{ cx: number; cy: number } | null>
```

Uses `dumpUi()` (already exists), then regex-matches the XML for:
- `resource-id="com.whatsapp:id/menuitem_search"` (search icon)
- `resource-id="com.whatsapp:id/conversations_row_contact_name"` (search result)
- `resource-id="com.whatsapp:id/send"` (send button — already uses bounds in tapSendButton)
- `text="..."` patterns for other UI elements

Returns center coordinates from bounds `[x1,y1][x2,y2]`.

- [ ] **P0-A.2 Replace hardcoded coords in `openViaSearch()`**

Before:
```typescript
await this.adb.shell(deviceSerial, 'input tap 624 172')  // search icon
await this.adb.shell(deviceSerial, `input text '${searchDigits}'`)
await this.adb.shell(deviceSerial, 'input tap 360 350')  // first result
```

After:
```typescript
const searchIcon = await this.findElementBounds(deviceSerial, {
  resourceId: 'com.whatsapp:id/menuitem_search',
})
if (!searchIcon) {
  // Fallback: try content-desc="Search" or "Pesquisar"
  const searchAlt = await this.findElementBounds(deviceSerial, {
    contentDesc: /^(Search|Pesquisar)$/i,
  })
  if (!searchAlt) throw new Error('Search icon not found in UI')
}
await this.adb.shell(deviceSerial, `input tap ${searchIcon.cx} ${searchIcon.cy}`)
await this.delay(1000)
await this.adb.shell(deviceSerial, `input text '${searchDigits}'`)
await this.delay(1500)
// Find first search result
const firstResult = await this.findElementBounds(deviceSerial, {
  resourceId: 'com.whatsapp:id/conversations_row_contact_name',
})
if (!firstResult) throw new Error('Search result not found')
await this.adb.shell(deviceSerial, `input tap ${firstResult.cx} ${firstResult.cy}`)
```

- [ ] **P0-A.3 Diversify search behavior**

Add variation within the search method:
- 70% search by last 8 digits (current)
- 30% search by contact name (if known from contacts DB)

```typescript
const contactName = this.queue.getContactName(phone)
const useNameSearch = contactName && Math.random() < 0.3
const searchTerm = useNameSearch ? contactName : phone.slice(-8)
```

- [ ] **P0-A.4 Add `openViaChatList()` method (new chat opening variant)**

For contacts that the sender has messaged before, open from the chat list instead of search:
```typescript
private async openViaChatList(deviceSerial: string, phone: string, body: string, appPackage: string): Promise<void> {
  // Open WA home
  await this.adb.shell(deviceSerial, `am start -n ${appPackage}/com.whatsapp.HomeActivity`)
  await this.delay(2000)
  // Scroll chat list looking for the contact
  // Use UIAutomator to find the contact row by name
  const xml = await this.dumpUi(deviceSerial)
  const contactName = this.queue.getContactName(phone)
  if (contactName) {
    const match = xml.match(new RegExp(`text="${escapeRegex(contactName)}"[^>]*bounds="\\[([\\d,\\]\\[]+)"`))
    if (match) {
      // Tap the contact in chat list
      // ... extract bounds, tap
      await this.typeMessage(deviceSerial, body)
      return
    }
  }
  // Fallback to search
  await this.openViaSearch(deviceSerial, phone, body)
}
```

- [ ] **P0-A.5 Update `tapSendButton()` to use existing bounds pattern (already done — verify)**

`tapSendButton()` already uses UIAutomator bounds with `com.whatsapp:id/send`. Verify it works on all chat states. Fallback to `input keyevent 66` (ENTER) is already implemented.

- [ ] **P0-A.6 Update tests**

Update send-engine.test.ts mocks to provide UIAutomator XML with bounds for all elements.

- [ ] **P0-A.7 Run tests + commit**

```bash
git commit -m "refactor(engine): replace hardcoded coords with UIAutomator bounds

openViaSearch uses findElementBounds() for search icon and results.
New openViaChatList() for returning contacts (avoids search entirely).
Diversified search: 70% by digits, 30% by contact name.
All coordinates now dynamic — works on any screen resolution."
```

---

## P0-B: Adjust SendStrategy Weights

**Depends on:** P0-A (search needs dynamic coords first)

**Files:**
- Modify: `packages/core/src/engine/send-strategy.ts`
- Modify: `packages/core/src/engine/send-strategy.test.ts`

- [ ] **P0-B.1 Change DEFAULT_CONFIG weights**

```typescript
const DEFAULT_CONFIG: SendStrategyConfig = {
  prefillWeight: 10,   // was 50 — only for emergencies (very long msgs)
  searchWeight: 50,    // was 30 — best anti-ban (no wa.me)
  typingWeight: 40,    // was 20 — generates typing indicator
}
```

- [ ] **P0-B.2 Remove the short-message prefill boost from `selectMethod()`**

Currently H8 boosts prefill to 80% for short msgs. Remove this — it defeats the anti-ban purpose:

```typescript
// REMOVE this block:
if (bodyLength < 500) {
  adjustedPrefillWeight = Math.max(prefillWeight, 80)
}
```

Keep the long-message prefill reduction (>1500 chars caps prefill at 10%) as a safety valve.

- [ ] **P0-B.3 Add `chatlist` as a 4th strategy variant**

Extend `ChatOpenMethod` type:
```typescript
export type ChatOpenMethod = 'prefill' | 'search' | 'typing' | 'chatlist'
```

Add `chatlistWeight` to config (default 20, reduce search to 30):
```typescript
prefillWeight: 10,
searchWeight: 30,
typingWeight: 40,
chatlistWeight: 20,  // NEW — opens from recent chat list
```

Strategy uses `chatlist` only when the contact has been messaged before (checked by SendEngine via queue.isFirstContactWith).

- [ ] **P0-B.4 Update tests + commit**

```bash
git commit -m "tune(engine): anti-ban strategy weights + chatlist method

prefill:10 (was 50), search:30, typing:40, chatlist:20 (new).
Removed H8 prefill boost for short messages. chatlist opens
from recent conversations — zero wa.me, zero search pattern."
```

---

## P1-A: SharedPrefs Root Fallback in wa-account-mapper

**Independent — no dependencies.**

**Files:**
- Modify: `packages/core/src/monitor/wa-account-mapper.ts`

- [ ] **P1-A.1 Add root SharedPrefs reader as 3rd fallback**

After the existing content provider (1st) and run-as (2nd) attempts fail, add:

```typescript
// 3rd attempt: root access to SharedPrefs
try {
  // Copy SharedPrefs to readable location
  await this.adb.shell(serial, `su -c "cp /data/user/${profileId}/com.whatsapp/shared_prefs/com.whatsapp_preferences_light.xml /sdcard/dispatch_wa_prefs_${profileId}.xml"`)
  const prefs = await this.adb.shell(serial, `cat /sdcard/dispatch_wa_prefs_${profileId}.xml`)
  // Extract country code
  const ccMatch = prefs.match(/<string name="cc">(\d+)<\/string>/)
  // Extract registration jid or self_lid
  const lidMatch = prefs.match(/<string name="self_lid">(\d+)@/)
  const jidMatch = prefs.match(/<string name="registration_jid">(\d+)@/)
  const number = jidMatch?.[1] ?? lidMatch?.[1]
  if (number && ccMatch) {
    const fullNumber = ccMatch[1] + number
    // ... save to mapping
  }
  // Cleanup
  await this.adb.shell(serial, `rm -f /sdcard/dispatch_wa_prefs_${profileId}.xml`)
} catch { /* root not available or WA not installed */ }
```

- [ ] **P1-A.2 Tests + commit**

```bash
git commit -m "feat(monitor): root SharedPrefs fallback in wa-account-mapper

3rd fallback after content provider and run-as: su -c cp SharedPrefs
to /sdcard/, extract cc + self_lid/registration_jid. Cleanup after read."
```

---

## P1-B: UHID Keyboard Prototype

**Depends on:** P0-A (for integration), P0-B (for strategy routing)
**Research confirmed:** `/dev/uhid` exists, `CONFIG_UHID=y` on POCO C71.

**This is a PROTOTYPE task.** Goal: validate that UHID keyboard works end-to-end on the POCO C71, triggering typing indicator in WhatsApp. If it works, proceed to full integration. If not, descope.

- [ ] **P1-B.1 Compile minimal UHID keyboard binary for ARM**

Write `scripts/uhid-keyboard.c` (~150 lines) that:
1. Opens `/dev/uhid`
2. Sends `UHID_CREATE2` with HID keyboard descriptor
3. Reads commands from stdin: `type <text>`, `key <keycode>`, `destroy`
4. For each char, sends HID key press + release report

Reference: scrcpy's `app/src/hid/hid_keyboard.c`

Compile: `aarch64-linux-gnu-gcc -static -o uhid-keyboard uhid-keyboard.c`
Push: `adb push uhid-keyboard /data/local/tmp/ && adb shell chmod +x /data/local/tmp/uhid-keyboard`

- [ ] **P1-B.2 Test on POCO C71**

```bash
# Create virtual keyboard
adb shell su -c "/data/local/tmp/uhid-keyboard create"

# Open WhatsApp chat
adb shell am start -a android.intent.action.VIEW -d "https://wa.me/5543991938235" -p com.whatsapp

# Wait for chat to open, then type via UHID
echo "type Hello from UHID" | adb shell su -c "/data/local/tmp/uhid-keyboard"

# Verify:
# 1. Text appears in chat field
# 2. Typing indicator shows on recipient's phone ("digitando...")
# 3. No POLICY_FLAG_INJECTED on the events
```

- [ ] **P1-B.3 If successful: create uhid-keyboard.ts wrapper**

```typescript
export class UhidKeyboard {
  constructor(private adb: AdbBridge) {}
  
  async create(deviceSerial: string): Promise<void>
  async type(deviceSerial: string, text: string): Promise<void>
  async destroy(deviceSerial: string): Promise<void>
}
```

- [ ] **P1-B.4 If successful: integrate in SendEngine as alternative to `input text`**

Replace `typeMessage()` with UHID-based typing when available:
```typescript
private async typeMessage(deviceSerial: string, text: string): Promise<void> {
  if (this.uhidKeyboard) {
    await this.uhidKeyboard.type(deviceSerial, text)
  } else {
    // Existing chunk-based input text fallback
    ...
  }
}
```

**IMPORTANT:** UHID typing is ~7x slower (30s vs 4s for 200 chars). This is intentional — it mimics human typing speed and generates proper typing indicator.

- [ ] **P1-B.5 Tests + commit**

```bash
git commit -m "feat(engine): UHID keyboard — proper IME typing with typing indicator

Virtual HID keyboard via /dev/uhid. Triggers InputConnection.commitText()
properly, generating natural typing indicator on WhatsApp server.
~7x slower than input text but eliminates IME bypass fingerprint."
```

---

## P2-A: Sendevent Batch for Taps

**Depends on:** P0-A (coordinates need to be known before sendevent can tap them)

**Files:**
- Modify: `packages/core/src/engine/send-engine.ts`

- [ ] **P2-A.1 Add `sendeventTap()` method**

```typescript
private async sendeventTap(deviceSerial: string, x: number, y: number): Promise<void> {
  // Touch major varies per tap (realistic finger contact area)
  const touchMajor = 5 + Math.floor(Math.random() * 6) // 5-10
  // Slight position jitter
  const jx = x + Math.floor(Math.random() * 7) - 3  // +/-3px
  const jy = y + Math.floor(Math.random() * 7) - 3

  await this.adb.shell(deviceSerial,
    `su -c "sendevent /dev/input/event3 3 57 0; ` +
    `sendevent /dev/input/event3 3 53 ${jx}; ` +
    `sendevent /dev/input/event3 3 54 ${jy}; ` +
    `sendevent /dev/input/event3 3 48 ${touchMajor}; ` +
    `sendevent /dev/input/event3 1 330 1; ` +
    `sendevent /dev/input/event3 0 0 0; ` +
    `usleep ${60000 + Math.floor(Math.random() * 80000)}; ` + // 60-140ms hold
    `sendevent /dev/input/event3 3 57 4294967295; ` +
    `sendevent /dev/input/event3 1 330 0; ` +
    `sendevent /dev/input/event3 0 0 0"`
  )
}
```

**NOTE:** Touchscreen device `/dev/input/event3` is POCO C71 specific. For multi-device, need auto-detection of the touchscreen event device (check ABS capabilities bitmask `261800000000000`).

- [ ] **P2-A.2 Add auto-detect touchscreen event device**

```typescript
private async detectTouchDevice(deviceSerial: string): Promise<string | null> {
  for (let i = 0; i <= 10; i++) {
    const caps = await this.adb.shell(deviceSerial,
      `su -c "cat /sys/class/input/event${i}/device/capabilities/abs 2>/dev/null"`
    ).catch(() => '')
    // ABS_MT_POSITION_X (bit 53) + ABS_MT_POSITION_Y (bit 54) = touchscreen
    if (caps.trim()) {
      const val = BigInt('0x' + caps.trim().replace(/\s+/g, ''))
      if ((val & (1n << 53n)) && (val & (1n << 54n))) {
        return `/dev/input/event${i}`
      }
    }
  }
  return null
}
```

- [ ] **P2-A.3 Replace input tap calls with sendeventTap when available**

Keep `input tap` as fallback when root is not available.

- [ ] **P2-A.4 Tests + commit**

```bash
git commit -m "feat(engine): sendevent batch taps — removes POLICY_FLAG_INJECTED

su -c batch sendevent with realistic touch_major + position jitter.
0ms execution (vs 77ms for input tap). Auto-detects touchscreen device.
Falls back to input tap when root unavailable."
```

---

## P2-B: Contact Aging

**Independent but requires Oralsin coordination.**

- [ ] **P2-B.1 Add `POST /api/v1/contacts/pre-register` endpoint**

Accepts batch of phone + name. Creates contacts on device via content provider but does NOT send any messages. Returns registration status.

- [ ] **P2-B.2 Oralsin integration: send contacts batch hours before messaging**

Oralsin sends contact pre-registration batch at night (e.g., 22:00) for next day's messages.

- [ ] **P2-B.3 Tests + commit**

---

## P3-A: Sysfs Thermal in HealthCollector

- [ ] **P3-A.1 Add CPU temperature from sysfs**

```typescript
// In HealthCollector.collect():
const cpuTemp = await this.adb.shell(serial, 
  'su -c "cat /sys/class/thermal/thermal_zone0/temp"'
).catch(() => null)
if (cpuTemp) {
  snapshot.cpuTemperatureCelsius = parseInt(cpuTemp.trim(), 10) / 1000
}
```

- [ ] **P3-A.2 Commit**

---

## P3-B: WA Auto-Update Control

- [ ] **P3-B.1 Disable Play Store auto-update on device connect**

Add to device:connected handler in server.ts:
```typescript
'pm disable-user --user 0 com.android.vending',
```

**WARNING:** This disables Play Store entirely. Re-enable manually when updates are needed.

- [ ] **P3-B.2 Commit**

---

## UI/Electron Propagation

All backend changes must be visible in the Dispatch UI. These tasks run in parallel with or after their corresponding backend tasks.

### UI-A: Strategy Distribution Visibility (after P0-B)

**Files:**
- Modify: `packages/ui/src/components/sender-dashboard.tsx`
- Modify: `packages/ui/src/components/metrics-dashboard.tsx`

- [ ] **UI-A.1 Show strategy distribution per sender in SenderDashboard**

Add a strategy mix indicator to each sender card. Fetch from `GET /api/v1/senders/status` (extend backend to include strategy stats if needed) or compute from Prometheus `dispatch_messages_sent_total` by method label.

Display: mini bar showing % prefill / search / typing / chatlist

- [ ] **UI-A.2 Update Grafana anti-ban dashboard if weights changed**

The Grafana "Anti-Ban Fingerprint" dashboard already shows strategy distribution. Verify it reflects the new weights after deployment.

### UI-B: CPU Temperature in Device Cards (after P3-A)

**Files:**
- Modify: `packages/ui/src/components/device-detail.tsx`
- Modify: `packages/ui/src/types.ts` (add cpuTemperatureCelsius to HealthSnapshot type)

- [ ] **UI-B.1 Add CPU temp to device health display**

Show CPU temperature alongside battery temperature in the device detail view. Color-code: green <45°C, amber 45-65°C, red >65°C.

### UI-C: UHID Status Indicator (after P1-B)

**Files:**
- Modify: `packages/ui/src/components/sender-dashboard.tsx`

- [ ] **UI-C.1 Show input method badge per sender**

When UHID is active, show "UHID" badge (green). When falling back to `input text`, show "ADB" badge (yellow). This lets the operator know which anti-fingerprint level is active.

### UI-D: Contact Aging Status (after P2-B)

**Files:**
- Modify: `packages/ui/src/components/oralsin-messages.tsx`

- [ ] **UI-D.1 Show contact registration age in message detail**

In the expanded message row, show when the contact was first registered on the device vs when the message was sent. Display "Contact aged: 14h" or "Contact new: just created" to indicate if aging is working.

### UI-E: Sendevent Status in Trace (after P2-A)

**Files:**
- Modify: `packages/ui/src/components/oralsin-messages.tsx`

- [ ] **UI-E.1 Show tap method in message trace**

When viewing a message trace, the `send_tapped` event should include whether sendevent or input tap was used. Display "sendevent (0ms)" or "input tap (77ms)" in the trace timeline.

---

## Acceptance Criteria

| Task | Criteria |
|------|---------|
| P0-A | Zero hardcoded coordinates in send-engine.ts. `grep -n "input tap [0-9]" send-engine.ts` returns 0 matches. |
| P0-B | Default weights: prefill ≤ 10, search ≥ 30, typing ≥ 30. No prefill boost for short messages. |
| P1-A | wa-account-mapper has 3 fallbacks: content provider → run-as → root SharedPrefs. |
| P1-B | UHID binary created, pushed, typing indicator verified on recipient phone. |
| P2-A | sendeventTap() with auto-detected touch device. `grep "POLICY_FLAG" send-engine.ts` returns 0. |
| P2-B | `/contacts/pre-register` endpoint exists and creates contacts without sending. |
| P3-A | HealthCollector reports cpuTemperatureCelsius from sysfs. |
| P3-B | Play Store disabled on device connect. |
| All | 705+ tests passing. No regressions. |
