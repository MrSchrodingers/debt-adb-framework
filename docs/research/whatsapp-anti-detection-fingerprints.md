# WhatsApp Automation Detection Fingerprints & Anti-Ban Strategies

> **Date**: 2026-04-08
> **Device**: POCO C71 (Android 15, rooted)
> **Current Method**: ADB `input text` + `input tap` + `uiautomator dump` + wa.me deep links

---

## Table of Contents

1. [Detection Signal Taxonomy](#1-detection-signal-taxonomy)
2. [Input Method Fingerprints (Deep Technical)](#2-input-method-fingerprints)
3. [Behavioral Fingerprints](#3-behavioral-fingerprints)
4. [System-Level Fingerprints](#4-system-level-fingerprints)
5. [Network Fingerprints](#5-network-fingerprints)
6. [`sendevent` vs `input text` vs UHID — Technical Comparison](#6-sendevent-vs-input-text-vs-uhid)
7. [Root-Based Anti-Fingerprint Measures](#7-root-based-anti-fingerprint-measures)
8. [Alternative Sending Methods](#8-alternative-sending-methods)
9. [Known CVEs & Research](#9-known-cves-and-research)
10. [Current Implementation Risk Assessment](#10-current-implementation-risk-assessment)
11. [Recommended Hardening Roadmap](#11-recommended-hardening-roadmap)

---

## 1. Detection Signal Taxonomy

WhatsApp's anti-abuse system operates on **three layers**, each independent:

```
+-------------------------------------------------------------+
| LAYER 1: SERVER-SIDE BEHAVIORAL ML (highest weight)         |
| - Message velocity, timing patterns, content similarity     |
| - Recipient graph analysis (who you msg, how many new)      |
| - Typing indicator presence/absence                         |
| - wa.me -> chat open -> send timing correlation             |
| - Report signals from recipients                            |
| 75%+ of bans come from THIS layer, not device checks        |
+-------------------------------------------------------------+
| LAYER 2: CLIENT-SIDE INTEGRITY (medium weight)              |
| - Play Integrity API (bootloader, root, system mods)        |
| - App signature verification                                |
| - Device attestation fingerprint                            |
+-------------------------------------------------------------+
| LAYER 3: LOCAL INPUT DETECTION (lowest weight)              |
| - Input event source attribution                            |
| - InputMethodManager state                                  |
| - Accessibility service detection                           |
| - Developer options / USB debugging checks                  |
+-------------------------------------------------------------+
```

**Critical insight**: Over 75% of banned accounts are detected proactively by server-side ML, NOT by local device inspection. Focusing only on input spoofing while ignoring behavioral signals is a losing strategy.

---

## 2. Input Method Fingerprints

### 2.1 How `adb shell input text` works internally

```
adb shell input text "hello"
  +-> /system/bin/input (Java wrapper)
       +-> InputManager.getInstance().injectInputEvent()
            +-> InputManagerService.injectInputEvent()
                 +-> nativeInjectInputEvent() (JNI)
                      +-> InputDispatcher::injectInputEvent()
                           +-> Event dispatched with POLICY_FLAG_INJECTED
```

**Key flag**: `POLICY_FLAG_INJECTED` (0x01000000 in AOSP `InputDispatcher.cpp`)

When `InputManager.injectInputEvent()` is called, the Android framework sets `POLICY_FLAG_INJECTED` on the event. This flag survives through the entire dispatch pipeline.

### 2.2 Can WhatsApp detect POLICY_FLAG_INJECTED?

**Answer: Not directly via public API, but indirectly -- YES.**

- `FLAG_TAINTED` and `isTainted()` are `@hide` (internal API), NOT exposed to regular apps
- However, WhatsApp can check **`MotionEvent.getSource()`** -- ADB injection uses `InputDevice.SOURCE_KEYBOARD` (0x00000101) for text and `InputDevice.SOURCE_TOUCHSCREEN` (0x00001002) for taps
- The source values from ADB injection are **technically correct** -- they match hardware sources
- But WhatsApp CAN cross-reference: if `getSource()` says touchscreen but `InputMethodManager.isActive()` returns false (no soft keyboard visible), that is suspicious
- **Detection risk for `input text`**: **MEDIUM** -- the event source looks correct, but the IME state is inconsistent

### 2.3 InputMethodManager (IME) state detection

This is the **most dangerous fingerprint** in our current implementation:

```
Current flow:
1. Open chat via wa.me
2. Focus lands on text field
3. Android auto-shows soft keyboard (if default behavior)
4. We call `input text 'word'` -- this BYPASSES the soft keyboard entirely
5. Text appears in field but InputMethodManager shows:
   - isActive() = true (field focused)
   - BUT no key events went through the IME
   - The composing text sequence is wrong (no commitText/setComposingText calls)
```

WhatsApp's input field (`com.whatsapp:id/entry`) is a custom `EditText`. It can override `onCreateInputConnection()` and monitor the `InputConnection` lifecycle. If text appears without proper `InputConnection.commitText()` calls, that is a **strong automation signal**.

**Detection risk**: **HIGH** -- this is the most likely local fingerprint WhatsApp checks

### 2.4 Touch event source

For `input tap`:
- Source is set to `InputDevice.SOURCE_TOUCHSCREEN` -- same as physical touch
- `MotionEvent.getToolType()` returns `TOOL_TYPE_FINGER` -- same as physical
- Pressure is set to `DEFAULT_PRESSURE` (1.0) -- real touches have variable pressure
- Touch size is `0` -- real touches have non-zero size based on finger area
- **Event timing**: real touches have ACTION_DOWN -> (small delay) -> ACTION_UP with natural jitter; ADB sends them with exactly `duration_ms` delay

**Detection risk for `input tap`**: **LOW-MEDIUM** -- source looks correct, but pressure/size/timing are synthetic

---

## 3. Behavioral Fingerprints

### 3.1 Typing indicator ("digitando...")

**This is critical.** WhatsApp sends a typing presence event to the server when:
1. The user starts typing (key events go through the `InputConnection`)
2. A "composing" state is sent via the encrypted Signal channel

When we use `input text`, the typing indicator behaves abnormally:
- If text appears too fast, the typing indicator may not fire at all
- Or it fires as a single brief flash instead of sustained "typing..."
- The server sees: chat opened -> 0ms typing -> message sent

WhatsApp's ML specifically looks for this pattern. An account that **never shows typing indicators** is almost certainly automated.

**Detection risk**: **HIGH** -- server-side, unforgeable without protocol-level intervention

### 3.2 Timing patterns

Our current implementation:
```typescript
// Word-level typing with gaussian delays (mean=200ms, stddev=60ms)
gaussianDelay(200, 60)
```

**Problems with gaussian distribution for anti-detection:**
- Too uniform -- real typing has **bursts and pauses** (think while composing)
- No typo-correction patterns (backspace -> retype)
- No pauses at sentence boundaries
- No variation between short words ("e", "a") and long words ("responsabilidade")
- Real humans sometimes pause 5-30 seconds mid-message to think

**Better model**: Poisson process with variable rate + occasional long pauses + word-length-proportional delays

**Detection risk**: **MEDIUM** -- gaussian is better than constant, but detectable by ML

### 3.3 wa.me -> chat open -> type -> send pattern

Every single message follows the exact same flow:
1. `am start -a android.intent.action.VIEW -d "https://wa.me/NUMBER"`
2. Wait 2-4s
3. Type message
4. Tap send

Real humans do not open every chat via wa.me links. They:
- Open existing conversations from the chat list
- Use the search function
- Reply from notifications
- Forward messages

The wa.me pattern is an **extremely strong signal** when repeated dozens of times in sequence.

**Detection risk**: **HIGH** -- server sees the same referrer pattern for every chat open

### 3.4 Contact addition -> immediate message pattern

Our implementation adds contacts via content provider, then immediately messages them. WhatsApp tracks:
- Contact was just added moments ago
- First message sent within seconds of contact creation
- Pattern repeats for many contacts

**Detection risk**: **HIGH** -- this is a classic bulk sender pattern

### 3.5 Message content similarity

If many messages share the same template with only name/amount substitution:
```
"Ola Joao, sua parcela de R$150,00 vence dia 15/04..."
"Ola Maria, sua parcela de R$200,00 vence dia 15/04..."
```

WhatsApp's NLP can detect template-based messages across recipients.

**Detection risk**: **MEDIUM-HIGH** -- depends on template variation

---

## 4. System-Level Fingerprints

### 4.1 Root detection

**WhatsApp DOES check for root.** Specific checks include:

| Check | Method | Bypass |
|-------|--------|--------|
| `su` binary existence | `Runtime.exec("which su")`, check `/system/bin/su`, `/system/xbin/su` | MagiskHide / Zygisk DenyList |
| Magisk files | Check `/data/adb/magisk/`, `/sbin/.magisk/` | SUSFS (hide mounts) |
| Bootloader status | `ro.boot.verifiedbootstate`, `ro.boot.flash.locked` | WAHideBootloader module |
| Play Integrity | `getStandardIntegrityToken()` -- checks MEETS_DEVICE_INTEGRITY | Play Integrity Fix (PIF) module |
| SELinux status | `getenforce` -- must return "Enforcing" | Most root tools maintain enforcing |
| System partition integrity | dm-verity, AVB2.0 attestation | Magisk systemless root preserves this |

**Current state (2026)**: WhatsApp uses Play Integrity API. The best bypass stack is:
```
SukiSU Ultra + ReZygisk + SUSFS + Play Integrity Fix (PIF) + WAHideBootloader
```

**Detection risk**: **HIGH if unmitigated**, **LOW with proper Magisk setup**

### 4.2 Developer Options / USB Debugging

WhatsApp **CAN** check:
- `Settings.Global.getInt(contentResolver, Settings.Global.DEVELOPMENT_SETTINGS_ENABLED)`
- `Settings.Global.getInt(contentResolver, Settings.Global.ADB_ENABLED)`

However, there is **no evidence** WhatsApp currently bans for this alone. Many developers and power users have these enabled. It is likely a **contributing signal** in the ML model, not a standalone trigger.

**Detection risk**: **LOW** -- contributing factor, not standalone trigger

### 4.3 ADB connection detection

Apps can detect ADB connection via:
- `android.os.Debug.isDebuggerConnected()` -- this checks for JDWP debugger, NOT ADB shell
- Check `sys.usb.state` property -- shows if USB debugging is active
- Check `/proc/self/status` for `TracerPid` -- only detects ptrace, not ADB shell
- Network: check if `adbd` is listening on port 5555 (TCP ADB)

**ADB shell commands do NOT trigger `isDebuggerConnected()`** -- they run as separate processes.

**Detection risk**: **LOW** -- ADB shell execution is not directly detectable by the target app

### 4.4 UIAutomator dump detection

`uiautomator dump` triggers the **Accessibility** subsystem. WhatsApp can detect:
- `AccessibilityManager.getEnabledAccessibilityServiceList()` -- checks for running accessibility services
- However, `uiautomator dump` uses a **system-level** accessibility connection, not a user-installed service
- It is visible via `dumpsys accessibility` but NOT via the app-facing `AccessibilityManager` API

**Detection risk**: **LOW** -- system-level accessibility is not exposed to apps

### 4.5 `/proc/self/status` TracerPid

WhatsApp (or any app) can read:
```
/proc/self/status -> TracerPid: 0    (normal)
/proc/self/status -> TracerPid: 1234 (being debugged/traced)
```

ADB shell commands do NOT set TracerPid on WhatsApp's process. Only Frida/ptrace would.

**Detection risk**: **LOW** for ADB automation, **HIGH** for Frida-based approaches

---

## 5. Network Fingerprints

### 5.1 Connection type fingerprinting

WhatsApp tracks:
- WiFi vs Mobile data
- IP address (datacenter IPs are flagged)
- Shared IP across multiple accounts
- Sudden IP changes during messaging session

For our use case (local devices on WiFi):
- IP is residential -- **safe**
- Each device has its own WhatsApp account -- **safe**
- Connection type is genuine WiFi -- **safe**

**Detection risk**: **LOW** for local device setup

### 5.2 Multi-account same-network patterns

If multiple devices on the same network all send to different recipients at similar times with similar templates, WhatsApp can correlate them as a **coordinated campaign**.

**Detection risk**: **MEDIUM** -- mitigated by jitter and varied timing across devices

---

## 6. `sendevent` vs `input text` vs UHID

### 6.1 Comparison matrix

| Method | Level | Needs Root | IME Bypass | Source Attribution | Detectable | Throughput |
|--------|-------|-----------|------------|-------------------|------------|------------|
| `input text` | Framework (Java) | No | Yes -- bypasses IME | SOURCE_KEYBOARD via InputManager.inject | Medium (POLICY_FLAG_INJECTED set) | Fast (one call per word) |
| `sendevent` | Kernel (/dev/input) | Yes (or shell group) | Yes -- bypasses IME | Appears as hardware event from that device node | Low (no POLICY_FLAG_INJECTED) | Slow (many events per char) |
| UHID (virtual device) | Kernel (/dev/uhid) | Yes (or shell group) | Partially -- can trigger IME if registered as keyboard | Appears as new USB HID device | Very Low (looks like USB keyboard) | Medium |
| scrcpy UHID mode | Kernel via ADB | No (ADB sufficient) | No -- triggers IME natively | Appears as USB HID keyboard | Very Low | Medium |
| Accessibility Service | Framework | No (but needs enabling) | Depends on impl | Flagged as accessibility injection | Medium-High | Medium |
| Notification RemoteInput | Framework | No | N/A -- uses reply channel | No touch/type events | Very Low | Slow (only replies) |

### 6.2 `sendevent` deep dive

```bash
# Get the correct input device for touchscreen
getevent -pl  # lists all input devices with capabilities

# Typical touch event sequence (single tap at x=540, y=1800):
sendevent /dev/input/event2 3 57 0      # ABS_MT_TRACKING_ID = 0
sendevent /dev/input/event2 3 53 540    # ABS_MT_POSITION_X = 540
sendevent /dev/input/event2 3 54 1800   # ABS_MT_POSITION_Y = 1800
sendevent /dev/input/event2 3 48 5      # ABS_MT_TOUCH_MAJOR = 5 (finger size!)
sendevent /dev/input/event2 3 58 50     # ABS_MT_PRESSURE = 50 (realistic pressure!)
sendevent /dev/input/event2 0 0 0       # SYN_REPORT
# ... pause ...
sendevent /dev/input/event2 3 57 -1     # ABS_MT_TRACKING_ID = -1 (finger up)
sendevent /dev/input/event2 0 0 0       # SYN_REPORT
```

**Advantages over `input tap`:**
- Sets realistic pressure (variable, not DEFAULT_PRESSURE=1.0)
- Sets touch major (finger contact area)
- Writes directly to `/dev/input/` -- no `POLICY_FLAG_INJECTED`
- Events are indistinguishable from hardware at the kernel level

**Disadvantages:**
- Very verbose -- each tap is ~7 sendevent calls
- For text input, you need to simulate **keyboard key events**, which is impractical for arbitrary text
- Requires knowing the correct `/dev/input/eventN` for your device
- Still bypasses IME for text entry

### 6.3 UHID virtual keyboard (best approach for text)

```
Create a virtual USB keyboard via /dev/uhid:
1. Open /dev/uhid
2. Write UHID_CREATE2 with HID descriptor for a standard keyboard
3. Send HID reports for key press/release
4. Android registers this as a new InputDevice
5. IME receives key events through normal InputConnection pipeline
```

**This is the gold standard** because:
- The virtual keyboard is registered as a **real input device** in the kernel
- Events flow through `EventHub` -> `InputReader` -> `InputDispatcher` with **no injection flags**
- IME processes the keys normally, triggering `commitText()` on WhatsApp's `InputConnection`
- Typing indicators fire correctly
- `InputMethodManager.isActive()` reflects the correct IME state

scrcpy already implements this in `--keyboard=uhid` mode and it works over ADB (no root needed).

**Detection risk**: **VERY LOW** -- functionally identical to a real Bluetooth/USB keyboard
**Implementation complexity**: **HARD** -- need to write HID report generator or adapt scrcpy's UHID implementation

### 6.4 scrcpy UHID as a practical path

scrcpy v2.4+ supports `--keyboard=uhid` which:
1. Creates a virtual HID keyboard on the device via UHID
2. Translates local key presses to HID key reports
3. Android sees a real USB keyboard

We could:
1. Run scrcpy in headless mode with `--keyboard=uhid --no-video --no-audio`
2. Send key events programmatically to scrcpy's input
3. Or extract scrcpy's UHID implementation and use it directly

---

## 7. Root-Based Anti-Fingerprint Measures

### 7.1 Recommended root stack (2026)

```
+--------------------------------------------------+
| SukiSU Ultra (or Magisk Alpha)                   |
|   +-> ReZygisk                                   |
|        +-> SUSFS (hide su/Magisk mounts)         |
|             +-> Play Integrity Fix (PIF)         |
|                  +-> WAHideBootloader            |
|                       +-> Shamiko (process hide) |
+--------------------------------------------------+
```

| Module | Purpose | Status (2026) |
|--------|---------|---------------|
| SukiSU Ultra | KernelSU fork, better hiding than Magisk | Active, recommended |
| ReZygisk | Zygisk implementation for non-Magisk kernels | Active |
| SUSFS | Hides su binary, Magisk mounts from /proc | Active, critical |
| Play Integrity Fix | Spoofs device fingerprint for Play Integrity | Updated monthly |
| WAHideBootloader | Specific WhatsApp bootloader check bypass | Active |
| Shamiko | Hides root from specific processes | Active |

### 7.2 Input source spoofing (with root)

With root, we can:

1. **Modify InputDispatcher flags**: Hook `InputDispatcher::injectInputEvent()` via kernel module or Xposed to strip `POLICY_FLAG_INJECTED` -- **extremely complex, breaks system stability**

2. **Create UHID device without scrcpy**: Write directly to `/dev/uhid` from a root shell -- **recommended approach**

3. **Hook WhatsApp's InputConnection**: Via LSPosed/Xposed, intercept `InputConnection.commitText()` and inject text through the proper channel -- **medium complexity, high risk of detection via Xposed detection**

4. **Frida instrumentation**: Hook WhatsApp's input validation functions -- **high risk, Frida is detectable**

### 7.3 Recommended: UHID + root for reliable text input

```bash
# On rooted device, create a virtual keyboard:
# 1. Push a small native binary that creates UHID device
adb push uhid-keyboard /data/local/tmp/
adb shell chmod +x /data/local/tmp/uhid-keyboard

# 2. Create the virtual keyboard (persists until killed)
adb shell /data/local/tmp/uhid-keyboard create

# 3. Send keystrokes through UHID (goes through full IME pipeline)
adb shell /data/local/tmp/uhid-keyboard type "Hello world"

# 4. These events trigger:
#    - InputMethodManager.isActive() = true
#    - InputConnection.commitText() called properly
#    - Typing indicator fires on WhatsApp server
#    - No POLICY_FLAG_INJECTED
```

---

## 8. Alternative Sending Methods

### 8.1 Method comparison

| Method | Detection Risk | Complexity | Throughput | Reliability | Notes |
|--------|---------------|------------|------------|-------------|-------|
| ADB `input text` + `input tap` (current) | **HIGH** | EASY | ~1 msg/15s | Medium | IME bypass is main risk |
| ADB + UHID keyboard | **LOW** | HARD | ~1 msg/20s | High | Best balance |
| `sendevent` for taps + UHID for text | **VERY LOW** | HARD | ~1 msg/20s | High | Gold standard |
| Accessibility Service | **MEDIUM-HIGH** | MEDIUM | ~1 msg/10s | Medium | WhatsApp detects accessibility services |
| Notification Reply (RemoteInput) | **VERY LOW** | MEDIUM | Only replies | Low | Only works for reply to existing notifications |
| Share Intent (ACTION_SEND) | **HIGH** | EASY | ~1 msg/20s | Low | Requires UI interaction, same wa.me pattern |
| Direct DB manipulation (msgstore.db) | **EXTREME** | HARD | Instant | None | Messages never actually sent to server |
| Xposed/LSPosed hooks | **MEDIUM** | VERY HARD | ~1 msg/5s | Medium | Xposed detection is an arms race |
| WhatsApp Web protocol (whatsmeow) | **VERY HIGH** | MEDIUM | Fast | Medium | Ban wave ongoing, highly detected |

### 8.2 Notification Reply (RemoteInput) -- interesting niche

```
Flow:
1. Send first message normally (UHID/ADB)
2. Wait for reply from recipient
3. Notification appears with RemoteInput action
4. Programmatically invoke RemoteInput.addResultsToIntent()
5. Send reply through notification -- no UI interaction at all

Detection risk: VERY LOW (it is the official notification reply API)
Limitation: Only works AFTER receiving a message, cannot initiate
```

This could be used for **Oralsin callback confirmations** -- after patient replies, we respond via notification.

### 8.3 Direct DB manipulation -- why it DOES NOT work

Despite root access to `/data/data/com.whatsapp/databases/msgstore.db`:
- Inserting a row in the message table only creates a **local record**
- The message is NEVER sent to WhatsApp's servers
- The Signal Protocol encryption requires proper key exchange
- Even if you forge the right protobuf, the server rejects messages without valid session keys
- This method only works for **forensic manipulation** (making it look like a message was sent/received locally)

**Verdict**: Useless for sending. Only useful for local evidence tampering.

### 8.4 Xposed/LSPosed hooks -- high-reward, high-risk

With LSPosed, you could hook WhatsApp's message send function (e.g., `SendE2EMessageJob.performJob()`) to inject messages directly into WhatsApp's send queue, bypassing ALL UI interaction.

**Problems:**
- WhatsApp obfuscates class names on every update (proguard)
- Need to reverse-engineer each WhatsApp version
- LSPosed itself is detectable (module list, Xposed bridge jar)
- Requires constant maintenance
- If WhatsApp adds integrity checks on the send path, this breaks

---

## 9. Known CVEs and Research

### 9.1 Relevant Android CVEs

| CVE | Year | Relevance |
|-----|------|-----------|
| CVE-2025-48633 | 2025 | Android RCE in core components -- not directly related but shows ongoing patching |
| CVE-2025-48572 | 2025 | Targeted exploitation in Android -- indicates active threat landscape |
| CVE-2025-38352 | 2025 | Android security flaw exploited in the wild |

No specific CVEs for `InputManagerService` injection spoofing were found in 2024-2025 searches. The `INJECT_EVENTS` permission model has been stable since Android 4.x.

### 9.2 Academic research

**"Stopping Abuse: How WhatsApp Fights Bulk Messaging and Automated Behavior"** (WhatsApp/Meta whitepaper, 2019, updated):
- Confirms ML-based detection with behavioral signals
- 75%+ of bans are proactive (not from user reports)
- Typing indicator analysis confirmed as a signal

**WhatsApp Device Fingerprinting** (Tal Be'ery, 2025):
- WhatsApp's encryption key patterns (Signed Pre-Key IDs) leaked device type
- Meta patched by randomizing SPK IDs
- Shows WhatsApp does deep protocol-level fingerprinting

### 9.3 WhatsApp 2026 "Guardian" protocols

In early 2026, Meta deployed new "Guardian" AI protocols that are specifically designed to detect:
- Rapid-fire engagement patterns
- Copy-paste member data harvesting
- High-volume broadcasts without prior interaction history
- Coordinated multi-account campaigns from same network

This represents a **significant escalation** in detection capabilities.

---

## 10. Current Implementation Risk Assessment

### Risk matrix for current `send-engine.ts`:

| Component | Current Implementation | Risk Level | Primary Concern |
|-----------|----------------------|------------|-----------------|
| Text input | `input text` (word chunks) | **HIGH** | IME bypass, no InputConnection.commitText() |
| Send button | `input tap` via UIAutomator coords | **MEDIUM** | Fixed pressure, zero touch size |
| Chat opening | wa.me deep link every time | **HIGH** | Repetitive pattern, server-side detectable |
| Typing delays | Gaussian (mean=200, stddev=60) | **MEDIUM** | Too uniform, no bursts/pauses |
| Contact creation | Content provider -> immediate send | **HIGH** | Classic bulk sender pattern |
| UI detection | `uiautomator dump` | **LOW** | System-level, not exposed to apps |
| Root presence | Unknown current Magisk setup | **UNKNOWN** | Needs verification |
| Typing indicator | Not explicitly handled | **HIGH** | Server sees no/minimal typing presence |
| Message templates | Similar content across recipients | **MEDIUM-HIGH** | NLP detection of template patterns |
| Multi-device timing | Jitter implemented in rate limiter | **MEDIUM** | Good but needs wider variance |

### Overall risk score: **HIGH**

The biggest risks are:
1. **IME bypass** (no typing indicator, wrong InputConnection flow)
2. **wa.me pattern** (every chat opened the same way)
3. **Contact -> immediate send** pattern
4. **Template similarity** in content

---

## 11. Recommended Hardening Roadmap

### Phase A: Quick wins (LOW effort, HIGH impact)

```
A1. Vary chat opening method
    - 30% via wa.me deep link
    - 40% via WhatsApp internal search (tap search -> type number -> tap result)
    - 30% via direct contact open (open WhatsApp -> scroll/search chat list)
    Implementation: rotate strategy per message

A2. Add realistic typing pauses
    - Replace gaussian with: burst typing (fast) + think pauses (2-10s)
    - Add word-length-proportional delay (longer words = more time)
    - Occasionally "make a typo" (type wrong char, backspace, retype)
    - Add sentence-boundary pause (1-5s after period/comma)

A3. Add contact "aging"
    - Create contacts in advance (hours/days before first message)
    - Or use wa.me without saving contact (skip ensureContact for wa.me)
    - Batch contact creation separate from messaging

A4. Vary message templates more aggressively
    - 10+ template variants per message type
    - Random greetings (Ola/Oi/Bom dia/Tudo bem?)
    - Random sentence structure
    - Occasional emoji insertion
```

### Phase B: UHID keyboard migration (MEDIUM effort, VERY HIGH impact)

```
B1. Implement UHID virtual keyboard
    - Option 1: Extract scrcpy's UHID implementation (C code, compile for ARM)
    - Option 2: Write minimal UHID creator in C (100-200 lines)
    - Push binary to device, create virtual keyboard on boot

B2. Replace `input text` with UHID key events
    - Type through proper HID key reports
    - IME processes keys -> InputConnection.commitText() fires
    - Typing indicator triggers naturally
    - Variable key-down durations (50-200ms per key)

B3. Replace `input tap` with sendevent
    - Use real touchscreen device node
    - Add realistic pressure (30-80, variable)
    - Add touch major (3-8, variable)
    - Add slight position jitter (+/-2-5 pixels)
    - Add natural down-to-up timing (50-150ms)
```

### Phase C: Root hardening (MEDIUM effort, HIGH impact)

```
C1. Install proper root hiding stack
    - SukiSU Ultra or Magisk Alpha + ReZygisk
    - SUSFS for mount/file hiding
    - Play Integrity Fix (PIF) -- verify MEETS_DEVICE_INTEGRITY
    - WAHideBootloader
    - Shamiko for process-level hiding

C2. Add WhatsApp to DenyList/exclusion
    - Ensure WhatsApp sees clean environment
    - Verify with integrity check tool (SPIC or similar)

C3. Optionally disable developer options before WhatsApp launch
    - `settings put global development_settings_enabled 0`
    - `settings put global adb_enabled 0`
    - Re-enable after send session (can still use ADB over TCP)
```

### Phase D: Advanced behavioral mimicry (HIGH effort, HIGH impact)

```
D1. Session simulation
    - Before sending, "use" WhatsApp briefly (scroll chats, open random chat, back)
    - Vary session length (do not always send immediately after opening)
    - Sometimes open WhatsApp and do nothing (background activity)

D2. Notification reply for follow-ups
    - After initial send, listen for reply notifications
    - Use RemoteInput to reply via notification channel
    - Zero UI fingerprint for follow-up messages

D3. Gradual volume ramp-up
    - New accounts start with 5 msgs/day
    - Increase by 5-10 per day over 2 weeks
    - Never exceed account's "trust score" based on age and activity

D4. Cross-device message distribution entropy
    - Do not distribute round-robin (predictable)
    - Random device selection weighted by health + idle time
    - Occasionally skip a device's turn entirely
```

### Priority order:

```
IMMEDIATE (this week):  A2 (typing pauses) -> A1 (chat opening variety)
SHORT TERM (2 weeks):   B1-B2 (UHID keyboard) -> C1-C2 (root hiding)
MEDIUM TERM (1 month):  A3-A4 (contact aging, templates) -> B3 (sendevent taps)
LONG TERM (ongoing):    D1-D4 (behavioral mimicry)
```

---

## Sources

- [WhatsApp Device Fingerprinting Vulnerability (Tal Be'ery)](https://medium.com/@TalBeerySec/i-know-which-device-you-used-last-summer-fingerprinting-whatsapp-users-devices-71b21ac8dc70)
- [Meta Addresses WhatsApp Device Fingerprinting](https://www.thecybersyrup.com/p/meta-begins-addressing-whatsapp-device-fingerprinting-risks-linked-to-spyware-targeting)
- [WhatsApp Automation: How to Stay Unbanned (2025 Guide)](https://tisankan.dev/whatsapp-automation-how-do-you-stay-unbanned/)
- [AI-Resilient WhatsApp Strategies: 2026 Account Ban Wave](https://aijourn.com/ai-resilient-whatsapp-strategies-navigating-the-2026-account-ban-wave/)
- [WhatsApp Mass Marketing 2026: Build a Bulletproof Risk System](https://warmer.wadesk.io/blog/whatsapp-mass-marketing-risk-control)
- [Stopping Abuse: How WhatsApp Fights Bulk Messaging (Meta Whitepaper)](https://internetlab.org.br/wp-content/uploads/2019/10/WA_StoppingAbuse_Whitepaper_020618-Final-1.pdf)
- [WAHideBootloader Magisk Module](https://github.com/thelordalex/WAHideBootloader)
- [Pass Strong Integrity + Root Detection Bypass (XDA, Jan 2026)](https://xdaforums.com/t/guide-how-to-pass-strong-integrity-and-bypass-root-detection-apps-revolut-company-portal-google-wallet-etc-working-as-of-january-13th-2026.4773849/)
- [WhatsApp Protector Anti-Ban Magisk Module](https://androidroot.net/module/202407/whatsapp-protector-anti-banned/)
- [Android Input Architecture (J. Levin)](https://newandroidbook.com/Book/Input.html)
- [AOSP InputDispatcher.cpp](https://cs.android.com/android/platform/superproject/+/master:frameworks/native/services/inputflinger/dispatcher/InputDispatcher.cpp)
- [Android InputManager.java](https://android.googlesource.com/platform/frameworks/base/+/master/core/java/android/hardware/input/InputManager.java)
- [scrcpy UHID Keyboard Documentation](https://github.com/Genymobile/scrcpy/blob/master/doc/keyboard.md)
- [Linux uinput Kernel Documentation](https://kernel.org/doc/html/v4.12/input/uinput.html)
- [WhatsApp Typing Indicator Deep Dive](https://parashar--manas.medium.com/how-whatsapps-typing-indicator-actually-works-8a3cf18f2bad)
- [Whatsmeow Ban Discussion (tulir/whatsmeow#567)](https://github.com/tulir/whatsmeow/discussions/567)
- [Whatsmeow "Account at Risk" Warning (tulir/whatsmeow#810)](https://github.com/tulir/whatsmeow/issues/810)
- [How to Detect Frida Hooking (Talsec)](https://docs.talsec.app/appsec-articles/articles/how-to-detect-hooking-frida-using-kotlin)
- [WaEnhancer LSPosed Module](https://www.magiskmodule.com/wa-enhancer-lsposed-module-to-fix-whatsapp-error/)
- [WhatsApp msgstore.db Manipulation Analysis](https://cti.monster/blog/2025/07/28/whatsapp-message-manipulation.html)
- [scrcpy UHID Issue #4034](https://github.com/Genymobile/scrcpy/issues/4034)
- [Android MotionEvent API](https://developer.android.com/reference/android/view/MotionEvent)
- [WhatsApp Official: Unauthorized Automated Messaging](https://faq.whatsapp.com/5957850900902049)
- [Detect Magisk Hide Using AI (Appdome)](https://www.appdome.com/how-to/mobile-malware-prevention/android-malware-detection/detect-magisk-hide-in-android-apps/)
